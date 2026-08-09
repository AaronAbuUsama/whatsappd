/** Report an observer failure without rolling back a committed transition. */
export const surface = (error: unknown): void => {
  try {
    process.emitWarning(
      error instanceof Error ? error : new Error(String(error), { cause: error }),
    );
  } catch {
    process.emitWarning(new Error("an observer failed with a value that cannot be described"));
  }
};

/** Deliver once to every registration present when publication begins. */
export function fanout<Listener>(
  listeners: ReadonlySet<Listener>,
  call: (listener: Listener) => void,
): void {
  for (const listener of Array.from(listeners)) {
    if (!listeners.has(listener)) continue;
    try {
      call(listener);
    } catch (error) {
      surface(error);
    }
  }
}

/** Deliver a committed batch against one registration snapshot. */
export function fanoutBatch<Listener, Value>(
  listeners: ReadonlySet<Listener>,
  values: Iterable<Value>,
  call: (listener: Listener, value: Value) => void,
): void {
  const receiving = Array.from(listeners);
  for (const value of values)
    for (const listener of receiving) {
      if (!listeners.has(listener)) continue;
      try {
        call(listener, value);
      } catch (error) {
        surface(error);
      }
    }
}
