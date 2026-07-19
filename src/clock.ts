/**
 * Wall-clock-keyed replay clock.
 *
 * The agent has no persistent process: every serverless instance derives the
 * identical replay position from wall time against a fixed epoch. That makes
 * the deployment genuinely autonomous — nothing to start, nothing to babysit,
 * every viewer sees the same live run — and every detection reproducible.
 */

import { CYCLE_MS, REPLAY_EPOCH_MS, TICKS } from "./fixture.js";

export interface ClockPos {
  /** 0-based index of the current replay cycle since the epoch. */
  cycle: number;
  /** Current tick within the cycle: 0..TICKS-1. */
  tick: number;
  /** Wall-clock ms timestamp when the current cycle started. */
  cycleStartMs: number;
}

export function clockPos(nowMs: number): ClockPos {
  const elapsed = nowMs - REPLAY_EPOCH_MS;
  const cycle = Math.floor(elapsed / CYCLE_MS);
  const inCycle = elapsed - cycle * CYCLE_MS;
  const tick = Math.min(TICKS - 1, Math.floor(inCycle / 1000));
  return { cycle, tick, cycleStartMs: REPLAY_EPOCH_MS + cycle * CYCLE_MS };
}

/** Wall-clock ms at which a given tick of a given cycle replayed. */
export function tickWallMs(cycleStartMs: number, tick: number): number {
  return cycleStartMs + tick * 1000;
}
