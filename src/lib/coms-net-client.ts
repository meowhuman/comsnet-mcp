/**
 * Shared ComsNet client — the ONE implementation of hub discovery, registration,
 * heartbeat, SSE, and messaging that every non-Pi consumer uses.
 *
 * Consumers: scripts/comsnet-mcp.ts (interactive REPL peers), scripts/cc-coms-peer.ts
 * (headless `claude -p` worker), scripts/voice-gateway (voice peer). Before this
 * module the first two were hand-maintained copies that had already drifted
 * (provider / context_used_pct / activity existed only in the MCP copy) — do not
 * copy this logic again; import it.
 *
 * Contract source of truth: scripts/coms-net-server.ts (the hub).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const COMS_NET_DIR = path.join(os.homedir(), ".pi", "coms-net");

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function ulid(): string {
	const rand = crypto.randomBytes(10);
	let t = Date.now();
	let timeStr = "";
	for (let i = 9; i >= 0; i--) { timeStr = CROCKFORD[t % 32] + timeStr; t = Math.floor(t / 32); }
	let randStr = "", bits = 0, value = 0;
	for (const byte of rand) {
		value = (value << 8) | byte; bits += 8;
		while (bits >= 5) { bits -= 5; randStr += CROCKFORD[(value >> bits) & 31]; }
	}
	return (timeStr + randStr).slice(0, 26);
}

function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
	} catch {
		return null;
	}
}

export type PromptEvent = {
	msg_id: string;
	project: string;
	sender: { session_id: string; name: string; cwd: string };
	prompt: string;
	conversation_id: string | null;
	response_schema: object | null;
	hops: number;
};

export type ResponseEvent = {
	msg_id: string;
	responder?: { name?: string };
	response: unknown;
	error?: string | null;
};

export type RegisterResponse = {
	ok: true;
	agent: { session_id: string; name: string; model: string; project: string };
	heartbeat_interval_ms: number;
	sse_url: string;
};

export type HubEndpoint = { serverUrl: string; token: string };

/** Read server.json + server.secret.json for one project. Null until the hub exists. */
export function discoverHub(project: string): HubEndpoint | null {
	const dir = path.join(COMS_NET_DIR, "projects", project);
	const sj = readJson<{ local_url: string }>(path.join(dir, "server.json"));
	const ss = readJson<{ token: string }>(path.join(dir, "server.secret.json"));
	if (sj?.local_url && ss?.token) return { serverUrl: sj.local_url.replace(/\/+$/, ""), token: ss.token };
	return null;
}

/** List every project dir that currently has a hub (server.json + secret). */
export function discoverAllHubs(): Array<{ project: string } & HubEndpoint> {
	const root = path.join(COMS_NET_DIR, "projects");
	let entries: string[] = [];
	try {
		entries = fs.readdirSync(root);
	} catch {
		return [];
	}
	const out: Array<{ project: string } & HubEndpoint> = [];
	for (const project of entries) {
		const hub = discoverHub(project);
		if (hub) out.push({ project, ...hub });
	}
	return out;
}

/** SSE frame parser (\n\n-delimited, event:/data: lines). Feed it raw chunks. */
export function makeSseParser(onEvent: (event: string, data: any) => void) {
	const decoder = new TextDecoder();
	let buffer = "";
	return (chunk: Uint8Array) => {
		buffer += decoder.decode(chunk, { stream: true });
		let idx = buffer.indexOf("\n\n");
		while (idx >= 0) {
			const frame = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 2);
			let event = "message";
			const data: string[] = [];
			for (const line of frame.split("\n")) {
				if (line.startsWith("event:")) event = line.slice(6).trim();
				if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
			}
			if (data.length) { try { onEvent(event, JSON.parse(data.join("\n"))); } catch { /* malformed frame */ } }
			idx = buffer.indexOf("\n\n");
		}
	};
}

export type ComsNetClientOptions = {
	project: string;
	name: string;
	model?: string;
	purpose?: string;
	/** Agent kind tag for monitors (claude-code | codex | voice-gateway | …). Omitted → not sent. */
	provider?: string;
	cwd?: string;
	explicit?: boolean;
	color?: string;
	/** Pre-resolved endpoint (e.g. cc-coms-peer --server-url/--auth-token). Skips file discovery. */
	endpoint?: HubEndpoint;
	sessionId?: string;
	/**
	 * true (default): connect() polls for server.json forever — resilient to cold start.
	 * false: connect() rejects immediately when the hub files are missing.
	 */
	waitForHub?: boolean;
	/** Live telemetry callbacks, sampled on every heartbeat. */
	getContextPct?: () => number;
	getQueueDepth?: () => number;
	getActivity?: () => string;
	log?: (msg: string) => void;
	onPrompt?: (event: PromptEvent) => void;
	onResponse?: (event: ResponseEvent) => void;
	/** Fired after every successful register (initial and reconnects). */
	onOnline?: (reg: RegisterResponse) => void;
};

