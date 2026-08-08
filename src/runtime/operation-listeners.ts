import type { WhatsAppOperation } from "./operations.ts";

/** Isolate one operation observer and give it an owned value. */
export function notifyOperationListener(
  listener: (operation: WhatsAppOperation) => void,
  operation: WhatsAppOperation,
): void {
  try {
    listener(structuredClone(operation));
  } catch (error) {
    process.emitWarning(
      error instanceof Error ? error : new Error("a WhatsApp operation observer failed"),
    );
  }
}

/** Deliver an operation to the current membership while honoring removals. */
export function fanoutOperationListeners(
  listeners: ReadonlySet<(operation: WhatsAppOperation) => void>,
  operation: WhatsAppOperation,
): void {
  const receiving = Array.from(listeners);
  for (const listener of receiving)
    if (listeners.has(listener)) notifyOperationListener(listener, operation);
}
