/**
 * Full-tournament historical backtest sweep.
 *
 * Runs src/backtest.ts's standalone detection logic across every fixture in
 * the local World Cup archive and writes results incrementally so a partial
 * run is still useful if interrupted.
 *
 * Fixtures are processed strictly serially. The vast majority of fixtures
 * are served from the local archive (already-captured full history — zero
 * extra load on the free-tier TxLINE API); any fixture that needs a live
 * fallback fetch goes through src/backtest.ts's own backoff and this loop's
 * pacing delay, so even in the fallback case we stay gentle on the API.
 *
 * Output:
 *   - data/backtest-results.jsonl   (repo)   — one JSON line per fixture
 *   - backtest-progress.log         (workspace disk, NOT /tmp) — human-tail-able status
 */
import { appendFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBacktest } from "../src/backtest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const ARCHIVE_DIR = process.env.TXLINE_ARCHIVE_DIR ?? join(REPO_ROOT, "data", "historical-archive");
const RESULTS_PATH = join(REPO_ROOT, "data", "backtest-results.jsonl");
const PROGRESS_PATH = process.env.BACKTEST_PROGRESS_PATH ?? join(REPO_ROOT, "data", "backtest-progress.log");
const PACING_MS = 150;

function log(line: string) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  appendFileSync(PROGRESS_PATH, stamped + "\n");
  console.log(stamped);
}

function listFixtureIds(): number[] {
  return readdirSync(ARCHIVE_DIR)
    .filter((d) => /^\d+$/.test(d) && statSync(join(ARCHIVE_DIR, d)).isDirectory())
    .map(Number)
    .sort((a, b) => a - b);
}

async function main() {
  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  mkdirSync(dirname(PROGRESS_PATH), { recursive: true });

  const fixtureIds = listFixtureIds();
  log(`=== backtest sweep START — ${fixtureIds.length} fixtures from ${ARCHIVE_DIR} ===`);
  log(`results -> ${RESULTS_PATH}`);
  log(`progress -> ${PROGRESS_PATH}`);

  let done = 0;
  let failed = 0;
  let totalAlerts = 0;
  let dirtyAlerts = 0; // suppressionCheck.clean === false
  const byRule: Record<string, number> = {};
  const bySource: Record<string, number> = {};

  for (const fixtureId of fixtureIds) {
    const t0 = Date.now();
    try {
      const result = await runBacktest(fixtureId);
      appendFileSync(RESULTS_PATH, JSON.stringify(result) + "\n");
      done++;
      totalAlerts += result.alerts.length;
      bySource[result.dataSource] = (bySource[result.dataSource] ?? 0) + 1;
      for (const a of result.alerts) {
        byRule[a.core.rule] = (byRule[a.core.rule] ?? 0) + 1;
        if (!a.suppressionCheck.clean) dirtyAlerts++;
      }
      log(
        `[${done + failed}/${fixtureIds.length}] fixture ${fixtureId} OK source=${result.dataSource} ` +
          `points=${result.pointCount} events=${result.eventCount} alerts=${result.alerts.length} ` +
          `(${Date.now() - t0}ms)`,
      );
    } catch (e) {
      failed++;
      const err = e instanceof Error ? e.stack ?? e.message : String(e);
      appendFileSync(RESULTS_PATH, JSON.stringify({ fixtureId, error: err, computedAt: new Date().toISOString() }) + "\n");
      log(`[${done + failed}/${fixtureIds.length}] fixture ${fixtureId} FAILED: ${err}`);
    }
    await new Promise((r) => setTimeout(r, PACING_MS));
  }

  log(
    `=== backtest sweep COMPLETE — ${done} ok, ${failed} failed, ${totalAlerts} total alerts ` +
      `(${dirtyAlerts} flagged suppression-check-not-clean) ===`,
  );
  log(`by rule: ${JSON.stringify(byRule)}`);
  log(`by data source: ${JSON.stringify(bySource)}`);
}

main().catch((e) => {
  log(`FATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
});
