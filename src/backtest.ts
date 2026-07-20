/**
 * FairWhistle — standalone HISTORICAL BACKTEST module.
 *
 * This is a deliberate, standalone COPY of the pure detection math that
 * lives in src/livewatch.ts (mergeSeries / collectEvents / zSeries /
 * detect), adapted for offline sweeps across archived fixtures.
 *
 * src/livewatch.ts is under a standing "live-match machinery untouchable"
 * rule — it is powering a page watching today's real, in-progress World Cup
 * Final. This file shares ZERO code path with it by design: nothing here
 * imports from livewatch.ts, and livewatch.ts is never edited (not even to
 * add an `export`). A little duplication is the deliberate tradeoff (this
 * repo's stated YAGNI / no-premature-abstraction doctrine), not a DRY
 * violation worth fixing. The only shared import is src/attest.ts
 * (canonical-JSON/hash/sign helpers — already stable, not live-specific).
 *
 * ONE deliberate change from the live module: livewatch.ts caps history to
 * `Date.now() - 48h`, which only makes sense for something happening right
 * now. A backtest has no "now" — each fixture's window is scoped to itself:
 * we use ALL odds/score rows returned for that fixture (a historical
 * archive is naturally bounded to the match + capture window already, so an
 * artificial wall-clock-relative cap would be both unnecessary and wrong —
 * it could even chop off part of an already-finished match depending on
 * when the backtest happens to run).
 *
 * DATA FIDELITY NOTE (verified empirically before writing this file): to
 * reproduce what production's own detection path actually consumes, odds
 * are read in the same shape as `/api/odds/updates/{fixtureId}` (what
 * livewatch.ts calls), and scores are read in the same shape as
 * `/api/scores/snapshot/{fixtureId}` (also what livewatch.ts calls) — NOT
 * the richer `/api/scores/updates/...` incremental feed that also exists in
 * the local archive. Confirmed live against TxLINE: `/api/scores/snapshot/
 * {fixtureId}` returns one representative row per distinct action type
 * (~34-44 rows for a full match), not the full play-by-play (~1000+ rows,
 * e.g. hundreds of "possession"/"throw_in" rows) that `/api/scores/
 * updates/...` returns. Using the richer feed would suppress far more of
 * the tape than production's real code path ever would, making this module
 * a stricter, non-equivalent detector rather than a faithful copy.
 */

import { existsSync, readFileSync } from "node:fs";
import { agentKey, canonicalJson, sha256Hex, signHex } from "./attest.js";

const TXLINE_BASE = "https://txline.txodds.com";
const CONSENSUS = 10021;
/** Local capture of the World Cup archive, if available — falls back to the live API per-fixture otherwise. */
const ARCHIVE_DIR = process.env.TXLINE_ARCHIVE_DIR ?? "";

