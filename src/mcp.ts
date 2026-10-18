#!/usr/bin/env bun
/**
 * ComsNet MCP server for Claude Code.
 *
 * Makes an INTERACTIVE Claude Code session a first-class ComsNet citizen: it
 * registers on the per-session hub (so other agents see it), and exposes tools to
 * list peers, send messages, read its inbox, and reply to inbound prompts.
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdio (the MCP stdio contract).
 * stdout carries ONLY protocol frames — all logging goes to stderr.
 *
 * Registration / heartbeat / SSE mirror scripts/cc-coms-peer.ts. Unlike that
 * headless worker, this never runs `claude -p`; inbound prompts are buffered and
 * surfaced to the human-driven session via the `comsnet_inbox` tool.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { COMS_NET_DIR, createComsNetClient } from "./lib/coms-net-client";
import { enrichDispatchPrompt } from "./lib/prompt-enrich";

const PROTOCOL_VERSION = "2025-06-18";

type InboundPrompt = {
	msg_id: string;
	sender: string;
	prompt: string;
	conversation_id: string | null;
	received_at: string;
	addressed_to?: string;
	answered: boolean;
};

// Issue #327: stderr was stdio-only — codex (and most MCP hosts) do not retain a
// non-interactive server's stderr, so a silently-swallowed error (e.g. a failed
// hub pull) left zero trace anywhere. Mirror every log line to a per-peer file so
// a post-mortem has something to read even when the host drops stderr.
let logStream: fs.WriteStream | null = null;
function initLogFile(project: string, name: string): void {
	try {
		const dir = path.join(COMS_NET_DIR, "run");
		fs.mkdirSync(dir, { recursive: true });
		logStream = fs.createWriteStream(path.join(dir, `mcp-${project}-${name}.log`), { flags: "a" });
	} catch { /* best-effort — stderr still works */ }
}
function log(...args: unknown[]): void {
	const line = `[comsnet-mcp] ${new Date().toISOString()} ${args.map(String).join(" ")}\n`;
	process.stderr.write(line);
	try { logStream?.write(line); } catch { /* best-effort */ }
}

