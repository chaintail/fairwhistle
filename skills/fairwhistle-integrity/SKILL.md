---
name: fairwhistle-integrity
description: "Use when a trading agent is about to execute or is holding a position on a soccer odds market and wants a pre-trade/in-trade integrity check, or when an agent needs FairWhistle's attested fixing/informed-money alerts, market status, or Ed25519 signature verification. Covers the fairwhistle MCP server's four tools, how to install/run it, honest replay-vs-live caveats, and a described (not implemented) polling pattern for live surveillance during a trade window. Triggers: 'is this market clean', 'check for fixing', 'integrity alert', 'FairWhistle', 'risk desk', fetching /api/alerts or /api/live-state by hand."
---

# FairWhistle — a trading agent's risk desk

FairWhistle is a match-integrity surveillance agent. It watches odds
microstructure (four books, 1X2 + totals 2.5) for patterns consistent with
match fixing or informed money — abnormal repricing velocity, coordinated
cross-market moves, and stale-then-snap board freezes — and publishes every
detection as a timestamped, hashed, **Ed25519-signed** alert. It does not
place trades or make buy/sell calls. It answers one question: *is there a
reason to distrust the current price on this market right now?*

Frame it as the desk a trading agent checks with before it trades, not a
strategy in itself: **check FairWhistle before executing on a market, and
again before holding through a window where you can't react quickly.**

Two sources, always labeled honestly in every tool response:

- **replay** (default) — a committed, seeded, deterministic **synthetic**
  fixture with 3 openly-labeled planted anomalies, replayed on a 10-minute
  wall-clock loop. Always available; useful for demoing/exercising the
  mechanics. Not real market data.
- **live** — the real FIFA World Cup Final via TxLINE **mainnet** consensus
  odds (free tier: single consensus bookmaker, ~60s batch delay —
  informative, not execution-grade latency). May be unconfigured on a given
  deployment, in which case the underlying endpoint returns HTTP 503 and any
  tool wrapping it returns a clear `available:false` result — that is an
  expected, honest state, not a bug, and should not be treated as a crash or
  retried aggressively.

