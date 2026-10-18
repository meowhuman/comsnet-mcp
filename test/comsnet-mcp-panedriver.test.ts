#!/usr/bin/env bun
/**
 * comsnet-mcp-panedriver.test.ts — D1/D1b/D4 pane driver tests.
 *
 * R5: Real behavior tests with fake drivers, not source-verification grep.
 * Also includes real herdr environment tests (S-010: no mock panes).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const REPO = path.resolve(import.meta.dir, "..");
const HERDR_BIN = (() => {
	for (const p of ["/opt/homebrew/bin/herdr", "/usr/local/bin/herdr"]) {
		try { if (fs.statSync(p).isFile()) return p; } catch { /* try next */ }
	}
	return "herdr";
})();

// ── Fake driver for behavior tests ──────────────────────────────────────────

import type { PaneDriver, PaneHandle, PaneState } from "../src/mcp";

function createFakeDriver(opts: {
	locateResult: PaneHandle | null;
	stateResult: PaneState;
	deliverResult: boolean;
}): PaneDriver & { calls: { locate: number; state: number; deliver: number } } {
	const calls = { locate: 0, state: 0, deliver: 0 };
	return {
		calls,
		async locate() { calls.locate++; return opts.locateResult; },
		async state(_h) { calls.state++; return opts.stateResult; },
		async deliver(_h, _text) { calls.deliver++; return opts.deliverResult; },
	};
}

// ── 1. Backoff sequences ────────────────────────────────────────────────────

describe("BACKOFF_MS sequences", () => {
	test("deliver backoff: 5s → 15s → 45s → 120s → 300s", async () => {
		const { BACKOFF_MS } = await import("../src/mcp");
		expect(BACKOFF_MS).toEqual([5_000, 15_000, 45_000, 120_000, 300_000]);
	});

	test("working backoff: 5s → 10s → 30s → 60s → 120s → 300s", async () => {
		const { WORKING_BACKOFF_MS } = await import("../src/mcp");
		expect(WORKING_BACKOFF_MS).toEqual([5_000, 10_000, 30_000, 60_000, 120_000, 300_000]);
	});

	test("working warn threshold: 10 minutes", async () => {
		const { WORKING_WARN_AFTER_MS } = await import("../src/mcp");
		expect(WORKING_WARN_AFTER_MS).toBe(10 * 60 * 1000);
	});
});

// ── 2. Behavior: state=working → deliver NOT called (R5) ────────────────────

describe("behavior: working state prevents delivery", () => {
	beforeEach(async () => {
		const mod = await import("../src/mcp");
		mod._clearInbox();
		mod._resetBackoff();
	});

	test("when state() returns 'working', deliver() is never called", async () => {
		const mod = await import("../src/mcp");
		const handle: PaneHandle = { target: "fake:pane1", tag: "cc:test" };
		const fake = createFakeDriver({
			locateResult: handle,
			stateResult: "working",
			deliverResult: true,
		});
		mod._setPaneDriver(fake);
		mod._pushInbox("msg-1", "sender-a");

		const result = await mod._nudgeCycle();

		expect(result.action).toBe("working-skip");
		expect(result.deliverCalled).toBe(false);
		expect(fake.calls.locate).toBe(1);
		expect(fake.calls.state).toBe(1);
		expect(fake.calls.deliver).toBe(0); // ← key assertion
	});

	test("when state() returns 'idle', deliver() IS called", async () => {
		const mod = await import("../src/mcp");
		const handle: PaneHandle = { target: "fake:pane1", tag: "cc:test" };
		const fake = createFakeDriver({
			locateResult: handle,
			stateResult: "idle",
			deliverResult: true,
		});
		mod._setPaneDriver(fake);
		mod._pushInbox("msg-2", "sender-b");

		const result = await mod._nudgeCycle();

		expect(result.action).toBe("delivered");
		expect(result.deliverCalled).toBe(true);
		expect(fake.calls.deliver).toBe(1);
	});
});

// ── 3. Behavior: deliver failure → no ack (R5) ──────────────────────────────

