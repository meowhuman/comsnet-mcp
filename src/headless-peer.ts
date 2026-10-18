#!/usr/bin/env bun
/**
 * External coding-agent ComsNet peer.
 *
 * Registers a non-interactive Claude Code or Codex worker on the existing
 * ComsNet hub. Incoming prompts are executed locally, then posted back as
 * message responses. The shared client owns ComsNet messaging, so the model
 * never needs to call ComsNet MCP tools.
 *
 * Hub discovery / registration / heartbeat / SSE come from the shared client
 * (scripts/lib/coms-net-client.ts) — do not re-implement them here.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createComsNetClient, discoverHub, type HubEndpoint, type PromptEvent } from "./lib/coms-net-client";

const DEFAULT_PROJECT = process.env.PI_COMS_NET_PROJECT ?? "Pi-custom-agents";
const AGENT_TIMEOUT_MS = Number(
	process.env.COMS_PEER_TIMEOUT_MS ?? process.env.CC_COMS_TIMEOUT_MS ?? 1_800_000,
);

function parseArgs(argv: string[]) {
	const out: Record<string, string | boolean> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) continue;
		const key = arg.slice(2);
		const next = argv[i + 1];
		if (!next || next.startsWith("--")) {
			out[key] = true;
		} else {
			out[key] = next;
			i++;
		}
	}
	return out;
}

function requireString(value: string | boolean | undefined, name: string): string {
	if (typeof value === "string" && value.length > 0) return value;
	throw new Error(`missing required --${name}`);
}

const args = parseArgs(process.argv.slice(2));
const project = typeof args.project === "string" ? args.project : DEFAULT_PROJECT;
const name = requireString(args.name, "name");
const model = typeof args.model === "string" ? args.model : "sonnet";
const runtime = typeof args.runtime === "string" ? args.runtime.toLowerCase() : "claude";
if (runtime !== "claude" && runtime !== "codex") {
	throw new Error(`unsupported --runtime ${runtime}; expected claude or codex`);
}
const runtimeLabel = runtime === "codex" ? "Codex" : "Claude Code";
const purpose = typeof args.purpose === "string" ? args.purpose : `${runtimeLabel} ComsNet worker`;
const skipPermissions = args["skip-permissions"] === true || args["skip-permissions"] === "true";
const explicit = args.explicit === true || args.explicit === "true";
const cwd = typeof args.cwd === "string" ? path.resolve(args.cwd) : process.cwd();
const roleFile = typeof args["role-file"] === "string" ? args["role-file"] : null;
const roleInstructions = roleFile
	? (() => {
		const rolePath = path.resolve(cwd, roleFile);
		if (!fs.existsSync(rolePath)) throw new Error(`role file not found: ${rolePath}`);
		return fs.readFileSync(rolePath, "utf-8").trim();
	})()
	: "";

// Explicit endpoint override (args/env) wins; otherwise discover from server files.
const overrideUrl = typeof args["server-url"] === "string" ? args["server-url"] : process.env.PI_COMS_NET_SERVER_URL;
const overrideToken = typeof args["auth-token"] === "string" ? args["auth-token"] : process.env.PI_COMS_NET_AUTH_TOKEN;
let endpoint: HubEndpoint | undefined;
if (overrideUrl || overrideToken) {
	const discovered = discoverHub(project);
	const serverUrl = (overrideUrl ?? discovered?.serverUrl)?.replace(/\/+$/, "");
	const token = overrideToken ?? discovered?.token;
	if (serverUrl && token) endpoint = { serverUrl, token };
}
if (!endpoint && !discoverHub(project)) {
	console.error(`cc-coms-peer: no ComsNet server for project "${project}". Start one first with: just coms-net-server`);
	process.exit(1);
}

let queueDepth = 0;

function agentPrompt(event: PromptEvent): string {
	const schemaNote = event.response_schema
		? `\n\nThe caller expects JSON matching this schema. Return only valid JSON:\n${JSON.stringify(event.response_schema)}`
		: "";
	return [
		`You are ${name}, a ${runtimeLabel} worker connected to Pi ComsNet.`,
		`Sender: ${event.sender.name} @ ${event.sender.cwd || "unknown cwd"}`,
		`Project: ${project}`,
		"Use Traditional Chinese. The first line of your final answer must be [Summary] <摘要>.",
		"Work only on the task below. Do not send ComsNet messages yourself.",
		"This worker replies on your behalf.",
		...(roleInstructions ? ["", "Role instructions:", roleInstructions] : []),
		"",
		"Task:",
		event.prompt,
		schemaNote,
	].join("\n");
}

function runAgent(prompt: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const outputPath = runtime === "codex"
			? path.join(os.tmpdir(), `codex-coms-peer-${process.pid}-${Date.now()}.txt`)
			: null;
		const command = runtime === "codex" ? (process.env.CODEX_BIN || "codex") : "claude";
		// Codex sandbox tier: read-only by default (this peer answers questions, it does
		// not edit), full access only when the caller explicitly opts in the same way the
		// Claude path does with --skip-permissions. Either way `exec` never prompts.
		const codexSandbox = skipPermissions ? "danger-full-access" : "read-only";
		const cmdArgs = runtime === "codex"
			? [
				"exec", "--ephemeral", "--sandbox", codexSandbox, "--model", model,
				"--output-last-message", outputPath!, prompt,
			]
			: ["-p", "--model", model, "--output-format", "text", prompt];
		if (runtime === "claude" && skipPermissions) {
			cmdArgs.splice(1, 0, "--dangerously-skip-permissions");
		}
		const child = spawn(command, cmdArgs, {
			cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error(`${runtimeLabel} timeout after ${AGENT_TIMEOUT_MS}ms`));
		}, AGENT_TIMEOUT_MS);
		(timer as any).unref?.();
		child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
		child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const finalOutput = outputPath && fs.existsSync(outputPath)
				? fs.readFileSync(outputPath, "utf-8").trim()
				: stdout.trim();
			if (outputPath) fs.rmSync(outputPath, { force: true });
			if (code === 0) {
				resolve(finalOutput);
				return;
			}
			reject(new Error(stderr.trim() || `${runtimeLabel} exited ${code}`));
		});
	});
}

async function handlePrompt(event: PromptEvent) {
	queueDepth++;
	console.log(`← ${event.sender.name} ${event.msg_id}`);
	try {
		const output = await runAgent(agentPrompt(event));
		let payload: unknown = output;
		let error: string | null = null;
		if (event.response_schema) {
			try {
				payload = JSON.parse(output);
			} catch {
				payload = null;
				error = "response not valid JSON";
			}
		}
		await client.respond(event.msg_id, payload, error);
		console.log(`→ response ${event.msg_id}${error ? ` error=${error}` : ""}`);
	} catch (err: any) {
		const message = err?.message ?? String(err);
		await client.respond(event.msg_id, null, message).catch(() => {});
		console.error(`✗ ${event.msg_id} ${message}`);
	} finally {
		queueDepth--;
	}
}

const client = createComsNetClient({
	project, name, model, purpose, cwd, explicit, endpoint,
	waitForHub: true,
	getQueueDepth: () => queueDepth,
	log: (msg) => console.error(`coms-peer: ${msg}`),
	onPrompt: (event) => void handlePrompt(event),
	onOnline: () => console.log(
		`coms-peer online: ${client.assignedName}@${project} runtime=${runtime} model=${model} cwd=${cwd}`,
	),
});

process.on("SIGINT", () => void client.deregister().then(() => process.exit(0)));
process.on("SIGTERM", () => void client.deregister().then(() => process.exit(0)));

await client.connect();