Full write-up: `README.md` in the repo (https://github.com/chaintail/fairwhistle).

## Installing / running the MCP server

The MCP server (`mcp/server.mjs`) is a thin stdio wrapper: every tool call is
a `fetch()` against FairWhistle's existing public HTTP read endpoints on a
running deployment. It adds no detection or attestation logic of its own.

**As a Claude Code plugin** (this repo doubles as the plugin root):

```
/plugin install fairwhistle@<marketplace-or-path>
```

or point Claude Code's plugin loader at a local checkout of the repo root —
it picks up `.claude-plugin/plugin.json` and `.mcp.json`, which wire the
`fairwhistle` MCP server to `node ${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs`.

**Standalone** (any MCP-capable client, including Codex — see the repo
README's "Codex compatibility" section for a `mcp_servers` TOML snippet):

```bash
cd fairwhistle
pnpm install                # pulls in @modelcontextprotocol/sdk + zod
node mcp/server.mjs         # stdio MCP server; talks to fairwhistle.vercel.app
```

Point it at a different deployment (e.g. a local `pnpm dev`) with
`FAIRWHISTLE_BASE_URL`:

```bash
FAIRWHISTLE_BASE_URL=http://localhost:3000 node mcp/server.mjs
```

## The four tools

### `list_active_alerts({ source, severity?, includeEvidence? })`

Wraps `GET /api/alerts` (replay) or `GET /api/live-state` (live). Returns the
full current set of attested alerts: rule, books/outcomes involved, headline,
narrative, z-score, severity, and the Ed25519 `instance`/`signature` needed
to verify each one. `source` defaults to `replay`; `severity` (`high` |
`critical`) filters; `includeEvidence` (default `false`) includes the full
evidence chart series — usually not needed just to decide whether to trade.

```
list_active_alerts({ source: "replay" })
->
{
  "source": "replay", "available": true,
  "honestyNote": "SYNTHETIC FIXTURE — deterministic replayed tape with 3 planted...",
  "alertCount": 2,
  "alerts": [
    { "id": "b8fcc890b3f4", "core": { "rule": "velocity", "outcomes": ["a"],
        "headline": "Abnormal pre-event drift: Cirrus Sports · 1X2 · Away", ... },
      "severity": "high", "instance": {...}, "signature": "...", "anchor": null }
  ]
}
```

### `get_market_status({ source })`

Wraps `GET /api/state` (replay) or `GET /api/live-state` (live). Replay:
current replay cycle/tick, match minute, and score (derived from the
occurred-events log, same as the dashboard). Live: fixture label, feed
game-state string (`scheduled` / `H1` / `HT` / …), and kickoff time.

```
get_market_status({ source: "live" })
-> { "source": "live", "available": true, "fixtureLabel": "FIFA World Cup Final — Spain v Argentina",
     "gameState": "scheduled", "kickoffMs": 1784487900000, "activeAlertCount": 0, ... }
```

### `check_market_integrity({ market, source })`

**The pre-trade tool.** `market` is one of `h`/`d`/`a` (1X2 home/draw/away)
or `o`/`u` (totals 2.5 over/under). Filters currently active alerts down to
the ones touching that outcome and returns a plain verdict: `clean` (nothing
flagged) or `flagged` (matching alerts included, full headline + narrative +
severity so the caller can judge for itself — this tool surfaces evidence,
it does not decide for you).

```
check_market_integrity({ market: "a", source: "replay" })
-> { "verdict": "flagged", "matchingAlertCount": 1,
     "alerts": [ { "core": { "rule": "velocity",
       "narrative": "Cirrus Sports repriced 1X2 · Away far faster than baseline volatility explains ..." } } ] }

check_market_integrity({ market: "d", source: "replay" })
-> { "verdict": "clean", "matchingAlertCount": 0, "alerts": [] }
```

### `verify_alert_signature({ source, alertId?, instance?, signature?, publicKey? })`

Independently checks an alert's Ed25519 signature — wraps `POST /api/verify`
(or `GET /api/verify?id=` for a **replay** alert looked up by id; replay-only
because that lookup is cycle-indexed server-side). For a **live** alert, or
any alert you already have in hand from `list_active_alerts` /
`check_market_integrity`, pass its `instance` + `signature` fields directly
(works for both sources; `publicKey` defaults to `instance.agentPubKey`).

```
verify_alert_signature({ source: "replay", alertId: "b8fcc890b3f4" })
-> { "id": "b8fcc890b3f4", "valid": true, "instanceHash": "...", "coreHash": "..." }
```

## When to reach for FairWhistle

- **Before executing** a trade on a specific outcome: call
  `check_market_integrity({ market, source })`. Treat `flagged` as a reason
  to widen your spread, size down, delay, or skip — not an automatic veto;
  read the narrative, it names the specific pattern and books.
- **Before holding** through a window you can't react quickly in (e.g. about
  to go offline, or executing a multi-leg strategy): call
  `list_active_alerts` for a full sweep across markets, not just the one
  you're about to trade.
- **To sanity-check any alert you're about to act on**: run
  `verify_alert_signature` — don't trust an alert's content without
  confirming the signature, especially if it arrived via a channel other
  than a direct tool call (e.g. pasted into a chat).

## Pattern: monitor/polling during a live trade window (described, not implemented)

For **live** surveillance around an actual trade window, this skill describes
the shape of a polling loop in prose — it is **not** wired up as code, a
scheduled job, or any kind of sub-agent here (sub-agent patterns are
explicitly out of scope for this integration, and Codex plugins don't
support them anyway). An agent following this skill runs the loop step by
step in its own turn, or a host application implements it as a regular
timer:

1. Before opening a position, call `get_market_status({ source: "live" })`
   to confirm the feed is available and see the current game state, then
   `check_market_integrity({ market, source: "live" })` for the specific
   outcome. If `available: false` (no live credentials configured on this
   deployment), that is expected — fall back to whatever other integrity
   signal you have, don't block on FairWhistle.
2. Pick a poll interval sized to the feed's own cadence: live data batches
   roughly every ~60s (documented in every live response's `honestyNote`),
   so polling much faster than that adds nothing. Every 30-60s is
   reasonable during an active trade window; every few minutes is enough
   just to hold a position.
3. On each wake, call `list_active_alerts({ source: "live", severity:
   "critical" })` (or `check_market_integrity` for your specific market) and
   compare against what you saw last poll — only act on *new* alerts, not
   ones you already evaluated.
4. If a new alert appears touching your market, the appropriate action is
   context-specific (widen/size down/exit/escalate to a human) — this skill
   does not prescribe one. Keep the reaction inline in the same
   session/loop that noticed it; do not spawn another agent to handle it.
5. Re-arm for the next interval. Both sources are pure functions of
   time/upstream state, so there is no session state to carry between
   wakes beyond "what alert ids have I already seen."

## Raw HTTP fallback (no MCP)

Every tool is a thin wrapper; an agent without MCP access can hit the same
endpoints directly:

```bash
curl "https://fairwhistle.vercel.app/api/alerts"
curl "https://fairwhistle.vercel.app/api/live-state"
curl "https://fairwhistle.vercel.app/api/meta"
curl -X POST "https://fairwhistle.vercel.app/api/verify" \
  -H 'content-type: application/json' \
  -d '{"instance": {...}, "signature": "...", "publicKey": "..."}'
```

See `public/llms.txt` in the repo for the same fallback aimed at agents
landing on the site directly.
