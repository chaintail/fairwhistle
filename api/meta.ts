import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getMeta } from "../src/state.js";
import { ALL_ALERTS } from "../src/state.js";
import { PARAMS } from "../src/detectors.js";

/** Agent metadata: identity, fixture, detector parameters, honesty labels. */
export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json({
    ...getMeta(),
    detectorParams: PARAMS,
    alertFingerprints: ALL_ALERTS.map((a) => ({
      rule: a.core.rule,
      coreHash: a.coreHash,
      tDetect: a.core.tDetect,
    })),
  });
}
