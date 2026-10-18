import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const registry = join(root, '.pi/agents/squads/_runtime/herdr-squads');
const projects = (existsSync(registry) ? readdirSync(registry) : [])
  .filter((file) => file.endsWith('.json'))
  .filter((file) => JSON.parse(readFileSync(join(registry, file), 'utf8')).backend === 'herdr');

function selectedDriver(project: string, backend?: string): string {
  const env = { ...process.env };
  const name = `backend-probe-${crypto.randomUUID()}`;
  delete env.PI_SQUAD_BACKEND;
  if (backend) env.PI_SQUAD_BACKEND = backend;
  const result = Bun.spawnSync([
    'bun', '-e',
    'process.argv = ["bun", "probe", "--project", process.env.PROBE_PROJECT,'
      + ' "--name", process.env.PROBE_NAME, "--cwd", process.cwd()];'
      + ' const m = await import("../src/mcp.ts"); m.createPaneDriver();',
  ], { cwd: root, env: { ...env, PROBE_PROJECT: project, PROBE_NAME: name } });
  rmSync(join(homedir(), '.pi/coms-net/run', `mcp-${project}-${name}.log`), { force: true });
  expect(result.exitCode).toBe(0);
  return result.stderr.toString();
}

test.skipIf(projects.length === 0)('real herdr squad selects herdr without inherited env', () => {
  const project = projects[0].replace(/\.json$/, '');
  expect(selectedDriver(project)).toContain('pane driver: herdr');
});

test.skipIf(projects.length === 0)('explicit tmux override wins over herdr registry', () => {
  const project = projects[0].replace(/\.json$/, '');
  expect(selectedDriver(project, 'tmux')).toContain('pane driver: tmux');
});

test.skipIf(!(process.env.COMSNET_E2E === '1'))('unregistered project retains tmux default', () => {
  expect(selectedDriver(`unregistered-${crypto.randomUUID()}`)).toContain('pane driver: tmux');
});
