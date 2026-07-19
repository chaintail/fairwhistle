/**
 * LIVE surveillance mode — the real World Cup Final through the same pipeline.
 *
 * Data: TxLINE free tier, consensus bookmaker only (TXLineStablePriceDemargined).
 * That single-book reality is labeled honestly in the UI: the velocity rule and
 * a cross-market co-move variant run here; the full multi-book rules
 * (lead-lag, stale-vs-consensus) need the multi-book tier and run in the
 * recorded-fixture demo instead.
 *
 * Suppression on live data is two-layered (public news must never alert):
 *  1. any scores-feed action row (goal/card/state change) opens a window;
 *  2. news signature — when ALL 1X2 outcomes reprice together in one batch,
 *     that's public information hitting the market; informed money moves ONE
 *     side. Windows open automatically around such batches.
 *
 * Detection is a pure function of the fetched history → identical alerts,
 * hashes and signatures on every serverless instance, same as the replay.
 */

import { agentKey, canonicalJson, sha256Hex, signHex } from "./attest.js";

const BASE = "https://txline.txodds.com";
const CONSENSUS = 10021;
export const LIVE_OUTCOMES = ["h", "d", "a", "o", "u"] as const;
export type LiveOutcome = (typeof LIVE_OUTCOMES)[number];
const LIVE_LABEL: Record<LiveOutcome, string> = {
  h: "1X2 · Spain (home)",
  d: "1X2 · Draw",
  a: "1X2 · Argentina (away)",
  o: "OU 2.5 · Over",
  u: "OU 2.5 · Under",
};

interface UpdateRow {
  FixtureId: number;
  Ts: number;
  BookmakerId: number;
  SuperOddsType: string;
  MarketPeriod: string | null;
  MarketParameters: string | null;
  PriceNames: string[];
  Prices: number[];
}

export interface LivePoint {
  ts: number;
  odds: Partial<Record<LiveOutcome, number>>;
}

export interface LiveEvent {
  ts: number;
  kind: string;
  detail: string;
}

export interface LiveAlert {
  id: string;
  coreHash: string;
  core: {
    project: "fairwhistle";
    v: 1;
    mode: "live";
    fixtureId: number;
    rule: "velocity_live" | "cross_market_live";
    outcomes: LiveOutcome[];
    tsStart: number;
    tsDetect: number;
    zPeak: number;
    headline: string;
    narrative: string;
    evidenceHash: string;
  };
  evidence: {
    window: [number, number];
    series: { label: string; points: [number, number][] }[];
    params: Record<string, number | string>;
  };
  severity: "high" | "critical";
  instance: { coreHash: string; agentPubKey: string; signedAt: string };
  instanceHash: string;
  signature: string;
}

const P = {
  retWindowMs: 150_000, // return horizon (~2.5 min of batches)
  baseWindowMs: 30 * 60_000, // trailing baseline window
  sigmaFloor: 0.011, // floor on horizon-return stddev
  zFire: 5,
  sustain: 2, // consecutive qualifying updates
  cooldownMs: 15 * 60_000,
  eventPreMs: 60_000,
  eventPostMs: 240_000, // free-tier batching smears news repricing
  newsJumpAll: 0.05, // all-of-1X2 co-move ≥5% in one step = public news
  xmZ: 4,
  xmSpanMs: 90_000,
} as const;

async function guestJwt(): Promise<string> {
  const r = await fetch(`${BASE}/auth/guest/start`, { method: "POST" });
  if (!r.ok) throw new Error(`guest auth ${r.status}`);
  return ((await r.json()) as { token: string }).token;
}

async function txGet(path: string): Promise<unknown> {
  const apiToken = process.env.TXLINE_API_TOKEN;
  if (!apiToken) throw new Error("TXLINE_API_TOKEN not configured");
  const jwt = await guestJwt();
  const r = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken },
  });
  if (!r.ok) throw new Error(`txline ${path.split("?")[0]} ${r.status}`);
  return r.json();
}

export interface LiveWatch {
  fixtureId: number;
  label: string;
  fetchedAt: string;
  gameState: string | null;
  startTime: number | null;
  points: LivePoint[]; // merged, ts-ascending
  events: LiveEvent[];
  alerts: LiveAlert[];
  agentPubKey: string;
  honesty: string;
}

