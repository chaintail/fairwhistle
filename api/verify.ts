import type { VercelRequest, VercelResponse } from "@vercel/node";
import { canonicalJson, sha256Hex, verifyHex } from "../src/attest.js";
import { getAlertsForCycle } from "../src/state.js";

/**
 * Server-side verification fallback (browsers without WebCrypto Ed25519).
 *
 * POST { instance, signature, publicKey } → re-canonicalizes the instance,
 * recomputes its hash and checks the ed25519 signature. GET ?id=<alertId>
 * re-verifies a current-cycle alert end-to-end.
 */
export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    if (req.method === "POST") {
      const { instance, signature, publicKey } = req.body ?? {};
      if (!instance || typeof signature !== "string" || typeof publicKey !== "string") {
        res.status(400).json({ error: "expected { instance, signature, publicKey }" });
        return;
      }
      const canonical = canonicalJson(instance);
      res.status(200).json({
        valid: verifyHex(canonical, signature, publicKey),
        instanceHash: sha256Hex(canonical),
      });
      return;
    }
    const id = String(req.query.id ?? "");
    const alert = getAlertsForCycle(Date.now()).find((a) => a.id === id);
    if (!alert) {
      res.status(404).json({ error: `no alert ${id} detected yet this cycle` });
      return;
    }
    const canonical = canonicalJson(alert.instance);
    res.status(200).json({
      id: alert.id,
      valid: verifyHex(canonical, alert.signature, alert.instance.agentPubKey),
      instanceHash: sha256Hex(canonical),
      coreHash: alert.coreHash,
    });
  } catch (e) {
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
}
