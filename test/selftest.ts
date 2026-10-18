#!/usr/bin/env bun
/**
 * ComsNet end-to-end self-test.
 *
 * Drives the REAL hub (scripts/coms-net-server.ts) and the REAL Claude-Code MCP
 * peer (scripts/comsnet-mcp.ts) over JSON-RPC stdio, exercising the two failure
 * modes the squad kept hitting:
 *
 *   1. default non-blocking — sender's comsnet_send returns immediately; a late
 *                    peer reply MUST reach the sender via comsnet_inbox.
 *   2. explicit wait — wait:true preserves the synchronous reply behaviour.
 *
 * No tmux, no real models — the "peer" is simulated via direct hub HTTP so the
 * test is deterministic and CI-able. Run: `bun scripts/comsnet-selftest.ts`.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO = path.resolve(import.meta.dir, "..");
const PROJECT = `comsnet-selftest-${process.pid}`;
const PROJ_DIR = path.join(os.homedir(), ".pi", "coms-net", "projects", PROJECT);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
	console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
}
// Issue #351: teardown hygiene. selftest used to SIGTERM children and remove
// PROJ_DIR after a fixed 300ms sleep without confirming the child actually
// exited — a slow hub/MCP could outlive the parent (bun does not auto-kill
// spawned children), leaving a stale discovery dir + orphan process behind.
// Next runs could then race against stale state / accumulate processes until
// something intermittently times out. We now wait (bounded, SIGKILL fallback)
// for every child to exit before touching its state directory.
const spawnedChildren: ChildProcessWithoutNullStreams[] = [];

async function terminateGracefully(child: ChildProcessWithoutNullStreams | null, label: string): Promise<void> {
	if (!child) return;
	if (child.exitCode != null || child.signalCode != null) return;
	const exited = new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
		const killer = setTimeout(() => {
			try { child.kill("SIGKILL"); } catch { /* ignore */ }
		}, 1_500);
		try { (killer as any).unref?.(); } catch { /* ignore */ }
	});
	try { child.kill("SIGTERM"); } catch { /* ignore */ }
	await exited;
}

async function stopAllChildren(): Promise<void> {
	// Newest first (MCP children before the hub server).
	for (let i = spawnedChildren.length - 1; i >= 0; i--) {
		await terminateGracefully(spawnedChildren[i], `child-${i}`);
	}
	spawnedChildren.length = 0;
}

// ── Minimal JSON-RPC stdio client for the MCP child ─────────────────────────
class McpClient {
	private child: ChildProcessWithoutNullStreams;
	private nextId = 1;
	private pending = new Map<number, (v: any) => void>();
	private buf = "";

	constructor(args: string[]) {
		this.child = spawn("bun", [path.join(REPO, "scripts", "comsnet-mcp.ts"), ...args], {
			stdio: ["pipe", "pipe", "inherit"],
			env: { ...process.env },
		}) as ChildProcessWithoutNullStreams;
		spawnedChildren.push(this.child);
		this.child.stdout.on("data", (c) => {
			this.buf += c.toString();
			let nl: number;
			while ((nl = this.buf.indexOf("\n")) >= 0) {
				const line = this.buf.slice(0, nl).trim();
				this.buf = this.buf.slice(nl + 1);
				if (!line) continue;
				try {
					const msg = JSON.parse(line);
					if (msg.id != null && this.pending.has(msg.id)) {
						this.pending.get(msg.id)!(msg);
						this.pending.delete(msg.id);
					}
				} catch { /* non-JSON line */ }
			}
		});
	}

	rpc(method: string, params?: any): Promise<any> {
		const id = this.nextId++;
		return new Promise((resolve) => {
			this.pending.set(id, resolve);
			this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
		});
	}

	async callTool(name: string, args: Record<string, any> = {}): Promise<string> {
		const res = await this.rpc("tools/call", { name, arguments: args });
		return res?.result?.content?.[0]?.text ?? `<no text: ${JSON.stringify(res)}>`;
	}

	kill(): void { try { this.child.kill("SIGTERM"); } catch { /* ignore */ } }

	async stop(): Promise<void> {
		await terminateGracefully(this.child, "mcp");
	}
}