describe("behavior: deliver failure does not ack", () => {
	beforeEach(async () => {
		const mod = await import("../src/mcp");
		mod._clearInbox();
		mod._resetBackoff();
	});

	test("deliver returns false → action is 'deliver-failed', inbox item NOT acked", async () => {
		const mod = await import("../src/mcp");
		const handle: PaneHandle = { target: "fake:pane2", tag: "codex:test" };
		const fake = createFakeDriver({
			locateResult: handle,
			stateResult: "idle",
			deliverResult: false, // ← delivery fails
		});
		mod._setPaneDriver(fake);
		mod._pushInbox("msg-3", "sender-c");

		const result = await mod._nudgeCycle();

		expect(result.action).toBe("deliver-failed");
		expect(result.deliverCalled).toBe(true);
		// The inbox item should still be unanswered (not acked, not marked answered)
		const inbox = mod._getInbox();
		const item = inbox.find((m) => m.msg_id === "msg-3");
		expect(item).toBeDefined();
		expect(item!.answered).toBe(false);
	});

	test("deliver returns true → action is 'delivered'", async () => {
		const mod = await import("../src/mcp");
		const handle: PaneHandle = { target: "fake:pane3", tag: "kimi:test" };
		const fake = createFakeDriver({
			locateResult: handle,
			stateResult: "idle",
			deliverResult: true,
		});
		mod._setPaneDriver(fake);
		mod._pushInbox("msg-4", "sender-d");

		const result = await mod._nudgeCycle();

		expect(result.action).toBe("delivered");
		expect(result.deliverCalled).toBe(true);
	});
});

// ── 4. Behavior: no outstanding → nothing happens ───────────────────────────

describe("behavior: no outstanding items", () => {
	beforeEach(async () => {
		const mod = await import("../src/mcp");
		mod._clearInbox();
		mod._resetBackoff();
	});

	test("empty inbox → action is 'nothing-outstanding', no driver calls", async () => {
		const mod = await import("../src/mcp");
		const fake = createFakeDriver({
			locateResult: null,
			stateResult: "unknown",
			deliverResult: false,
		});
		mod._setPaneDriver(fake);

		const result = await mod._nudgeCycle();

		expect(result.action).toBe("nothing-outstanding");
		expect(fake.calls.locate).toBe(0);
		expect(fake.calls.state).toBe(0);
		expect(fake.calls.deliver).toBe(0);
	});
});

// ── 5. Behavior: locate fails → no deliver ──────────────────────────────────

describe("behavior: locate fails", () => {
	beforeEach(async () => {
		const mod = await import("../src/mcp");
		mod._clearInbox();
		mod._resetBackoff();
	});

	test("locate returns null → action is 'locate-failed', deliver not called", async () => {
		const mod = await import("../src/mcp");
		const fake = createFakeDriver({
			locateResult: null,
			stateResult: "unknown",
			deliverResult: false,
		});
		mod._setPaneDriver(fake);
		mod._pushInbox("msg-5", "sender-e");

		const result = await mod._nudgeCycle();

		expect(result.action).toBe("locate-failed");
		expect(result.deliverCalled).toBe(false);
		expect(fake.calls.state).toBe(0);
		expect(fake.calls.deliver).toBe(0);
	});
});

// ── 6. Real herdr environment tests (S-010) ─────────────────────────────────

