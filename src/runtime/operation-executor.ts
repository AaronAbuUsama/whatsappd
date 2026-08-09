import { randomUUID } from "node:crypto";
import type { WhatsAppSession } from "../session.ts";
import type { WhatsAppBackend } from "./contracts.ts";
import {
  serializedOperationError,
  type DurableOutbound,
  type WhatsAppOperation,
  type WhatsAppOperationResult,
} from "./operations.ts";

export type OperationSession = Partial<
  Pick<WhatsAppSession, "send" | "markRead" | "setTyping" | "requestHistory">
>;

async function outbound(
  accountId: string,
  media: WhatsAppBackend["media"],
  content: DurableOutbound,
) {
  if ("text" in content) return { text: content.text };
  if ("location" in content) return structuredClone(content);
  if ("contacts" in content) return structuredClone(content);
  if ("react" in content) return structuredClone(content);
  if ("edit" in content) return structuredClone(content);
  if ("delete" in content) return structuredClone(content);

  const read = async (ref: string, kind: string): Promise<Buffer> => {
    const bytes = await media.read({ accountId, ref });
    if (!bytes) throw new Error(`staged ${kind} media is missing`);
    return Buffer.from(bytes);
  };
  if ("image" in content)
    return {
      image: await read(content.image.ref, "image"),
      ...(content.caption !== undefined && { caption: content.caption }),
    };
  if ("video" in content)
    return {
      video: await read(content.video.ref, "video"),
      ...(content.caption !== undefined && { caption: content.caption }),
      ...(content.gifPlayback !== undefined && { gifPlayback: content.gifPlayback }),
    };
  if ("audio" in content)
    return {
      audio: await read(content.audio.ref, "audio"),
      ...(content.ptt !== undefined && { ptt: content.ptt }),
      ...(content.seconds !== undefined && { seconds: content.seconds }),
      ...(content.mimetype !== undefined && { mimetype: content.mimetype }),
    };
  if ("document" in content)
    return {
      document: await read(content.document.ref, "document"),
      fileName: content.fileName,
      mimetype: content.mimetype,
      ...(content.caption !== undefined && { caption: content.caption }),
    };
  return { sticker: await read(content.sticker.ref, "sticker") };
}

export function createOperationExecutor(config: {
  readonly accountId: string;
  readonly backend: WhatsAppBackend;
  readonly ttlMs: number;
  readonly session: () => OperationSession | undefined;
  readonly stopped: () => boolean;
  readonly failed: (error: unknown) => void;
}) {
  let online = false;
  let draining: Promise<void> | undefined;
  let rerun = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const release = (operation: WhatsAppOperation): Promise<WhatsAppOperation | undefined> =>
    operation.state.status === "claimed"
      ? config.backend.operations.release(config.accountId, operation.id, operation.state.attemptId)
      : Promise.resolve(undefined);

  const execute = async (operation: WhatsAppOperation): Promise<void> => {
    if (operation.state.status !== "claimed") return;
    const attemptId = operation.state.attemptId;
    const session = config.session();
    if (!online || !session) {
      await release(operation);
      return;
    }

    let invoke: () => Promise<WhatsAppOperationResult>;
    try {
      const input = operation.input;
      switch (input.type) {
        case "send": {
          const send = session.send?.bind(session);
          if (!send) throw new Error("the Session cannot send messages");
          const content = await outbound(config.accountId, config.backend.media, input.content);
          invoke = async () => send(input.chatId, content, input.options);
          break;
        }
        case "mark_read": {
          const markRead = session.markRead?.bind(session);
          if (!markRead) throw new Error("the Session cannot mark messages read");
          invoke = async () => {
            await markRead([...input.refs]);
            return null;
          };
          break;
        }
        case "phone_history": {
          const requestHistory = session.requestHistory?.bind(session);
          if (!requestHistory) throw new Error("the Session cannot request phone history");
          invoke = () => requestHistory(input.anchor, { count: input.count });
          break;
        }
      }
    } catch (error) {
      await config.backend.operations.fail(
        config.accountId,
        operation.id,
        attemptId,
        serializedOperationError(error),
      );
      return;
    }

    if (!online || config.session() !== session) {
      await release(operation);
      return;
    }

    const started = await config.backend.operations.start(
      config.accountId,
      operation.id,
      attemptId,
      config.ttlMs,
    );
    if (!started) return;
    try {
      await config.backend.operations.succeed(
        config.accountId,
        operation.id,
        attemptId,
        await invoke(),
      );
    } catch (error) {
      const safe = serializedOperationError(error);
      await config.backend.operations.unknown(
        config.accountId,
        operation.id,
        attemptId,
        `${safe.name}: ${safe.message}`,
      );
    }
  };

  const drain = async (): Promise<void> => {
    while (!config.stopped() && online && config.session()) {
      const operation = await config.backend.operations.claim(
        config.accountId,
        randomUUID(),
        config.ttlMs,
      );
      if (!operation) {
        if (!config.stopped() && online) {
          retry ??= setTimeout(wake, Math.max(1, config.ttlMs));
          retry.unref();
        }
        return;
      }
      await execute(operation);
    }
  };

  function wake(): void {
    if (retry) clearTimeout(retry);
    retry = undefined;
    if (config.stopped() || !online || !config.session()) return;
    if (draining) {
      rerun = true;
      return;
    }
    const pending = drain();
    draining = pending;
    void pending.then(
      () => {
        if (draining !== pending) return;
        draining = undefined;
        if (rerun) {
          rerun = false;
          wake();
        }
      },
      (error) => {
        if (draining !== pending) return;
        draining = undefined;
        config.failed(error);
      },
    );
  }

  const unsubscribe = config.backend.operations.subscribe(config.accountId, wake);
  return {
    setOnline(value: boolean): void {
      online = value;
      if (value) wake();
    },
    async stop(): Promise<void> {
      online = false;
      if (retry) clearTimeout(retry);
      retry = undefined;
      unsubscribe();
      await draining;
    },
  };
}
