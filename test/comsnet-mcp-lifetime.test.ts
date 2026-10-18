/**
 * Issue #261 — an MCP server must not outlive the REPL it serves.
 *
 * A leaked comsnet-mcp keeps a hub registration, keeps buffering replies nobody
 * can drain, and keeps typing tmux nudges into whatever pane now carries its
 * @squad_agent tag — which traps the peer in a loop where the nudge claims N
 * pending replies and comsnet_inbox reports empty.
 *
 * These are process-level tests on the REAL script: the guards are about process
 * lifetime, so mocking them out would test nothing. No hub is started on purpose —
 * the connect/heartbeat loops retry forever, so this also proves a guard fires
 * while those loops are spinning (the exact state the orphans were found in).
 */
import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO = new URL('..', import.meta.url).pathname;
const MCP = path.join(REPO, 'src', 'mcp.ts');
const RUN_DIR = path.join(os.homedir(), '.pi', 'coms-net', 'run');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(250);
  }
  return false;
}

async function waitForFile(file: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = fs.readFileSync(file, 'utf-8').trim();
      if (v) return v;
    } catch { /* not yet */ }
    await sleep(200);
  }
  return null;
}

/** Unique per run so concurrent/repeat runs never fight over the same lock file. */
function uniqueName(label: string): string {
  return `lifetime-${label}-${process.pid}`;
}

describe.skipIf(!(process.env.COMSNET_E2E === '1'))('comsnet-mcp lifetime guards (Issue #261)', () => {
  test('exits when its parent dies (orphan reparented to init)', async () => {
    const name = uniqueName('orphan');
    const project = `comsnet-lifetime-${process.pid}`;
    const pidFile = path.join(os.tmpdir(), `${name}.child`);
    const fifo = path.join(os.tmpdir(), `${name}.stdin`);
    try { fs.unlinkSync(pidFile); } catch { /* fine */ }
    try { fs.unlinkSync(fifo); } catch { /* fine */ }
    spawnSync('mkfifo', [fifo]);

    // Hold BOTH ends ourselves (O_RDWR opens a fifo without blocking). This is the
    // whole point: the MCP's stdin stays open even after its parent dies, which is
    // exactly the state the real orphans were found in — so the stdin-EOF path
    // cannot be what ends it here. Only the ppid watchdog can.
    const fifoFd = fs.openSync(fifo, fs.constants.O_RDWR);

    // An intermediate `sh` we can kill while leaving the MCP running — the
    // tmux-kill-pane shape. `< fifo` overrides the /dev/null that a POSIX shell
    // otherwise hands to a background job.
    const parent = spawn(
      'sh',
      ['-c', `bun ${JSON.stringify(MCP)} --project ${project} --name ${name} < ${JSON.stringify(fifo)} & echo $! > ${JSON.stringify(pidFile)}; sleep 120`],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );

    const raw = await waitForFile(pidFile, 15_000);
    expect(raw, 'MCP child pid was never recorded').toBeTruthy();
    const childPid = parseInt(raw!, 10);
    expect(Number.isFinite(childPid)).toBeTrue();

    // It must be up and stay up while its parent lives.
    await sleep(2_000);
    expect(alive(childPid), 'MCP died before the parent was killed').toBeTrue();

    parent.kill('SIGKILL');

    // Watchdog polls every 5s; allow a couple of cycles plus deregister slack.
    const exited = await waitForExit(childPid, 25_000);
    if (!exited) try { process.kill(childPid, 'SIGKILL'); } catch { /* cleanup */ }
    try { fs.closeSync(fifoFd); } catch { /* cleanup */ }
    try { fs.unlinkSync(fifo); } catch { /* cleanup */ }
    try { fs.unlinkSync(pidFile); } catch { /* cleanup */ }
    // A SIGKILLed child never runs its exit hook, so drop its lock file here.
    try { fs.unlinkSync(path.join(RUN_DIR, `mcp-${project}-${name}.pid`)); } catch { /* cleanup */ }
    expect(exited, `orphan MCP ${childPid} outlived its parent`).toBeTrue();
  }, 45_000);

  test('a second instance supersedes the first for the same (project, name)', async () => {
    const name = uniqueName('singleton');
    const project = `comsnet-lifetime-${process.pid}`;
    const lockFile = path.join(RUN_DIR, `mcp-${project}-${name}.pid`);
    try { fs.unlinkSync(lockFile); } catch { /* fine */ }

    const first = spawn('bun', [MCP, '--project', project, '--name', name], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const firstLock = await waitForFile(lockFile, 15_000);
    expect(firstLock, 'first instance never claimed the lock').toBe(String(first.pid));

    const second = spawn('bun', [MCP, '--project', project, '--name', name], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });

    const firstExited = await waitForExit(first.pid!, 20_000);
    expect(firstExited, 'the superseded instance kept running').toBeTrue();

    // And the survivor owns the lock.
    const deadline = Date.now() + 10_000;
    let owner = '';
    while (Date.now() < deadline) {
      owner = (await waitForFile(lockFile, 1_000)) ?? '';
      if (owner === String(second.pid)) break;
    }
    expect(owner).toBe(String(second.pid));

    second.kill('SIGTERM');
    await waitForExit(second.pid!, 10_000);
    try { fs.unlinkSync(lockFile); } catch { /* cleanup */ }
  }, 60_000);

  test('exits on stdin EOF rather than lingering on its retry loops', async () => {
    const name = uniqueName('stdineof');
    const project = `comsnet-lifetime-${process.pid}`;
    // stdio 'ignore' gives the child /dev/null on stdin → immediate EOF.
    const proc = spawn('bun', [MCP, '--project', project, '--name', name], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const exited = await waitForExit(proc.pid!, 20_000);
    if (!exited) try { process.kill(proc.pid!, 'SIGKILL'); } catch { /* cleanup */ }
    expect(exited, 'MCP kept running after stdin closed').toBeTrue();
  }, 30_000);
});

// Sanity: the guards must be present in the source, so a refactor that drops one
// fails loudly even if the process-level tests are skipped on a constrained host.
describe('comsnet-mcp guard wiring', () => {
  const src = fs.readFileSync(MCP, 'utf-8');

  test('nudges only the pane we actually live under', () => {
    expect(src).toContain('isAncestorOfUs');
    expect(src).toContain('#{pane_pid}');
  });

  test('drops duplicate replies instead of re-counting them', () => {
    expect(src).toContain('replies.some((rp) => rp.msg_id === mid)');
  });

  test('shown-but-unacked replies stop driving nudges', () => {
    expect(src).toContain('replies.filter((r) => !r.shown)');
  });

  test('startup claims the singleton lock and the watchdog runs', () => {
    expect(src).toContain('claimSingletonLock()');
    expect(src).toContain('startParentWatchdog()');
  });
});

describe.skipIf(!(process.env.COMSNET_E2E === '1'))('coms-net-server replay cap (Issue #261)', () => {
  // Hub source is not part of this repo; only read it when explicitly running E2E.
  const hubSrcPath = path.join(REPO, 'scripts', 'coms-net-server.ts');
  const src = process.env.COMSNET_E2E === '1' && fs.existsSync(hubSrcPath)
    ? fs.readFileSync(hubSrcPath, 'utf-8')
    : '';

  test('terminal outcomes are not replayed forever to a sender that never acks', () => {
    expect(src).toContain('MAX_COMPLETION_REPLAYS');
    expect(src).toContain('completion_replays');
  });
});