describe.skipIf(!(process.env.COMSNET_E2E === "1"))("herdr driver: real environment", () => {
	test("herdr agent list returns valid JSON with agents", () => {
		const out = execFileSync(HERDR_BIN, ["agent", "list"], {
			encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"],
		});
		const json = JSON.parse(out);
		expect(json.result).toBeDefined();
		expect(Array.isArray(json.result.agents)).toBe(true);
		expect(json.result.agents.length).toBeGreaterThan(0);
	});

	test("each agent has required fields (pane_id, agent_status, workspace_id)", () => {
		const out = execFileSync(HERDR_BIN, ["agent", "list"], {
			encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"],
		});
		const json = JSON.parse(out);
		for (const agent of json.result.agents) {
			expect(agent.pane_id).toBeDefined();
			expect(agent.agent_status).toBeDefined();
			expect(["idle", "working", "blocked", "done", "unknown"]).toContain(agent.agent_status);
			expect(agent.workspace_id).toBeDefined();
		}
	});

	test("squad state file exists and has panes with tags", () => {
		const stateDir = path.join(REPO, ".pi", "agents", "squads", "_runtime", "herdr-squads");
		const files = fs.readdirSync(stateDir).filter((f: string) => f.endsWith(".json"));
		expect(files.length).toBeGreaterThan(0);
		const latest = files.sort().pop()!;
		const state = JSON.parse(fs.readFileSync(path.join(stateDir, latest), "utf-8"));
		expect(state.panes).toBeDefined();
		expect(Array.isArray(state.panes)).toBe(true);
		expect(state.panes.length).toBeGreaterThan(0);
		for (const pane of state.panes) {
			expect(pane.id).toBeDefined();
			expect(pane.tag).toBeDefined();
		}
	});

	test("herdr pane process-info returns foreground_processes for a real pane", () => {
		const out = execFileSync(HERDR_BIN, ["agent", "list"], {
			encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"],
		});
		const json = JSON.parse(out);
		const firstPane = json.result.agents[0];
		const info = execFileSync(HERDR_BIN, ["pane", "process-info", "--pane", firstPane.pane_id], {
			encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"],
		});
		const infoJson = JSON.parse(info);
		const procs = infoJson.result.process_info.foreground_processes;
		expect(Array.isArray(procs)).toBe(true);
		expect(procs.length).toBeGreaterThan(0);
		for (const p of procs) {
			expect(p.pid).toBeDefined();
			expect(typeof p.pid).toBe("number");
		}
	});

	test("herdr pane process-info fails for non-existent pane", () => {
		let threw = false;
		try {
			execFileSync(HERDR_BIN, ["pane", "process-info", "--pane", "wX:z99"], {
				encoding: "utf-8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"],
			});
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});

	// locate() reads `project`/`cwd` from module-level consts fixed at first import,
	// which is already cached by the tests above with the real repo cwd/project. To
	// exercise "state file has a tag but `herdr pane list` no longer has that pane
	// ID" (the herdr-squad-wake bug) without touching the real production state
	// file, run comsnet-mcp fresh in a subprocess with its own --cwd/--project.
	test("locate() returns null when the state file's pane has vanished from `herdr pane list`", async () => {
		const { execFileSync: execSync } = await import("node:child_process");
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comsnet-locate-vanished-"));
		const stateDir = path.join(tmpDir, ".pi", "agents", "squads", "_runtime", "herdr-squads");
		fs.mkdirSync(stateDir, { recursive: true });
		const project = "locate-vanished-test";
		fs.writeFileSync(
			path.join(stateDir, `${project}.json`),
			JSON.stringify({
				version: 1,
				backend: "herdr",
				project,
				workspaceId: "wZ",
				hubPaneId: "wZ:p1",
				// wZ:z99 does not exist in real `herdr pane list` output.
				panes: [{ id: "wZ:z99", tag: "claude", agent: "claude" }],
			}),
		);
		const probe = path.join(tmpDir, "probe.ts");
		fs.writeFileSync(
			probe,
			`import { createHerdrDriver } from ${JSON.stringify(path.join(REPO, "scripts", "comsnet-mcp.ts"))};\n`
			+ `const driver = createHerdrDriver();\n`
			+ `const handle = await driver.locate();\n`
			+ `console.log(JSON.stringify(handle));\n`,
		);
		const out = execSync("bun", ["run", probe, "--project", project, "--cwd", tmpDir, "--name", "claude"], {
			encoding: "utf-8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"],
		});
		expect(JSON.parse(out.trim())).toBeNull();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("herdr driver deliver to non-existent pane returns false", async () => {
		process.env.PI_SQUAD_BACKEND = "herdr";
		const { createHerdrDriver } = await import("../src/mcp");
		const driver = createHerdrDriver();
		const ok = await driver.deliver(
			{ target: "wX:z99", tag: "nonexistent" },
			"test nudge text",
		);
		expect(ok).toBe(false);
		delete process.env.PI_SQUAD_BACKEND;
	});

	test("herdr driver state returns valid PaneState for a known pane", async () => {
		process.env.PI_SQUAD_BACKEND = "herdr";
		const { createHerdrDriver } = await import("../src/mcp");
		const driver = createHerdrDriver();
		const out = execFileSync(HERDR_BIN, ["agent", "list"], {
			encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"],
		});
		const json = JSON.parse(out);
		const firstAgent = json.result.agents[0];
		const state = await driver.state({ target: firstAgent.pane_id, tag: "test" });
		expect(["idle", "working", "blocked", "done", "unknown"]).toContain(state);
		delete process.env.PI_SQUAD_BACKEND;
	});

	test("herdr driver state returns 'unknown' for non-existent pane", async () => {
		process.env.PI_SQUAD_BACKEND = "herdr";
		const { createHerdrDriver } = await import("../src/mcp");
		const driver = createHerdrDriver();
		const state = await driver.state({ target: "wX:z99", tag: "fake" });
		expect(state).toBe("unknown");
		delete process.env.PI_SQUAD_BACKEND;
	});
});

// ── 7. Driver selection ─────────────────────────────────────────────────────

describe("driver selection", () => {
	test("createPaneDriver returns a valid driver", async () => {
		delete process.env.PI_SQUAD_BACKEND;
		const { createPaneDriver } = await import("../src/mcp");
		const driver = createPaneDriver();
		expect(driver.locate).toBeTypeOf("function");
		expect(driver.state).toBeTypeOf("function");
		expect(driver.deliver).toBeTypeOf("function");
	});
});

// ── 8. tmux driver: own-session nudge (owner-approved, S-010 real panes) ────
//
// codex-discord / opus-discord now run in a tmux session named after their own
// `--name` instead of a window inside the shared project session. locate()
// must accept `sess === name` as well as `sess === project` — but must still
// reject a pane in a session that matches NEITHER (the #311-class failure:
// tag alone is not enough, session identity still gates delivery).
//
// Real tmux sessions are used (no mocked panes), and the probe script runs
// INSIDE the pane it is trying to locate so Guard 3 (isAncestorOfUs) is
// exercised for real, exactly like production.

describe.skipIf(!(process.env.COMSNET_E2E === "1"))("tmux driver: own-session nudge support", () => {
	function writeProbe(tmpDir: string): string {
		const probe = path.join(tmpDir, "probe.ts");
		fs.writeFileSync(
			probe,
			`import * as fs from "node:fs";\n`
			+ `import { createTmuxDriver } from ${JSON.stringify(path.join(REPO, "scripts", "comsnet-mcp.ts"))};\n`
			+ `const driver = createTmuxDriver();\n`
			+ `const handle = await driver.locate();\n`
			+ `fs.writeFileSync(process.env.OUT_FILE!, JSON.stringify(handle));\n`,
		);
		return probe;
	}

	async function waitForFile(file: string, timeoutMs = 8_000): Promise<string> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			if (fs.existsSync(file)) return fs.readFileSync(file, "utf-8");
			await new Promise((r) => setTimeout(r, 100));
		}
		throw new Error(`timed out waiting for ${file}`);
	}

	test("pane in a session named after the peer's OWN --name is located and nudgeable", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comsnet-own-session-"));
		const peerName = `test-own-${process.pid}-${Date.now()}`;
		const outFile = path.join(tmpDir, "out.json");
		const probe = writeProbe(tmpDir);
		try {
			// Session named EXACTLY after the peer's own name, NOT the project
			// ("some-other-project") — this is the owner-approved own-session layout.
			execFileSync("tmux", [
				"new-session", "-d", "-s", peerName,
				`OUT_FILE='${outFile}' bun run '${probe}' --project some-other-project --name '${peerName}'; sleep 15`,
			]);
			const pane = execFileSync("tmux", [
				"list-panes", "-t", peerName, "-F", "#{pane_id}",
			], { encoding: "utf-8" }).trim().split("\n")[0];
			execFileSync("tmux", ["set-option", "-p", "-t", pane, "@squad_agent", `codex:${peerName}`]);

			const raw = await waitForFile(outFile);
			const handle = JSON.parse(raw);
			expect(handle).not.toBeNull();
			expect(handle.tag).toBe(`codex:${peerName}`);
		} finally {
			try { execFileSync("tmux", ["kill-session", "-t", peerName], { stdio: "ignore" }); } catch { /* already gone */ }
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	}, 15_000);

	test("pane in a session matching NEITHER the project NOR the peer's --name is still rejected (#311-class regression guard)", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comsnet-unrelated-session-"));
		const peerName = `test-unrelated-${process.pid}-${Date.now()}`;
		const unrelatedSession = `${peerName}-decoy-session`;
		const outFile = path.join(tmpDir, "out.json");
		const probe = writeProbe(tmpDir);
		try {
			// Tag matches `wanted` (built from --name) and process ancestry would
			// pass — but the session name is neither the project nor the peer's
			// own name, so it must still be rejected.
			execFileSync("tmux", [
				"new-session", "-d", "-s", unrelatedSession,
				`OUT_FILE='${outFile}' bun run '${probe}' --project some-other-project --name '${peerName}'; sleep 15`,
			]);
			const pane = execFileSync("tmux", [
				"list-panes", "-t", unrelatedSession, "-F", "#{pane_id}",
			], { encoding: "utf-8" }).trim().split("\n")[0];
			execFileSync("tmux", ["set-option", "-p", "-t", pane, "@squad_agent", `codex:${peerName}`]);

			const raw = await waitForFile(outFile);
			const handle = JSON.parse(raw);
			expect(handle).toBeNull();
		} finally {
			try { execFileSync("tmux", ["kill-session", "-t", unrelatedSession], { stdio: "ignore" }); } catch { /* already gone */ }
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	}, 15_000);
});

