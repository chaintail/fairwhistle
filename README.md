# 🛡️ FairWhistle

**Match-integrity surveillance agent** — an autonomous agent that watches odds
microstructure for patterns consistent with fixing or informed money, and
publishes timestamped, cryptographically attested alerts.

**Live demo:** https://fairwhistle.vercel.app
**Track:** Trading Tools and Agents (TxODDS World Cup hackathon)

---

## Why this exists

Sports-betting integrity monitoring is a real industry: leagues, regulators and
tribunals pay for evidence-grade detection of suspicious market behavior. Every
fixing scandal starts as a price pattern someone saw too late. A high-frequency
multi-book odds feed like **TxLINE** is exactly the raw material an integrity
desk needs — FairWhistle is the machine that turns it into signed, auditable,
court-ready alerts. It positions TxLINE data for a market beyond traders:
**regulators and leagues.**

## What the agent does — autonomously

```
        ┌──────────────┐    ┌────────────────┐    ┌──────────────────┐
feed ──▶│  FeedAdapter │───▶│   Detectors    │───▶│   Attestation    │──▶ dashboard
        │ (TxLINE seam)│    │ 3 transparent  │    │ sha256 fingerprint│    /api/alerts
        │ replay tape  │    │ microstructure │    │ ed25519 signature │    /api/feed (SSE)
        │ (this demo)  │    │ rules, causal  │    │ devnet anchor     │    devnet memo
        └──────────────┘    └────────────────┘    └──────────────────┘
```

1. **Ingest** a normalized multi-book in-play odds stream (4 books, 1X2 + OU 2.5).
2. **Detect** with three explainable microstructure rules (no black box — every
   alert carries its z-scores, thresholds and evidence window):
   - **Velocity** — abnormal repricing vs trailing baseline volatility, outside
     public-event windows: price moving on information the market doesn't have.
   - **Cross-market coordination** — abnormal moves landing across ≥3 books and
     ≥2 markets in the same seconds, with no public trigger.
   - **Stale-then-snap** — a book freezing its board while consensus drifts,
     then repricing the gap in one tick: liquidity pulled while holding exposure.
3. **Attest** every detection:
   - cycle-invariant **detection fingerprint** = sha256 of the canonical detection core,
   - per-cycle **instance** signed live with the agent's **Ed25519** key,
   - fingerprint **anchored on Solana devnet** via memo transaction.
4. **Publish**: surveillance dashboard, attested JSON feed (`/api/alerts`),
   SSE push stream (`/api/feed`). Signature verification runs in your browser.

Crucially, repricing on **public** information (goals, cards) is *suppressed* —
a healthy market reacting to news is not suspicious. The agent hunts moves that
public information cannot explain.

## Autonomous by construction

There is no operator, no cron, no long-running process to babysit. The replay
clock is keyed to wall time against a fixed epoch, and detection is a pure
function of the stream prefix — so every serverless instance, on any request,
independently computes the identical agent state, alerts and signatures.
Deploy it and walk away: it is *incapable* of needing manual intervention.

## What is synthetic vs real (full honesty)

| Component | Status |
|---|---|
| Odds stream | **Synthetic deterministic tape**, TxLINE-shaped (4 books, per-second quotes), with **3 planted anomalies — openly labeled in the UI**. No live TxODDS data is used. |
| Detectors | **Real** — they read only the odds stream; scenario metadata is never passed to them. They run unchanged on a live feed. |
| Match events | Scripted fixture events (goal / red card / goal) used for suppression logic. |
| Ed25519 signatures | **Real**, signed at detection time each cycle, verifiable in-browser (WebCrypto) or via `/api/verify`. |
| Solana anchors | **Real devnet memo transactions** ([Memo program](https://spl.solana.com/memo)) — explorer links in the UI. Devnet, not mainnet, and labeled as such. |
| Live TxLINE ingestion | **Plug-in seam** (`src/feed.ts` → `TxLineAdapter` stub): subscribe, normalize to `OddsTick`, hand the same `history()` view to the detectors. Nothing else changes. |

## Repo tour

```
src/
  fixture.ts    the synthetic tape: prob model, book noise, planted scenarios
  feed.ts       FeedAdapter seam (ReplayAdapter today, TxLineAdapter in prod)
  detectors.ts  the three rules + dedupe + evidence assembly
  attest.ts     canonical JSON, sha256, ed25519 sign/verify
  clock.ts      wall-clock-keyed replay position
  state.ts      agent state assembly + per-cycle signing + anchor join
api/            Vercel functions: state, alerts, feed (SSE), verify, meta
public/         dashboard (vanilla JS + SVG, zero frontend deps)
scripts/        gen-key, anchor-devnet, test-cycle, dev-server
data/anchors.json  devnet anchor records (real tx signatures)
```

## Run it

```bash
pnpm install
pnpm test:cycle          # deterministic detection test: exactly 3 alerts, attestation round-trip
pnpm gen:key             # generate agent Ed25519 keypair → FAIRWHISTLE_SIGNING_KEY
PORT=3000 npx tsx scripts/dev-server.ts   # local harness at localhost:3000
pnpm anchor:devnet       # anchor fingerprints on Solana devnet (needs devnet SOL)
vercel deploy --prod     # production
```

Without `FAIRWHISTLE_SIGNING_KEY` the agent generates an ephemeral instance key
and says so in the UI — it never fakes a signature.

## API

| Endpoint | What |
|---|---|
| `GET /api/state?since=<tick>` | replay position, tape increments, events, signed alerts |
| `GET /api/alerts` | attested alert feed (fingerprint, instance, signature, anchor) |
| `GET /api/feed` | SSE push stream (snapshot + live alert events) |
| `GET /api/meta` | agent identity, fixture id, detector params, fingerprints |
| `POST /api/verify` | server-side signature verification fallback |

## Verifying an alert yourself

```
instance      = { coreHash, cycle, detectedAt, agentPubKey }   # from /api/alerts
message       = canonical_json(instance)                      # sorted keys, no whitespace
valid         = ed25519_verify(agentPubKey, message, signature)
fingerprint   = alert.coreHash  →  devnet memo: fairwhistle:v1:<fixtureId>:<rule>:<coreHash>
```

The dashboard's **Verify signature** button does exactly this in your browser.

---

Built solo in one day for the Superteam Earn × TxODDS World Cup hackathon.
MIT license.
