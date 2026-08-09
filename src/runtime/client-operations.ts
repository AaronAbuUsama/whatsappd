import { randomUUID } from "node:crypto";
import type { BinaryInput, MessageRef, SendOptions } from "../model/outbound.ts";
import type { Unsubscribe } from "../subscription.ts";
import type { MediaStore } from "./contracts.ts";
import {
  operationIdFor,
  operationInputJson,
  type DurableOutbound,
  type WhatsAppOperation,
  type WhatsAppOperationInput,
  type WhatsAppOperationResult,
  type WhatsAppOperationState,
  type WhatsAppOperationStore,
} from "./operations.ts";

export interface OptimisticMessage {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly content: DurableOutbound;
  readonly state: WhatsAppOperationState<MessageRef>;
}

export interface ClientOperationOptions {
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export interface ClientSendOptions extends ClientOperationOptions, SendOptions {}

export type TerminalWhatsAppOperation<Result = WhatsAppOperationResult> = Omit<
  WhatsAppOperation<Result>,
  "state"
> & {
  readonly state: Extract<
    WhatsAppOperationState<Result>,
    { readonly status: "succeeded" | "failed" | "outcome_unknown" }
  >;
};

export interface ClientMessageActions {
  /**
   * Durable message sends.
   *
   * @remarks
   * Media is completely published before the operation receipt exists. Buffer
   * input is snapshotted at method invocation; URL and async-iterable input is
   * consumed once with backpressure. `ptt: true` is validated as Ogg Opus mono
   * before publication; the Client does not transcode audio.
   */
  readonly send: {
    text(
      chatId: string,
      text: string,
      options?: ClientSendOptions,
    ): Promise<WhatsAppOperation<MessageRef>>;
    image(
      chatId: string,
      input: BinaryInput,
      options?: ClientSendOptions & { readonly caption?: string },
    ): Promise<WhatsAppOperation<MessageRef>>;
    video(
      chatId: string,
      input: BinaryInput,
      options?: ClientSendOptions & {
        readonly caption?: string;
        readonly gifPlayback?: boolean;
      },
    ): Promise<WhatsAppOperation<MessageRef>>;
    audio(
      chatId: string,
      input: BinaryInput,
      options?: ClientSendOptions & {
        readonly ptt?: boolean;
        readonly seconds?: number;
        readonly mimetype?: string;
      },
    ): Promise<WhatsAppOperation<MessageRef>>;
    document(
      chatId: string,
      input: BinaryInput,
      options: ClientSendOptions & {
        readonly fileName: string;
        readonly mimetype: string;
        readonly caption?: string;
      },
    ): Promise<WhatsAppOperation<MessageRef>>;
    sticker(
      chatId: string,
      input: BinaryInput,
      options?: ClientSendOptions,
    ): Promise<WhatsAppOperation<MessageRef>>;
    location(
      chatId: string,
      location: Extract<DurableOutbound, { readonly location: unknown }>["location"],
      options?: ClientSendOptions,
    ): Promise<WhatsAppOperation<MessageRef>>;
    contacts(
      chatId: string,
      contacts: Extract<DurableOutbound, { readonly contacts: unknown }>["contacts"],
      options?: ClientSendOptions,
    ): Promise<WhatsAppOperation<MessageRef>>;
  };
  react(
    ref: MessageRef,
    emoji: string,
    options?: ClientOperationOptions,
  ): Promise<WhatsAppOperation<MessageRef>>;
  unreact(
    ref: MessageRef,
    options?: ClientOperationOptions,
  ): Promise<WhatsAppOperation<MessageRef>>;
  edit(
    ref: MessageRef,
    text: string,
    options?: ClientOperationOptions,
  ): Promise<WhatsAppOperation<MessageRef>>;
  revoke(ref: MessageRef, options?: ClientOperationOptions): Promise<WhatsAppOperation<MessageRef>>;
  markRead(
    refs: readonly MessageRef[],
    options?: ClientOperationOptions,
  ): Promise<WhatsAppOperation<null>>;
  setTyping(
    chatId: string,
    on: boolean,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
  requestPhoneHistory(
    chatId: string,
    request: {
      readonly before: { readonly ref: MessageRef; readonly timestamp: number };
      readonly count?: number;
    },
    options?: ClientOperationOptions,
  ): Promise<WhatsAppOperation<{ readonly requestId: string }>>;
}

export interface ClientOperations {
  get(operationId: string): WhatsAppOperation | undefined;
  subscribe(
    operationId: string,
    listener: () => void,
    options?: { readonly signal?: AbortSignal },
  ): Unsubscribe;
  wait(
    operationId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<TerminalWhatsAppOperation>;
  acknowledge(operationId: string): Promise<WhatsAppOperation | undefined>;
}

const abortError = (signal?: AbortSignal): unknown =>
  signal?.reason ?? new DOMException("The operation was aborted", "AbortError");

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw abortError(signal);
};

const withAbort = <T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return pending;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener("abort", abort);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
};

const terminal = (
  operation: WhatsAppOperation | undefined,
): operation is TerminalWhatsAppOperation =>
  operation?.state.status === "succeeded" ||
  operation?.state.status === "failed" ||
  operation?.state.status === "outcome_unknown";

const sendOptions = (options?: ClientSendOptions): SendOptions | undefined =>
  options?.quote !== undefined || options?.mentions !== undefined
    ? {
        ...(options.quote !== undefined && { quote: structuredClone(options.quote) }),
        ...(options.mentions !== undefined && { mentions: [...options.mentions] }),
      }
    : undefined;

const MEDIA_CHUNK_BYTES = 64 * 1024;

const abortableSource = (
  source: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    const iterator = source[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await withAbort(iterator.next(), signal);
        if (next.done) return;
        yield next.value;
      }
    } finally {
      void Promise.resolve(iterator.return?.()).catch(() => {});
    }
  },
});