console.log("\n✅ All pane driver tests loaded.");


let restoreClient348: (() => Promise<void>) | null = null;
async function stubClient348(stub: any) {
	const mod = await import("../src/mcp");
	const prev = mod._setClient(stub);
	restoreClient348 = async () => { mod._setClient(prev); };
}

// ──────────────────────────────────────────────────────────────
// Issue #348 — nudge-storm ceiling & multi-reply inbox.
// A single reply must never be (re)delivered to the pane more than
// MAX_NUDGE_REPEATS times, and comsnet_inbox must surface ALL buffered
// replies — not just the newest — so a long report can never be
// silently lost behind repeated identical nudges.
// ──────────────────────────────────────────────────────────────

function countingDriver(): PaneDriver & { calls: { locate: number; state: number; deliver: number }; texts: string[] } {
	const calls = { locate: 0, state: 0, deliver: 0 };
	const texts: string[] = [];
	const handle: PaneHandle = { target: "fake:pane348", tag: "codex:test" };
	return {
		calls,
		texts,
		async locate() { calls.locate++; return handle; },
		async state() { calls.state++; return "idle"; },
		async deliver(_h, text) { calls.deliver++; texts.push(text); return true; },
	};
}

describe("Issue #348 — nudge cap per msg_id", () => {
	beforeEach(async () => {
		const mod = await import("../src/mcp");
		mod._clearInbox();
		mod._clearOutbound();
		mod._resetNudgeCounts();
	});
	afterEach(async () => {
		if (restoreClient348) { await restoreClient348(); restoreClient348 = null; }
	});

	test("one unread reply is pushed at most MAX_NUDGE_REPEATS times, then stops", async () => {
		const mod = await import("../src/mcp");
		const driver = countingDriver();
		mod._setPaneDriver(driver);
		const stubClient: any = {
			registered: true,
			assignedName: "codex-build",
			ack: async () => {},
			completionAck: async () => true,
			respond: async () => {},
			pullInbox: async () => [],
			progress: async () => {},
		};
		await stubClient348(stubClient);

		// Simulate a long task: a reply lands but the user never reads it.
		mod._trackOutbound("r1", "opus-orchestrator");
		mod.handleOutboundResponse({ msg_id: "r1", responder: { name: "opus-orchestrator" }, response: "here is the full report" });

		const cap = mod.MAX_NUDGE_REPEATS;
		let action = "";
		for (let i = 0; i < cap + 5; i++) {
			const result = await mod._nudgeCycle();
			action = result.action;
			if (action === "nudge-capped" || action === "nothing-outstanding") break;
		}
		// Pushed exactly up to the cap — never cap+1 identical nudges.
		expect(driver.calls.deliver).toBe(cap);
		expect(action).toBe("nudge-capped");
		// The following cycle must NOT deliver again (scheduler parks).
		const after = await mod._nudgeCycle();
		expect(after.deliverCalled).toBe(false);
		expect(driver.calls.deliver).toBe(cap);
	});

	test("an inbound prompt awaiting reply is also capped", async () => {
		const mod = await import("../src/mcp");
		const driver = countingDriver();
		mod._setPaneDriver(driver);
		const stubClient: any = { registered: true, assignedName: "codex-build", ack: async () => {}, completionAck: async () => true, respond: async () => {}, pullInbox: async () => [], progress: async () => {} };
		await stubClient348(stubClient);

		mod._pushInbox("m348", "opus-orchestrator");
		const cap = mod.MAX_NUDGE_REPEATS;
		let action = "";
		for (let i = 0; i < cap + 5; i++) {
			const result = await mod._nudgeCycle();
			action = result.action;
			if (action === "nudge-capped") break;
		}
		expect(driver.calls.deliver).toBe(cap);
		expect(action).toBe("nudge-capped");
	});

	test("reading the reply resets the cap so a NEW nudge cycle can start", async () => {
		const mod = await import("../src/mcp");
		const driver = countingDriver();
		mod._setPaneDriver(driver);
		const acked: string[] = [];
		const stubClient: any = {
			registered: true,
			assignedName: "codex-build",
			ack: async () => {},
			completionAck: async (msgId: string) => { acked.push(msgId); return true; },
			respond: async () => {},
			pullInbox: async () => [],
			progress: async () => {},
		};
		await stubClient348(stubClient);

		mod._trackOutbound("r1", "opus-orchestrator");
		mod.handleOutboundResponse({ msg_id: "r1", responder: { name: "opus-orchestrator" }, response: "full report content" });

		// User finally reads the inbox → reply is drained (shown/spliced).
		await mod.callTool("comsnet_inbox", {});
		expect(acked).toContain("r1");
		expect(mod._getNudgeCount("r1")).toBe(0); // count cleared after read

		// A brand-new reply nudges again instead of being stopped by the old cap.
		mod._trackOutbound("r2", "opus-orchestrator");
		mod.handleOutboundResponse({ msg_id: "r2", responder: { name: "opus-orchestrator" }, response: "second reply" });
		const result = await mod._nudgeCycle();
		expect(result.action).toBe("delivered");
		expect(driver.calls.deliver).toBe(1);
	});
});