let cache: { data: LiveWatch; at: number } | null = null;

function mergeSeries(rows: UpdateRow[]): LivePoint[] {
  const byTs = new Map<number, Partial<Record<LiveOutcome, number>>>();
  for (const r of rows) {
    if (r.BookmakerId !== CONSENSUS || r.MarketPeriod !== null) continue;
    let mapping: [string, LiveOutcome][] | null = null;
    if (r.SuperOddsType === "1X2_PARTICIPANT_RESULT") {
      mapping = [["part1", "h"], ["draw", "d"], ["part2", "a"]];
    } else if (r.SuperOddsType === "OVERUNDER_PARTICIPANT_GOALS" && r.MarketParameters === "line=2.5") {
      mapping = [["over", "o"], ["under", "u"]];
    }
    if (!mapping) continue;
    const slot = byTs.get(r.Ts) ?? {};
    for (const [name, oc] of mapping) {
      const i = r.PriceNames.indexOf(name);
      if (i >= 0 && r.Prices[i] > 0) slot[oc] = r.Prices[i] / 1000;
    }
    byTs.set(r.Ts, slot);
  }
  const pts = [...byTs.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([ts, odds]) => ({ ts, odds }));
  // forward-fill so every point has all outcomes once first seen
  const last: Partial<Record<LiveOutcome, number>> = {};
  for (const p of pts) {
    for (const oc of LIVE_OUTCOMES) {
      if (p.odds[oc] !== undefined) last[oc] = p.odds[oc];
      else if (last[oc] !== undefined) p.odds[oc] = last[oc];
    }
  }
  return pts.filter((p) => LIVE_OUTCOMES.every((oc) => p.odds[oc] !== undefined));
}

function collectEvents(scoreRows: Record<string, unknown>[], points: LivePoint[]): LiveEvent[] {
  const events: LiveEvent[] = [];
  for (const r of scoreRows) {
    const action = String(r.Action ?? "");
    if (!action || action === "comment" || action === "coverage_update" || action === "heartbeat") continue;
    events.push({ ts: Number(r.Ts ?? 0), kind: action, detail: JSON.stringify(r).slice(0, 160) });
  }
  // news-signature windows: all three 1X2 outcomes jump together in one step
  for (let i = 1; i < points.length; i++) {
    const moves = (["h", "d", "a"] as LiveOutcome[]).map((oc) =>
      Math.abs(Math.log((points[i].odds[oc] ?? 1) / (points[i - 1].odds[oc] ?? 1))),
    );
    if (moves.every((m) => m >= P.newsJumpAll)) {
      events.push({ ts: points[i].ts, kind: "news_reprice", detail: "all 1X2 outcomes repriced together (public-information signature)" });
    }
  }
  return events.sort((x, y) => x.ts - y.ts);
}

function inEventWindow(ts: number, events: LiveEvent[]): boolean {
  return events.some((e) => ts >= e.ts - P.eventPreMs && ts <= e.ts + P.eventPostMs);
}

interface Zed { ts: number; oc: LiveOutcome; z: number; ret: number }

