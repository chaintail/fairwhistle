import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getState } from "../src/state.js";

/**
 * Dashboard state: replay position, tape increments since ?since=<tick>,
 * events, and every alert detected so far this cycle (signed).
 */
export default function handler(req: VercelRequest, res: VercelResponse) {
  const raw = Number(req.query.since ?? -1);
  const since = Number.isFinite(raw) ? Math.max(-1, Math.min(raw, 10_000)) : -1;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json(getState(Date.now(), since));
}