describe("Issue #348 — inbox returns EVERY unread reply", () => {
	beforeEach(async () => {
		const mod = await import("../src/mcp");
		mod._clearInbox();
		mod._clearOutbound();
		mod._resetNudgeCounts();
	});
	afterEach(async () => {
		if (restoreClient348) { await restoreClient348(); restoreClient348 = null; }
	});

	test("two buffered replies to two outbound messages are BOTH returned", async () => {
		const mod = await import("../src/mcp");
		const acked: string[] = [];
		const stubClient: any = {
			registered: true,
			assignedName: "codex-build",
			ack: async () => {},
			completionAck: async (msgId: string) => { acked.push(msgId); return true; },
			respond: async () => {},
			pullInbox: async () => [],
			progress: async () => {},
		};
		await stubClient348(stubClient);

		mod._trackOutbound("o1", "cloud-builder");
		mod._trackOutbound("o2", "cloud-builder");
		mod.handleOutboundResponse({ msg_id: "o1", responder: { name: "cloud-builder" }, response: "part one of the report" });
		mod.handleOutboundResponse({ msg_id: "o2", responder: { name: "cloud-builder" }, response: "part two of the report" });

		const out = await mod.callTool("comsnet_inbox", {});
		expect(out).toContain("o1");
		expect(out).toContain("o2");
		expect(out).toContain("part one of the report");
		expect(out).toContain("part two of the report");
		expect(acked).toEqual(expect.arrayContaining(["o1", "o2"]));
	});
});