async function main(): Promise<void> {
	// 1. Boot the hub on an ephemeral port scoped to a throwaway project.
	const testServerEnv = {
		...process.env,
		PI_COMS_NET_PROJECT: PROJECT,
		PI_COMS_NET_LOG_QUIET: "1",
		PI_COMS_NET_HEARTBEAT_MS: "100",
		PI_COMS_NET_STALE_AFTER_MS: "1000",
		PI_COMS_NET_OFFLINE_AFTER_MS: "2000",
		PI_COMS_NET_STALE_SCAN_INTERVAL_MS: "50",
		PI_COMS_NET_TTL_SCAN_INTERVAL_MS: "50",
	};
	// Issue #351: purge any stale discovery/state left by a crashed previous run
	// of this exact project before the new hub writes fresh files — a stale
	// server.json pointing at a dead port used to race the MCP child connect.
	try { fs.rmSync(PROJ_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
	// Issue #351: purge stale discovery/state from a crashed previous run of this
	// exact project before the new hub writes fresh files.
	try { fs.rmSync(PROJ_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
	let server = spawn("bun", [path.join(REPO, "scripts", "coms-net-server.ts")], {
		stdio: ["ignore", "ignore", "inherit"],
		env: testServerEnv,
	});
	spawnedChildren.push(server);
	spawnedChildren.push(server);

	let serverUrl = "", token = "";
	const waitForHubFiles = async () => {
		for (let i = 0; i < 60; i++) {
			try {
				const sj = JSON.parse(fs.readFileSync(path.join(PROJ_DIR, "server.json"), "utf-8"));
				const ss = JSON.parse(fs.readFileSync(path.join(PROJ_DIR, "server.secret.json"), "utf-8"));
				if (sj.local_url && ss.token) {
					serverUrl = sj.local_url.replace(/\/+$/, "");
					token = ss.token;
					return true;
				}
			} catch { /* not ready */ }
			await sleep(250);
		}
		return false;
	};
	const startHub = async () => {
		server = spawn("bun", [path.join(REPO, "scripts", "coms-net-server.ts")], {
			stdio: ["ignore", "ignore", "inherit"],
			env: testServerEnv,
		});
		spawnedChildren.push(server);
		return waitForHubFiles();
	};
	for (let i = 0; i < 60; i++) {
		try {
			const sj = JSON.parse(fs.readFileSync(path.join(PROJ_DIR, "server.json"), "utf-8"));
			const ss = JSON.parse(fs.readFileSync(path.join(PROJ_DIR, "server.secret.json"), "utf-8"));
			if (sj.local_url && ss.token) { serverUrl = sj.local_url.replace(/\/+$/, ""); token = ss.token; break; }
		} catch { /* not ready */ }
		await sleep(250);
	}
	check("hub started", !!serverUrl && !!token, serverUrl);
	if (!serverUrl) {
		await stopAllChildren();
		try { fs.rmSync(PROJ_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
		process.exit(1);
	}

	const hub = (method: string, p: string, body?: any) =>
		fetch(serverUrl + p, {
			method,
			headers: { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}).then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json().catch(() => null) }));

	// 2. Register a simulated peer "carrie" directly on the hub.
	const peerSession = `peer-${Date.now()}`;
	await hub("POST", "/v1/agents/register", {
		project: PROJECT, session_id: peerSession, name: "carrie",
		purpose: "test peer", model: "sonnet", provider: "claude-code", color: "#36F9F6", cwd: REPO, explicit: false,
	});
	check("peer registered", true);

	// 3. Start the MCP sender peer and wait until it has registered on the hub.
	const mcp = new McpClient(["--project", PROJECT, "--name", "sender", "--model", "sonnet", "--provider", "claude-code", "--cwd", REPO]);
	await mcp.rpc("initialize", { protocolVersion: "2025-06-18" });
	let connected = false;
	for (let i = 0; i < 40; i++) {
		const list = await mcp.callTool("comsnet_list_agents");
		if (!list.includes("not connected")) { connected = true; break; }
		await sleep(250);
	}
	check("MCP sender connected to hub", connected);
	const agents = await hub("GET", `/v1/agents?project=${PROJECT}&include_explicit=true`);
	const senderSession = (agents.json?.agents ?? []).find((a: any) => a.name === "sender")?.session_id ?? "";
	check("MCP sender session resolved", !!senderSession, senderSession);

	// ── Test 1: INBOUND AUTO-ACK + WORKING ON INBOX READ ─────────────────────
	const inboundSend = await hub("POST", "/v1/messages", {
		project: PROJECT, sender_session: peerSession, target: "sender", target_session: null,
		prompt: "inbound-lifecycle", conversation_id: null, response_schema: null, hops: 0,
	});
	const inboundId = inboundSend.json?.msg_id ?? "";
	check("inbound: prompt accepted", inboundSend.ok && !!inboundId, inboundId);
	await sleep(200);
	const inboundInbox = await mcp.callTool("comsnet_inbox");
	check("inbound: prompt surfaced", inboundInbox.includes("inbound-lifecycle"), inboundInbox.split("\n")[0]);
	const inboundState = await hub("GET", `/v1/messages/${inboundId}`);
	check("inbound: adapter ack/progress reaches working", inboundState.json?.status === "working", inboundState.json?.status ?? "none");
	await mcp.callTool("comsnet_respond", { msg_id: inboundId, response: "inbound-complete" });

	// ── Test 2: DEFAULT NON-BLOCKING + LATE REPLY ──────────────────────────────
	// No wait field: send returns immediately, then a later response is surfaced.
	const sendOut = await mcp.callTool("comsnet_send", { target: "carrie", prompt: "ping-late" });
	const m = sendOut.match(/msg_id=([0-9A-Z]+)/);
	const msgId = m?.[1] ?? "";
	check("default: send is non-blocking",
		/^Sent to carrie/.test(sendOut) && !/replied:/.test(sendOut), sendOut.split("\n")[0]);
	check("default: msg_id captured", !!msgId, msgId);

	// Peer replies AFTER the await window.
	await sleep(300);
	const respRes = await hub("POST", `/v1/messages/${msgId}/response`, {
		project: PROJECT, responder_session: peerSession, response: "pong-late-answer", error: null,
	});
	check("default: late peer response accepted by hub", respRes.ok, `status ${respRes.status}`);

	// Give the SSE `response` event time to reach the MCP and buffer.
	await sleep(1500);
	const inbox1 = await mcp.callTool("comsnet_inbox");
	check("default: late reply surfaced to sender via comsnet_inbox",
		inbox1.includes("pong-late-answer") && /REPLY from carrie/i.test(inbox1),
		inbox1.replace(/\n/g, " ⏎ ").slice(0, 120));
	// Buffer must clear after reading.
	const inbox2 = await mcp.callTool("comsnet_inbox");
	check("default: reply buffer cleared after read", !inbox2.includes("pong-late-answer"));

	// ── Test 2: SERVER DEADLINE terminalizes a deferred target ────────────────
	const deadlineOut = await mcp.callTool("comsnet_send", {
		target: "never-online", prompt: "deadline", deadline_ms: 1_000,
	});
	const deadlineId = deadlineOut.match(/msg_id=([0-9A-Z]+)/)?.[1] ?? "";
	check("deadline: deferred send accepted", !!deadlineId, deadlineOut.split("\n")[0]);
	await sleep(1_300);
	const deadlineInbox = await mcp.callTool("comsnet_inbox");
	check("deadline: sender receives one timeout completion",
		deadlineInbox.includes(deadlineId) && deadlineInbox.includes("deadline_exceeded"),
		deadlineInbox.replace(/\n/g, " ⏎ ").slice(0, 160));

	// ── Test 3: TARGET STALE terminalizes instead of leaving sender pending ───
	const doomedSession = `doomed-${Date.now()}`;
	await hub("POST", "/v1/agents/register", {
		project: PROJECT, session_id: doomedSession, name: "doomed",
		purpose: "stale peer", model: "sonnet", provider: "claude-code", color: "#36F9F6", cwd: REPO, explicit: false,
	});
	const staleOut = await mcp.callTool("comsnet_send", { target: "doomed", prompt: "stale-target", deadline_ms: 5_000 });
	const staleId = staleOut.match(/msg_id=([0-9A-Z]+)/)?.[1] ?? "";
	check("stale: send accepted", !!staleId, staleOut.split("\n")[0]);
	await sleep(2_300);
	const staleInbox = await mcp.callTool("comsnet_inbox");
	check("stale: sender receives target-offline completion",
		staleInbox.includes(staleId) && staleInbox.includes("target_offline"),
		staleInbox.replace(/\n/g, " ⏎ ").slice(0, 160));
	await hub("POST", "/v1/agents/register", {
		project: PROJECT, session_id: peerSession, name: "carrie",
		purpose: "test peer reconnected", model: "sonnet", provider: "claude-code", color: "#36F9F6", cwd: REPO, explicit: false,
	});

	// ── Test 4: EXPLICIT WAIT (reply inside the await window) ─────────────────
	// Fire comsnet_send with wait:true, answer immediately, then
	// read the send result — it should contain the reply inline.
	const sendP = mcp.callTool("comsnet_send", { target: "carrie", prompt: "ping-fast", wait: true, timeout_ms: 15000 });
	await sleep(400);
	const open = await hub("GET", `/v1/agents?project=${PROJECT}&include_explicit=true`);
	void open;
	// Find the queued msg_id for ping-fast via the hub inbox-by-name.
	const pend = await hub("GET", `/v1/inbox?project=${PROJECT}&name=carrie`);
	const fastMsg = (pend.json?.messages ?? []).find((x: any) => x.prompt === "ping-fast");
	check("fast: hub shows queued prompt for peer", !!fastMsg, fastMsg?.msg_id ?? "none");
	if (fastMsg) {
		await hub("POST", `/v1/messages/${fastMsg.msg_id}/response`, {
			project: PROJECT, responder_session: peerSession, response: "pong-fast-answer", error: null,
		});
	}
	const sendResult = await sendP;
	check("explicit wait: reply returned inline by comsnet_send",
		sendResult.includes("pong-fast-answer") && /replied:/.test(sendResult),
		sendResult.replace(/\n/g, " ⏎ ").slice(0, 120));
	// The inline-consumed reply must NOT also show up in comsnet_inbox.
	await sleep(800);
	const inbox3 = await mcp.callTool("comsnet_inbox");
	check("explicit wait: inline reply not double-surfaced in inbox", !inbox3.includes("pong-fast-answer"));

	// ── Test 5: HUB COLD RESTART DURABILITY ─────────────────────────────────
	// Create durable pending work immediately before stopping the hub. The first
	// target completes after restart; the second must be deadline-terminalized by
	// the new hub's scanner. Neither target has an active stream before restart.
	const durableOut = await mcp.callTool("comsnet_send", {
		target: "durable-target", prompt: "durable-after-hub-restart", deadline_ms: 5_000,
	});
	const durableId = durableOut.match(/msg_id=([0-9A-Z]+)/)?.[1] ?? "";
	check("durable restart: pending send accepted", !!durableId, durableOut.split("\n")[0]);
	const durableDeadlineOut = await mcp.callTool("comsnet_send", {
		target: "durable-deadline", prompt: "durable-deadline-after-hub-restart", deadline_ms: 1_000,
	});
	const durableDeadlineId = durableDeadlineOut.match(/msg_id=([0-9A-Z]+)/)?.[1] ?? "";
	check("durable restart: deadline send accepted", !!durableDeadlineId, durableDeadlineOut.split("\n")[0]);

	await terminateGracefully(server, "hub-restart");
	try { fs.rmSync(path.join(PROJ_DIR, "server.json"), { force: true }); } catch { /* ignore */ }
	try { fs.rmSync(path.join(PROJ_DIR, "server.secret.json"), { force: true }); } catch { /* ignore */ }
	const restarted = await startHub();
		check("restart: hub restarted", restarted, serverUrl);
		const peerSession2 = `peer-restart-${Date.now()}`;
		await hub("POST", "/v1/agents/register", {
			project: PROJECT, session_id: peerSession2, name: "carrie",
			purpose: "test peer after restart", model: "sonnet", provider: "claude-code",
			color: "#36F9F6", cwd: REPO, explicit: false,
		});
		let reconnected = false;
		for (let i = 0; i < 50; i++) {
			const list = await mcp.callTool("comsnet_list_agents");
			if (list.includes("carrie") && !list.includes("not connected")) { reconnected = true; break; }
			await sleep(300);
		}
		check("restart: MCP re-registered on new hub", reconnected);
		const durableTargetSession = `durable-target-${Date.now()}`;
		await hub("POST", "/v1/agents/register", {
			project: PROJECT, session_id: durableTargetSession, name: "durable-target",
			purpose: "durable restart target", model: "sonnet", provider: "claude-code",
			color: "#36F9F6", cwd: REPO, explicit: false,
		});
		const durablePending = await hub("GET", `/v1/inbox?project=${PROJECT}&name=durable-target`);
		const durableMsg = (durablePending.json?.messages ?? []).find(
			(x: any) => x.msg_id === durableId && x.prompt === "durable-after-hub-restart",
		);
		check("durable restart: target reattached pending prompt", !!durableMsg, durableMsg?.msg_id ?? "none");
		const durableResponse = durableMsg
			? await hub("POST", `/v1/messages/${durableId}/response`, {
				project: PROJECT, responder_session: durableTargetSession,
				response: "pong-durable-after-restart", error: null,
			})
			: { ok: false, status: 0 };
		check("durable restart: reattached target completes", durableResponse.ok, `status ${durableResponse.status}`);
		await sleep(1_300);
		const durableInbox = await mcp.callTool("comsnet_inbox");
		check("durable restart: sender receives recovered completion once",
			durableInbox.includes(durableId) && durableInbox.includes("pong-durable-after-restart"),
			durableInbox.replace(/\n/g, " ⏎ ").slice(0, 180));
		check("durable restart: new hub resumes deadline scanner",
			durableInbox.includes(durableDeadlineId) && durableInbox.includes("deadline_exceeded"),
			durableInbox.replace(/\n/g, " ⏎ ").slice(0, 180));
		// Issue #351: carrie is a plain HTTP peer with NO heartbeat; the hub's fast
		// stale scan (1s/2s) drops it shortly after each registration, so the other
		// blocks re-register right before use. This block must too — and the reply
		// must come from THAT fresh session (peerSession2 is already offline here).
		const readySession = `peer-restart-ready-${Date.now()}`;
		await hub("POST", "/v1/agents/register", {
			project: PROJECT, session_id: readySession, name: "carrie",
			purpose: "restart inline peer", model: "sonnet", provider: "claude-code",
			color: "#36F9F6", cwd: REPO, explicit: false,
		});
		const restartSend = mcp.callTool("comsnet_send", { target: "carrie", prompt: "ping-restart", wait: true, timeout_ms: 15000 });
		await sleep(500);
		const pend2 = await hub("GET", `/v1/inbox?project=${PROJECT}&name=carrie`);
		const restartMsg = (pend2.json?.messages ?? []).find((x: any) => x.prompt === "ping-restart");
		check("restart: new hub received prompt", !!restartMsg, restartMsg?.msg_id ?? "none");
		if (restartMsg) {
			await hub("POST", `/v1/messages/${restartMsg.msg_id}/response`, {
				project: PROJECT, responder_session: readySession, response: "pong-restart-answer", error: null,
			});
		}
		const restartResult = await restartSend;
		check("restart: reply returned after reconnect",
			restartResult.includes("pong-restart-answer"),
			restartResult.replace(/\n/g, " ⏎ ").slice(0, 120));
		await sleep(150); // allow the sender adapter to persist its completion acknowledgement

		// ── Test 6: SENDER RESTART BEFORE A LATE REPLY ──────────────────────────
		await hub("POST", "/v1/agents/register", {
			project: PROJECT, session_id: peerSession2, name: "carrie",
			purpose: "recovery peer", model: "sonnet", provider: "claude-code", color: "#36F9F6", cwd: REPO, explicit: false,
		});
		const recoveryOut = await mcp.callTool("comsnet_send", { target: "carrie", prompt: "sender-restart" });
		const recoveryId = recoveryOut.match(/msg_id=([0-9A-Z]+)/)?.[1] ?? "";
		check("sender restart: send accepted", !!recoveryId, recoveryOut.split("\n")[0]);
		await mcp.stop();
		await sleep(100);
		const recoveryResponse = await hub("POST", `/v1/messages/${recoveryId}/response`, {
			project: PROJECT, responder_session: peerSession2, response: "pong-after-sender-restart", error: null,
		});
		check("sender restart: late response accepted", recoveryResponse.ok, `status ${recoveryResponse.status}`);
		const recoveredMcp = new McpClient(["--project", PROJECT, "--name", "sender", "--model", "sonnet", "--provider", "claude-code", "--cwd", REPO]);
		await recoveredMcp.rpc("initialize", { protocolVersion: "2025-06-18" });
		let recovered = false;
		let recoveredOutput = "";
		for (let i = 0; i < 30; i++) {
			const recoveredInbox = await recoveredMcp.callTool("comsnet_inbox");
			if (recoveredInbox.includes("pong-after-sender-restart")) {
				recovered = true;
				recoveredOutput = recoveredInbox;
				break;
			}
			await sleep(100);
		}
		check("sender restart: terminal reply recovered once", recovered);
		check("sender restart: acknowledged completion is not replayed", !recoveredOutput.includes("pong-restart-answer"));
		await sleep(150);
		const recoveredInboxAgain = await recoveredMcp.callTool("comsnet_inbox");
		check("sender restart: duplicate completion is not replayed",
			!recoveredInboxAgain.includes("pong-after-sender-restart"),
			recoveredInboxAgain.replace(/\n/g, " ⏎ ").slice(0, 120));

		// ── Teardown ───────────────────────────────────────────────────────────────
		// Issue #351: wait for every child to really exit (bounded, SIGKILL
		// fallback) before removing the state dir — a SIGTERM followed by a fixed
		// 300ms sleep let slow hubs/MCPs outlive the parent and accumulate.
		await recoveredMcp.stop();
		await stopAllChildren();
		await sleep(200);
		try { fs.rmSync(PROJ_DIR, { recursive: true, force: true }); } catch { /* ignore */ }

	console.log(`\n${failures === 0 ? "🎉 ALL PASS" : `💥 ${failures} FAILURE(S)`}`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
