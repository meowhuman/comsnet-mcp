/**
 * coms-net-server.ts — orphaned-outcome escalation (D2).
 *
 * Prior behaviour: a terminal outcome that a sender never completion-acked got
 * replayed up to MAX_COMPLETION_REPLAYS times, then was silently marked
 * `completion_consumed_at` — the result was gone forever even though the sender
 * never actually saw it (comment in the old code: "the outcome is lost to that
 * sender"). This test drives the REAL hub as a subprocess (no mocks — S-010) and
 * proves the new behaviour instead:
 *
 *   1. Replay attempts are paced by PI_COMS_NET_COMPLETION_REPLAY_BACKOFF_MS —
 *      a reconnect immediately after a replay is skipped; one after the backoff
 *      window elapses gets the outcome.
 *   2. Hitting MAX_COMPLETION_REPLAYS marks the message `orphaned_at`, NOT
 *      `completion_consumed_at` — the result stays in the store.
 *   3. A genuine reconnect after orphaning recovers it — the sender gets the
 *      outcome, proving orphaned is a flag, not a dead end.
 *   4. The Discord escalation fires exactly once per orphan episode (no spam),
 *      verified against a stub script (PI_COMS_NET_DISCORD_EMIT_SH) so the test
 *      never touches the real webhook.
 *
 * Scenario: "responder 覆咗但 sender 死咗" — B answers while A has no live
 * stream at all (A never even connected once), matching the real failure mode.
 * A then "restarts" (new session_id, same name) repeatedly, exercising the
 * hub's re-register replay-reset path exactly as a real MCP restart would.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO = path.resolve(import.meta.dir, "..");
const PROJECT = `coms-net-orphan-test-${process.pid}`;
const PROJ_DIR = path.join(os.homedir(), ".pi", "coms-net", "projects", PROJECT);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fast, deterministic backoff ladder for the test: 150ms then 300ms (default prod
// ladder is 5s/15s/45s/120s/300s — see PI_COMS_NET_COMPLETION_REPLAY_BACKOFF_MS).
const BACKOFF = [150, 300];
const MAX_REPLAYS = 2;

const DISCORD_STUB_LOG = path.join(os.tmpdir(), `coms-net-orphan-discord-${process.pid}.log`);
const DISCORD_STUB_SH = path.join(os.tmpdir(), `coms-net-orphan-discord-stub-${process.pid}.sh`);
const CALL_MARKER = "===DISCORD-STUB-CALL===";
fs.writeFileSync(
	DISCORD_STUB_SH,
	`#!/usr/bin/env bash\n# test stub — records one call (marker + full args, incl. newlines) instead of posting to Discord\necho "${CALL_MARKER}" >> "${DISCORD_STUB_LOG}"\nprintf '%s\\n' "$@" >> "${DISCORD_STUB_LOG}"\n`,
);
fs.chmodSync(DISCORD_STUB_SH, 0o755);

let server: ChildProcessWithoutNullStreams;
let serverLog = "";
let serverUrl = "";
let token = "";

async function waitForHubFiles(): Promise<boolean> {
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
		await sleep(150);
	}
	return false;
}

beforeAll(async () => {
	// Public cut ships the bridge only: this suite needs a hub checkout (scripts/coms-net-server.ts).
	if (process.env.COMSNET_E2E !== "1") return;
	fs.rmSync(PROJ_DIR, { recursive: true, force: true });
	server = spawn("bun", [path.join(REPO, "scripts", "coms-net-server.ts")], {
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			PI_COMS_NET_PROJECT: PROJECT,
			PI_COMS_NET_MAX_COMPLETION_REPLAYS: String(MAX_REPLAYS),
			PI_COMS_NET_COMPLETION_REPLAY_BACKOFF_MS: BACKOFF.join(","),
			PI_COMS_NET_DISCORD_EMIT_SH: DISCORD_STUB_SH,
			PI_COMS_NET_ORPHAN_WEBHOOK_ENV: "DISCORD_TEST_WEBHOOK_URL_UNUSED",
			PI_COMS_NET_STALE_AFTER_MS: "60000",
			PI_COMS_NET_OFFLINE_AFTER_MS: "120000",
		},
	}) as ChildProcessWithoutNullStreams;
	server.stdout.on("data", (c) => { serverLog += c.toString(); });
	server.stderr.on("data", (c) => { serverLog += c.toString(); });
	const ok = await waitForHubFiles();
	expect(ok).toBe(true);
});

afterAll(async () => {
	try { server.kill("SIGTERM"); } catch { /* ignore */ }
	await sleep(300);
	fs.rmSync(PROJ_DIR, { recursive: true, force: true });
	fs.rmSync(DISCORD_STUB_SH, { force: true });
	fs.rmSync(DISCORD_STUB_LOG, { force: true });
});

const hub = (method: string, p: string, body?: any) =>
	fetch(serverUrl + p, {
		method,
		headers: { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	}).then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json().catch(() => null) }));

async function register(sessionId: string, name: string) {
	return hub("POST", "/v1/agents/register", {
		project: PROJECT, session_id: sessionId, name,
		purpose: "orphan-test", model: "test-model", provider: "test", color: "#888888", cwd: REPO, explicit: false,
	});
}

/** Open one SSE connection, read for `readMs`, then disconnect (simulates one
 * reconnect cycle of a peer that reads whatever arrives and then dies again). */
async function openSseOnce(sessionId: string, readMs: number): Promise<string> {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), readMs);
	let text = "";
	try {
		const resp = await fetch(
			`${serverUrl}/v1/events?project=${encodeURIComponent(PROJECT)}&session_id=${encodeURIComponent(sessionId)}`,
			{ headers: { authorization: `Bearer ${token}` }, signal: ac.signal },
		);
		const reader = resp.body!.getReader();
		const dec = new TextDecoder();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			text += dec.decode(value, { stream: true });
		}
	} catch { /* abort fires this — expected end of the read window */ }
	finally { clearTimeout(timer); }
	return text;
}