export const BT_OUTCOMES = ["h", "d", "a", "o", "u"] as const;
export type BtOutcome = (typeof BT_OUTCOMES)[number];
const BT_LABEL: Record<BtOutcome, string> = {
  h: "1X2 · Home",
  d: "1X2 · Draw",
  a: "1X2 · Away",
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

export interface BtPoint {
  ts: number;
  odds: Partial<Record<BtOutcome, number>>;
}

export interface BtEvent {
  ts: number;
  kind: string;
  detail: string;
}

export interface BtAlert {
  id: string;
  coreHash: string;
  core: {
    project: "fairwhistle";
    v: 1;
    mode: "backtest";
    fixtureId: number;
    rule: "velocity_backtest" | "cross_market_backtest";
    outcomes: BtOutcome[];
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
  /**
   * Post-hoc honesty check (today's lesson, applied retroactively): does
   * this alert's own suppression window stay clean when checked against the
   * COMPLETE historical event set? Should always be `clean: true` by
   * construction (detect() below already excludes event windows before an
   * alert is ever emitted) — this field makes that guarantee explicit and
   * auditable per-alert rather than merely implicit in the algorithm, and
   * would catch a detector bug if it were ever violated.
   */
  suppressionCheck: { clean: boolean; note: string };
  instance?: { coreHash: string; agentPubKey: string; signedAt: string };
  instanceHash?: string;
  signature?: string;
}

export interface BacktestResult {
  fixtureId: number;
  dataSource: "local-archive" | "live-api";
  pointCount: number;
  eventCount: number;
  windowStart: number | null;
  windowEnd: number | null;
  alerts: BtAlert[];
  agentPubKey?: string;
  keyEphemeral?: boolean;
  honesty: string;
  computedAt: string;
}

// Identical thresholds to livewatch.ts's live pipeline — same detection
// math, only the window-cap semantics differ (see file header).
const P = {
  retWindowMs: 150_000,
  baseWindowMs: 30 * 60_000,
  sigmaFloor: 0.011,
  zFire: 5,
  sustain: 2,
  cooldownMs: 15 * 60_000,
  eventPreMs: 60_000,
  eventPostMs: 240_000,
  newsJumpAll: 0.05,
  xmZ: 4,
  xmSpanMs: 90_000,
} as const;

// ---------------------------------------------------------------------------
// Data loading: prefer the local archive (already-captured full history,
// zero extra load on the free-tier API); fall back to a gentle, backed-off
// live fetch per fixture if the archive is missing or unparseable.
// ---------------------------------------------------------------------------

interface FixtureRaw {
  updateRows: UpdateRow[];
  scoreRows: Record<string, unknown>[];
  source: "local-archive" | "live-api";
}

/** Read an ndjson capture file and concatenate every line's `raw` JSON array. */
function readNdjsonConcatRaw(path: string): unknown[] {
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const obj = JSON.parse(line) as { raw?: string; source?: string };
    if (!obj.raw) continue;
    const arr = JSON.parse(obj.raw);
    if (Array.isArray(arr)) out.push(...arr);
  }
  return out;
}

/** The one line in snapshots.ndjson captured from the SAME endpoint livewatch.ts calls. */
function readScoresSnapshot(path: string): Record<string, unknown>[] {
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  let best: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const obj = JSON.parse(line) as { raw?: string; source?: string };
    if (!obj.source || !obj.source.includes("/api/scores/snapshot/")) continue;
    if (!obj.raw) continue;
    const arr = JSON.parse(obj.raw);
    if (Array.isArray(arr) && arr.length >= best.length) best = arr;
  }
  return best;
}

async function guestJwt(): Promise<string> {
  const r = await fetch(`${TXLINE_BASE}/auth/guest/start`, { method: "POST" });
  if (!r.ok) throw new Error(`guest auth ${r.status}`);
  return ((await r.json()) as { token: string }).token;
}