const sourceOf = async (
  input: BinaryInput,
  signal?: AbortSignal,
): Promise<AsyncIterable<Uint8Array>> => {
  throwIfAborted(signal);
  if (Buffer.isBuffer(input)) {
    const bytes = Uint8Array.from(input);
    return (async function* () {
      for (let offset = 0; offset < bytes.byteLength; offset += MEDIA_CHUNK_BYTES) {
        throwIfAborted(signal);
        yield bytes.subarray(offset, Math.min(offset + MEDIA_CHUNK_BYTES, bytes.byteLength));
      }
    })();
  }
  if ("url" in input) {
    const response = await fetch(input.url, { signal });
    if (!response.ok) throw new Error(`media request failed with HTTP ${response.status}`);
    if (!response.body) throw new Error("media response has no body");
    return abortableSource(response.body, signal);
  }
  return abortableSource(input.stream, signal);
};

interface MediaCursor {
  readonly iterator: AsyncIterator<Uint8Array>;
  chunk?: Uint8Array;
  offset: number;
}

const invalidVoiceNote = (): TypeError =>
  new TypeError("ptt audio must be an Ogg Opus mono stream");

const fillVoiceNotePrefix = async (
  cursor: MediaCursor,
  prefix: Buffer,
  length: number,
  needed: number,
): Promise<number> => {
  while (length < needed) {
    if (!cursor.chunk || cursor.offset === cursor.chunk.byteLength) {
      const next = await cursor.iterator.next();
      if (next.done) throw invalidVoiceNote();
      if (!(next.value instanceof Uint8Array))
        throw new TypeError("media source must yield Uint8Array");
      cursor.chunk = next.value;
      cursor.offset = 0;
    }
    const take = Math.min(needed - length, cursor.chunk.byteLength - cursor.offset);
    prefix.set(cursor.chunk.subarray(cursor.offset, cursor.offset + take), length);
    cursor.offset += take;
    length += take;
  }
  return length;
};

const voiceNotePacketLength = (prefix: Buffer): number => {
  let packetLength = 0;
  for (let index = 0; index < prefix[26]!; index += 1) {
    const lace = prefix[27 + index]!;
    packetLength += lace;
    if (lace < 255) return packetLength;
  }
  throw invalidVoiceNote();
};

const voiceNotePrefix = async (cursor: MediaCursor): Promise<Uint8Array> => {
  const prefix = Buffer.allocUnsafe(65_307);
  let length = await fillVoiceNotePrefix(cursor, prefix, 0, 27);
  if (
    prefix.toString("ascii", 0, 4) !== "OggS" ||
    prefix[4] !== 0 ||
    (prefix[5]! & 0x03) !== 0x02 ||
    prefix.readUInt32LE(18) !== 0 ||
    prefix[26] === 0
  )
    throw invalidVoiceNote();

  const packet = 27 + prefix[26]!;
  length = await fillVoiceNotePrefix(cursor, prefix, length, packet);
  const packetLength = voiceNotePacketLength(prefix);
  if (packetLength < 19 || packet + packetLength > prefix.byteLength) throw invalidVoiceNote();
  length = await fillVoiceNotePrefix(cursor, prefix, length, packet + packetLength);
  if (
    prefix.toString("ascii", packet, packet + 8) !== "OpusHead" ||
    prefix[packet + 8] !== 1 ||
    prefix[packet + 9] !== 1 ||
    prefix[packet + 18] !== 0
  )
    throw invalidVoiceNote();
  return Uint8Array.from(prefix.subarray(0, length));
};

