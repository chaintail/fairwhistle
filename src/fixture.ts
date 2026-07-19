/**
 * Synthetic TxLINE-shaped in-play odds fixture.
 *
 * HONESTY LABEL: this is a deterministic, seeded, synthetic tape — not live
 * TxODDS data. It is shaped like an in-play multi-book odds feed (per-second
 * quotes, 4 books, 1X2 + OU2.5) and carries three PLANTED integrity anomalies
 * so the agent has something to catch on demand. A live TxLINE feed plugs in
 * behind the same FeedAdapter interface (see src/feed.ts) without touching
 * the detectors.
 *
 * The tape covers the first ~75 minutes of a fictional match, replayed on a
 * 10-minute wall-clock loop (1 tick = 1 second of replay = 7.5s of match).
 */

import { mulberry32, gaussian } from "./prng.js";

export const FIXTURE_SEED = 0x5eed_f1f4;
export const TICKS = 600; // 10-minute replay cycle, 1 tick/sec
export const CYCLE_MS = TICKS * 1000;
/** Fixed epoch all instances key the replay clock to (2026-07-19T00:00:00Z). */
export const REPLAY_EPOCH_MS = Date.UTC(2026, 6, 19);

export const MATCH = {
  home: "FC Meridian",
  away: "Atlético Solara",
  competition: "Synthetic Friendly (replayed tape)",
  minutesCovered: 75,
} as const;

/** Replay tick → displayed match minute (600 ticks ≈ 75 minutes). */
export function matchMinute(tick: number): number {
  return Math.floor(tick / 8);
}

export interface Book {
  id: string;
  name: string;
  margin: number; // overround multiplier applied to fair probabilities
  noise: number; // stddev of AR(1) log-price noise per tick
  lag: number; // ticks of latency behind the model price
}

export const BOOKS: Book[] = [
  { id: "alpha", name: "Alpha Exchange", margin: 1.045, noise: 0.0018, lag: 1 },
  { id: "borealis", name: "Borealis Book", margin: 1.05, noise: 0.0022, lag: 2 },
  { id: "cirrus", name: "Cirrus Sports", margin: 1.055, noise: 0.002, lag: 3 },
  { id: "dorado", name: "Dorado Odds", margin: 1.06, noise: 0.0025, lag: 2 },
];

/** Outcome keys: 1X2 home/draw/away + totals over/under 2.5. */
export const OUTCOMES = ["h", "d", "a", "o", "u"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const OUTCOME_LABEL: Record<Outcome, string> = {
  h: "1X2 · Home",
  d: "1X2 · Draw",
  a: "1X2 · Away",
  o: "OU 2.5 · Over",
  u: "OU 2.5 · Under",
};
export const MARKET_OF: Record<Outcome, "1x2" | "ou25"> = {
  h: "1x2",
  d: "1x2",
  a: "1x2",
  o: "ou25",
  u: "ou25",
};

export interface MatchEvent {
  t: number;
  type: "goal" | "red_card";
  team: "home" | "away";
  label: string;
}

/** Public (legitimate) match events. Repricing around these is NOT suspicious. */
export const EVENTS: MatchEvent[] = [
  { t: 180, type: "goal", team: "home", label: "GOAL — FC Meridian 1-0 (22')" },
  { t: 300, type: "red_card", team: "home", label: "RED CARD — FC Meridian down to 10 (37')" },
  { t: 430, type: "goal", team: "away", label: "GOAL — Atlético Solara 1-1 (54')" },
];

/**
 * Planted anomaly scenarios (declared openly — the demo is honest about what
 * is synthetic). Windows are replay ticks.
 */
export interface Scenario {
  id: string;
  rule: "velocity" | "cross_market" | "stale_snap";
  window: [number, number];
  title: string;
  story: string;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "s1-informed-drift",
    rule: "velocity",
    window: [240, 300],
    title: "Pre-event informed drift",
    story:
      "Cirrus Sports' away-win price shortens ~25% over 60s with no public information; Borealis follows late. A red card against the home side lands only AFTER the move — pattern consistent with informed money acting ahead of the event.",
  },
  {
    id: "s2-coordinated-move",
    rule: "cross_market",
    window: [385, 425],
    title: "Coordinated cross-market move",
    story:
      "All four books shorten Home and Over ~10% within seconds of each other, with no match event and no public trigger — pattern consistent with a coordinated position being taken across markets.",
  },
  {
    id: "s3-stale-snap",
    rule: "stale_snap",
    window: [480, 512],
    title: "Stale-then-snap repricing",
    story:
      "Dorado Odds freezes every quote for 30s while consensus drifts away, then reprices the full gap in a single tick — pattern consistent with a book pulling liquidity while holding exposure, a classic integrity red flag.",
  },
];

