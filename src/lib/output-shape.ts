/**
 * Output-shape guard — a read-only heuristic for peer-to-peer replies.
 *
 * Why this exists in code: "put the conclusion in the last section" was written
 * down as a prompt rule, and a reply still violated it the next day. A rule that
 * keeps failing belongs in code, not in stronger wording.
 *
 * Behaviour: **read-only**. It appends a log line and never rewrites or blocks a
 * message — heuristics misjudge, so a human must be able to see and fix the rule.
 *
 * Zero runtime dependencies (node:fs / node:path only) so it can be imported by
 * any peer implementation without pulling in a TUI stack.
 *
 * Callers: a hub client's "agent finished a turn" hook.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * 日誌路徑。**一定要 lazy 計算**。
 *
 * 2026-09-28 教訓：初版寫 `const OUTPUT_SHAPE_LOG = path.join(import.meta.dir, …)`
 * （module 載入時就算）——`import.meta.dir` 係 **Bun-only**，pi 嘅 extension loader（jiti）
 * 没提供它 → `path.join(undefined, …)` 即場 throw → **整個 coms-net.ts 載入失敗**
 * （錯誤訊息誤導：怪罪 importer），所有 agent 重啟都會死。
 * 現在：優先用標準 `import.meta.url`（jiti 有）；拿唔到就 fallback cwd。両者都拿唔到
 * 也唔會在載入時爆——只在真的寫 log 那一刻嘗試。
 */
function outputShapeLogPath(): string {
	// Lazy on purpose: computing this at module load broke an extension loader
	// once (a bundler-specific `import.meta.dir` was undefined -> throw at import
	// time, which looked like the *importer* was broken). Only resolve when a log
	// line is actually written.
	return (
		process.env.COMSNET_SHAPE_LOG ??
		path.join(os.tmpdir(), "comsnet-output-shape.jsonl")
	);
}

/** 收工語氣的標題：最後一節係呢啲之一才算合規。 */
const CLOSING_HEADING_RE =
	/(總結|結論|最重要|要你|要對方做|拍板|bottom\s*line|summary|next\s*(step|action)|下一步)/i;

/** Markdown 表格（表頭 + 分隔列）。Discord 唔支援表格 → 會原樣變一行 raw `| a | b |`。 */
const MARKDOWN_TABLE_RE = /^\s*\|.*\|\s*$\n\s*\|[-\s:|]+\|\s*$/m;

/** Discord 單條訊息 2000 字元上限；留 buffer，超咗就要分片（段落會斷中間）。 */
export const DISCORD_SAFE_CHARS = 1900;

/**
 * Discord surface check: chat UIs fragment long messages, so this surface has a
 * separate length/table rule (see DISCORD_SAFE_CHARS).
 *
 * 為何要同 coms-net 分開：coms-net peer reply 係 terminal/TUI 睇，表格冇問題；
 * Discord 完全唔 render markdown 表格，2000 字元上限亦會中途分片。
 * 所以 Discord 多兩條硬規則：①唔准 table　②唔准超 1900 字元。
 * 其餘（有 `##` 節時最後一節要係收工語氣）跟返 outputShapeViolation。
 *
 * @returns 唔合規就返回原因字串；合規／空白就 null
 */
export function discordShapeViolation(text: string): string | null {
	if (!text) return null;
	if (MARKDOWN_TABLE_RE.test(text)) {
		return "markdown table（Discord 唔 render 表格）";
	}
	if (text.length > DISCORD_SAFE_CHARS) {
		return `超 ${DISCORD_SAFE_CHARS} 字元（Discord 2000 上限會分片，段落會斷）`;
	}
	return outputShapeViolation(text);
}

/**
 * 純函數：把訊息切成 `##` 節，看最後一節嘅標題係唔係收工語氣。
 *
 * 唔過濾：整篇冇任何 `#` 標題（短答形式 —— AGENTS.md 叫短答唔加 header，
 * 冇「最後一節」可言）。
 *
 * @returns 唔合規就返回嗰個標題；合規或者冇標題就返回 null
 */
export function outputShapeViolation(text: string): string | null {
	if (!text) return null;
	const headings = text
		.split("\n")
		.map((line) => line.match(/^#{1,3}\s+(.+?)\s*$/))
		.filter((m): m is RegExpMatchArray => m !== null)
		.map((m) => m[1]);
	if (headings.length === 0) return null;
	const last = headings[headings.length - 1];
	return CLOSING_HEADING_RE.test(last) ? null : last;
}

export function logOutputShapeViolation(
	agentName: string | undefined,
	msgId: string | undefined,
	heading: string,
	text: string,
	surface: "comsnet" | "discord" = "comsnet",
): void {
	try {
		const logPath = outputShapeLogPath();
		fs.mkdirSync(path.dirname(logPath), { recursive: true });
		fs.appendFileSync(
			logPath,
			JSON.stringify({
				ts: new Date().toISOString(),
				agent: agentName,
				surface,
				inbound_msg_id: msgId ?? null,
				last_heading: heading,
				text_tail: text.slice(-300),
			}) + "\n",
		);
	} catch {
		// 合規記錄失敗絕對不可以影響訊息送出。
	}
}

export { outputShapeLogPath as outputShapeLogFile };
