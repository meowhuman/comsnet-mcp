#!/usr/bin/env bun
/**
 * comsnet-mcp-inbox-authoritative.test.ts — Issue #327 regression tests.
 *
 * Two independent silent-loss bugs, same shape ("first round works, then
 * silently breaks"):
 *
 *  1. Inbound: `comsnet_inbox`'s hub pull can throw (network/hub blip); the
 *     failure used to be swallowed (stderr-only log) and the tool fell through
 *     to "Inbox empty (no pending messages or replies)." — indistinguishable
 *     from a genuinely empty inbox even though the hub may have pending work.
 *
 *  2. Outbound: `ackAfterDelivery()` used to blanket-mark EVERY "awaiting"
 *     outbound entry as "consumed" whenever ANY nudge was delivered — not just
 *     the ones whose reply was actually included in that nudge. A reply that
 *     arrived for a DIFFERENT outbound message after the nudge was built (but
 *     before deliver() returned) got permanently marked "consumed" without
 *     ever being surfaced, so `handleOutboundResponse`'s dedup guard silently
 *     dropped it forever.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { PaneDriver, PaneHandle } from "../src/mcp";

// `client` is a module-level singleton — any test that calls `_setClient` MUST
// restore it, or later tests (in this file or others sharing the module in the
// same bun test process) silently run against a stub missing real methods.
let restoreClient: (() => Promise<void>) | null = null;
async function withStubClient(stub: any) {
	const mod = await import("../src/mcp");
	const prev = mod._setClient(stub);
	restoreClient = async () => { mod._setClient(prev); };
}

describe("Issue #327 — inbound: hub pull failure must not report Inbox empty", () => {
	beforeEach(async () => {
		const mod = await import("../src/mcp");
		mod._clearInbox();
		mod._clearOutbound();
	});
	afterEach(async () => {
		if (restoreClient) { await restoreClient(); restoreClient = null; }
	});

	test("pullInbox throwing on the 2nd call surfaces the failure instead of claiming empty", async () => {
		const mod = await import("../src/mcp");
		let calls = 0;
		const stubClient: any = {
			registered: true,
			assignedName: "codex-build",
			pullInbox: async (_agentName: string) => {
				calls++;
				if (calls === 1) return [{ msg_id: "m1", sender: "opus-orchestrator", prompt: "task one", created_at: new Date().toISOString() }];
				throw new Error("simulated hub network blip");
			},
			ack: async () => {},
			progress: async () => {},
			completionAck: async () => true,
			respond: async () => {},
		};
		await withStubClient(stubClient);

		// Call 1 — pull succeeds, msg m1 surfaces normally.
		const r1 = await mod.callTool("comsnet_inbox", {});
		expect(r1).toContain("m1");

		// Answer it so it doesn't linger in the pending list for call 2.
		await mod.callTool("comsnet_respond", { msg_id: "m1", response: "ack1" });

		// Call 2 — pull throws. The hub may genuinely have a pending message we
		// simply failed to fetch; the tool must NEVER claim "Inbox empty" in
		// that case.
		const r2 = await mod.callTool("comsnet_inbox", {});
		expect(r2).not.toBe("Inbox empty (no pending messages or replies).");
		expect(r2.toLowerCase()).toContain("pull failed");
	});
});

describe("Issue #327 — inbound: same peer receiving two prompts, second must be readable", () => {
	beforeEach(async () => {
		const mod = await import("../src/mcp");
		mod._clearInbox();
		mod._clearOutbound();
	});
	afterEach(async () => {
		if (restoreClient) { await restoreClient(); restoreClient = null; }
	});

	test("two consecutive prompts from the same sender both surface via comsnet_inbox", async () => {
		const mod = await import("../src/mcp");
		const stubClient: any = {
			registered: true,
			assignedName: "codex-build",
			pullInbox: async () => [],
			ack: async () => {},
			progress: async () => {},
			completionAck: async () => true,
			respond: async () => {},
		};
		await withStubClient(stubClient);

		mod.handleInboundPrompt({ msg_id: "task-1", sender: { name: "opus-orchestrator" }, prompt: "first task", conversation_id: null });
		const r1 = await mod.callTool("comsnet_inbox", {});
		expect(r1).toContain("task-1");
		await mod.callTool("comsnet_respond", { msg_id: "task-1", response: "done 1" });

		mod.handleInboundPrompt({ msg_id: "task-2", sender: { name: "opus-orchestrator" }, prompt: "second task", conversation_id: null });
		const r2 = await mod.callTool("comsnet_inbox", {});
		expect(r2).toContain("task-2");
	});
});

function fakeDriver(deliverResult = true): PaneDriver {
	const handle: PaneHandle = { target: "fake:pane1", tag: "codex:test" };
	return {
		async locate() { return handle; },
		async state() { return "idle"; },
		async deliver() { return deliverResult; },
	};
}

describe("Issue #327 — outbound: second reply must still trigger a nudge", () => {
	beforeEach(async () => {
		const mod = await import("../src/mcp");
		mod._clearInbox();
		mod._clearOutbound();
		mod._resetBackoff();
		mod._setPaneDriver(fakeDriver(true));
	});

	test("ackAfterDelivery only consumes the outbound entry whose reply was actually nudged", async () => {
		const mod = await import("../src/mcp");

		// Two outbound sends, as comsnet_send would register.
		mod._trackOutbound("out-1", "codex-build");
		mod._trackOutbound("out-2", "codex-verifier");

		// Only reply #1 has arrived so far — reply #2 has NOT landed yet.
		mod.handleOutboundResponse({ msg_id: "out-1", responder: { name: "codex-build" }, response: "report one" });

		const result = await mod._nudgeCycle();
		expect(result.action).toBe("delivered");

		// out-2 never had a reply yet — it must remain "awaiting", NOT be
		// wrongly marked "consumed" just because a DIFFERENT nudge went out.
		const outbound = mod._getOutbound();
		expect(outbound.get("out-2")?.state).toBe("awaiting");

		// Now the second reply actually arrives. Because out-2 correctly stayed
		// "awaiting", handleOutboundResponse's dedup guard must accept it.
		mod.handleOutboundResponse({ msg_id: "out-2", responder: { name: "codex-verifier" }, response: "report two" });

		const replies = mod._getReplies();
		expect(replies.some((r: any) => r.msg_id === "out-2")).toBe(true);

		// And it must be included in the next nudge cycle instead of being
		// silently dropped forever.
		const text = mod.nudgeText();
		expect(text).toContain("codex-verifier");
	});

	afterEach(async () => {
		const mod = await import("../src/mcp");
		mod._clearInbox();
		mod._clearOutbound();
		mod._resetBackoff();
	});
});

console.log("\n✅ Issue #327 regression tests loaded.");
