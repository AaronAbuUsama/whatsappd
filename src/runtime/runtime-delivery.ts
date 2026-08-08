/** Report an observer failure asynchronously without interrupting siblings. */
export const surface = (error: unknown): void => {
  try {
    process.emitWarning(
      error instanceof Error ? error : new Error(String(error), { cause: error }),
    );
  } catch {
    process.emitWarning(new Error("an observer failed with a value that cannot be described"));
  }
};

/** Deliver to a membership snapshot while honoring removals made mid-fanout. */
export function fanout<Listener>(
  listeners: ReadonlySet<Listener>,
  call: (listener: Listener) => void,
): void {
  const receiving = [...listeners];
  for (const listener of receiving) {
    if (!listeners.has(listener)) continue;
    try {
      call(listener);
    } catch (error) {
      surface(error);
    }
  }
}

interface Registration<Frame> {
  readonly notify: (frame: Frame) => void;
}

/** Give each observer its own frame wrapper and isolate clone/callback failures. */
export function deliver<Frame extends { readonly type: string }>(
  listeners: ReadonlySet<Registration<Frame>>,
  frame: Frame,
): void {
  fanout(listeners, (listener) => {
    listener.notify(frame.type === "closed" ? { ...frame } : structuredClone(frame));
  });
}
