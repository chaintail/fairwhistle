/**
 * Minimal local harness that mimics Vercel's runtime: /api/* routed to the
 * function handlers with .query/.body/.status()/.json() shims, public/
 * served static. For local smoke tests only — production runs on Vercel.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

import stateHandler from "../api/state.js";
import alertsHandler from "../api/alerts.js";
import metaHandler from "../api/meta.js";
import verifyHandler from "../api/verify.js";
import feedHandler from "../api/feed.js";

const routes: Record<string, (req: unknown, res: unknown) => unknown> = {
  "/api/state": stateHandler as never,
  "/api/alerts": alertsHandler as never,
  "/api/meta": metaHandler as never,
  "/api/verify": verifyHandler as never,
  "/api/feed": feedHandler as never,
};

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

function shim(req: IncomingMessage, res: ServerResponse, body: string) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const q: Record<string, string> = {};
  url.searchParams.forEach((v, k) => (q[k] = v));
  const r = req as IncomingMessage & { query: Record<string, string>; body: unknown };
  r.query = q;
  try {
    r.body = body ? JSON.parse(body) : undefined;
  } catch {
    r.body = undefined;
  }
  const rs = res as ServerResponse & {
    status: (c: number) => typeof rs;
    json: (v: unknown) => void;
    flushHeaders: () => void;
  };
  rs.status = (c: number) => ((res.statusCode = c), rs);
  rs.json = (v: unknown) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(v));
  };
  return { req: r, res: rs, path: url.pathname };
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const { req: rq, res: rs, path } = shim(req, res, body);
    const handler = routes[path];
    if (handler) {
      try {
        await handler(rq, rs);
      } catch (e) {
        res.statusCode = 500;
        res.end(String(e));
      }
      return;
    }
    const file = path === "/" ? "/index.html" : path;
    try {
      const data = await readFile(join(process.cwd(), "public", file));
      res.setHeader("Content-Type", MIME[extname(file)] ?? "application/octet-stream");
      res.end(data);
    } catch {
      res.statusCode = 404;
      res.end("not found");
    }
  });
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`fairwhistle dev harness on http://localhost:${port}`));
