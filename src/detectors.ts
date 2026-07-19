/**
 * Microstructure integrity detectors.
 *
 * Deliberately transparent, explainable rules — no black box. Every alert
 * carries the exact rule, thresholds, z-scores and the evidence window that
 * tripped it, so a league integrity desk (or a judge) can audit the call.
 *
 * All three detectors are causal (look only backward), so running them over
 * the full tape once and filtering by the replay position is identical to
 * running them tick-by-tick. Public match events (goals, cards) SUPPRESS
 * alerts in a window around the event: repricing on public information is
 * exactly what a healthy market should do. What we hunt is repricing that
 * public information cannot explain.
 */

import {
  BOOKS,
  EVENTS,
  MARKET_OF,
  OUTCOME_LABEL,
  OUTCOMES,
  type Outcome,
  type TickQuotes,
} from "./fixture.js";
import { consensus } from "./feed.js";
import { canonicalJson, sha256Hex } from "./attest.js";

// ---- Tunable rule parameters (audited in every alert's evidence.params) ----
export const PARAMS = {
  velocity: {
    windowS: 20, // return horizon
    trailingS: 120, // trailing window for baseline volatility
    sigmaFloor: 0.006, // min 20s log-return stddev (guards quantized/quiet tape)
    zFire: 5, // |z| threshold
    sustainS: 3, // consecutive seconds above threshold
    cooldownS: 120,
  },
  crossMarket: {
    windowS: 8,
    zFire: 4,
    minBooks: 3,
    minMarkets: 2,
    minPairs: 5, // (book,outcome) pairs abnormal in the same bucket
    cooldownS: 120,
  },
  staleSnap: {
    minFrozenS: 25, // full board unchanged at least this long
    consensusMove: 0.015, // consensus drifted ≥1.5% during the freeze
    snapMove: 0.025, // ≥2.5% single-tick reprice after the freeze
    snapWithinS: 15,
  },
  eventSuppressPreS: 2, // suppress from just before the event feed-tick…
  eventSuppressPostS: 25, // …to well after books finish repricing it
  dedupeClusterS: 20,
} as const;

export type Rule = "velocity" | "cross_market" | "stale_snap";
const RULE_PRIORITY: Record<Rule, number> = { stale_snap: 0, cross_market: 1, velocity: 2 };

export interface EvidenceSeries {
  label: string;
  points: [number, number][]; // [tick, value]
}

export interface Evidence {
  window: [number, number];
  series: EvidenceSeries[];
  zSeries: [number, number][];
  params: Record<string, number | string>;
}

export interface AlertCore {
  project: "fairwhistle";
  v: 1;
  fixtureId: string;
  rule: Rule;
  books: string[];
  outcomes: Outcome[];
  tStart: number;
  tDetect: number;
  zPeak: number;
  headline: string;
  narrative: string;
  evidenceHash: string;
}

export interface Alert {
  id: string; // first 12 hex chars of coreHash
  coreHash: string;
  core: AlertCore;
  evidence: Evidence;
  severity: "high" | "critical";
}

interface Candidate {
  rule: Rule;
  tStart: number;
  tDetect: number;
  books: string[];
  outcomes: Outcome[];
  zPeak: number;
  zSeries: [number, number][];
  extra: Record<string, number | string>;
}

function inEventWindow(t: number): boolean {
  return EVENTS.some(
    (e) => t >= e.t - PARAMS.eventSuppressPreS && t <= e.t + PARAMS.eventSuppressPostS,
  );
}

/** True if the return window [t-w, t] overlaps any event repricing window. */
function windowTouchesEvent(t: number, w: number): boolean {
  for (let s = t - w; s <= t; s++) if (inEventWindow(s)) return true;
  return false;
}

function logRet(series: number[], t: number, w: number): number {
  if (t - w < 0) return 0;
  return Math.log(series[t] / series[t - w]);
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
}