/** One entry per discord-emit.sh invocation (split on CALL_MARKER, not "\n" — the
 * orphan message itself is multi-line). */
function readDiscordStubCalls(): string[] {
	try {
		return fs.readFileSync(DISCORD_STUB_LOG, "utf-8")
			.split(CALL_MARKER)
			.map((s) => s.trim())
			.filter(Boolean);
	} catch { return []; }
}

test.skipIf(!(process.env.COMSNET_E2E === "1"))("orphan escalation: paced replay, cap → orphaned (not consumed), reconnect recovers, Discord fires once", async () => {
	// 1. Register B (the responder) and A (the sender) — A never opens SSE yet, so
	// its very first delivery attempt already has nowhere to land.
	const responderSession = `responder-${Date.now()}`;
	await register(responderSession, "responder");
	let senderSession = `sender-a1-${Date.now()}`;
	await register(senderSession, "sender");

	// 2. A sends a request to B.
	const send = await hub("POST", "/v1/messages", {
		project: PROJECT, sender_session: senderSession, target: "responder", target_session: null,
		prompt: "ping", conversation_id: null, response_schema: null, hops: 0,
	});
	expect(send.ok).toBe(true);
	const msgId = send.json.msg_id as string;
	expect(msgId).toBeTruthy();

	// 3. B answers while A still has no open stream — completion_notified_at stays
	// unset, exactly the "responder 覆咗但 sender 死咗" bootstrap state.
	const resp = await hub("POST", `/v1/messages/${msgId}/response`, {
		project: PROJECT, responder_session: responderSession, response: "pong", error: null,
	});
	expect(resp.ok).toBe(true);
	const afterAnswer = await hub("GET", `/v1/messages/${msgId}`);
	expect(afterAnswer.json.status).toBe("complete");

	// ── Cycle 1: A "restarts" (new session_id, same name) and connects for the
	// first time ever. No backoff gate applies (last_replay_at is unset) — this
	// delivers immediately (replay #1).
	senderSession = `sender-a2-${Date.now()}`;
	await register(senderSession, "sender");
	let frame = await openSseOnce(senderSession, 250);
	expect(frame).toContain('"status":"complete"');
	expect(frame).toContain('"response":"pong"');

	// ── Cycle 2: A restarts again IMMEDIATELY (well under BACKOFF[1]=150ms since
	// replay #1 just happened at replaysSoFar=1). Must be throttled — no outcome.
	senderSession = `sender-a3-${Date.now()}`;
	await register(senderSession, "sender");
	frame = await openSseOnce(senderSession, 100);
	expect(frame).not.toContain('"response":"pong"');

	// ── Cycle 3: wait past BACKOFF[1]=150ms, then restart again — replay #2 (the
	// 2nd and last allowed replay under MAX_REPLAYS=2) should now deliver.
	await sleep(220);
	senderSession = `sender-a4-${Date.now()}`;
	await register(senderSession, "sender");
	frame = await openSseOnce(senderSession, 250);
	expect(frame).toContain('"response":"pong"');

	// ── Cycle 4: restart immediately again. completion_replays is now at
	// MAX_REPLAYS(2) — this reconnect must escalate to `orphaned`, NOT consume the
	// message. No completion-ack was ever sent, so if the outcome were lost here
	// that would reproduce the exact bug this task fixes.
	senderSession = `sender-a5-${Date.now()}`;
	await register(senderSession, "sender");
	frame = await openSseOnce(senderSession, 150);
	expect(frame).not.toContain('"response":"pong"');

	const orphanedState = await hub("GET", `/v1/messages/${msgId}`);
	// The public GET doesn't expose orphaned_at, but status must still be "complete"
	// (never downgraded) and the outcome must still be readable — proof it wasn't
	// discarded.
	expect(orphanedState.json.status).toBe("complete");
	expect(orphanedState.json.response).toBe("pong");

	expect(serverLog).toContain("orphaned");
	await sleep(200); // let the fire-and-forget discord-emit stub flush to disk
	const discordCallsAfterOrphan = readDiscordStubCalls();
	expect(discordCallsAfterOrphan.length).toBe(1);
	expect(discordCallsAfterOrphan[0]).toContain(msgId);
	expect(discordCallsAfterOrphan[0]).toContain("sender: sender");
	expect(discordCallsAfterOrphan[0]).toContain("responder: responder");

	// ── Cycle 5: a genuine reconnect after the backoff window has elapsed again
	// must RECOVER the orphaned message and deliver the outcome — orphaned is not
	// a dead end.
	await sleep(220);
	senderSession = `sender-a6-${Date.now()}`;
	await register(senderSession, "sender");
	frame = await openSseOnce(senderSession, 250);
	expect(frame).toContain('"response":"pong"');
	expect(serverLog).toContain("recovered");

	// Recovering and re-delivering once must NOT fire a second Discord alert — the
	// escalation already happened and was reported; it doesn't re-fire just because
	// the sender reconnected and got the (still merely "notified", not yet acked)
	// outcome again.
	const discordCallsAfterRecovery = readDiscordStubCalls();
	expect(discordCallsAfterRecovery.length).toBe(1);

	// 6. Finally, A completion-acks — the message is now genuinely consumed.
	const ack = await hub("POST", `/v1/messages/${msgId}/completion-ack`, { sender_session: senderSession });
	expect(ack.ok).toBe(true);
	expect(ack.json.status).toBe("complete");
}, 20_000);
