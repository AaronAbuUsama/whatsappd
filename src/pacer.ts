/**
 * Send pacing. WhatsApp can flag accounts that emit bursts of messages, so
 * outbound sends are funnelled through a FIFO queue that guarantees a minimum
 * gap between them. Serializing also gives a caller firing many sends
 * concurrently a predictable order rather than a thundering herd.
 *
 * Pure timing mechanism. A `minGapMs` of `0` or less disables the wait (each
 * call still chains in order).
 */
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface Pacer {
  /** Queue `fn`; it runs no sooner than `minGapMs` after the previous one started. */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createPacer(minGapMs: number, now: () => number = Date.now): Pacer {
  let last = -Infinity;
  // The tail of the queue. We chain onto it so calls run strictly in order; the
  // `.catch` keeps one rejecting task from poisoning everything queued behind it.
  let tail: Promise<unknown> = Promise.resolve();

  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const result = tail.then(async () => {
        const wait = minGapMs > 0 ? last + minGapMs - now() : 0;
        if (wait > 0) await delay(wait);
        last = now();
        return fn();
      });
      tail = result.catch(() => {});
      return result;
    },
  };
}