function zSeries(points: LivePoint[], events: LiveEvent[]): Zed[] {
  const n = points.length;
  const out: Zed[] = [];
  // two-pointer: refIdx[i] = first point with ts >= ts[i] - retWindow
  const refIdx = new Array<number>(n);
  let lo = 0;
  for (let i = 0; i < n; i++) {
    while (points[lo].ts < points[i].ts - P.retWindowMs) lo++;
    refIdx[i] = lo;
  }
  const okIdx = points.map((p) => !inEventWindow(p.ts, events));
  for (const oc of LIVE_OUTCOMES) {
    // horizon return per point + prefix sums over event-clean points
    const ret = new Array<number>(n);
    const cnt = new Array<number>(n + 1).fill(0);
    const sum = new Array<number>(n + 1).fill(0);
    const sq = new Array<number>(n + 1).fill(0);
    for (let i = 0; i < n; i++) {
      const r = refIdx[i] < i
        ? Math.log((points[i].odds[oc] ?? 1) / (points[refIdx[i]].odds[oc] ?? 1))
        : 0;
      ret[i] = r;
      const use = okIdx[i] && refIdx[i] < i ? 1 : 0;
      cnt[i + 1] = cnt[i] + use;
      sum[i + 1] = sum[i] + (use ? r : 0);
      sq[i + 1] = sq[i] + (use ? r * r : 0);
    }
    let bLo = 0;
    for (let i = 1; i < n; i++) {
      if (refIdx[i] >= i) continue;
      while (points[bLo].ts < points[i].ts - P.baseWindowMs) bLo++;
      const k = cnt[i] - cnt[bLo];
      if (k < 8) continue;
      const s = sum[i] - sum[bLo];
      const s2 = sq[i] - sq[bLo];
      const mean = s / k;
      const varc = Math.max(0, (s2 - k * mean * mean) / (k - 1));
      const sigma = Math.max(Math.sqrt(varc), P.sigmaFloor);
      out.push({ ts: points[i].ts, oc, z: ret[i] / sigma, ret: ret[i] });
    }
  }
  return out.sort((x, y) => x.ts - y.ts);
}

function detect(points: LivePoint[], events: LiveEvent[]): Omit<LiveAlert, "instance" | "instanceHash" | "signature">[] {
  if (points.length < 20) return [];
  const zs = zSeries(points, events);
  const alerts: Omit<LiveAlert, "instance" | "instanceHash" | "signature">[] = [];
  const fixtureId = Number(process.env.TXLINE_FIXTURE_ID ?? 18257739);

  const evidenceFor = (ocs: LiveOutcome[], t0: number, t1: number, params: Record<string, number | string>) => {
    const w0 = t0 - 20 * 60_000;
    const series = ocs.map((oc) => ({
      label: LIVE_LABEL[oc],
      points: points.filter((p) => p.ts >= w0 && p.ts <= t1 + 5 * 60_000).map((p) => [p.ts, p.odds[oc] ?? 0] as [number, number]),
    }));
    return { window: [w0, t1 + 5 * 60_000] as [number, number], series, params };
  };

  // velocity: sustained one-sided abnormal repricing outside event windows
  let cooldownUntil = 0;
  for (const oc of LIVE_OUTCOMES) {
    const mine = zs.filter((z) => z.oc === oc);
    let run: Zed[] = [];
    for (const z of mine) {
      if (z.ts <= cooldownUntil || inEventWindow(z.ts, events)) { run = []; continue; }
      if (Math.abs(z.z) >= P.zFire) {
        run.push(z);
        if (run.length >= P.sustain) {
          const zPeak = Math.max(...run.map((r) => Math.abs(r.z)));
          const ev = evidenceFor([oc], run[0].ts, z.ts, { rule: "velocity_live", zFire: P.zFire, retWindowMs: P.retWindowMs, movePct: Number((Math.abs(z.ret) * 100).toFixed(2)) });
          const core = {
            project: "fairwhistle" as const, v: 1 as const, mode: "live" as const, fixtureId,
            rule: "velocity_live" as const, outcomes: [oc], tsStart: run[0].ts, tsDetect: z.ts,
            zPeak: Number(zPeak.toFixed(2)),
            headline: `LIVE abnormal drift: ${LIVE_LABEL[oc]} (consensus feed)`,
            narrative: `Consensus price for ${LIVE_LABEL[oc]} repriced ${(Math.abs(z.ret) * 100).toFixed(1)}% over ~${Math.round(P.retWindowMs / 60000)} min (peak |z| ${zPeak.toFixed(1)}, threshold ${P.zFire}) with no goal, card, or public-news repricing signature in the window. Single-book consensus variant of the velocity rule; multi-book confirmation requires the full tier.`,
            evidenceHash: sha256Hex(canonicalJson(ev)),
          };
          const coreHash = sha256Hex(canonicalJson(core));
          alerts.push({ id: coreHash.slice(0, 12), coreHash, core, evidence: ev, severity: "high" });
          cooldownUntil = z.ts + P.cooldownMs;
          run = [];
        }
      } else run = [];
    }
  }

  // cross-market co-move: 1X2 side + totals side abnormal together, no event
  let xmCooldown = 0;
  for (const z of zs) {
    if (z.ts <= xmCooldown || inEventWindow(z.ts, events)) continue;
    if (!["h", "a"].includes(z.oc) || Math.abs(z.z) < P.xmZ) continue;
    const partner = zs.find((w) => ["o", "u"].includes(w.oc) && Math.abs(w.z) >= P.xmZ && Math.abs(w.ts - z.ts) <= P.xmSpanMs && !inEventWindow(w.ts, events));
    if (!partner) continue;
    const ocs = [z.oc, partner.oc] as LiveOutcome[];
    const t0 = Math.min(z.ts, partner.ts), t1 = Math.max(z.ts, partner.ts);
    const ev = evidenceFor(ocs, t0, t1, { rule: "cross_market_live", xmZ: P.xmZ, spanMs: P.xmSpanMs });
    const fixtureIdN = fixtureId;
    const core = {
      project: "fairwhistle" as const, v: 1 as const, mode: "live" as const, fixtureId: fixtureIdN,
      rule: "cross_market_live" as const, outcomes: ocs, tsStart: t0, tsDetect: t1,
      zPeak: Number(Math.max(Math.abs(z.z), Math.abs(partner.z)).toFixed(2)),
      headline: `LIVE coordinated co-move: ${ocs.map((o) => LIVE_LABEL[o]).join(" + ")}`,
      narrative: `Result and totals markets repriced abnormally together (|z| ≥ ${P.xmZ}) inside ${Math.round(P.xmSpanMs / 1000)}s with no public trigger — consensus-feed variant of the coordination rule.`,
      evidenceHash: sha256Hex(canonicalJson(ev)),
    };
    const coreHash = sha256Hex(canonicalJson(core));
    alerts.push({ id: coreHash.slice(0, 12), coreHash, core, evidence: ev, severity: "critical" });
    xmCooldown = t1 + P.cooldownMs;
  }

  return alerts.sort((x, y) => x.core.tsDetect - y.core.tsDetect);
}

