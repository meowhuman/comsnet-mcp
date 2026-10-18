#!/usr/bin/env bun
/**
 * 測試 output-shape 唯讀合規檢查。
 *
 * Run:
 *   bun test ./.pi/extensions/lib/coms-net-output-shape.test.ts
 *
 * 背景：the prompt 嘅「最重要嘅總結放最後一節」規則 2026-09-27 就寫落去，
 * 2026-09-28 我回 peer 嗰條照樣漏（最後一節係「順帶一個坑」）→ 去碼化。
 * 呢個檢查係**唯讀**：只 append log，唔改訊息內容。
 */
import { afterAll, expect, test } from 'bun:test';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  outputShapeLogFile,
  logOutputShapeViolation,
  outputShapeViolation,
  discordShapeViolation,
  DISCORD_SAFE_CHARS,
} from '../src/lib/output-shape.ts';

test('最後一節係收工語氣 → 合規', () => {
  expect(outputShapeViolation('## A\nfoo\n\n## 要你做\n- x')).toBeNull();
  expect(outputShapeViolation('## 已做\nfoo\n\n## 總結\n一句')).toBeNull();
  expect(outputShapeViolation('## 1\nfoo\n\n## 最重要\n一句')).toBeNull();
  expect(outputShapeViolation('## 1\nfoo\n\n## 結論：OK')).toBeNull();
  expect(outputShapeViolation('## 1\nfoo\n\n## Bottom line\nx')).toBeNull();
});

test('最後一節唔係收工語氣 → 揪出嗰個標題', () => {
  // real violation shape: ends on an appendix section
  expect(outputShapeViolation('## 1. 點解\nfoo\n\n## 4. 順帶一個坑\nbar')).toBe('4. 順帶一個坑');
  expect(outputShapeViolation('## 已做\nfoo\n\n## 附錄：路徑\n- a/b.md')).toBe('附錄：路徑');
});

test('短答（完全冇標題）唔算違規 —— AGENTS.md 叫短答唔加 header', () => {
  expect(outputShapeViolation('- a\n- b\n- c')).toBeNull();  expect(outputShapeViolation('')).toBeNull();
});

test('記錄器接受任何 agent 名（唔再寫死單一 agent）', () => {
  const before = existsSync(outputShapeLogFile()) ? readFileSync(outputShapeLogFile(), 'utf-8') : '';
  logOutputShapeViolation('some-other-agent', 'msg-x', '附錄', 'text');
  const after = readFileSync(outputShapeLogFile(), 'utf-8');
  expect(after.length).toBeGreaterThan(before.length);
  expect(JSON.parse(after.trim().split('\n').pop()!).agent).toBe('some-other-agent');
  // 還原，唔想喺真 log 留測試噪音
  if (before.trim()) require('node:fs').writeFileSync(outputShapeLogFile(), before);
  else try { require('node:fs').rmSync(outputShapeLogFile(), { force: true }); } catch {}
});

test('記錄器寫一行 JSONL，包含觸規標題', () => {
  const before = existsSync(outputShapeLogFile()) ? readFileSync(outputShapeLogFile(), 'utf-8') : '';
  logOutputShapeViolation('peer-a', 'msg-test-01', '附錄：路徑', '## 已做\nfoo\n\n## 附錄：路徑\n- a');
  const after = readFileSync(outputShapeLogFile(), 'utf-8');
  expect(after.length).toBeGreaterThan(before.length);
  const last = after.trim().split('\n').pop()!;
  const row = JSON.parse(last);
  expect(row.agent).toBe('peer-a');
  expect(row.inbound_msg_id).toBe('msg-test-01');
  expect(row.last_heading).toBe('附錄：路徑');
  // 驗完即刻收返，唔想喺真 log 留測試噪音
  const kept = before.trim() ? before : '';
  if (kept) require('node:fs').writeFileSync(outputShapeLogFile(), kept);
  else rmSync(outputShapeLogFile(), { force: true });
});

afterAll(() => {
  rmSync(join('/tmp', 'nonexistent-shape-test'), { force: true });
});

test('收工語氣涵蓋「要你決定／拍板」變體 —— 2026-10-04 修 false positive', () => {
  // 呢兩句係 2026-10-03 output-shape-log 真寫入嘅「違規」，其實都係收工語氣。
  expect(outputShapeViolation('## 已做\nfoo\n\n## 要你決定\n- A 還是 B')).toBeNull();
  expect(outputShapeViolation('## 證據\nfoo\n\n## 要你拍板\n- A')).toBeNull();
});

test('Discord：markdown 表格 → 違規（Discord 唔 render 表格）', () => {
  expect(discordShapeViolation('| 卡 | 狀態 |\n|---|---|\n| 5090 | down |')).toContain('table');
  // 冇分隔列嘅普通用 pipe 唔算表格
  expect(discordShapeViolation('- `a | b` 用法')).toBeNull();
});

test(`Discord：超 ${DISCORD_SAFE_CHARS} 字元 → 違規（2000 上限會分片）`, () => {
  expect(discordShapeViolation('x'.repeat(DISCORD_SAFE_CHARS + 1))).toContain('字元');
  expect(discordShapeViolation('x'.repeat(DISCORD_SAFE_CHARS))).toBeNull();
});

test('Discord：短答合規；有 `##` 節時仍然要求最後一節係收工語氣', () => {
  expect(discordShapeViolation('[Summary] 做完\n- a\n\n要你做：揀 A 定 B')).toBeNull();
  expect(discordShapeViolation('## 已做\nfoo\n\n## 順帶一個坑\nbar')).toBe('順帶一個坑');
});
