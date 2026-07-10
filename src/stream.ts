/**
 * A single-value fan-out channel. Push once; the value is delivered to every
 * registered callback (`on`) and to at most one `for await` consumer.
 *
 * The callback surface is what powers `session.onMessage` &c.; the async-iterable
 * is the low-level stream. The async side stays dormant until first iterated, so
 * a channel that is only ever consumed via callbacks never buffers.
 */
export type Handler<T> = (value: T) => void | Promise<void>;

export class Channel<T> implements AsyncIterable<T> {
  private readonly handlers = new Set<Handler<T>>();
  private readonly onHandlerError?: (err: unknown) => void;
  private readonly buffer: T[] = [];
  private resolve?: (r: IteratorResult<T>) => void;
  private done = false;
  private tapped = false;

  /**
   * @param onHandlerError - where a handler's sync throw or async rejection is
   * reported. A misbehaving handler must not break delivery to the other
   * handlers or the connection; its error is contained and surfaced here.
   */
  constructor(onHandlerError?: (err: unknown) => void) {
    this.onHandlerError = onHandlerError;
  }

  /** Register a callback for every future value; returns an unsubscribe. */
  on(handler: Handler<T>): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  push(value: T): void {
    if (this.done) return;
    for (const handler of this.handlers) {
      try {
        const result = handler(value);
        if (result instanceof Promise) result.catch((err) => this.onHandlerError?.(err));
      } catch (err) {
        this.onHandlerError?.(err);
      }
    }
    // The async side is inert until someone iterates, so a channel consumed only
    // via `on` never accumulates an unread backlog.
    if (!this.tapped) return;
    if (this.resolve) {
      this.resolve({ value, done: false });
      this.resolve = undefined;
    } else this.buffer.push(value);
  }

  /** End the stream: the `for await` consumer completes; callbacks stop firing. */
  close(): void {
    this.done = true;
    if (this.resolve) {
      this.resolve({ value: undefined as never, done: true });
      this.resolve = undefined;
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    this.tapped = true;
    return {
      next: (): Promise<IteratorResult<T>> => {
        const queued = this.buffer.shift();
        if (queued !== undefined) return Promise.resolve({ value: queued, done: false });
        if (this.done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((r) => (this.resolve = r));
      },
    };
  }
}