export type ComsNetClient = {
	readonly sessionId: string;
	/** Hub may reassign the name on collision; tracks the live value. */
	readonly assignedName: string;
	readonly registered: boolean;
	/** Register + heartbeat + SSE with infinite retry. Resolves after the FIRST successful register. */
	connect(): Promise<void>;
	/** Raw authed request against the hub — escape hatch for endpoints not wrapped below. */
	request(method: string, urlPath: string, body?: unknown, timeoutMs?: number): Promise<any>;
	send(target: string, prompt: string, opts?: { deadlineMs?: number | null; conversationId?: string | null; responseSchema?: object | null }): Promise<{ msgId: string }>;
	/** Long-poll for a reply. Returns { status:"timeout" } payload when the peer is still working. */
	awaitReply(msgId: string, timeoutMs?: number): Promise<any>;
	respond(msgId: string, response: unknown, error?: string | null): Promise<void>;
	listAgents(): Promise<any[]>;
	pullInbox(agentName?: string): Promise<any[]>;
	ack(msgId: string): Promise<void>;
	progress(msgId: string, note?: string): Promise<void>;
	/** Resolves true when the hub recorded the ack; false when it did not (see impl). */
	completionAck(msgId: string): Promise<boolean>;
	/** Push one heartbeat immediately (e.g. right after an activity change). */
	heartbeatNow(): Promise<void>;
	deregister(): Promise<void>;
};

