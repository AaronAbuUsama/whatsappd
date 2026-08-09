import { randomUUID } from "node:crypto";
import type { BinaryInput, MessageRef, SendOptions } from "../model/outbound.ts";
import type { Unsubscribe } from "../subscription.ts";
import type { MediaStore } from "./contracts.ts";
import {
  operationIdFor,
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

const terminal = (
  operation: WhatsAppOperation | undefined,
): operation is TerminalWhatsAppOperation =>
  operation?.state.status === "succeeded" ||
  operation?.state.status === "failed" ||
  operation?.state.status === "outcome_unknown";

const sendOptions = (options?: ClientSendOptions): SendOptions | undefined =>
  options?.quote !== undefined || options?.mentions !== undefined
    ? {
        ...(options.quote !== undefined && { quote: options.quote }),
        ...(options.mentions !== undefined && { mentions: options.mentions }),
      }
    : undefined;

const bytesOf = async (input: BinaryInput, signal?: AbortSignal): Promise<Uint8Array> => {
  throwIfAborted(signal);
  if (Buffer.isBuffer(input)) return Uint8Array.from(input);
  if ("url" in input) {
    const response = await fetch(input.url, { signal });
    if (!response.ok) throw new Error(`media request failed with HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of input.stream) {
    throwIfAborted(signal);
    chunks.push(Uint8Array.from(chunk));
  }
  return Uint8Array.from(Buffer.concat(chunks));
};

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

  const submit = async <Result extends WhatsAppOperationResult>(
    input: WhatsAppOperationInput,
    identity: ReturnType<typeof identityFor>,
    signal?: AbortSignal,
  ): Promise<WhatsAppOperation<Result>> => {
    throwIfAborted(signal);
    const submitted = await config.operations.submit({
      accountId: config.accountId,
      ...identity,
      input,
    });
    const current = (await config.operations.get(config.accountId, submitted.id)) ?? submitted;
    config.retain(current);
    return current as WhatsAppOperation<Result>;
  };

  const stage = async (
    kind: "image" | "video" | "audio" | "document" | "sticker",
    input: BinaryInput,
    identity: ReturnType<typeof identityFor>,
    signal?: AbortSignal,
    mimetype?: string,
  ): Promise<{ readonly ref: string }> => {
    const bytes = await bytesOf(input, signal);
    throwIfAborted(signal);
    const stored = await config.media.put({
      accountId: config.accountId,
      owner: { type: "operation", operationId: identity.id },
      kind,
      bytes,
      ...(mimetype !== undefined && { mimetype }),
    });
    throwIfAborted(signal);
    return { ref: stored.ref };
  };

  const send = (
    chatId: string,
    content: DurableOutbound,
    options: ClientSendOptions | undefined,
    identity = identityFor(options),
  ): Promise<WhatsAppOperation<MessageRef>> => {
    const outboundOptions = sendOptions(options);
    return submit<MessageRef>(
      {
        version: 1,
        type: "send",
        chatId,
        content,
        ...(outboundOptions && { options: outboundOptions }),
      },
      identity,
      options?.signal,
    );
  };

  const messages: ClientMessageActions = {
    send: {
      text: (chatId, text, options) => send(chatId, { text }, options),
      async image(chatId, input, options) {
        const identity = identityFor(options);
        const image = await stage("image", input, identity, options?.signal);
        return send(
          chatId,
          { image, ...(options?.caption !== undefined && { caption: options.caption }) },
          options,
          identity,
        );
      },
      async video(chatId, input, options) {
        const identity = identityFor(options);
        const video = await stage("video", input, identity, options?.signal);
        return send(
          chatId,
          {
            video,
            ...(options?.caption !== undefined && { caption: options.caption }),
            ...(options?.gifPlayback !== undefined && { gifPlayback: options.gifPlayback }),
          },
          options,
          identity,
        );
      },
      async audio(chatId, input, options) {
        const identity = identityFor(options);
        const audio = await stage("audio", input, identity, options?.signal, options?.mimetype);
        return send(
          chatId,
          {
            audio,
            ...(options?.ptt !== undefined && { ptt: options.ptt }),
            ...(options?.seconds !== undefined && { seconds: options.seconds }),
            ...(options?.mimetype !== undefined && { mimetype: options.mimetype }),
          },
          options,
          identity,
        );
      },
      async document(chatId, input, options) {
        const identity = identityFor(options);
        const document = await stage("document", input, identity, options.signal, options.mimetype);
        return send(
          chatId,
          {
            document,
            fileName: options.fileName,
            mimetype: options.mimetype,
            ...(options.caption !== undefined && { caption: options.caption }),
          },
          options,
          identity,
        );
      },
      async sticker(chatId, input, options) {
        const identity = identityFor(options);
        const sticker = await stage("sticker", input, identity, options?.signal);
        return send(chatId, { sticker }, options, identity);
      },
      location: (chatId, location, options) =>
        send(chatId, { location: structuredClone(location) }, options),
      contacts: (chatId, contacts, options) =>
        send(chatId, { contacts: structuredClone(contacts) }, options),
    },
    react: (ref, emoji, options) =>
      send(ref.chatId, { react: { to: structuredClone(ref), emoji } }, options),
    unreact: (ref, options) =>
      send(ref.chatId, { react: { to: structuredClone(ref), emoji: "" } }, options),
    edit: (ref, text, options) =>
      send(ref.chatId, { edit: { target: structuredClone(ref), text } }, options),
    revoke: (ref, options) => send(ref.chatId, { delete: structuredClone(ref) }, options),
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