/** odds[bookId][outcome] = number[] indexed by tick. */
function buildMatrix(ticks: TickQuotes[]): Record<string, Record<Outcome, number[]>> {
  const m: Record<string, Record<Outcome, number[]>> = {};
  for (const b of BOOKS) {
    m[b.id] = { h: [], d: [], a: [], o: [], u: [] };
    for (const tq of ticks) for (const oc of OUTCOMES) m[b.id][oc].push(tq[b.id][oc]);
  }
  return m;
}

function velocityCandidates(
  ticks: TickQuotes[],
  mat: Record<string, Record<Outcome, number[]>>,
): Candidate[] {
  const P = PARAMS.velocity;
  const out: Candidate[] = [];
  const cooldownUntil: Record<string, number> = {};
  for (const b of BOOKS) {
    for (const oc of OUTCOMES) {
      const s = mat[b.id][oc];
      let run = 0;
      let zRun: [number, number][] = [];
      for (let t = P.trailingS + P.windowS; t < ticks.length; t++) {
        if ((cooldownUntil[b.id] ?? -1) >= t) continue;
        if (windowTouchesEvent(t, P.windowS)) {
          run = 0;
          zRun = [];
          continue;
        }
        // Baseline volatility from the trailing window, EXCLUDING event
        // repricing ticks — public-news jumps must not desensitize the rule.
        const rets1: number[] = [];
        for (let s2 = t - P.trailingS; s2 < t; s2++) {
          if (!windowTouchesEvent(s2, 1)) rets1.push(logRet(s, s2, 1));
        }
        const sigma20 = Math.max(stddev(rets1) * Math.sqrt(P.windowS), P.sigmaFloor);
        const z = logRet(s, t, P.windowS) / sigma20;
        if (Math.abs(z) >= P.zFire) {
          run++;
          zRun.push([t, Number(z.toFixed(2))]);
          if (run >= P.sustainS) {
            const tDetect = t;
            out.push({
              rule: "velocity",
              tStart: t - P.windowS - P.sustainS,
              tDetect,
              books: [b.id],
              outcomes: [oc],
              zPeak: Math.max(...zRun.map((p) => Math.abs(p[1]))),
              zSeries: zRun,
              extra: { windowS: P.windowS, zFire: P.zFire, sigmaFloor: P.sigmaFloor },
            });
            cooldownUntil[b.id] = t + P.cooldownS;
            run = 0;
            zRun = [];
          }
        } else {
          run = 0;
          zRun = [];
        }
      }
    }
  }
  return out;
}

function crossMarketCandidates(
  ticks: TickQuotes[],
  mat: Record<string, Record<Outcome, number[]>>,
): Candidate[] {
  const P = PARAMS.crossMarket;
  const out: Candidate[] = [];
  let cooldownUntil = -1;
  for (let t = 140; t < ticks.length; t++) {
    if (t <= cooldownUntil) continue;
    if (windowTouchesEvent(t, P.windowS)) continue;
    const abnormal: { book: string; oc: Outcome; z: number }[] = [];
    for (const b of BOOKS) {
      for (const oc of OUTCOMES) {
        const s = mat[b.id][oc];
        const rets1: number[] = [];
        for (let s2 = t - 120; s2 < t; s2++) {
          if (!windowTouchesEvent(s2, 1)) rets1.push(logRet(s, s2, 1));
        }
        const sigma = Math.max(stddev(rets1) * Math.sqrt(P.windowS), 0.006);
        const z = logRet(s, t, P.windowS) / sigma;
        if (Math.abs(z) >= P.zFire) abnormal.push({ book: b.id, oc, z });
      }
    }
    const books = new Set(abnormal.map((x) => x.book));
    const markets = new Set(abnormal.map((x) => MARKET_OF[x.oc]));
    if (abnormal.length >= P.minPairs && books.size >= P.minBooks && markets.size >= P.minMarkets) {
      out.push({
        rule: "cross_market",
        tStart: t - P.windowS,
        tDetect: t,
        books: [...books].sort(),
        outcomes: [...new Set(abnormal.map((x) => x.oc))].sort() as Outcome[],
        zPeak: Math.max(...abnormal.map((x) => Math.abs(x.z))),
        zSeries: abnormal.map((x) => [t, Number(x.z.toFixed(2))] as [number, number]),
        extra: {
          windowS: P.windowS,
          zFire: P.zFire,
          abnormalPairs: abnormal.length,
          booksInvolved: books.size,
          marketsInvolved: markets.size,
        },
      });
      cooldownUntil = t + P.cooldownS;
    }
  }
  return out;
}

