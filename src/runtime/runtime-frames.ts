import type { Unsubscribe } from "../subscription.ts";
import type {
  CurrentMirrorSnapshot,
  RuntimeDurableFrame,
  RuntimeFrameClient,
  StoredMessagePage,
  StoredMessagePageOptions,
} from "./contracts.ts";

/** Distinguishes watch cancellation from every value a snapshot may return. */
const CANCELLED = Symbol("cancelled");

interface DurableFrameSource {
  snapshot(): Promise<CurrentMirrorSnapshot>;
  onFrame(listener: (frame: RuntimeDurableFrame) => void): Unsubscribe;
}

/** Follow one mirror from a snapshot through contiguous patches and closure. */
export async function* durableFrames(
  source: DurableFrameSource,
  options?: { readonly signal?: AbortSignal },
): AsyncGenerator<RuntimeDurableFrame> {
  const signal = options?.signal;
  const queued: RuntimeDurableFrame[] = [];
  let wake: (() => void) | undefined;
  let close!: (frame: Extract<RuntimeDurableFrame, { type: "closed" }>) => void;
  const closed = new Promise<Extract<RuntimeDurableFrame, { type: "closed" }>>((resolve) => {
    close = resolve;
  });
  const push = (frame: RuntimeDurableFrame): void => {
    queued.push(frame);
    if (frame.type === "closed") close(frame);
    wake?.();
  };
  const off = source.onFrame(push);
  let onAbort = (): void => {};
  const cancelled = new Promise<typeof CANCELLED>((resolve) => {
    if (signal?.aborted) resolve(CANCELLED);
    onAbort = (): void => {
      wake?.();
      resolve(CANCELLED);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  let applied = -1;
  const resnapshot = async (): Promise<
    CurrentMirrorSnapshot | typeof CANCELLED | Extract<RuntimeDurableFrame, { type: "closed" }>
  > => {
    const alreadyClosed = queued.find(
      (frame): frame is Extract<RuntimeDurableFrame, { type: "closed" }> => frame.type === "closed",
    );
    if (alreadyClosed) return alreadyClosed;
    const snapshot = await Promise.race([source.snapshot(), cancelled, closed]);
    if (snapshot === CANCELLED || "type" in snapshot) return snapshot;
    applied = snapshot.revision;
    return snapshot;
  };
  const align = async (
    frame: RuntimeDurableFrame,
  ): Promise<RuntimeDurableFrame | typeof CANCELLED | undefined> => {
    if (frame.type !== "patch") return frame;
    if (frame.patch.revision <= applied) return undefined;
    if (frame.patch.fromRevision === applied) {
      applied = frame.patch.revision;
      return frame;
    }
    const fresh = await resnapshot();
    if (fresh === CANCELLED || "type" in fresh) return fresh;
    return { type: "snapshot", snapshot: fresh };
  };

  try {
    const snapshot = await resnapshot();
    if (snapshot === CANCELLED || signal?.aborted) return;
    if ("type" in snapshot) {
      yield snapshot;
      return;
    }
    yield { type: "snapshot", snapshot };
    while (!signal?.aborted) {
      for (const frame of queued.splice(0)) {
        const aligned = await align(frame);
        if (aligned === CANCELLED || signal?.aborted) return;
        if (!aligned) continue;
        yield aligned;
        if (aligned.type === "closed") return;
      }
      if (queued.length === 0 && !signal?.aborted)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      wake = undefined;
    }
  } finally {
    off();
    signal?.removeEventListener("abort", onAbort);
  }
}

interface RuntimeFrameSource extends DurableFrameSource {
  messages(chatId: string, options?: StoredMessagePageOptions): Promise<StoredMessagePage>;
}

/** Create the raw frame client retained for projection tests. */
export function createRuntimeFrameClient(runtime: RuntimeFrameSource): RuntimeFrameClient {
  return {
    messages: (chatId, options) => runtime.messages(chatId, options),
    watch: (options) => durableFrames(runtime, options),
  };
}
