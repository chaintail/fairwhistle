/**
 * Agent state assembly: replay position + tape prefix + detections up to
 * "now", each detection signed for the current cycle. This is what every API
 * surface (dashboard state, JSON alert feed, SSE) serves.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BOOKS,
  CYCLE_MS,
  EVENTS,
  MATCH,
  SCENARIOS,
  TICKS,
  matchMinute,
} from "./fixture.js";
import { ReplayAdapter } from "./feed.js";
import { clockPos, tickWallMs } from "./clock.js";
import { detectAlerts, type Alert } from "./detectors.js";
import { agentKey, canonicalJson, sha256Hex, signHex } from "./attest.js";

export interface AnchorRecord {
  coreHash: string;
  status: "anchored" | "simulated";
  cluster?: string;
  txSignature?: string;
  explorerUrl?: string;
  anchoredAt?: string;
  note?: string;
}

export interface SignedAlert extends Alert {
  instance: {
    coreHash: string;
    cycle: number;
    detectedAt: string; // wall-clock ISO of the tick in this cycle
    agentPubKey: string;
  };
  instanceHash: string;
  signature: string; // ed25519 over canonical instance JSON, hex
  anchor: AnchorRecord | null;
}

const adapter = new ReplayAdapter();
const tape = adapter.raw();
export const FIXTURE_ID = sha256Hex(canonicalJson(tape)).slice(0, 16);
const ALL_ALERTS: Alert[] = detectAlerts(tape, FIXTURE_ID);

let anchors: AnchorRecord[] = [];
try {
  anchors = JSON.parse(
    readFileSync(join(process.cwd(), "data", "anchors.json"), "utf8"),
  ) as AnchorRecord[];
} catch {
  anchors = [];
}

const signedCycleCache = new Map<number, SignedAlert[]>();

function signAlertsForCycle(cycle: number, cycleStartMs: number): SignedAlert[] {
  const cached = signedCycleCache.get(cycle);
  if (cached) return cached;
  const key = agentKey();
  const signed = ALL_ALERTS.map((a) => {
    const instance = {
      coreHash: a.coreHash,
      cycle,
      detectedAt: new Date(tickWallMs(cycleStartMs, a.core.tDetect)).toISOString(),
      agentPubKey: key.publicKeyHex,
    };
    const canonical = canonicalJson(instance);
    return {
      ...a,
      instance,
      instanceHash: sha256Hex(canonical),
      signature: signHex(canonical),
      anchor: anchors.find((x) => x.coreHash === a.coreHash) ?? null,
    };
  });
  signedCycleCache.set(cycle, signed);
  if (signedCycleCache.size > 8) {
    const oldest = Math.min(...signedCycleCache.keys());
    signedCycleCache.delete(oldest);
  }
  return signed;
}

export interface AgentState {
  meta: {
    project: "FairWhistle";
    fixtureId: string;
    match: typeof MATCH;
    books: { id: string; name: string }[];
    synthetic: true;
    syntheticNote: string;
    agentPubKey: string;
    keyEphemeral: boolean;
    cycleMs: number;
    ticks: number;
    scenarios: typeof SCENARIOS;
  };
  now: { cycle: number; tick: number; matchMinute: number; wallIso: string; cycleStartIso: string };
  events: { t: number; type: string; team: string; label: string; occurred: boolean }[];
  alerts: SignedAlert[];
}

export function getMeta(): AgentState["meta"] {
  const key = agentKey();
  return {
    project: "FairWhistle",
    fixtureId: FIXTURE_ID,
    match: MATCH,
    books: BOOKS.map((b) => ({ id: b.id, name: b.name })),
    synthetic: true,
    syntheticNote:
      "SYNTHETIC FIXTURE — deterministic replayed tape with 3 planted, openly-labeled integrity anomalies. No live TxODDS data is used in this demo; a live TxLINE feed plugs in behind the same FeedAdapter interface without touching the detectors.",
    agentPubKey: key.publicKeyHex,
    keyEphemeral: key.ephemeral,
    cycleMs: CYCLE_MS,
    ticks: TICKS,
    scenarios: SCENARIOS,
  };
}

export function getState(nowMs: number, sinceTick = -1): AgentState & {
  ticks: { t: number; quotes: Record<string, Record<string, number>> }[];
} {
  const pos = clockPos(nowMs);
  const alerts = signAlertsForCycle(pos.cycle, pos.cycleStartMs).filter(
    (a) => a.core.tDetect <= pos.tick,
  );
  const from = Math.max(0, sinceTick + 1);
  const ticks: { t: number; quotes: Record<string, Record<string, number>> }[] = [];
  for (let t = from; t <= pos.tick; t++) ticks.push({ t, quotes: tape[t] });
  return {
    meta: getMeta(),
    now: {
      cycle: pos.cycle,
      tick: pos.tick,
      matchMinute: matchMinute(pos.tick),
      wallIso: new Date(nowMs).toISOString(),
      cycleStartIso: new Date(pos.cycleStartMs).toISOString(),
    },
    events: EVENTS.map((e) => ({ ...e, occurred: e.t <= pos.tick })),
    alerts,
    ticks,
  };
}

export function getAlertsForCycle(nowMs: number): SignedAlert[] {
  const pos = clockPos(nowMs);
  return signAlertsForCycle(pos.cycle, pos.cycleStartMs).filter((a) => a.core.tDetect <= pos.tick);
}

export { ALL_ALERTS, tape };