function staleSnapCandidates(ticks: TickQuotes[]): Candidate[] {
  const P = PARAMS.staleSnap;
  const out: Candidate[] = [];
  for (const b of BOOKS) {
    let frozenSince = -1;
    for (let t = 1; t < ticks.length; t++) {
      const same = OUTCOMES.every((oc) => ticks[t][b.id][oc] === ticks[t - 1][b.id][oc]);
      if (same) {
        if (frozenSince < 0) frozenSince = t - 1;
        continue;
      }
      // Board just moved at t after a frozen run [frozenSince .. t-1].
      if (frozenSince >= 0) {
        const frozenLen = t - 1 - frozenSince;
        if (frozenLen >= P.minFrozenS) {
          // Did consensus (other books) drift while this board was frozen?
          let consMove = 0;
          let movedOc: Outcome = "h";
          for (const oc of OUTCOMES) {
            const c0 = consensus(ticks[frozenSince], oc, b.id);
            const c1 = consensus(ticks[t - 1], oc, b.id);
            const mv = Math.abs(Math.log(c1 / c0));
            if (mv > consMove) {
              consMove = mv;
              movedOc = oc;
            }
          }
          if (consMove >= P.consensusMove) {
            // Snap: a large single-tick reprice shortly after the freeze ends.
            for (let s = t; s < Math.min(t + P.snapWithinS, ticks.length); s++) {
              let snap = 0;
              let snapOc: Outcome = movedOc;
              for (const oc of OUTCOMES) {
                const mv = Math.abs(Math.log(ticks[s][b.id][oc] / ticks[s - 1][b.id][oc]));
                if (mv > snap) {
                  snap = mv;
                  snapOc = oc;
                }
              }
              if (snap >= P.snapMove && !inEventWindow(s)) {
                out.push({
                  rule: "stale_snap",
                  tStart: frozenSince,
                  tDetect: s,
                  books: [b.id],
                  outcomes: [snapOc, movedOc].filter((v, i, arr) => arr.indexOf(v) === i),
                  zPeak: Number((snap / 0.006).toFixed(2)),
                  zSeries: [[s, Number((snap / 0.006).toFixed(2))]],
                  extra: {
                    frozenS: frozenLen,
                    consensusMovePct: Number((consMove * 100).toFixed(2)),
                    snapMovePct: Number((snap * 100).toFixed(2)),
                  },
                });
                break;
              }
            }
          }
        }
        frozenSince = -1;
      }
    }
  }
  return out;
}

function headline(c: Candidate): { headline: string; narrative: string; severity: Alert["severity"] } {
  const bookNames = c.books.map((id) => BOOKS.find((b) => b.id === id)?.name ?? id).join(", ");
  const ocLabels = c.outcomes.map((o) => OUTCOME_LABEL[o]).join(" + ");
  const upcoming = EVENTS.find((e) => e.t > c.tDetect && e.t <= c.tDetect + 90);
  switch (c.rule) {
    case "velocity": {
      const post = upcoming
        ? ` The move PRECEDED a public event (${upcoming.label}) — pattern consistent with informed money acting ahead of non-public information.`
        : "";
      return {
        severity: "high",
        headline: `Abnormal pre-event drift: ${bookNames} · ${ocLabels}`,
        narrative:
          `${bookNames} repriced ${ocLabels} far faster than baseline volatility explains ` +
          `(peak |z| ${c.zPeak.toFixed(1)}, threshold ${PARAMS.velocity.zFire}) with no public match event in the window.${post}`,
      };
    }
    case "cross_market":
      return {
        severity: "critical",
        headline: `Coordinated cross-market move: ${c.extra.booksInvolved} books, ${c.extra.marketsInvolved} markets`,
        narrative:
          `${bookNames} shortened ${ocLabels} together inside an ${PARAMS.crossMarket.windowS}s window ` +
          `(${c.extra.abnormalPairs} abnormal book/outcome pairs, peak |z| ${c.zPeak.toFixed(1)}) with no match event or public trigger — ` +
          `pattern consistent with a coordinated position taken across markets simultaneously.`,
      };
    case "stale_snap":
      return {
        severity: "high",
        headline: `Stale board then snap reprice: ${bookNames}`,
        narrative:
          `${bookNames} froze its entire board for ${c.extra.frozenS}s while market consensus moved ` +
          `${c.extra.consensusMovePct}%, then repriced ${c.extra.snapMovePct}% in a single tick — ` +
          `pattern consistent with a book pulling liquidity while holding exposure.`,
      };
  }
}

