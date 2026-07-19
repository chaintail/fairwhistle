import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAlertsForCycle } from "../src/state.js";
import { clockPos } from "../src/clock.js";

/**
 * SSE alert stream — push interface for downstream consumers (integrity
 * desks, settlement bots). Emits a snapshot on connect, then any newly
 * detected alert as an `alert` event. Streams ~50s per connection (serverless
 * duration budget); clients auto-reconnect via standard EventSource behavior.
 */
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let known = new Set<string>();
  const snapshot = getAlertsForCycle(Date.now());
  snapshot.forEach((a) => known.add(`${a.instance.cycle}:${a.id}`));
  send("snapshot", { at: new Date().toISOString(), alerts: snapshot });

  const started = Date.now();
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      const now = Date.now();
      const pos = clockPos(now);
      send("tick", { cycle: pos.cycle, tick: pos.tick });
      for (const a of getAlertsForCycle(now)) {
        const k = `${a.instance.cycle}:${a.id}`;
        if (!known.has(k)) {
          known.add(k);
          send("alert", a);
        }
      }
      // New cycle → forget last cycle's instances so re-detections re-emit.
      if (known.size > 64) known = new Set([...known].slice(-16));
      if (now - started > 50_000) {
        clearInterval(timer);
        resolve();
      }
    }, 1000);
    _req.on?.("close", () => {
      clearInterval(timer);
      resolve();
    });
  });
  res.end();
}
