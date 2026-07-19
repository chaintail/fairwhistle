import type { VercelRequest, VercelResponse } from "@vercel/node";
import { liveWatch } from "../src/livewatch.js";

/**
 * LIVE surveillance state: real TxLINE consensus series for the configured
 * fixture, generic event markers, and any live detections (signed). Optional
 * ?sinceTs= trims the series for incremental polling.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const data = await liveWatch();
    const sinceTs = Number(req.query.sinceTs ?? 0);
    res.status(200).json(
      sinceTs > 0 ? { ...data, points: data.points.filter((p) => p.ts > sinceTs) } : data,
    );
  } catch (e) {
    res.status(503).json({
      ok: false,
      reason: String(e instanceof Error ? e.message : e),
      note: "Live mode needs TXLINE_API_TOKEN; the recorded-fixture demo on / is unaffected.",
    });
  }
}
