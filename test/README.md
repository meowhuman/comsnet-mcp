# Tests

```bash
bun test                       # unit suites — no network, no hub, no private paths
COMSNET_E2E=1 bun test         # also run the environment-dependent suites
```

## Why some suites are skipped by default

This repository ships **the bridge only**. Three groups of tests need things a
public checkout does not have, so they are gated behind `COMSNET_E2E=1`:

| suite | needs |
|---|---|
| `coms-net-orphan.test.ts` | a coms-net **hub** checkout (`scripts/coms-net-server.ts`) + a Discord stub |
| `comsnet-mcp-lifetime.test.ts` (process suites) | the same hub, plus the ability to spawn/observe child processes |
| `comsnet-mcp-panedriver.test.ts` (`herdr` / `tmux own-session`) | a live terminal fleet with herdr state (`squads/_runtime/herdr-squads`) or tmux |

Everything else runs against in-process fakes and is deterministic.

> Note: `src/mcp.ts` deliberately keeps an identity `prompt-enrich` hook
> (`src/lib/prompt-enrich.ts`) so the bridge has no dependency on any one
> operator's memory layout.