function parseArgs(argv: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		if (!argv[i].startsWith("--")) continue;
		const key = argv[i].slice(2);
		const next = argv[i + 1];
		if (next && !next.startsWith("--")) { out[key] = next; i++; } else { out[key] = "true"; }
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
const project = args.project ?? process.env.PI_COMS_NET_PROJECT ?? "Pi-custom-agents";
const name = args.name ?? process.env.PI_COMS_AGENT_NAME ?? "claude";
const model = args.model ?? process.env.PI_COMS_AGENT_MODEL ?? "sonnet";
// Agent kind for monitors to tag the peer (claude-code | codex). Passed by the
// launcher (justfile pi-squad / squad-tools /add-agent); falls back to claude-code.
const provider = args.provider ?? "claude-code";
// Purpose label reflects the actual client (was hardcoded "Claude Code" → codex
// peers showed wrong). Derive from provider; allow explicit --purpose override.
const providerLabel =
	provider === "codex" ? "Codex" :
	provider === "claude-code" ? "Claude Code" :
	provider;
const purpose = args.purpose ?? `Interactive ${providerLabel} (ComsNet MCP)`;
const cwd = args.cwd ? path.resolve(args.cwd) : process.cwd();
const herdrStatePath = path.join(
	cwd, ".pi", "agents", "squads", "_runtime", "herdr-squads", `${project}.json`,
);
initLogFile(project, name);
// Status line (status_line_main.py) writes this CC pane's live context % here; we
// surface it in the heartbeat so the coms-net widget shows real % instead of 0.
const ctxFile = args["ctx-file"] ?? path.join(COMS_NET_DIR, "run", `ctx-${project}-${name}`);

function readCtxPct(): number {
	try {
		const v = parseFloat(fs.readFileSync(ctxFile, "utf-8").trim());
		return Number.isFinite(v) ? v : 0;
	} catch {
		return 0;
	}
}

// ── Lifetime guards (Issue #261) ─────────────────────────────────────────────
// An MCP server that outlives its REPL is not merely idle: it keeps a hub
// registration, keeps buffering replies nobody can drain, and keeps typing
// tmux nudges into whatever pane now carries our @squad_agent tag. Three guards
// bound our lifetime; each covers a hole the others miss.

const ORIGINAL_PPID = process.ppid;

/** Terminal shutdown used by every guard below. Never returns. */
function selfTerminate(reason: string): void {
	log(`shutting down: ${reason}`);
	// Give deregister a moment, but never hang on it — the point is to die.
	const hardExit = setTimeout(() => process.exit(0), 2_000);
	try { (hardExit as any).unref?.(); } catch { /* ignore */ }
	void client.deregister().finally(() => process.exit(0));
}

// Guard 1 — parent death. stdin EOF is the documented stdio-MCP shutdown signal,
// but it does NOT always arrive: killing a tmux pane reparents us to launchd with
// the pipe still open, and we then run forever (observed: 2h43m orphan, 0 hub
// connections, still nudging). ppid flipping away from our spawner is unambiguous.
//
// MUST read the ppid via `ps`, NOT `process.ppid`: Bun caches process.ppid at
// startup and keeps returning the original value long after we are reparented
// (verified — `ps` reports 1 while process.ppid still reports the dead parent),
// so a watchdog built on process.ppid never fires. This is a Bun/Node difference.
function realPpid(): number {
	try {
		const out = execFileSync("ps", ["-o", "ppid=", "-p", String(process.pid)], {
			encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
		});
		const v = parseInt(out.trim(), 10);
		return Number.isFinite(v) ? v : -1;
	} catch {
		return -1;
	}
}

function startParentWatchdog(): void {
	const timer = setInterval(() => {
		const ppid = realPpid();
		if (ppid === -1) return; // ps unavailable — stay up rather than guess
		if (ppid !== ORIGINAL_PPID || ppid === 1) {
			clearInterval(timer);
			selfTerminate(`parent ${ORIGINAL_PPID} exited (ppid now ${ppid})`);
		}
	}, 5_000);
	try { (timer as any).unref?.(); } catch { /* ignore */ }
}

// Guard 2 — singleton per (project, name). One REPL can spawn a second MCP server
// without reaping the first (observed: two live children of the same codex, both
// registered, both nudging the same pane). Newest wins: we signal the incumbent to
// go, then claim the lock. Stale locks (dead pid) are simply overwritten.
const lockFile = path.join(COMS_NET_DIR, "run", `mcp-${project}-${name}.pid`);

function claimSingletonLock(): void {
	try {
		fs.mkdirSync(path.dirname(lockFile), { recursive: true });
		const prev = parseInt(fs.readFileSync(lockFile, "utf-8").trim(), 10);
		if (Number.isFinite(prev) && prev > 0 && prev !== process.pid) {
			try {
				process.kill(prev, 0); // probe: throws if the pid is gone
				process.kill(prev, "SIGTERM");
				log(`superseded older MCP instance pid=${prev} for ${name}@${project}`);
			} catch { /* already dead — nothing to supersede */ }
		}
	} catch { /* no lock yet */ }
	try {
		fs.writeFileSync(lockFile, String(process.pid), "utf-8");
	} catch (err: any) {
		log(`lock write: ${err?.message ?? err}`);
	}
}

function releaseSingletonLock(): void {
	try {
		const held = parseInt(fs.readFileSync(lockFile, "utf-8").trim(), 10);
		if (held === process.pid) fs.unlinkSync(lockFile);
	} catch { /* nothing to release */ }
}

// ── Codex context % (codex has no status line; read its session rollout) ──────
// codex logs token usage to ~/.codex/sessions/.../rollout-*.jsonl. We find THIS
// pane's rollout via lsof on our parent codex process (robust with multiple codex
// panes), then compute input_tokens / model_context_window from the last token_count.
let codexRollout: string | null = null;
function findCodexRollout(): string | null {
	try {
		const out = execFileSync("lsof", ["-p", String(process.ppid)], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
		const m = out.match(/\S*\.codex\/sessions\/\S+\/rollout-\S+\.jsonl/);
		return m ? m[0] : null;
	} catch {
		return null;
	}
}
function readCodexCtxPct(): number {
	if (!codexRollout) codexRollout = findCodexRollout();
	if (!codexRollout) return 0;
	try {
		// Read only the tail — token_count events are frequent, and rollouts get large.
		const stat = fs.statSync(codexRollout);
		const len = Math.min(stat.size, 65536);
		const buf = Buffer.alloc(len);
		const fd = fs.openSync(codexRollout, "r");
		fs.readSync(fd, buf, 0, len, stat.size - len);
		fs.closeSync(fd);
		const lines = buf.toString("utf-8").split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			if (!lines[i].includes("token_count")) continue;
			try {
				const info = JSON.parse(lines[i])?.payload?.info;
				const win = info?.model_context_window;
				const used = info?.last_token_usage?.input_tokens;
				if (win && used != null) return Math.round((used / win) * 100);
			} catch { /* truncated first line — skip */ }
		}
	} catch {
		codexRollout = null; // 讀取失敗（檔案已移除），下次 heartbeat 重新搜尋
	}
	return 0;
}

// Context % source by agent kind: codex → rollout; cc → status-line ctx file.
function currentCtxPct(): number {
	return provider === "codex" ? readCodexCtxPct() : readCtxPct();
}

const inbox: InboundPrompt[] = [];
// One-line 繁體中文 summary of what this session is currently doing. Set via the
// comsnet_status tool; sent on every heartbeat so teammates see live activity in
// comsnet_list_agents and the monitor.
let currentActivity = "";

// ── Outbound tracking (so late replies are never lost) ──────────────────────
// An interactive REPL's comsnet_send blocks on the server long-poll for a bounded
// time. If the peer replies AFTER that window, the hub still pushes a `response`
// SSE event — we buffer it here and nudge the pane so the sender re-engages instead
// of silently stopping. state "awaiting" = no synchronous result returned yet;
// "consumed" = comsnet_send already returned the reply inline (don't double-surface).
type OutboundEntry = { target: string; state: "awaiting" | "consumed" };
const outbound = new Map<string, OutboundEntry>();
// `shown`: already surfaced by comsnet_inbox but the hub never confirmed the
// completion-ack, so we keep it for a retry. Shown replies must NOT drive nudges —
// nudging over something the agent has already read is the Issue #261 loop.
type ReplyItem = { msg_id: string; from: string; text: string; error: string | null; shown?: boolean };
const replies: ReplyItem[] = [];

async function pullInboxForName(agentName: string): Promise<void> {
	for (const m of await client.pullInbox(agentName)) {
		if (!inbox.some((x) => x.msg_id === m.msg_id)) {
			inbox.push({
				msg_id: m.msg_id,
				sender: m.sender ?? "?",
				prompt: m.prompt,
				conversation_id: m.conversation_id ?? null,
				received_at: m.created_at ?? new Date().toISOString(),
				addressed_to: agentName,
				answered: false,
			});
			void client.ack(m.msg_id);
		}
	}
}

// ━━ Pane driver abstraction (D1) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Non-Pi peers (CC / codex / kimi / opencode / antigravity) have no async push,
// so when a peer sends us a message we must wake the pane. The old code hard-bound
// to tmux, but herdr-backed squads have no tmux session at all — findMyPane()
// always returned null and nudges silently no-oped (Issues #311/#312/#313).
//
// Two drivers, selected by PI_SQUAD_BACKEND. No extra abstraction for a hypothetical
// third backend — YAGNI.

export type PaneState = "idle" | "working" | "blocked" | "done" | "unknown";

export interface PaneHandle {
	/** Backend-specific target: tmux pane_id (e.g. %5) or herdr pane_id (e.g. wC:p3). */
	target: string;
	/** The matched tag (e.g. "cc:opus-orchestrator", "codex:reviewer"). */
	tag: string;
}

export interface PaneDriver {
	locate(): Promise<PaneHandle | null>;
	state(h: PaneHandle): Promise<PaneState>;
	/** Deliver nudge text to the pane. Returns true only on confirmed delivery. */
	deliver(h: PaneHandle, text: string): Promise<boolean>;
}

// ── tmux driver ─────────────────────────────────────────────────────────────

function tmux(tmuxArgs: string[]): Promise<string> {
	return new Promise((resolve) => {
		try {
			const child = spawn("tmux", tmuxArgs, { stdio: ["ignore", "pipe", "ignore"] });
			let out = "";
			child.stdout.on("data", (c) => { out += c.toString(); });
			child.on("error", () => resolve(""));
			child.on("close", () => resolve(out));
		} catch { resolve(""); }
	});
}

/** True when `pid` is us or an ancestor of ours (the tmux pane process we run under). */
function isAncestorOfUs(pid: string | undefined): boolean {
	const target = parseInt(String(pid ?? ""), 10);
	if (!Number.isFinite(target) || target <= 0) return false;
	let cur = process.pid;
	// Depth-capped: pane → shell → REPL → us is only a few hops; the cap also stops
	// a corrupt ppid cycle from spinning here.
	for (let hop = 0; hop < 12 && cur > 1; hop++) {
		if (cur === target) return true;
		try {
			const out = execFileSync("ps", ["-o", "ppid=", "-p", String(cur)], {
				encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
			});
			const next = parseInt(out.trim(), 10);
			if (!Number.isFinite(next) || next === cur) return false;
			cur = next;
		} catch {
			return false;
		}
	}
	return false;
}

export function createTmuxDriver(): PaneDriver {
	const wanted = new Set([
		`cc:${name}`, `codex:${name}`, `kimi:${name}`,
		`opencode:${name}`, `antigravity:${name}`, name,
	]);
	return {
		async locate() {
			const out = await tmux([
				"list-panes", "-a", "-F",
				"#{session_name}|#{pane_id}|#{@squad_agent}|#{pane_pid}",
			]);
			for (const line of out.split("\n")) {
				const [sess, pane, tag, panePid] = line.split("|");
				// A peer's pane lives either in the shared project-named session (the
				// historical default) OR in its own dedicated session named after its
				// own `--name` (owner-approved per-peer sessions, e.g. codex-discord /
				// opus-discord). `wanted` is already scoped to THIS peer's own name, so
				// allowing `sess === name` can never match another peer's pane — and
				// Guard 3 below (isAncestorOfUs) still rejects any pane that is not
				// literally the one we live under, even if session+tag both match.
				if ((sess !== project && sess !== name) || !wanted.has(tag)) continue;
				// Guard 3 — pane ownership (Issue #261). The tag alone is NOT identity:
				// when a pane dies and a replacement claims the same @squad_agent tag,
				// a stale MCP would happily type into the newcomer's REPL. Only nudge
				// the pane we actually live under.
				if (!isAncestorOfUs(panePid)) {
					log(`skip nudge: pane ${pane} (${tag}) is not our REPL`);
					continue;
				}
				return { target: pane, tag };
			}
			return null;
		},
		async state() {
			return "unknown"; // tmux has no agent-state concept
		},
		async deliver(h, text) {
			// Type the text, then submit with Enter as a SEPARATE keystroke after a
			// beat — claude's TUI drops an Enter that arrives in the same burst.
			await tmux(["send-keys", "-t", h.target, "-l", text]);
			await new Promise((r) => setTimeout(r, 80));
			await tmux(["send-keys", "-t", h.target, "Enter"]);
			return true; // tmux has no delivery confirmation
		},
	};
}

// ── herdr driver ────────────────────────────────────────────────────────────

const HERDR_BIN = (() => {
	for (const p of ["/opt/homebrew/bin/herdr", "/usr/local/bin/herdr"]) {
		try { if (fs.statSync(p).isFile()) return p; } catch { /* try next */ }
	}
	return "herdr"; // last resort: $PATH
})();

/** Async herdr CLI call — returns parsed JSON or null. R2: non-blocking. */
async function herdrJsonAsync(subcmd: string[], timeoutMs = 10_000): Promise<any | null> {
	try {
		const { stdout } = await execFileAsync(HERDR_BIN, subcmd, {
			encoding: "utf-8", timeout: timeoutMs,
		});
		return JSON.parse(stdout);
	} catch {
		return null;
	}
}

export function createHerdrDriver(): PaneDriver {
	const wanted = new Set([
		`cc:${name}`, `codex:${name}`, `kimi:${name}`,
		`opencode:${name}`, `antigravity:${name}`, name,
	]);

	/** Read the herdr squad state file to find pane→tag mapping for this project. */
	function readSquadState(): { panes: { id: string; tag: string }[] } | null {
		try {
			return JSON.parse(fs.readFileSync(herdrStatePath, "utf-8"));
		} catch {
			return null;
		}
	}

	/**
	 * R1 — Ownership check (Issue #261 Guard 3, herdr path).
	 * Verify that our process tree is among the pane's foreground processes.
	 * Without this, a stale MCP (whose pane died) would nudge a replacement pane
	 * that happens to carry the same tag — typing into another agent's REPL.
	 */
	async function isOurProcess(paneId: string): Promise<boolean> {
		const json = await herdrJsonAsync(["pane", "process-info", "--pane", paneId]);
		const procs = json?.result?.process_info?.foreground_processes;
		if (!Array.isArray(procs)) return false;
		const pids = new Set(procs.map((p: any) => Number(p.pid)).filter(Number.isFinite));
		// Walk our parent chain; if any ancestor pid appears in the pane's
		// foreground processes, the pane is ours.
		let cur = process.pid;
		for (let hop = 0; hop < 12 && cur > 1; hop++) {
			if (pids.has(cur)) return true;
			try {
				const out = execFileSync("ps", ["-o", "ppid=", "-p", String(cur)], {
					encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
				});
				const next = parseInt(out.trim(), 10);
				if (!Number.isFinite(next) || next === cur) return false;
				cur = next;
			} catch {
				return false;
			}
		}
		return false;
	}

	return {
		async locate() {
			const state = readSquadState();
			if (!state) return null;
			const match = state.panes.find((p) => wanted.has(p.tag));
			if (!match) return null;
			// The pane herdr spawned can vanish (REPL crash / /exit / context cap)
			// without herdr ever updating the squad state file. A dead pane is a
			// distinct failure from "not ours" — surface it explicitly so the
			// operator knows to run /show, instead of it looking like a silent
			// ownership-check skip.
			const listJson = await herdrJsonAsync(["pane", "list"]);
			const livePanes = listJson?.result?.panes;
			if (Array.isArray(livePanes) && !livePanes.some((p: any) => p?.pane_id === match.id)) {
				log(`skip nudge: herdr pane ${match.id} (${match.tag}) has vanished — peer is dead, run /show in the Pi pane to revive it`);
				return null;
			}
			// R1: ownership check — skip if the pane is not ours.
			if (!await isOurProcess(match.id)) {
				log(`skip nudge: herdr pane ${match.id} (${match.tag}) is not our REPL`);
				return null;
			}
			return { target: match.id, tag: match.tag };
		},
		async state(h) {
			// R2: async — no event-loop block.
			const json = await herdrJsonAsync(["agent", "list"]);
			const agents = json?.result?.agents;
			if (!Array.isArray(agents)) return "unknown";
			const found = agents.find((a: any) => a.pane_id === h.target);
			if (!found) return "unknown";
			const s = found.agent_status;
			if (s === "idle" || s === "working" || s === "blocked" || s === "done") return s;
			return "unknown";
		},
		async deliver(h, text) {
			// R2: async — no event-loop block.
			// R6: `--until working` has a race: if the agent finishes its turn
			// before herdr observes the state transition, it may timeout and
			// return non-zero even though the prompt was accepted. This causes
			// a redundant nudge (safe — idempotent) but not a lost message.
			try {
				await execFileAsync(HERDR_BIN, [
					"agent", "prompt", h.target, text,
					"--wait", "--until", "working", "--timeout", "10000",
				], { encoding: "utf-8", timeout: 15_000 });
				return true;
			} catch {
				return false;
			}
		},
	};
}

// ── driver selection ────────────────────────────────────────────────────────

export function createPaneDriver(): PaneDriver {
	const backend = resolvePaneBackend();
	log(`pane driver: ${backend}`);
	return backend === "herdr" ? createHerdrDriver() : createTmuxDriver();
}

function resolvePaneBackend(): string {
	if (process.env.PI_SQUAD_BACKEND) return process.env.PI_SQUAD_BACKEND;
	// MCP hosts may omit inherited env. Use this project's existing registry,
	// rather than sending a herdr peer's reply notification through tmux.
	try {
		const state = JSON.parse(fs.readFileSync(herdrStatePath, "utf-8"));
		if (state.backend === "herdr") return "herdr";
	} catch { /* No readable squad registry: retain standalone tmux behavior. */ }
	return "tmux";
}

// ── state-aware nudge scheduler (D1b) ───────────────────────────────────────
// Build the one-line nudge covering BOTH inbound prompts awaiting a reply AND
// replies that arrived after comsnet_send stopped blocking. Returns null when
// there is nothing outstanding (so the scheduler can stop).
function composeText(pending: InboundPrompt[], unread: ReplyItem[]): string | null {
	const parts: string[] = [];
	if (pending.length) {
		const from = [...new Set(pending.map((m) => m.sender))].join(", ");
		parts.push(`${pending.length} message(s) from ${from} awaiting your reply`);
	}
	const unshown = unread.filter((r) => !r.shown);
	if (unshown.length) {
		const from = [...new Set(unshown.map((r) => r.from))].join(", ");
		parts.push(`${unshown.length} reply(ies) from ${from} to your earlier message(s)`);
	}
	if (!parts.length) return null;
	const tail = pending.length ? ", then comsnet_respond to reply." : ".";
	return `[ComsNet] ${parts.join("; ")}. Call comsnet_inbox to read${tail}`;
}

export function nudgeText(): string | null {
	return composeText(
		inbox.filter((m) => !m.answered),
		replies.filter((r) => !r.shown),
	);
}

// Backoff: 5s → 15s → 45s → 120s → 300s → 300s …
export const BACKOFF_MS = [5_000, 15_000, 45_000, 120_000, 300_000];

/** R3: separate backoff for the "working" skip path. */
export const WORKING_BACKOFF_MS = [5_000, 10_000, 30_000, 60_000, 120_000, 300_000];
export const WORKING_WARN_AFTER_MS = 10 * 60 * 1000; // 10 minutes

// Issue #348: nudge-storm ceiling. One inbound prompt / one outbound reply may
// be (re)delivered to the pane at most this many times while the user has not
// yet read it. The old scheduler re-typed the SAME one-line nudge every 5s for
// as long as the item stayed unread, so a reply left sitting for ~15 min while
// the orchestrator was busy produced 200+ identical nudges that buried the very
// report they announced. After the cap we log once and stop pushing that item;
// the hub still holds it unanswered so reading comsnet_inbox later works.
export const MAX_NUDGE_REPEATS = Number(process.env.PI_COMS_NET_NUDGE_MAX_REPEATS) || 10;

/** msg_id → successful deliveries to the pane (inbox prompts & replies alike). */
const nudgeCounts = new Map<string, number>();

export function _resetNudgeCounts(): void {
	nudgeCounts.clear();
}

export function _getNudgeCount(msg_id: string): number {
	return nudgeCounts.get(msg_id) ?? 0;
}

function dropNudgeCount(msg_id: string): void {
	nudgeCounts.delete(msg_id);
}

/** Split outstanding items into those still within the nudge budget and those
 * that have been pushed MAX_NUDGE_REPEATS times already (read-only). */
function budgetSplit(items: { msg_id: string }[]): {
	within: { msg_id: string }[];
	over: { msg_id: string }[];
} {
	const within: { msg_id: string }[] = [];
	const over: { msg_id: string }[] = [];
	for (const it of items) {
		((nudgeCounts.get(it.msg_id) ?? 0) < MAX_NUDGE_REPEATS ? within : over).push(it);
	}
	return { within, over };
}

let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
let backoffIndex = 0;
let workingBackoffIndex = 0;
let workingSinceMs = 0; // when we first observed "working" for the current streak
let paneDriver: PaneDriver = createPaneDriver();

/** Test hook: replace the pane driver. Returns the previous driver. */
export function _setPaneDriver(driver: PaneDriver): PaneDriver {
	const prev = paneDriver;
	paneDriver = driver;
	return prev;
}

/** Test hook: reset backoff counters. */
export function _resetBackoff(): void {
	backoffIndex = 0;
	workingBackoffIndex = 0;
	workingSinceMs = 0;
	if (nudgeTimer) { clearTimeout(nudgeTimer); nudgeTimer = null; }
}

/** Test hook: inject an inbox item for testing nudge cycle. */
export function _pushInbox(msg_id: string, sender: string): void {
	inbox.push({
		msg_id, sender, prompt: "test", conversation_id: null,
		received_at: new Date().toISOString(), answered: false,
	});
}

/** Test hook: get current inbox state. */
export function _getInbox(): typeof inbox { return inbox; }

/** Test hook: clear inbox. */
export function _clearInbox(): void { inbox.length = 0; _resetNudgeCounts(); }

/** Test hook: seed an outbound "awaiting" entry, as comsnet_send does. */
export function _trackOutbound(msgId: string, target: string): void {
	outbound.set(msgId, { target, state: "awaiting" });
}

/** Test hook: inspect outbound state. */
export function _getOutbound(): typeof outbound { return outbound; }

/** Test hook: inspect buffered replies. */
export function _getReplies(): typeof replies { return replies; }

/** Test hook: clear outbound + reply buffers. */
export function _clearOutbound(): void { outbound.clear(); replies.length = 0; _resetNudgeCounts(); }

/** Test hook: swap the ComsNet client for a stub. Returns the previous client. */
export function _setClient(c: typeof client): typeof client {
	const prev = client;
	client = c;
	return prev;
}

/**
 * D4: Ack all pending items ONLY after the nudge is confirmed delivered.
 *
 * Issue #327: this used to re-read the LIVE `inbox`/`outbound` state instead of
 * the exact snapshot `nudgeText()` built the delivered message from. Between
 * `nudgeText()` running and the pane confirming delivery (a `deliver()` call
 * that can take real network/tmux time), a NEW inbound prompt or a NEW outbound
 * reply can land — onPrompt/onResponse push it and call `scheduleNudge()`, but
 * the in-flight nudge's debounce (`if (nudgeTimer) return`) drops that call as
 * a no-op because a cycle is already running. `ackAfterDelivery()` then blindly
 * marked EVERY unanswered inbox item and EVERY "awaiting" outbound entry as
 * handled — including the ones that just arrived and were never mentioned in
 * the pane's nudge text. The outbound side is fatal: `handleOutboundResponse`
 * drops any reply whose entry is already "consumed" (its dedup guard), so that
 * reply is silently lost forever — no nudge, no re-delivery, nothing. Scoping
 * both loops to the caller-supplied snapshot (the msg_ids `nudgeText()` actually
 * included) fixes this: only items that were truly delivered to the pane are
 * marked handled.
 */
function ackAfterDelivery(scope: { inboxIds: Set<string>; outboundIds: Set<string> }): void {
	// Ack inbound prompts that were actually part of the delivered nudge.
	for (const m of inbox) {
		if (!m.answered && scope.inboxIds.has(m.msg_id)) {
			void client.ack(m.msg_id);
		}
	}
	// Mark only the outbound replies that were actually shown as consumed —
	// NOT every "awaiting" entry, which could include replies that hadn't
	// arrived yet when this nudge was built.
	for (const [msgId, ob] of outbound) {
		if (ob.state === "awaiting" && scope.outboundIds.has(msgId)) {
			ob.state = "consumed";
		}
	}
}

/**
 * Core nudge cycle — extracted for testability. Called by `scheduleNudge`
 * after the debounce timer fires. Tests can call this directly with a fake
 * driver to verify behavior without timers.
 *
 * Issue #348: delivery is capped per msg_id at MAX_NUDGE_REPEATS. An item the
 * user has not yet read is still re-nudged (in case the pane missed it) but
 * never more than MAX_NUDGE_REPEATS times, and identical repeats after the cap
 * stop the scheduler instead of pushing 200+ copies of the same line.
 */
export async function _nudgeCycle(): Promise<{
	action: "delivered" | "working-skip" | "locate-failed" | "nothing-outstanding" | "deliver-failed" | "nudge-capped";
	deliverCalled: boolean;
}> {
	const outstandingInbox = inbox.filter((m) => !m.answered);
	const outstandingReplies = replies.filter((r) => !r.shown);
	const inboxSplit = budgetSplit(outstandingInbox);
	const replySplit = budgetSplit(outstandingReplies);

	if (
		(outstandingInbox.length || outstandingReplies.length) &&
		!inboxSplit.within.length && !replySplit.within.length
	) {
		// Everything outstanding has been nudged MAX_NUDGE_REPEATS times. Stop
		// pushing identical text (the storm), log once per capped item, and keep
		// the scheduler parked — reading comsnet_inbox still works.
		for (const m of [...outstandingInbox, ...outstandingReplies]) {
			log(`nudge cap reached (${MAX_NUDGE_REPEATS}) — stop pushing ${m.msg_id}; awaiting comsnet_inbox`);
		}
		backoffIndex = 0;
		workingBackoffIndex = 0;
		workingSinceMs = 0;
		return { action: "nudge-capped", deliverCalled: false };
	}

	const text = composeText(inboxSplit.within as InboundPrompt[], replySplit.within as ReplyItem[]);
	if (!text) {
		backoffIndex = 0;
		workingBackoffIndex = 0;
		workingSinceMs = 0;
		return { action: "nothing-outstanding", deliverCalled: false };
	}
	// Snapshot exactly what this nudge is about to deliver — see ackAfterDelivery
	// doc comment for why this must NOT be re-read after deliver() returns.
	const nudgedInboxIds = new Set((inboxSplit.within as InboundPrompt[]).map((m) => m.msg_id));
	const nudgedOutboundIds = new Set((replySplit.within as ReplyItem[]).map((r) => r.msg_id));
	const handle = await paneDriver.locate();
	if (!handle) return { action: "locate-failed", deliverCalled: false };
	const st = await paneDriver.state(handle);
	if (st === "working") {
		if (workingSinceMs === 0) workingSinceMs = Date.now();
		const elapsed = Date.now() - workingSinceMs;
		if (elapsed >= WORKING_WARN_AFTER_MS) {
			log(`warning: pane ${handle.target} (${handle.tag}) has been working for ${Math.round(elapsed / 1000)}s — may be stuck`);
			workingSinceMs = Date.now();
		}
		const delay = WORKING_BACKOFF_MS[Math.min(workingBackoffIndex, WORKING_BACKOFF_MS.length - 1)];
		workingBackoffIndex++;
		return { action: "working-skip", deliverCalled: false };
	}
	workingBackoffIndex = 0;
	workingSinceMs = 0;
	const ok = await paneDriver.deliver(handle, text);
	if (ok) {
		log(`nudged ${handle.target} (${handle.tag}) via ${resolvePaneBackend()}`);
		for (const id of [...nudgedInboxIds, ...nudgedOutboundIds]) {
			nudgeCounts.set(id, (nudgeCounts.get(id) ?? 0) + 1);
		}
		ackAfterDelivery({ inboxIds: nudgedInboxIds, outboundIds: nudgedOutboundIds });
		backoffIndex = 0;
		return { action: "delivered", deliverCalled: true };
	}
	log(`deliver failed for ${handle.target}, backing off`);
	const delay = BACKOFF_MS[Math.min(backoffIndex, BACKOFF_MS.length - 1)];
	backoffIndex++;
	return { action: "deliver-failed", deliverCalled: true };
}

function scheduleNudge(): void {
	// Debounce: one pending nudge covers any messages/replies that land together.
	if (nudgeTimer) return;
	nudgeTimer = setTimeout(async () => {
		nudgeTimer = null;
		const result = await _nudgeCycle();
		if (result.action === "nothing-outstanding") return;
		if (result.action === "locate-failed") {
			// Pane not up yet (cold start) — retry shortly without advancing backoff.
			const retry = setTimeout(() => scheduleNudge(), 3_000);
			try { (retry as any).unref?.(); } catch { /* ignore */ }
			return;
		}
		if (result.action === "working-skip") {
			const delay = WORKING_BACKOFF_MS[Math.min(workingBackoffIndex - 1, WORKING_BACKOFF_MS.length - 1)];
			const next = setTimeout(() => scheduleNudge(), delay);
			try { (next as any).unref?.(); } catch { /* ignore */ }
			return;
		}
		if (result.action === "delivered") {
			const again = setTimeout(() => { if (nudgeText()) scheduleNudge(); }, BACKOFF_MS[0]);
			try { (again as any).unref?.(); } catch { /* ignore */ }
			return;
		}
		if (result.action === "nudge-capped") {
			// Issue #348: everything pending has already been nudged to the cap.
			// Stop rescheduling entirely — repeated identical nudges were burying
			// the very content they announce. The hub still holds the messages as
			// unanswered; a later comsnet_inbox read (or a fresh inbound/reply)
			// re-engages the scheduler normally.
			return;
		}
		// deliver-failed
		const delay = BACKOFF_MS[Math.min(backoffIndex - 1, BACKOFF_MS.length - 1)];
		const retry = setTimeout(() => scheduleNudge(), delay);
		try { (retry as any).unref?.(); } catch { /* ignore */ }
	}, 1_500);
	try { (nudgeTimer as any).unref?.(); } catch { /* ignore */ }
}

// ━━ ComsNet client (shared module owns discovery/register/heartbeat/SSE) ━━━━

// Extracted to named, exported functions (Issue #327) so tests can drive the
// exact same inbound/outbound handling the real SSE callbacks use, instead of
// re-implementing the logic in a test double.
export function handleInboundPrompt(data: {
	msg_id: string; sender?: { name?: string }; prompt: string; conversation_id?: string | null;
}): void {
	inbox.push({
		msg_id: data.msg_id, sender: data.sender?.name ?? "?", prompt: data.prompt,
		conversation_id: data.conversation_id ?? null, received_at: new Date().toISOString(),
		answered: false,
	});
	// D4: do NOT ack here. Ack is deferred until the nudge is actually delivered
	// to the pane (see ackAfterDelivery). If the pane never wakes, the hub keeps
	// the message as unanswered and can replay it.
	log(`inbox += ${data.sender?.name} ${data.msg_id}`);
	scheduleNudge();
}

// A peer replied to one of OUR comsnet_send messages. If the synchronous
// send already returned the reply inline, skip; otherwise buffer it and
// nudge so the sender re-engages (Issue 2: senders used to silently stop
// when a reply landed after the blocking window).
export function handleOutboundResponse(data: {
	msg_id?: string; responder?: { name?: string }; response: unknown; error?: string | null;
}): void {
	const mid: string | undefined = data.msg_id;
	const ob = mid ? outbound.get(mid) : undefined;
	if (!mid || ob?.state === "consumed") return;
	// D4: do NOT mark consumed here. Deferred until nudge delivery succeeds
	// (see ackAfterDelivery). If the pane never wakes, the reply stays pending
	// and the hub can replay it.
	// Dedup by msg_id (Issue #261). The `outbound` guard above only covers messages
	// THIS process sent; after an MCP restart that map is empty, so the hub's
	// replay-on-reconnect pushed a fresh copy of the same terminal response every
	// time — which is what inflated the nudge counts (7 → 8 → 9 …) with no ceiling.
	if (replies.some((rp) => rp.msg_id === mid)) {
		log(`reply dup ignored ${mid}`);
		return;
	}
	const from = data.responder?.name ?? ob?.target ?? "?";
	const r = data.response;
	const text = typeof r === "string" ? r : (r != null ? JSON.stringify(r, null, 2) : "");
	replies.push({ msg_id: mid, from, text, error: data.error ?? null });
	log(`reply += ${from} ${mid}`);
	scheduleNudge();
}

let client = createComsNetClient({
	project, name, model, purpose, provider, cwd, explicit: false,
	getContextPct: currentCtxPct,
	getQueueDepth: () => inbox.filter((m) => !m.answered).length,
	getActivity: () => currentActivity,
	log,
	onPrompt: handleInboundPrompt,
	onResponse: handleOutboundResponse,
});

process.on("SIGINT", () => selfTerminate("SIGINT"));
process.on("SIGTERM", () => selfTerminate("SIGTERM"));
process.on("exit", releaseSingletonLock);

// ━━ Tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// D3b: Permission from registry frontmatter `squad_control: true`, plus the
// PI_SQUAD_ADD_AGENT=1 env escape hatch. No more hardcoded names.
// F1: Also check `.claude/agents/<name>.md` — CC peers live there, not in Pi registry.
function checkSquadControl(): boolean {
	if (process.env.PI_SQUAD_ADD_AGENT === "1") return true;
	// 1. Pi registry .md
	const registryMd = path.join(cwd, ".pi", "agents", "registry", name, `${name}.md`);
	try {
		const text = fs.readFileSync(registryMd, "utf-8");
		const m = text.match(/^---\n([\s\S]*?)\n---/);
		if (m && /^squad_control:\s*true/m.test(m[1])) return true;
	} catch { /* no registry .md — fall through */ }
	// 2. .claude/agents/<name>.md (CC peer identity lives here)
	const ccMd = path.join(cwd, ".claude", "agents", `${name}.md`);
	try {
		const text = fs.readFileSync(ccMd, "utf-8");
		const m = text.match(/^---\n([\s\S]*?)\n---/);
		if (m && /^squad_control:\s*true/m.test(m[1])) return true;
	} catch { /* no CC .md — fall through */ }
	return false;
}
const canControlAgents = checkSquadControl();
const TOOLS = [
	{
		name: "comsnet_list_agents",
		description: "List the other agents currently online on this squad's ComsNet hub (Pi agents and Claude Code peers), with their model and status. Subagent children (purpose tagged [subagent]) are hidden by default and only counted; set include_subagents:true to list them.",
		inputSchema: { type: "object", properties: { include_subagents: { type: "boolean", description: "Also list subagent children (default false)." } } },
	},
	{
		name: "comsnet_send",
		description: "Send a message/task to another agent on the hub by name without blocking. Set wait:true only when this turn must wait for the reply; otherwise you are nudged automatically when it arrives.",
		inputSchema: {
			type: "object",
			properties: {
				target: { type: "string", description: "Peer name (as shown by comsnet_list_agents)." },
				prompt: { type: "string", description: "The message/task to send." },
				wait: { type: "boolean", description: "Wait for the reply (default false)." },
				timeout_ms: { type: "number", description: "Max wait in ms (default 60000)." },
				deadline_ms: { type: "number", description: "Optional response deadline in ms; the hub default applies when omitted." },
			},
			required: ["target", "prompt"],
		},
	},
	{
		name: "comsnet_inbox",
		description: "Read inbound messages other agents have sent to you on the hub. Returns pending (unanswered) prompts with their msg_id; reply with comsnet_respond.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "comsnet_status",
		description: "Set your current activity — ONE plain 繁體中文 line saying what you are ACTUALLY doing right now (e.g. 「正在重構 picker 邏輯」). Call whenever you start or switch tasks. NO internal task IDs (e.g. T-008), NO English jargon — write so a non-technical owner understands at a glance. Keep it short (≤ 40 字).",
		inputSchema: {
			type: "object",
			properties: {
				summary: { type: "string", description: "One-line 繁體中文 activity summary (≤ 40 字)." },
			},
			required: ["summary"],
		},
	},
	{
		name: "comsnet_respond",
		description: "Reply to an inbound message from comsnet_inbox, identified by msg_id.",
		inputSchema: {
			type: "object",
			properties: {
				msg_id: { type: "string", description: "msg_id from comsnet_inbox." },
				response: { type: "string", description: "Your reply text." },
			},
			required: ["msg_id", "response"],
		},
	},
	...(canControlAgents ? [
		{
			name: "comsnet_add_agent",
			description: "Add a new agent pane (codex / cc / cldsp / kimi / opencode / antigravity / Pi registry agent) to this running squad. Available to agents with squad_control: true in their registry .md, or peers equipped with PI_SQUAD_ADD_AGENT=1.",
			inputSchema: {
				type: "object",
				properties: {
					token: { type: "string", description: "Launch token, e.g. codex:reviewer:gpt-5.6-terra or a registry agent name." },
				},
				required: ["token"],
			},
		},
		{
			name: "comsnet_drop_agent",
			description: "Drop one running agent pane by ComsNet name. Available to agents with squad_control: true in their registry .md, or peers equipped with PI_SQUAD_ADD_AGENT=1.",
			inputSchema: {
				type: "object",
				properties: {
					agent: { type: "string", description: "Running agent name from comsnet_list_agents." },
				},
				required: ["agent"],
			},
		},
	] : []),
];

export async function callTool(toolName: string, a: Record<string, any>): Promise<string> {
	if (!client.registered) return "ComsNet hub not connected yet (still registering). Try again in a moment.";
	switch (toolName) {
		case "comsnet_list_agents": {
			const allAgents = (await client.listAgents()).filter((x: any) => x.session_id !== client.sessionId);
			const isSub = (x: any) => typeof x.purpose === "string" && x.purpose.startsWith("[subagent]");
			const agents = a.include_subagents === true ? allAgents : allAgents.filter((x: any) => !isSub(x));
			const hiddenSub = allAgents.length - agents.length;
			if (!agents.length) return hiddenSub ? `No other agents online on the hub. (+${hiddenSub} subagent hidden)` : "No other agents online on the hub.";
			// `purpose` distinguishes a 24/7 daemon (its registry frontmatter `description`,
			// e.g. "喵記 — Nova 貓咪的專屬管家...") from a disposable squad copy of the same
			// agent name (always the literal "Squad peer" — set by `just pi-peer`'s
			// `--purpose "Squad peer"`, overriding the frontmatter description). Issue #316
			// P0-7: surface the existing field rather than inventing a new marker.
			return agents.map((x: any) => {
				const act = x.activity ? ` — ${x.activity}` : "";
				const purpose = x.purpose ? ` · ${x.purpose}` : "";
				return `• ${x.name} (${x.model ?? "?"}) — ${x.status ?? "?"}${act}${purpose}`;
			}).join("\n") + (hiddenSub ? `\n(+${hiddenSub} subagent hidden${hiddenSub > 3 ? " ⚠️ 數量偏多" : ""}; include_subagents:true to list)` : "");
		}
		case "comsnet_send": {
			const wait = a.wait === true;
			// M1.2 memory-aware envelope: attach a recall digest to task briefs so the
			// worker gets relevant memory without recall capability (fail-closed).
			let outPrompt = a.prompt;
			try { outPrompt = enrichDispatchPrompt(a.prompt, a.target); } catch { /* send unmodified */ }
			const { msgId } = await client.send(a.target, outPrompt, {
				deadlineMs: typeof a.deadline_ms === "number" ? a.deadline_ms : null,
			});
			// Track every outbound so a late `response` SSE event re-nudges us instead
			// of being lost (Issue 2). "awaiting" until either the blocking await below
			// returns the reply inline ("consumed") or the SSE handler surfaces it.
			outbound.set(msgId, { target: a.target, state: "awaiting" });
			if (!wait) return `Sent to ${a.target} (msg_id=${msgId}). You will be nudged automatically when they reply — no need to poll.`;
			const timeout = Number(a.timeout_ms ?? 120_000);
			const res = await client.awaitReply(msgId, timeout);
			// On a long-poll timeout the message is still live on the hub: keep the
			// outbound "awaiting" so the eventual reply re-nudges this pane. Do NOT
			// present the empty/timeout payload as if the peer answered.
			if (res?.status === "timeout") {
				return `Sent to ${a.target} (msg_id=${msgId}). No reply within ${Math.round(timeout / 1000)}s — they're likely still working. You'll be nudged automatically when their reply arrives; no need to re-send or poll.`;
			}
			const ob = outbound.get(msgId);
			if (ob) ob.state = "consumed";
			// The `response` SSE event can race the long-poll return and buffer a copy
			// before we mark consumed — purge it so it isn't ALSO shown by comsnet_inbox.
			for (let i = replies.length - 1; i >= 0; i--) {
				if (replies[i].msg_id === msgId) replies.splice(i, 1);
			}
			if (res?.error) {
				void client.completionAck(msgId);
				return `${a.target} error: ${res.error}`;
			}
			void client.completionAck(msgId);
			const r = res?.response;
			return `${a.target} replied:\n${typeof r === "string" ? r : JSON.stringify(r, null, 2)}`;
		}
		case "comsnet_inbox": {
			// Merge the in-memory SSE buffer with an authoritative hub pull by name.
			// The pull recovers messages delivered to a previous MCP instance (e.g.
			// codex re-spawning its MCP server drops the in-memory buffer) — the hub
			// keeps them as unanswered until comsnet_respond, keyed by agent NAME.
			// Issue #327: a failed pull used to be swallowed here (logged to stderr
			// only, which most MCP hosts — codex included — never retain), then fall
			// straight through to "Inbox empty" if the local buffer happened to have
			// nothing yet. That made a transient hub/network failure indistinguishable
			// from a genuinely empty inbox — the hub is the source of truth and its
			// unreachability must never be reported as "nothing pending".
			const pullErrors: string[] = [];
			for (const pullName of [...new Set([client.assignedName, name])]) {
				try {
					await pullInboxForName(pullName);
				} catch (err: any) {
					const msg = err?.message ?? String(err);
					log(`inbox pull ${pullName}: ${msg}`);
					pullErrors.push(`${pullName}: ${msg}`);
				}
			}
			const pending = inbox.filter((m) => !m.answered);
			await Promise.all(pending.map((m) => client.progress(m.msg_id)));
			const sections: string[] = [];
			if (pullErrors.length) {
				sections.push(
					`⚠ Hub pull failed (${pullErrors.join("; ")}) — this list may be missing pending ` +
					`messages the hub actually has. Do NOT treat an otherwise-empty result as confirmed ` +
					`empty; retry comsnet_inbox shortly.`,
				);
			}
			// Replies to OUR earlier comsnet_send calls that arrived after the blocking
			// window. These need NO comsnet_respond — they are answers to read. Shown
			// once, then cleared.
			if (replies.length) {
				const shown = [...replies];
				const acked = await Promise.all(shown.map((rp) => client.completionAck(rp.msg_id)));
				sections.push(shown.map((rp) =>
					rp.error
						? `↩ REPLY from ${rp.from} (to your msg ${rp.msg_id}) — ERROR: ${rp.error}`
						: `↩ REPLY from ${rp.from} (to your msg ${rp.msg_id}):\n  ${rp.text}`,
				).join("\n\n"));
				// Drop only what the hub confirmed consumed (Issue #261). An unacked reply
				// stays buffered so the next drain retries the ack — but it is marked shown
				// so it stops driving nudges, which is what made the loop unbreakable:
				// the agent was told to read an inbox that reported itself empty.
				const ackedIds = new Set(shown.filter((_, i) => acked[i]).map((rp) => rp.msg_id));
				for (let i = replies.length - 1; i >= 0; i--) {
					const rp = replies[i];
					if (ackedIds.has(rp.msg_id)) {
						replies.splice(i, 1);
						dropNudgeCount(rp.msg_id);
					} else {
						rp.shown = true;
						dropNudgeCount(rp.msg_id);
					}
				}
			}
			if (pending.length) {
				sections.push(pending.map((m) => {
					const addressed = m.addressed_to && m.addressed_to !== client.assignedName ? ` → ${m.addressed_to}` : "";
					return `[${m.msg_id}] from ${m.sender}${addressed} @ ${m.received_at}\n  ${m.prompt}`;
				}).join("\n\n"));
			}
			if (!sections.length) return "Inbox empty (no pending messages or replies).";
			return sections.join("\n\n");
		}
		case "comsnet_status": {
			currentActivity = String(a.summary ?? "").trim();
			// Push immediately so teammates see it without waiting for the next heartbeat.
			await client.heartbeatNow();
			return currentActivity ? `Status set: ${currentActivity}` : "Status cleared.";
		}
		case "comsnet_respond": {
			const item = inbox.find((m) => m.msg_id === a.msg_id);
			await client.respond(a.msg_id, a.response);
			if (item) {
				item.answered = true;
				dropNudgeCount(a.msg_id);
			}
			return `Replied to ${item?.sender ?? a.msg_id}.`;
		}
		case "comsnet_add_agent":
		case "comsnet_drop_agent": {
			if (!canControlAgents) {
				throw new Error("agent control is not enabled for this peer (needs squad_control: true in registry .md or PI_SQUAD_ADD_AGENT=1)");
			}
			const action = toolName === "comsnet_add_agent" ? "add" : "drop";
			const value = String(action === "add" ? a.token ?? "" : a.agent ?? "").trim();
			if (!value) throw new Error(`${action} requires a target`);
			const helperScript = path.join(cwd, "scripts", "squad-add-peer.ts");
			const argv = ["bun", helperScript, "--session", project, "--repo", cwd, "--token", value];
			if (action === "drop") argv.push("--drop");
			try {
				const output = execFileSync(
					argv[0], argv.slice(1),
					{ cwd, encoding: "utf-8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] },
				);
				return output.trim();
			} catch (error: any) {
				const detail = error?.stderr?.toString().trim() || error?.message || String(error);
				throw new Error(`${action} failed: ${detail}`);
			}
		}
		default:
			throw new Error(`unknown tool: ${toolName}`);
	}
}

// ━━ JSON-RPC stdio loop ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function send(msg: unknown): void {
	process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handle(msg: any): Promise<void> {
	const { id, method, params } = msg;
	const reply = (result: unknown) => send({ jsonrpc: "2.0", id, result });
	const fail = (code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });

	try {
		switch (method) {
			case "initialize":
				return reply({
					protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: "comsnet", version: "1.0.0" },
				});
			case "notifications/initialized":
			case "notifications/cancelled":
				return; // notifications: no response
			case "ping":
				return reply({});
			case "tools/list":
				return reply({ tools: TOOLS });
			case "tools/call": {
				const text = await callTool(params.name, params.arguments ?? {});
				return reply({ content: [{ type: "text", text }] });
			}
			default:
				if (id !== undefined) return fail(-32601, `method not found: ${method}`);
				return;
		}
	} catch (err: any) {
		if (id !== undefined) {
			// Tool errors surface as content with isError so the model can react.
			if (method === "tools/call") return reply({ content: [{ type: "text", text: `Error: ${err?.message ?? err}` }], isError: true });
			return fail(-32603, err?.message ?? String(err));
		}
	}
}

async function main(): Promise<void> {
	claimSingletonLock();
	startParentWatchdog();
	void client.connect().catch((err) => log(`connect: ${err?.message ?? err}`));
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of process.stdin) {
		buffer += decoder.decode(chunk as Uint8Array, { stream: true });
		let nl = buffer.indexOf("\n");
		while (nl >= 0) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (line) { try { await handle(JSON.parse(line)); } catch (err) { log(`parse: ${err}`); } }
			nl = buffer.indexOf("\n");
		}
	}
	// stdin EOF is the stdio-MCP shutdown signal. Exit explicitly rather than
	// falling off the end of main(): connectLoop/heartbeatLoop retry forever and
	// would otherwise keep the process (and its nudges) alive (Issue #261).
	selfTerminate("stdin closed");
}

// Only run when this file is the entry point (not when imported by tests).
if (import.meta.main) void main();
