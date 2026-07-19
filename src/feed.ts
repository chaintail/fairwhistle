/**
 * Feed abstraction — the seam where live TxLINE plugs in.
 *
 * The detectors consume a normalized OddsTick stream and know nothing about
 * where it came from. Tonight the stream is the deterministic replay tape
 * (honestly labeled in the UI); in production the TxLineAdapter subscribes to
 * the live TxODDS TxLINE feed and emits the same shape.
 */

import { BOOKS, OUTCOMES, generateTape, type Outcome, type TickQuotes } from "./fixture.js";

export interface OddsTick {
  /** Replay tick / feed sequence number (1 per second). */
  t: number;
  /** bookId -> outcome -> decimal odds. */
  quotes: TickQuotes;
}

export interface FeedAdapter {
  /** Ticks [0..upTo] inclusive, in order. Pure + repeatable for the replay. */
  history(upTo: number): OddsTick[];
}

/** Deterministic replay of the synthetic fixture tape. */
export class ReplayAdapter implements FeedAdapter {
  private tape = generateTape();

  history(upTo: number): OddsTick[] {
    const out: OddsTick[] = [];
    const end = Math.min(upTo, this.tape.length - 1);
    for (let t = 0; t <= end; t++) out.push({ t, quotes: this.tape[t] });
    return out;
  }

  raw(): TickQuotes[] {
    return this.tape;
  }
}

/**
 * Production adapter (not active in this demo): subscribe to the TxLINE
 * websocket, normalize book/market/price records into OddsTick, maintain a
 * ring buffer, and hand the same history() view to the detectors. Kept as a
 * typed stub so the plug-in point is explicit rather than hypothetical.
 */
export class TxLineAdapter implements FeedAdapter {
  constructor(_opts: { apiKey: string; fixtureId: string }) {
    throw new Error(
      "TxLineAdapter requires live TxODDS credentials — this demo runs the ReplayAdapter (synthetic fixture, labeled in-UI).",
    );
  }
  history(_upTo: number): OddsTick[] {
    return [];
  }
}

/** Median consensus price across books for one outcome at one tick. */
export function consensus(tick: TickQuotes, outcome: Outcome, excludeBook?: string): number {
  const vals = BOOKS.filter((b) => b.id !== excludeBook)
    .map((b) => tick[b.id]?.[outcome])
    .filter((v): v is number => typeof v === "number")
    .sort((x, y) => x - y);
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}

/** Sanity re-export so callers don't need fixture internals for iteration. */
export { BOOKS, OUTCOMES };
export type { Outcome, TickQuotes };