/** Gentle live fetch with exponential backoff on 429/5xx — only used as a fallback. */
async function txGetWithRetry(path: string, maxAttempts = 5): Promise<unknown> {
  const apiToken = process.env.TXLINE_API_TOKEN;
  if (!apiToken) throw new Error("TXLINE_API_TOKEN not configured");
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const jwt = await guestJwt();
      const r = await fetch(`${TXLINE_BASE}${path}`, {
        headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken },
      });
      if (r.status === 429 || r.status >= 500) {
        throw new Error(`txline ${path.split("?")[0]} ${r.status}`);
      }
      if (!r.ok) throw new Error(`txline ${path.split("?")[0]} ${r.status} (non-retryable)`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      const backoffMs = Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500;
      await new Promise((res) => setTimeout(res, backoffMs));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function loadFixtureRaw(fixtureId: number, opts?: { forceLive?: boolean }): Promise<FixtureRaw> {
  const dir = `${ARCHIVE_DIR}/${fixtureId}`;
  if (!opts?.forceLive && existsSync(dir) && existsSync(`${dir}/odds-stream.ndjson`) && existsSync(`${dir}/snapshots.ndjson`)) {
    try {
      const updateRows = readNdjsonConcatRaw(`${dir}/odds-stream.ndjson`) as UpdateRow[];
      const scoreRows = readScoresSnapshot(`${dir}/snapshots.ndjson`);
      return { updateRows, scoreRows, source: "local-archive" };
    } catch {
      // fall through to live fetch below
    }
  }
  const updateRows = (await txGetWithRetry(`/api/odds/updates/${fixtureId}`)) as UpdateRow[];
  const scoreRows = (await txGetWithRetry(`/api/scores/snapshot/${fixtureId}`).catch(() => [])) as Record<
    string,
    unknown
  >[];
  return { updateRows, scoreRows, source: "live-api" };
}

// ---------------------------------------------------------------------------
// Pure detection math — deliberate copy of livewatch.ts's mergeSeries /
// collectEvents / zSeries / detect, with the wall-clock cap removed.
// ---------------------------------------------------------------------------

export function mergeSeries(rows: UpdateRow[]): BtPoint[] {
  const byTs = new Map<number, Partial<Record<BtOutcome, number>>>();
  for (const r of rows) {
    if (r.BookmakerId !== CONSENSUS || r.MarketPeriod !== null) continue;
    let mapping: [string, BtOutcome][] | null = null;
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
  const last: Partial<Record<BtOutcome, number>> = {};
  for (const p of pts) {
    for (const oc of BT_OUTCOMES) {
      if (p.odds[oc] !== undefined) last[oc] = p.odds[oc];
      else if (last[oc] !== undefined) p.odds[oc] = last[oc];
    }
  }
  return pts.filter((p) => BT_OUTCOMES.every((oc) => p.odds[oc] !== undefined));
}

export function collectEvents(scoreRows: Record<string, unknown>[], points: BtPoint[]): BtEvent[] {
  const events: BtEvent[] = [];
  for (const r of scoreRows) {
    const action = String(r.Action ?? "");
    if (!action || action === "comment" || action === "coverage_update" || action === "heartbeat") continue;
    events.push({ ts: Number(r.Ts ?? 0), kind: action, detail: JSON.stringify(r).slice(0, 160) });
  }
  for (let i = 1; i < points.length; i++) {
    const moves = (["h", "d", "a"] as BtOutcome[]).map((oc) =>
      Math.abs(Math.log((points[i].odds[oc] ?? 1) / (points[i - 1].odds[oc] ?? 1))),
    );
    if (moves.every((m) => m >= P.newsJumpAll)) {
      events.push({
        ts: points[i].ts,
        kind: "news_reprice",
        detail: "all 1X2 outcomes repriced together (public-information signature)",
      });
    }
  }
  return events.sort((x, y) => x.ts - y.ts);
}

function inEventWindow(ts: number, events: BtEvent[]): boolean {
  return events.some((e) => ts >= e.ts - P.eventPreMs && ts <= e.ts + P.eventPostMs);
}

interface Zed {
  ts: number;
  oc: BtOutcome;
  z: number;
  ret: number;
}

function zSeries(points: BtPoint[], events: BtEvent[]): Zed[] {
  const n = points.length;
  const out: Zed[] = [];
  const refIdx = new Array<number>(n);
  let lo = 0;
  for (let i = 0; i < n; i++) {
    while (points[lo].ts < points[i].ts - P.retWindowMs) lo++;
    refIdx[i] = lo;
  }
  const okIdx = points.map((p) => !inEventWindow(p.ts, events));
  for (const oc of BT_OUTCOMES) {
    const ret = new Array<number>(n);
    const cnt = new Array<number>(n + 1).fill(0);
    const sum = new Array<number>(n + 1).fill(0);
    const sq = new Array<number>(n + 1).fill(0);
    for (let i = 0; i < n; i++) {
      const r = refIdx[i] < i ? Math.log((points[i].odds[oc] ?? 1) / (points[refIdx[i]].odds[oc] ?? 1)) : 0;
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

function suppressionClean(tsDetect: number, events: BtEvent[]): { clean: boolean; note: string } {
  const hit = events.find((e) => tsDetect >= e.ts - P.eventPreMs && tsDetect <= e.ts + P.eventPostMs);
  if (hit) {
    return {
      clean: false,
      note: `event '${hit.kind}' at ${new Date(hit.ts).toISOString()} falls inside this alert's suppression window despite the alert firing — should not happen (detect() already excludes event windows); investigate as a detector bug.`,
    };
  }
  return {
    clean: true,
    note: "no scores-feed event or news-signature co-move falls inside the suppression window around this alert. Full historical event data was available for this check from the start — a backtest has no 'later-arriving event data' problem the way a live point-in-time detection does.",
  };
}

export function detect(
  points: BtPoint[],
  events: BtEvent[],
  fixtureId: number,
): Omit<BtAlert, "instance" | "instanceHash" | "signature">[] {
  if (points.length < 20) return [];
  const zs = zSeries(points, events);
  const alerts: Omit<BtAlert, "instance" | "instanceHash" | "signature">[] = [];

  const evidenceFor = (ocs: BtOutcome[], t0: number, t1: number, params: Record<string, number | string>) => {
    const w0 = t0 - 20 * 60_000;
    const series = ocs.map((oc) => ({
      label: BT_LABEL[oc],
      points: points
        .filter((p) => p.ts >= w0 && p.ts <= t1 + 5 * 60_000)
        .map((p) => [p.ts, p.odds[oc] ?? 0] as [number, number]),
    }));
    return { window: [w0, t1 + 5 * 60_000] as [number, number], series, params };
  };

  let cooldownUntil = 0;
  for (const oc of BT_OUTCOMES) {
    const mine = zs.filter((z) => z.oc === oc);
    let run: Zed[] = [];
    for (const z of mine) {
      if (z.ts <= cooldownUntil || inEventWindow(z.ts, events)) {
        run = [];
        continue;
      }
      if (Math.abs(z.z) >= P.zFire) {
        run.push(z);
        if (run.length >= P.sustain) {
          const zPeak = Math.max(...run.map((r) => Math.abs(r.z)));
          const ev = evidenceFor([oc], run[0].ts, z.ts, {
            rule: "velocity_backtest",
            zFire: P.zFire,
            retWindowMs: P.retWindowMs,
            movePct: Number((Math.abs(z.ret) * 100).toFixed(2)),
          });
          const core = {
            project: "fairwhistle" as const,
            v: 1 as const,
            mode: "backtest" as const,
            fixtureId,
            rule: "velocity_backtest" as const,
            outcomes: [oc],
            tsStart: run[0].ts,
            tsDetect: z.ts,
            zPeak: Number(zPeak.toFixed(2)),
            headline: `BACKTEST abnormal drift: ${BT_LABEL[oc]} (consensus feed)`,
            narrative: `Consensus price for ${BT_LABEL[oc]} repriced ${(Math.abs(z.ret) * 100).toFixed(1)}% over ~${Math.round(P.retWindowMs / 60000)} min (peak |z| ${zPeak.toFixed(1)}, threshold ${P.zFire}) with no goal, card, or public-news repricing signature in the window. Recomputed on complete historical data — single-book consensus variant of the velocity rule.`,
            evidenceHash: sha256Hex(canonicalJson(ev)),
          };
          const coreHash = sha256Hex(canonicalJson(core));
          alerts.push({
            id: coreHash.slice(0, 12),
            coreHash,
            core,
            evidence: ev,
            severity: "high",
            suppressionCheck: suppressionClean(z.ts, events),
          });
          cooldownUntil = z.ts + P.cooldownMs;
          run = [];
        }
      } else run = [];
    }
  }

  let xmCooldown = 0;
  for (const z of zs) {
    if (z.ts <= xmCooldown || inEventWindow(z.ts, events)) continue;
    if (!["h", "a"].includes(z.oc) || Math.abs(z.z) < P.xmZ) continue;
    const partner = zs.find(
      (w) =>
        ["o", "u"].includes(w.oc) &&
        Math.abs(w.z) >= P.xmZ &&
        Math.abs(w.ts - z.ts) <= P.xmSpanMs &&
        !inEventWindow(w.ts, events),
    );
    if (!partner) continue;
    const ocs = [z.oc, partner.oc] as BtOutcome[];
    const t0 = Math.min(z.ts, partner.ts);
    const t1 = Math.max(z.ts, partner.ts);
    const ev = evidenceFor(ocs, t0, t1, { rule: "cross_market_backtest", xmZ: P.xmZ, spanMs: P.xmSpanMs });
    const core = {
      project: "fairwhistle" as const,
      v: 1 as const,
      mode: "backtest" as const,
      fixtureId,
      rule: "cross_market_backtest" as const,
      outcomes: ocs,
      tsStart: t0,
      tsDetect: t1,
      zPeak: Number(Math.max(Math.abs(z.z), Math.abs(partner.z)).toFixed(2)),
      headline: `BACKTEST coordinated co-move: ${ocs.map((o) => BT_LABEL[o]).join(" + ")}`,
      narrative: `Result and totals markets repriced abnormally together (|z| ≥ ${P.xmZ}) inside ${Math.round(P.xmSpanMs / 1000)}s with no public trigger — recomputed on complete historical data, consensus-feed variant of the coordination rule.`,
      evidenceHash: sha256Hex(canonicalJson(ev)),
    };
    const coreHash = sha256Hex(canonicalJson(core));
    alerts.push({
      id: coreHash.slice(0, 12),
      coreHash,
      core,
      evidence: ev,
      severity: "critical",
      suppressionCheck: suppressionClean(t1, events),
    });
    xmCooldown = t1 + P.cooldownMs;
  }

  return alerts.sort((x, y) => x.core.tsDetect - y.core.tsDetect);
}

// ---------------------------------------------------------------------------
// Top-level: fetch/load → detect → (optionally sign) → return.
// ---------------------------------------------------------------------------

export async function runBacktest(
  fixtureId: number,
  opts?: { sign?: boolean; forceLive?: boolean },
): Promise<BacktestResult> {
  const raw = await loadFixtureRaw(fixtureId, opts);
  const points = mergeSeries(raw.updateRows);
  const events = collectEvents(raw.scoreRows, points);
  const rawAlerts = detect(points, events, fixtureId);

  const sign = opts?.sign ?? true;
  const key = sign ? agentKey() : null;
  const alerts: BtAlert[] = rawAlerts.map((a) => {
    if (!key) return a as BtAlert;
    const instance = { coreHash: a.coreHash, agentPubKey: key.publicKeyHex, signedAt: new Date().toISOString() };
    const canonical = canonicalJson(instance);
    return { ...a, instance, instanceHash: sha256Hex(canonical), signature: signHex(canonical) };
  });

  return {
    fixtureId,
    dataSource: raw.source,
    pointCount: points.length,
    eventCount: events.length,
    windowStart: points[0]?.ts ?? null,
    windowEnd: points[points.length - 1]?.ts ?? null,
    alerts,
    agentPubKey: key?.publicKeyHex,
    keyEphemeral: key?.ephemeral,
    honesty:
      "BACKTEST MODE — recomputed on the COMPLETE historical data available for this fixture (not live point-in-time detection). This is a standalone copy of the live detection math (src/backtest.ts), run over an already-finished match, so it has no wall-clock 'now' and no lagging-event-data problem. Not a directly comparable claim to a live alert signed during an in-progress match on partial data.",
    computedAt: new Date().toISOString(),
  };
}
