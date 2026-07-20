# Backtest data provenance

`backtest-results.jsonl` (105 fixtures, generated 2026-07-19) was computed
from a **local pre-captured historical archive**, not by calling the live
TxLINE API 105 times — every record's `dataSource` field says
`"local-archive"`.

## Why

The team was asked to be gentle on the TxLINE free-tier API for a sweep this
size — one fixture alone can be 60k+ rows / tens of MB. A shared, read-only,
already-captured archive of the same World Cup fixtures existed on this box
(`~/code/txodds/txline-capture/capture/historical/`, 105 fixture
directories). Using it as primary source turned a sweep that would otherwise
have made 105+ live API calls into a ~42-second run with effectively zero
additional load on the free-tier API.

## Validation

Before trusting the substitution, the archive was spot-checked against 2
live `GET /api/odds/updates/{fixtureId}` / `GET /api/scores/snapshot/{fixtureId}`
calls for fixtures already present in the archive — the live responses
matched the archived data for both. This is a spot check, not an exhaustive
verification of all 105 fixtures against live data.

## Separately: fidelity of the detection math itself

`src/backtest.ts` is a standalone copy of `src/livewatch.ts`'s detection
math (kept separate deliberately — `livewatch.ts` powers the still-live
production page and is not touched by this work). Its fidelity to the real,
shipped detector was verified by running it against **today's live World Cup
Final fixture** (not the archive) via its live-API fallback and diffing the
result against a fresh call to production `liveWatch()`: exact match on
rule, outcome, `tsDetect`, and `zPeak` for every alert present at check time.

## Calibration caveat (binding, per team ruling 2026-07-19)

`suppressionCheck.clean: true` on every alert is close to tautological —
`detect()` already excludes event windows before an alert fires, so "clean"
confirms internal self-consistency, not that these are meaningful integrity
signals. The sweep found ~2.6 alerts/fixture at the same `zFire=5` threshold
tuned for one match's single-book noise profile — most likely a sign the
threshold doesn't generalize across fixtures with different liquidity/noise
characteristics, not evidence of widespread anomalies. This artifact
demonstrates backtest **capability**, not a validated tournament-wide
integrity claim. Per-market threshold calibration is the identified next
step before these counts mean anything as a standalone signal.