const voiceNoteSource = (source: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    const cursor: MediaCursor = { iterator: source[Symbol.asyncIterator](), offset: 0 };
    try {
      yield await voiceNotePrefix(cursor);
      if (cursor.chunk && cursor.offset < cursor.chunk.byteLength) {
        const remainder = cursor.chunk.subarray(cursor.offset);
        cursor.chunk = undefined;
        yield remainder;
      }
      for (;;) {
        const next = await cursor.iterator.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      void Promise.resolve(cursor.iterator.return?.()).catch(() => {});
    }
  },
});

const normalizedRefs = (refs: readonly MessageRef[]): readonly MessageRef[] => {
  const unique = new Map<string, MessageRef>();
  for (const ref of refs) unique.set(`${ref.chatId}\0${ref.id}\0${String(ref.fromMe)}`, ref);
  return [...unique.values()]
    .sort((a, b) =>
      a.chatId < b.chatId
        ? -1
        : a.chatId > b.chatId
          ? 1
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : Number(a.fromMe) - Number(b.fromMe),
    )
    .map((ref) => structuredClone(ref));
};

export function createClientOperationApis(config: {
  readonly accountId: string;
  readonly operations: WhatsAppOperationStore;
  readonly media: MediaStore;
  readonly setTyping: (chatId: string, on: boolean) => Promise<void>;
  readonly get: (operationId: string) => WhatsAppOperation | undefined;
  readonly retain: (operation: WhatsAppOperation) => void;
  readonly subscribe: (
    operationId: string,
    listener: () => void,
    options?: { readonly signal?: AbortSignal },
  ) => Unsubscribe;
}): {
  readonly messages: ClientMessageActions;
  readonly operations: ClientOperations;
  readonly close: () => void;
} {
  const waits = new Set<() => void>();
  const identityFor = (options?: ClientOperationOptions) => {
    const idempotencyKey = options?.idempotencyKey ?? randomUUID();
    if (idempotencyKey.length === 0) throw new TypeError("idempotencyKey must not be empty");
    return { idempotencyKey, id: operationIdFor(config.accountId, idempotencyKey) };
  };
  const prepareSend = (options?: ClientSendOptions) => ({
    identity: identityFor(options),
    signal: options?.signal,
    options: sendOptions(options),
  });

  const submit = async <Result extends WhatsAppOperationResult>(
    input: WhatsAppOperationInput,
    identity: ReturnType<typeof identityFor>,
    signal?: AbortSignal,
  ): Promise<WhatsAppOperation<Result>> => {
    throwIfAborted(signal);
    let submitted: WhatsAppOperation;
    try {
      submitted = await config.operations.submit({
        accountId: config.accountId,
        ...identity,
        input,
      });
    } catch (error) {
      let recovered: WhatsAppOperation | undefined;
      try {
        recovered = await config.operations.get(config.accountId, identity.id);
      } catch {
        throw error;
      }
      if (
        !recovered ||
        recovered.idempotencyKey !== identity.idempotencyKey ||
        operationInputJson(recovered.input) !== operationInputJson(input)
      )
        throw error;
      submitted = recovered;
    }
    config.retain(submitted);
    return submitted as WhatsAppOperation<Result>;
  };

  const stage = async (
    kind: "image" | "video" | "audio" | "document" | "sticker",
    input: BinaryInput,
    identity: ReturnType<typeof identityFor>,
    signal?: AbortSignal,
    mimetype?: string,
  ): Promise<{ readonly ref: string }> => {
    const source = await sourceOf(input, signal);
    const stored = await config.media.write({
      accountId: config.accountId,
      owner: { type: "operation", operationId: identity.id },
      kind,
      source,
      ...(mimetype !== undefined && { mimetype }),
    });
    return { ref: stored.ref };
  };

  const send = (
    chatId: string,
    content: DurableOutbound,
    prepared: ReturnType<typeof prepareSend>,
    mediaCommitted = false,
  ): Promise<WhatsAppOperation<MessageRef>> => {
    return submit<MessageRef>(
      {
        version: 1,
        type: "send",
        chatId,
        content,
        ...(prepared.options && { options: prepared.options }),
      },
      prepared.identity,
      mediaCommitted ? undefined : prepared.signal,
    );
  };

  const messages: ClientMessageActions = {
    send: {
      text: (chatId, text, options) => send(chatId, { text }, prepareSend(options)),
      async image(chatId, input, options) {
        const prepared = prepareSend(options);
        const caption = options?.caption;
        const image = await stage("image", input, prepared.identity, prepared.signal);
        return send(
          chatId,
          {
            image: { ref: image.ref },
            ...(caption !== undefined && { caption }),
          },
          prepared,
          true,
        );
      },
      async video(chatId, input, options) {
        const prepared = prepareSend(options);
        const caption = options?.caption;
        const gifPlayback = options?.gifPlayback;
        const video = await stage("video", input, prepared.identity, prepared.signal);
        return send(
          chatId,
          {
            video: { ref: video.ref },
            ...(caption !== undefined && { caption }),
            ...(gifPlayback !== undefined && { gifPlayback }),
          },
          prepared,
          true,
        );
      },
      async audio(chatId, input, options) {
        const prepared = prepareSend(options);
        const ptt = options?.ptt;
        const seconds = options?.seconds;
        const mimetype = options?.mimetype;
        const source = await sourceOf(input, prepared.signal);
        const audio = await config.media.write({
          accountId: config.accountId,
          owner: { type: "operation", operationId: prepared.identity.id },
          kind: "audio",
          source: ptt === true ? voiceNoteSource(source) : source,
          ...(mimetype !== undefined && { mimetype }),
        });
        return send(
          chatId,
          {
            audio: { ref: audio.ref },
            ...(ptt !== undefined && { ptt }),
            ...(seconds !== undefined && { seconds }),
            ...(mimetype !== undefined && { mimetype }),
          },
          prepared,
          true,
        );
      },
      async document(chatId, input, options) {
        const prepared = prepareSend(options);
        const fileName = options.fileName;
        const mimetype = options.mimetype;
        const caption = options.caption;
        const document = await stage(
          "document",
          input,
          prepared.identity,
          prepared.signal,
          mimetype,
        );
        return send(
          chatId,
          {
            document: { ref: document.ref },
            fileName,
            mimetype,
            ...(caption !== undefined && { caption }),
          },
          prepared,
          true,
        );
      },
      async sticker(chatId, input, options) {
        const prepared = prepareSend(options);
        const sticker = await stage("sticker", input, prepared.identity, prepared.signal);
        return send(chatId, { sticker: { ref: sticker.ref } }, prepared, true);
      },
      location: (chatId, location, options) =>
        send(chatId, { location: structuredClone(location) }, prepareSend(options)),
      contacts: (chatId, contacts, options) =>
        send(chatId, { contacts: structuredClone(contacts) }, prepareSend(options)),
    },
    react: (ref, emoji, options) =>
      send(ref.chatId, { react: { to: structuredClone(ref), emoji } }, prepareSend(options)),
    unreact: (ref, options) =>
      send(ref.chatId, { react: { to: structuredClone(ref), emoji: "" } }, prepareSend(options)),
    edit: (ref, text, options) =>
      send(ref.chatId, { edit: { target: structuredClone(ref), text } }, prepareSend(options)),
    revoke: (ref, options) =>
      send(ref.chatId, { delete: structuredClone(ref) }, prepareSend(options)),
    markRead(refs, options) {
      const identity = identityFor(options);
      return submit<null>(
        { version: 1, type: "mark_read", refs: normalizedRefs(refs) },
        identity,
        options?.signal,
      );
    },
    async setTyping(chatId, on, options) {
      throwIfAborted(options?.signal);
      await config.setTyping(chatId, on);
    },
    requestPhoneHistory(chatId, request, options) {
      if (request.before.ref.chatId !== chatId)
        throw new TypeError("phone-history anchor must belong to the requested chat");
      const count = request.count ?? 50;
      if (!Number.isInteger(count) || count < 1 || count > 50)
        throw new RangeError(`count must be an integer in 1..50, got ${count}`);
      return submit<{ readonly requestId: string }>(
        {
          version: 1,
          type: "phone_history",
          anchor: structuredClone(request.before),
          count,
        },
        identityFor(options),
        options?.signal,
      );
    },
  };

  const operations: ClientOperations = {
    get: config.get,
    subscribe: config.subscribe,
    wait(operationId, options) {
      const current = config.get(operationId);
      if (terminal(current)) return Promise.resolve(current);
      const signal = options?.signal;
      if (signal?.aborted) return Promise.reject(abortError(signal));
      return new Promise<TerminalWhatsAppOperation>((resolve, reject) => {
        let off = (): void => {};
        const cleanup = (): void => {
          off();
          waits.delete(cancel);
          signal?.removeEventListener("abort", cancel);
        };
        const cancel = (): void => {
          cleanup();
          reject(abortError(signal));
        };
        const read = (): void => {
          const operation = config.get(operationId);
          if (!terminal(operation)) return;
          cleanup();
          resolve(operation);
        };
        off = config.subscribe(operationId, read);
        waits.add(cancel);
        signal?.addEventListener("abort", cancel, { once: true });
        read();
      });
    },
    async acknowledge(operationId) {
      const operation = await config.operations.acknowledge(config.accountId, operationId);
      if (operation) config.retain(operation);
      return operation;
    },
  };

  return {
    messages,
    operations,
    close() {
      for (const cancel of waits) cancel();
      waits.clear();
    },
  };
}