function buildEvidence(
  c: Candidate,
  ticks: TickQuotes[],
  mat: Record<string, Record<Outcome, number[]>>,
): Evidence {
  const t0 = Math.max(0, c.tStart - 40);
  const t1 = Math.min(ticks.length - 1, c.tDetect + 15);
  const series: EvidenceSeries[] = [];
  const wanted: { book: string; oc: Outcome }[] = [];
  for (const b of c.books) for (const oc of c.outcomes) wanted.push({ book: b, oc });
  // Cap the series count for readability; evidence hash covers what's shown.
  for (const { book, oc } of wanted.slice(0, 8)) {
    const pts: [number, number][] = [];
    for (let t = t0; t <= t1; t++) pts.push([t, mat[book][oc][t]]);
    const name = BOOKS.find((b) => b.id === book)?.name ?? book;
    series.push({ label: `${name} · ${OUTCOME_LABEL[oc]}`, points: pts });
  }
  // Consensus reference for the primary outcome.
  const primaryOc = c.outcomes[0];
  const consPts: [number, number][] = [];
  for (let t = t0; t <= t1; t++)
    consPts.push([t, Number(consensus(ticks[t], primaryOc, c.books[0]).toFixed(3))]);
  series.push({ label: `Consensus (others) · ${OUTCOME_LABEL[primaryOc]}`, points: consPts });
  return {
    window: [t0, t1],
    series,
    zSeries: c.zSeries,
    params: { rule: c.rule, ...c.extra },
  };
}

/**
 * Full detection pass over a tape prefix. Pure and deterministic:
 * same tape → same alerts, same hashes, every cycle, every instance.
 */
export function detectAlerts(ticks: TickQuotes[], fixtureId: string): Alert[] {
  const mat = buildMatrix(ticks);
  const candidates = [
    ...velocityCandidates(ticks, mat),
    ...crossMarketCandidates(ticks, mat),
    ...staleSnapCandidates(ticks),
  ].sort((a, b) => a.tDetect - b.tDetect || RULE_PRIORITY[a.rule] - RULE_PRIORITY[b.rule]);

  // Cluster candidates within dedupeClusterS; keep highest-priority per cluster.
  const accepted: Candidate[] = [];
  for (const c of candidates) {
    const clash = accepted.find((a) => Math.abs(a.tDetect - c.tDetect) <= PARAMS.dedupeClusterS);
    if (!clash) {
      accepted.push(c);
    } else if (RULE_PRIORITY[c.rule] < RULE_PRIORITY[clash.rule]) {
      accepted[accepted.indexOf(clash)] = c;
    }
  }

  return accepted.map((c) => {
    const { headline: h, narrative, severity } = headline(c);
    const evidence = buildEvidence(c, ticks, mat);
    const core: AlertCore = {
      project: "fairwhistle",
      v: 1,
      fixtureId,
      rule: c.rule,
      books: c.books,
      outcomes: c.outcomes,
      tStart: c.tStart,
      tDetect: c.tDetect,
      zPeak: Number(c.zPeak.toFixed(2)),
      headline: h,
      narrative,
      evidenceHash: sha256Hex(canonicalJson(evidence)),
    };
    const coreHash = sha256Hex(canonicalJson(core));
    return { id: coreHash.slice(0, 12), coreHash, core, evidence, severity };
  });
}