/** Piecewise-linear anchors for true probabilities: [t, pHome, pDraw, pAway, pOver]. */
const ANCHORS: [number, number, number, number, number][] = [
  [0, 0.42, 0.28, 0.3, 0.48],
  [179, 0.41, 0.29, 0.3, 0.44],
  [180, 0.6, 0.24, 0.16, 0.55], // goal home
  [299, 0.62, 0.23, 0.15, 0.5],
  [300, 0.48, 0.27, 0.25, 0.52], // red card home
  [429, 0.45, 0.27, 0.28, 0.46],
  [430, 0.27, 0.3, 0.43, 0.58], // goal away
  [470, 0.26, 0.305, 0.435, 0.55],
  [530, 0.245, 0.315, 0.44, 0.5],
  [599, 0.235, 0.345, 0.42, 0.44],
];

function interpProbs(t: number): { h: number; d: number; a: number; o: number } {
  let lo = ANCHORS[0];
  let hi = ANCHORS[ANCHORS.length - 1];
  for (let i = 0; i < ANCHORS.length - 1; i++) {
    if (t >= ANCHORS[i][0] && t <= ANCHORS[i + 1][0]) {
      lo = ANCHORS[i];
      hi = ANCHORS[i + 1];
      break;
    }
  }
  const span = hi[0] - lo[0] || 1;
  const f = (t - lo[0]) / span;
  const mix = (i: number) => lo[i] + (hi[i] - lo[i]) * f;
  return { h: mix(1), d: mix(2), a: mix(3), o: mix(4) };
}

/**
 * Scenario odds-injection envelope: multiplicative factor applied to a
 * specific book/outcome price at tick t. 1.0 = untouched.
 */
function injection(bookId: string, outcome: Outcome, t: number): number {
  // S1: informed drift — Cirrus away shortens 18% over 240..299, Borealis
  // follows with 7% from 255. Released inside the post-red-card window.
  if (outcome === "a") {
    if (bookId === "cirrus") {
      if (t >= 240 && t < 300) return 1 - 0.25 * ((t - 240) / 59);
      if (t >= 300 && t < 315) return 0.75 + 0.25 * ((t - 300) / 15);
    }
    if (bookId === "borealis") {
      if (t >= 255 && t < 300) return 1 - 0.07 * ((t - 255) / 44);
      if (t >= 300 && t < 315) return 0.93 + 0.07 * ((t - 300) / 15);
    }
  }
  // S2: coordinated move — every book shortens Home + Over 10% inside 5s,
  // holds; released under cover of the (legitimate) 430 goal repricing.
  if (outcome === "h" || outcome === "o") {
    if (t >= 385 && t < 390) return 1 - 0.1 * ((t - 385) / 5);
    if (t >= 390 && t < 430) return 0.9;
  }
  return 1.0;
}

export type Quotes = Record<Outcome, number>; // decimal odds per outcome
export type TickQuotes = Record<string, Quotes>; // bookId -> quotes

export interface Tape {
  fixtureId: string;
  ticks: TickQuotes[]; // index = replay tick (seconds)
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Generate the full deterministic tape. Same seed → same tape, everywhere. */
export function generateTape(): TickQuotes[] {
  const rng = mulberry32(FIXTURE_SEED);
  // Pre-roll AR(1) noise state per book/outcome so t=0 isn't special.
  const noiseState: Record<string, Record<Outcome, number>> = {};
  for (const b of BOOKS) {
    noiseState[b.id] = { h: 0, d: 0, a: 0, o: 0, u: 0 };
  }
  const RHO = 0.9;

  const ticks: TickQuotes[] = [];
  for (let t = 0; t < TICKS; t++) {
    const tq: TickQuotes = {};
    for (const b of BOOKS) {
      const p = interpProbs(Math.max(0, t - b.lag));
      const fair: Record<Outcome, number> = {
        h: 1 / (p.h * b.margin),
        d: 1 / (p.d * b.margin),
        a: 1 / (p.a * b.margin),
        o: 1 / (p.o * b.margin),
        u: 1 / ((1 - p.o) * b.margin),
      };
      const q = {} as Quotes;
      for (const oc of OUTCOMES) {
        const ns = noiseState[b.id];
        ns[oc] = RHO * ns[oc] + b.noise * gaussian(rng);
        q[oc] = round2(fair[oc] * Math.exp(ns[oc]) * injection(b.id, oc, t));
      }
      tq[b.id] = q;
    }
    // S3: stale-then-snap — Dorado's entire board frozen 480..509, then a
    // single-tick reprice to live value at 510.
    if (t >= 480 && t <= 509) {
      tq["dorado"] = { ...ticks[479]["dorado"] };
    }
    ticks.push(tq);
  }
  return ticks;
}
