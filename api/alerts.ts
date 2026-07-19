import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAlertsForCycle, getMeta } from "../src/state.js";

/**
 * Machine-readable attested alert feed — what a league integrity desk or
 * downstream system would consume. Every alert carries its core fingerprint
 * hash, per-cycle instance, ed25519 signature and (if present) devnet anchor.
 */
export default function handler(_req: VercelRequest, res: VercelResponse) {
  const meta = getMeta();
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json({
    project: meta.project,
    fixtureId: meta.fixtureId,
    synthetic: meta.synthetic,
    syntheticNote: meta.syntheticNote,
    agentPubKey: meta.agentPubKey,
    keyEphemeral: meta.keyEphemeral,
    generatedAt: new Date().toISOString(),
    alerts: getAlertsForCycle(Date.now()),
  });
}
