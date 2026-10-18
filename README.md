# comsnet-mcp

**Give Claude Code (or any MCP client) a seat at the Pi agent table.**

`comsnet-mcp` is a stdio MCP server that registers your CLI coding session as a
peer on a [coms-net](https://github.com/disler/pi-vs-claude-code) hub: it can
list peers, send work to them, read its inbox, and reply — with the same
identity model the Pi agents use.

```
┌──────────────┐   MCP (stdio)   ┌──────────────┐   HTTP/SSE   ┌────────────┐
│ Claude Code  │ ──────────────▶ │ comsnet-mcp  │ ───────────▶ │ coms-net   │
│ (this repo)  │ ◀────────────── │   bridge     │ ◀─────────── │    hub     │
└──────────────┘                 └──────────────┘              └────────────┘
                                                                     ▲
                                                          Pi agents, other
                                                          CLI peers, workers
```

## Why

Multi-agent setups usually stop at "one orchestrator, many subprocesses". Once
you run several *interactive* tools side by side — Claude Code in one pane, Pi
agents in another, a headless worker in a third — they can't see each other.

coms-net already solves that for Pi. This bridge makes the same hub reachable
from any MCP client, so a Claude Code session becomes an addressable peer
instead of an island.

## Status

Early. The bridge is in daily use on a private fleet; this repository is the
extracted, dependency-free public cut. No npm package yet — run from source.

## Quick start

```bash
# 1. have a coms-net hub running (see upstream repo)
# 2. give the bridge a hub endpoint
export COMS_NET_HUB=http://127.0.0.1:8787      # or let it read ~/.pi/coms-net/server.json

# 3. register the server with your MCP client, e.g. Claude Code
claude mcp add comsnet -- bun /path/to/comsnet-mcp/src/mcp.ts
```

Then, inside the session:

```
> use comsnet_inbox to see if anything is waiting
> use comsnet_send to ask "pi-agent" for the current GPU lane status
```

## Tools exposed

| tool | purpose |
|---|---|
| `comsnet_status` | one-line presence/registration status |
| `comsnet_list_agents` | peers currently on the hub, with model + status (`include_subagents` opt-in) |
| `comsnet_send` | start a conversation with a peer; returns `msg_id` (`wait:true` to block) |
| `comsnet_inbox` | read inbound prompts addressed to this session |
| `comsnet_respond` | reply to an inbound prompt |

Replies are delivered as a follow-up turn ("you were nudged") rather than by
polling — see `src/lib/coms-net-client.ts` for the SSE stream that powers it.

## Loop safety

Two mechanisms are on by default because unbounded agent-to-agent chatter is a
real failure mode we hit:

- **hop limit** — forwarded messages carry a hop counter; past the limit the
  hub refuses to keep relaying (`PI_COMS_NET_MAX_HOPS`, default 5).
- **reply shape guard** (`src/lib/output-shape.ts`) — a peer reply that is
  structured but ends on a non-conclusion section is flagged, so a fleet
  doesn't drown in "here is my analysis, thoughts?" turns.

## Repo layout

```
src/mcp.ts            MCP stdio server (newline-delimited JSON-RPC)
src/headless-peer.ts  non-interactive worker peer (for `claude -p` style jobs)
src/lib/              hub client: discovery, registration, heartbeat, SSE, inbox
test/                 protocol + lifetime + inbox-authority tests
```

## Tests

```bash
bun test                  # unit suites: no network, no hub, no private paths
COMSNET_E2E=1 bun test    # + suites that need a hub checkout / live terminal fleet
```

32 pass / 19 skip / 0 fail on a bare checkout. See [`test/README.md`](test/README.md)
for why the environment-dependent suites are gated.

## Credits & prior art

See [`NOTICE`](NOTICE). coms-net protocol © Dan Disler (MIT).

## Licence

MIT — see [`LICENSE`](LICENSE).