export async function liveWatch(): Promise<LiveWatch> {
  if (cache && Date.now() - cache.at < 20_000) return cache.data;
  const fixtureId = Number(process.env.TXLINE_FIXTURE_ID ?? 18257739);
  const label = process.env.TXLINE_FIXTURE_LABEL ?? "FIFA World Cup Final — Spain v Argentina";

  const [updates, scores] = await Promise.all([
    txGet(`/api/odds/updates/${fixtureId}`) as Promise<UpdateRow[]>,
    txGet(`/api/scores/snapshot/${fixtureId}`).catch(() => []) as Promise<Record<string, unknown>[]>,
  ]);

  // cap history to the last 48h — plenty of baseline, bounded compute
  const points = mergeSeries(updates).filter((p) => p.ts >= Date.now() - 48 * 3600_000);
  const events = collectEvents(scores, points);
  const key = agentKey();
  const signedAlerts: LiveAlert[] = detect(points, events).map((a) => {
    const instance = { coreHash: a.coreHash, agentPubKey: key.publicKeyHex, signedAt: new Date().toISOString() };
    const canonical = canonicalJson(instance);
    return { ...a, instance, instanceHash: sha256Hex(canonical), signature: signHex(canonical) };
  });

  let gameState: string | null = null;
  let startTime: number | null = null;
  if (Array.isArray(scores) && scores.length) {
    gameState = (scores[scores.length - 1].GameState as string) ?? null;
    startTime = (scores[0].StartTime as number) ?? null;
  }

  const data: LiveWatch = {
    fixtureId, label,
    fetchedAt: new Date().toISOString(),
    gameState, startTime,
    points, events, alerts: signedAlerts,
    agentPubKey: key.publicKeyHex,
    honesty:
      "LIVE MODE — real TxLINE mainnet data (free tier: consensus bookmaker TXLineStablePriceDemargined, ~60s batch delay). Single-book variants of the velocity and coordination rules run here; the full multi-book rule set runs in the recorded-fixture demo. Public-news repricing (goals, cards, all-outcomes co-jumps) is suppressed, never alerted.",
  };
  cache = { data, at: Date.now() };
  return data;
}
