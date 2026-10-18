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

> **Built on coms-net by [IndyDevDan](https://github.com/disler/pi-vs-claude-code) (MIT).**
> The hub, its protocol and the Pi client are his work; this repository is the
> MCP-side bridge, written independently against the same wire protocol.
> See [`NOTICE`](NOTICE) for the full lineage.

## Status

Early. The bridge is in daily use on a private fleet; this repository is the
extracted, dependency-free public cut. No npm package yet — run from source.

## What you need

Two pieces, and this repository is only the second one:

1. **A coms-net hub** — the upstream server (`scripts/coms-net-server.ts` in
   [disler/pi-vs-claude-code](https://github.com/disler/pi-vs-claude-code)). It
   owns the message store and hands out `server.json` + a token.
2. **This bridge** — the MCP side.

If you never ran the Pi toolchain, you do not need it: start the hub, then point
the bridge at it explicitly instead of relying on discovery:

```bash
claude mcp add comsnet -- bun /path/to/comsnet-mcp/src/mcp.ts \
  --server-url http://127.0.0.1:<hub-port> --auth-token <token-from-hub>
```

Your CLI also has to be able to host an MCP server. Claude Code, Codex, Cursor,
Zed and Windsurf can; a plain shell script cannot — for those, run
`src/headless-peer.ts` as a worker process instead, or talk to the hub's HTTP API
directly.

## Quick start

You need a coms-net **hub** running for the project you want to join (that is
the upstream repository — this repo ships only the MCP side).

```bash
# 1. who am I, and which hub project am I joining?
export PI_COMS_NET_PROJECT=default        # default: "default"
export PI_COMS_AGENT_NAME=claude-code     # the name peers address you by
# optional: PI_COMS_AGENT_MODEL, PI_COMS_NET_AUTH_TOKEN

# 2. hub discovery is automatic: the bridge reads
#    ~/.pi/coms-net/projects/<project>/{server.json,server.secret.json}
#    (a restarted hub rewrites the port there and the client follows it)

# 3. register the server with your MCP client — example for Claude Code
claude mcp add comsnet -- bun /path/to/comsnet-mcp/src/mcp.ts
#    any MCP stdio client works; server name and args are up to you
```

| flag / env | default | meaning |
|---|---|---|
| `--project` / `PI_COMS_NET_PROJECT` | `default` | hub project directory to join |
| `--name` / `PI_COMS_AGENT_NAME` | `claude` | peer name others address |
| `--model` / `PI_COMS_AGENT_MODEL` | `sonnet` | reported model label |
| `--provider` | `claude-code` | agent kind tag for monitors |
| `--server-url` / `PI_COMS_NET_SERVER_URL` | discovered | hub URL when you have no `~/.pi/coms-net` layout |
| `--auth-token` / `PI_COMS_NET_AUTH_TOKEN` | discovered | hub token; required whenever the URL is set |
| `COMSNET_SHAPE_LOG` | `$TMPDIR/comsnet-output-shape.jsonl` | reply-shape guard log |

## Connecting a client

The bridge is a plain **MCP stdio server**, so any MCP-capable tool can host it.
Three cases, deliberately different:

### Claude Code

```bash
claude mcp add comsnet -- bun /path/to/comsnet-mcp/src/mcp.ts
# or commit a project-scoped .mcp.json:
# { "mcpServers": { "comsnet": { "command": "bun", "args": ["/path/to/comsnet-mcp/src/mcp.ts"] } } }
```

### Codex

Codex reads its own TOML config (`~/.codex/config.toml`):

```toml
[mcp_servers.comsnet]
command = "bun"
args = ["/path/to/comsnet-mcp/src/mcp.ts"]
env = { PI_COMS_NET_PROJECT = "default", PI_COMS_AGENT_NAME = "codex" }
```

Pass `--provider codex` in `args` if you want monitors to tag the peer as Codex
rather than Claude Code.

### Pi

**Don't use this bridge.** Pi agents join coms-net natively through the
`coms-net.ts` extension in the upstream repo — same hub, same tools, no MCP hop.
Use `comsnet-mcp` for the clients that *cannot* load a Pi extension.

## Do I need a squad UI / pane manager?

No. Peers are addressed **by name** on the hub:

```
comsnet_list_agents            → everyone online, with model + status
comsnet_send(target: "pi-agent") → deliver work to that name
comsnet_inbox / comsnet_respond  → the reverse direction
```

There is no registry to synchronise and no launcher to install. A "squad" view
and a tmux/herdr pane driver are *optional operator conveniences* — the pane
driver only matters for the headless-worker mode (`src/headless-peer.ts`), which
needs to locate a terminal pane to nudge. Interactive MCP clients need none of
that: they are already the pane.


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

- **hop ceiling** — forwarded conversations carry a hop counter. The **hub** is
  the enforcement point (upstream `PI_COMS_NET_MAX_HOPS`, default 5); this
  bridge carries the count and does not raise it. Set it on the hub, not here.
- **reply shape guard** (`src/lib/output-shape.ts`) — a peer reply that is
  structured but ends on a non-conclusion section is *logged*, never blocked
  (heuristics misjudge; a human must be able to see and fix the rule).

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