export function createComsNetClient(opts: ComsNetClientOptions): ComsNetClient {
	const {
		project,
		name,
		model = "sonnet",
		purpose = "ComsNet peer",
		provider,
		cwd = process.cwd(),
		explicit = false,
		color = "#36F9F6",
		waitForHub = true,
		getContextPct = () => 0,
		getQueueDepth = () => 0,
		getActivity = () => "",
		log = () => {},
		onPrompt,
		onResponse,
		onOnline,
	} = opts;

	const sessionId = opts.sessionId ?? ulid();
	let endpoint: HubEndpoint | null = opts.endpoint ?? null;
	let registered = false;
	let assignedName = name;
	let shuttingDown = false;
	let sseAbort: AbortController | null = null;
	let heartbeatStarted = false;

	async function request(method: string, urlPath: string, body?: unknown, timeoutMs = 65_000): Promise<any> {
		if (!endpoint) throw new Error("hub not ready");
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), timeoutMs);
		(timer as any).unref?.();
		try {
			const resp = await fetch(endpoint.serverUrl + urlPath, {
				method,
				signal: ac.signal,
				headers: {
					authorization: `Bearer ${endpoint.token}`,
					accept: "application/json",
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			const text = await resp.text();
			const parsed = text ? JSON.parse(text) : null;
			if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${parsed?.error ?? text}`);
			return parsed;
		} finally {
			clearTimeout(timer);
		}
	}

	async function register(): Promise<RegisterResponse> {
		const resp = await request("POST", "/v1/agents/register", {
			project, session_id: sessionId, name, purpose, model,
			...(provider ? { provider } : {}),
			color, cwd, explicit,
		}, 10_000);
		if (resp?.agent?.name && resp.agent.name !== name) assignedName = resp.agent.name;
		registered = true;
		return resp;
	}

	async function heartbeatBody() {
		return {
			project,
			context_used_pct: getContextPct(),
			queue_depth: getQueueDepth(),
			model,
			status: "online",
			activity: getActivity(),
		};
	}

	async function heartbeatLoop(intervalMs: number): Promise<void> {
		while (!shuttingDown) {
			await new Promise((r) => setTimeout(r, intervalMs));
			if (shuttingDown) return;
			await request("POST", `/v1/agents/${encodeURIComponent(sessionId)}/heartbeat`, await heartbeatBody(), 5_000)
				.catch((err) => log(`heartbeat: ${err?.message ?? err}`));
		}
	}

	async function openSse(sseUrl: string): Promise<void> {
		sseAbort = new AbortController();
		try {
			const resp = await fetch(endpoint!.serverUrl + sseUrl, {
				headers: { authorization: `Bearer ${endpoint!.token}`, accept: "text/event-stream" },
				signal: sseAbort.signal,
			});
			if (!resp.ok || !resp.body) throw new Error(`SSE HTTP ${resp.status}`);
			const parse = makeSseParser((event, data) => {
				if (event === "prompt" && onPrompt) onPrompt(data as PromptEvent);
				else if (event === "response" && onResponse) onResponse(data as ResponseEvent);
			});
			const reader = resp.body.getReader();
			while (!shuttingDown) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value) parse(value);
			}
		} finally {
			sseAbort = null;
		}
	}

	// Discovery → register → heartbeat → SSE, with infinite retry. Re-registers after
	// every SSE drop so a restarted hub picks the session back up. When the endpoint
	// comes from file discovery (no opts.endpoint), it is RE-READ on every iteration —
	// a restarted hub writes a new port to server.json and we must follow it.
	const fixedEndpoint = opts.endpoint ?? null;
	async function connectLoop(onFirstRegister: () => void): Promise<void> {
		let first = true;
		while (!shuttingDown) {
			endpoint = fixedEndpoint ?? discoverHub(project);
			if (!endpoint) {
				if (!waitForHub) throw new Error(`no ComsNet server for project "${project}"`);
				await new Promise((r) => setTimeout(r, 500));
				continue;
			}
			try {
				const reg = await register();
				log(`online: ${assignedName}@${project} model=${model}`);
				onOnline?.(reg);
				if (first) { first = false; onFirstRegister(); }
				if (!heartbeatStarted) {
					heartbeatStarted = true;
					void heartbeatLoop(reg.heartbeat_interval_ms || 10_000);
				}
				await openSse(reg.sse_url);
			} catch (err: any) {
				if (!shuttingDown) log(`connect: ${err?.message ?? err}`);
				if (!waitForHub && first) throw err;
			}
			registered = false;
			if (!shuttingDown) await new Promise((r) => setTimeout(r, 1_000));
		}
	}

	return {
		get sessionId() { return sessionId; },
		get assignedName() { return assignedName; },
		get registered() { return registered; },

		connect(): Promise<void> {
			return new Promise((resolve, reject) => {
				connectLoop(resolve).catch(reject);
			});
		},

		request,

		async send(target, prompt, sendOpts = {}) {
			const resp = await request("POST", "/v1/messages", {
				project, sender_session: sessionId, target, target_session: null,
				prompt,
				conversation_id: sendOpts.conversationId ?? null,
				response_schema: sendOpts.responseSchema ?? null,
				hops: 0,
				deadline_ms: typeof sendOpts.deadlineMs === "number" ? sendOpts.deadlineMs : null,
			}, 10_000);
			if (!resp?.msg_id) throw new Error("send failed: no msg_id returned");
			return { msgId: resp.msg_id };
		},

		awaitReply(msgId, timeoutMs = 120_000) {
			return request("GET", `/v1/messages/${encodeURIComponent(msgId)}/await?timeout_ms=${timeoutMs}`, undefined, timeoutMs + 5_000);
		},

		async respond(msgId, response, error = null) {
			await request("POST", `/v1/messages/${encodeURIComponent(msgId)}/response`, {
				project, responder_session: sessionId, response, error,
			}, 10_000);
		},

		async listAgents() {
			const resp = await request("GET", `/v1/agents?project=${encodeURIComponent(project)}&include_explicit=true`);
			return resp?.agents ?? [];
		},

		async pullInbox(agentName = assignedName) {
			const resp = await request("GET", `/v1/inbox?project=${encodeURIComponent(project)}&name=${encodeURIComponent(agentName)}`);
			return resp?.messages ?? [];
		},

		async ack(msgId) {
			await request("POST", `/v1/messages/${encodeURIComponent(msgId)}/ack`, { responder_session: sessionId }, 5_000)
				.catch((err) => log(`ack ${msgId}: ${err?.message ?? err}`));
		},

		async progress(msgId, note = "worker engaged") {
			await request("POST", `/v1/messages/${encodeURIComponent(msgId)}/progress`, { responder_session: sessionId, progress: note }, 5_000)
				.catch((err) => log(`progress ${msgId}: ${err?.message ?? err}`));
		},

		// Reports success so callers can keep their local copy when the hub did NOT
		// record the ack (Issue #261). Swallowing the failure while the caller cleared
		// its buffer let hub and client diverge: the hub still saw the outcome as
		// unconsumed and replayed it on the next reconnect, forever.
		async completionAck(msgId) {
			try {
				await request("POST", `/v1/messages/${encodeURIComponent(msgId)}/completion-ack`, { sender_session: sessionId }, 5_000);
				return true;
			} catch (err: any) {
				log(`completion ack ${msgId}: ${err?.message ?? err}`);
				return false;
			}
		},

		async heartbeatNow() {
			await request("POST", `/v1/agents/${encodeURIComponent(sessionId)}/heartbeat`, await heartbeatBody(), 5_000).catch(() => {});
		},

		async deregister() {
			if (shuttingDown) return;
			shuttingDown = true;
			sseAbort?.abort();
			await request("DELETE", `/v1/agents/${encodeURIComponent(sessionId)}?project=${encodeURIComponent(project)}`, undefined, 3_000).catch(() => {});
		},
	};
}
