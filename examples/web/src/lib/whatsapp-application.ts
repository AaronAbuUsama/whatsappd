import { randomUUID } from "node:crypto";
/* eslint-disable max-lines -- one server-only projection keeps opaque identifiers in one trust boundary */
import {
  type BinaryInput,
  type ChatRecord,
  type ClientSendOptions,
  type MessageRecord,
  type MessageRef,
  type OptimisticMessage,
  type WhatsAppOperation,
} from "whatsappd";
import {
  avatarUrl,
  chatName,
  connectionOf,
  directName,
  firstName,
  initials,
  operationDetail,
  optimisticContent,
  previewOf,
  reactionsOf,
  receiptOf,
} from "./whatsapp-projection.ts";
import type {
  ApplicationChat,
  ApplicationConversation,
  ApplicationMessage,
  ApplicationMessageContent,
  ApplicationUpdate,
  WhatsAppApplication,
  WhatsAppApplicationCommandResult,
  WhatsAppApplicationCommand,
  WhatsAppApplicationOptions,
} from "./whatsapp-application-types.ts";

export type * from "./whatsapp-application-types.ts";

const SIDEBAR_PREVIEW_COUNT = 40;
const PAGE_TIMEOUT_MS = 10_000;
const STATUS_CHAT_ID = "status@broadcast";

type MessageOptions = {
  readonly quote?: string;
  readonly mentions?: readonly string[];
};

type GroupCommand = Extract<
  WhatsAppApplicationCommand,
  {
    readonly type:
      | "group_subject"
      | "group_description"
      | "group_participants"
      | "group_setting"
      | "group_invite"
      | "group_revoke_invite"
      | "group_picture"
      | "group_remove_picture"
      | "group_leave";
  }
>;

const GROUP_COMMANDS = new Set<GroupCommand["type"]>([
  "group_subject",
  "group_description",
  "group_participants",
  "group_setting",
  "group_invite",
  "group_revoke_invite",
  "group_picture",
  "group_remove_picture",
  "group_leave",
]);

const isGroupCommand = (command: WhatsAppApplicationCommand): command is GroupCommand =>
  GROUP_COMMANDS.has(command.type as GroupCommand["type"]);

type OpaqueRegistry<T> = {
  readonly token: (value: T, identity: string) => string;
  readonly resolve: (token: string) => T | undefined;
};

function registry<T>(): OpaqueRegistry<T> {
  const byToken = new Map<string, T>();
  const byIdentity = new Map<string, string>();
  return {
    token(value, identity) {
      let token = byIdentity.get(identity);
      if (!token) {
        token = randomUUID();
        byIdentity.set(identity, token);
      }
      byToken.set(token, value);
      return token;
    },
    resolve: (token) => byToken.get(token),
  };
}

export function createWhatsAppApplication(
  options: WhatsAppApplicationOptions,
): WhatsAppApplication {
  const { accountId, client, media } = options;
  const canSend = options.canSend ?? (() => true);
  const canCreateGroupWith = options.canCreateGroupWith ?? (() => false);
  const chats = registry<string>();
  const messages = registry<MessageRef>();
  const operations = registry<string>();
  const mediaRefs = registry<{
    readonly ref: string;
    readonly mimetype?: string;
    readonly fileName?: string;
  }>();
  const avatars = registry<{ readonly nativeId: string; readonly source?: string }>();
  const avatarLoads = new Map<string, Promise<string | undefined>>();
  const listeners = new Set<() => void>();
  const pageLoads = new Map<string, Promise<void>>();
  const groupMetadata = new Map<string, Awaited<ReturnType<typeof client.groups.metadata>>>();
  let revision = 0;
  let closed = false;

  const avatarToken = (nativeId: string, source?: string): string | undefined =>
    source || options.resolveAvatar
      ? avatars.token({ nativeId, ...(source && { source }) }, nativeId)
      : undefined;

  const announce = (): void => {
    revision += 1;
    for (const listener of listeners) listener();
  };
  const subscriptions = [
    client.account.subscribe(announce),
    client.chats.subscribe(announce),
    client.contacts.subscribe(announce),
    client.groups.subscribe(announce),
    client.messages.subscribe(announce),
  ];

  const page = (chatId: string): Promise<void> => {
    const current = client.messages.get(chatId);
    if (current.messages.length > 0 || current.older === "exhausted") return Promise.resolve();
    const existing = pageLoads.get(chatId);
    if (existing) return existing;
    const pending = new Promise<void>((resolvePage, rejectPage) => {
      let unsubscribe = (): void => {};
      const timeout = setTimeout(() => {
        unsubscribe();
        rejectPage(new Error("saved message page timed out"));
      }, PAGE_TIMEOUT_MS);
      unsubscribe = client.messages.subscribe(() => {
        if (client.messages.get(chatId).older === "loading") return;
        clearTimeout(timeout);
        unsubscribe();
        resolvePage();
      });
      if (client.messages.get(chatId).older === "stored") client.messages.older(chatId);
      else {
        clearTimeout(timeout);
        unsubscribe();
        resolvePage();
      }
    }).finally(() => pageLoads.delete(chatId));
    pageLoads.set(chatId, pending);
    return pending;
  };

  const chatView = (chat: ChatRecord, includeAvatar = false): ApplicationChat => {
    const name = chatName(client, chat);
    const contact = chat.isGroup ? undefined : client.contacts.resolve(chat.chatId);
    const source = avatarUrl(contact?.imgUrl);
    const avatar = includeAvatar ? avatarToken(chat.chatId, source) : undefined;
    const latest = client.messages.get(chat.chatId).messages[0];
    return {
      key: chats.token(chat.chatId, chat.chatId),
      name,
      initials: initials(name),
      ...(avatar && { avatar }),
      isGroup: chat.isGroup,
      lastMessageAt: chat.lastMessageAt,
      canSend: canSend(chat.chatId),
      ...(previewOf(latest) && { preview: previewOf(latest) }),
      ...(!chat.isGroup &&
        client.contacts.presence(chat.chatId) && {
          presence: client.contacts.presence(chat.chatId),
        }),
    };
  };

  const mediaToken = (message: MessageRecord): string | undefined => {
    if (!("media" in message) || message.media.state !== "stored") return undefined;
    return mediaRefs.token(
      {
        ref: message.media.ref,
        ...(message.media.mimetype && { mimetype: message.media.mimetype }),
        ...(message.media.fileName && { fileName: message.media.fileName }),
      },
      message.media.ref,
    );
  };

  const contentView = (message: MessageRecord): ApplicationMessageContent => {
    switch (message.kind) {
      case "text":
        return { kind: "text", text: message.text };
      case "image":
      case "video":
      case "audio":
      case "document":
      case "sticker": {
        const mediaKey = mediaToken(message);
        return {
          kind: message.kind,
          state: message.media.state,
          ...(mediaKey && { media: mediaKey }),
          ...(message.media.mimetype && { mimetype: message.media.mimetype }),
          ...(message.media.fileName && { fileName: message.media.fileName }),
          ...(message.media.state === "stored" && { byteLength: message.media.byteLength }),
          ...(message.media.seconds !== undefined && { seconds: message.media.seconds }),
          ...(message.media.ptt !== undefined && { ptt: message.media.ptt }),
          ...(message.text && { text: message.text }),
          ...(message.media.state === "failed" && { failure: message.media.reason }),
        };
      }
      case "location":
        return {
          kind: message.kind,
          lat: message.lat,
          lng: message.lng,
          ...(message.name && { name: message.name }),
          ...(message.address && { address: message.address }),
        };
      case "contacts":
        return { kind: message.kind, contacts: message.contacts };
      case "poll":
        return {
          kind: message.kind,
          name: message.name,
          options: message.options,
          selectableCount: message.selectableCount,
        };
      case "unsupported":
        return { kind: message.kind, rawType: message.rawType };
      case "revoked":
        return {
          kind: message.kind,
          ...(message.revokedAt !== undefined && { revokedAt: message.revokedAt }),
        };
    }
  };

  const senderName = (message: MessageRecord): string | undefined =>
    message.fromMe
      ? undefined
      : (message.pushName ?? firstName(client.contacts.resolve(message.sender.id)));

  const authoritativeMessage = (
    message: MessageRecord,
    loaded: ReadonlyMap<string, MessageRecord>,
    keys: ReadonlyMap<string, string>,
  ): ApplicationMessage => {
    const quoted = message.context?.quoted && loaded.get(message.context.quoted.id);
    const quoteKey = message.context?.quoted && keys.get(message.context.quoted.id);
    return {
      key: keys.get(message.messageId)!,
      fromMe: message.fromMe,
      ...(senderName(message) && { sender: senderName(message) }),
      timestamp: message.timestamp,
      edited: message.editedAt !== undefined || message.flags?.edited === true,
      ephemeral: message.flags?.ephemeral === true,
      viewOnce: message.flags?.viewOnce === true,
      ...(receiptOf(message) && { receipt: receiptOf(message) }),
      reactions: reactionsOf(message),
      ...(message.context?.quoted && {
        quote: {
          ...(quoteKey && { key: quoteKey }),
          ...(quoted && senderName(quoted) && { sender: senderName(quoted) }),
          ...(previewOf(quoted) && { text: previewOf(quoted) }),
        },
      }),
      mentions: message.context?.mentions?.map((id) => chats.token(id, id)) ?? [],
      content: contentView(message),
    };
  };

  const optimisticMessage = (message: OptimisticMessage, timestamp: number): ApplicationMessage => {
    const operationKey = operations.token(message.operationId, message.operationId);
    return {
      key: `operation:${operationKey}`,
      fromMe: true,
      timestamp,
      edited: false,
      ephemeral: false,
      viewOnce: false,
      reactions: [],
      mentions: [],
      content: optimisticContent(message.content),
      operation: {
        key: operationKey,
        status: message.state.status,
        ...(operationDetail(message) && { detail: operationDetail(message) }),
      },
    };
  };

  const sendOptions = (command: MessageOptions): ClientSendOptions | undefined => {
    const quote = command.quote ? messages.resolve(command.quote) : undefined;
    const mentions = command.mentions?.map((token) => chats.resolve(token) ?? token);
    return quote || mentions?.length
      ? { ...(quote && { quote }), ...(mentions?.length && { mentions }) }
      : undefined;
  };

  const operationResult = (operation: WhatsAppOperation): WhatsAppApplicationCommandResult => ({
    type: "operation",
    key: operations.token(operation.id, operation.id),
    status: operation.state.status,
  });
  const assertAllowed = (chatId: string): void => {
    if (!canSend(chatId))
      throw new TypeError("This local example may only act on allowlisted chats");
  };

  return {
    // eslint-disable-next-line complexity -- exhaustive projection of the public Client view
    async state(selectedKey) {
      if (closed) throw new Error("WhatsApp application is closed");
      const records = client.chats.list();
      const selectedId = selectedKey ? chats.resolve(selectedKey) : undefined;
      const selected = selectedId
        ? (records.find((chat) => chat.chatId === selectedId) ?? {
            accountId,
            chatId: selectedId,
            isGroup: selectedId.endsWith("@g.us"),
            ...(client.groups.list().find((group) => group.groupId === selectedId)?.subject && {
              subject: client.groups.list().find((group) => group.groupId === selectedId)?.subject,
            }),
            lastMessageAt: 0,
          })
        : undefined;
      const preview = records.slice(0, SIDEBAR_PREVIEW_COUNT);
      const status = records.find((chat) => chat.chatId === STATUS_CHAT_ID);
      const pageIds = new Set(preview.map((chat) => chat.chatId));
      if (status) pageIds.add(status.chatId);
      if (selected) pageIds.add(selected.chatId);
      await Promise.all([...pageIds].map(page));
      const chatViews = records
        .filter((chat) => chat.chatId !== STATUS_CHAT_ID)
        .map((chat, index) => chatView(chat, index < SIDEBAR_PREVIEW_COUNT));
      const account = client.account.get();
      const updates: ApplicationUpdate[] = [];
      if (status) {
        for (const message of client.messages.get(status.chatId).messages) {
          const nativeId = message.sender.id;
          const contact = client.contacts.resolve(nativeId);
          const sender = message.fromMe
            ? (account.identity?.pushName ?? "You")
            : (senderName(message) ?? "WhatsApp contact");
          const source = avatarUrl(contact?.imgUrl);
          const avatar = avatarToken(nativeId, source);
          updates.push({
            key: messages.token(message.ref, `${message.chatId}\0${message.messageId}`),
            sender,
            initials: initials(sender),
            ...(avatar && { avatar }),
            timestamp: message.timestamp,
            content: contentView(message),
          });
        }
      }
      let conversation: ApplicationConversation | undefined;
      if (selected) {
        const retained = client.messages.get(selected.chatId);
        const loaded = new Map(retained.messages.map((message) => [message.messageId, message]));
        const keys = new Map(
          retained.messages.map((message) => [
            message.messageId,
            messages.token(message.ref, `${message.chatId}\0${message.messageId}`),
          ]),
        );
        const storedGroup = selected.isGroup
          ? client.groups.list().find((candidate) => candidate.groupId === selected.chatId)
          : undefined;
        let group = selected.isGroup ? groupMetadata.get(selected.chatId) : undefined;
        if (selected.isGroup && canSend(selected.chatId) && !group) {
          try {
            group = await client.groups.metadata(selected.chatId);
            groupMetadata.set(selected.chatId, group);
          } catch {
            // Stored membership is still useful while the live metadata request is unavailable.
          }
        }
        const projected = [...retained.messages]
          .reverse()
          .map((message) => authoritativeMessage(message, loaded, keys));
        const optimistic = retained.outgoing.map((message, index) =>
          optimisticMessage(message, Date.now() + index),
        );
        const participantRecords = (group ?? storedGroup)?.participants;
        conversation = {
          chat: chatView(selected, true),
          messages: [...projected, ...optimistic],
          paging: retained.error ? "error" : retained.older,
          ...(group && {
            group: {
              ...(group.description && { description: group.description }),
              ...(group.announcement !== undefined && { announcement: group.announcement }),
              ...(group.locked !== undefined && { locked: group.locked }),
            },
          }),
          ...(participantRecords !== undefined && {
            participants: participantRecords.map((participant) => ({
              key: chats.token(participant.id, participant.id),
              name: directName(client, participant.id),
              ...(participant.role && { role: participant.role }),
            })),
          }),
        };
      }
      return {
        revision,
        account: {
          name: account.identity?.pushName ?? account.accountId,
          ...(connectionOf(account) && { connection: connectionOf(account) }),
          ...(account.lastConnectedAt !== undefined && {
            lastConnectedAt: account.lastConnectedAt,
          }),
          ...(account.lastDisconnectedAt !== undefined && {
            lastDisconnectedAt: account.lastDisconnectedAt,
          }),
        },
        chats: chatViews,
        updates,
        contacts: client.contacts.list().map((contact, index) => {
          const nativeId =
            contact.nativeIds.find(canSend) ?? contact.nativeIds[0] ?? contact.contactId;
          const groupIds = contact.nativeIds.filter(canCreateGroupWith);
          const groupId = groupIds.find((id) => id.endsWith("@s.whatsapp.net")) ?? groupIds[0];
          const name = firstName(contact) ?? nativeId.split("@")[0] ?? "Unknown contact";
          const source = avatarUrl(contact.imgUrl);
          const avatar = index < SIDEBAR_PREVIEW_COUNT ? avatarToken(nativeId, source) : undefined;
          return {
            key: chats.token(nativeId, nativeId),
            name,
            initials: initials(name),
            ...(avatar && { avatar }),
            ...(contact.about && { about: contact.about }),
            ...(contact.lastSeenAt !== undefined && { lastSeenAt: contact.lastSeenAt }),
            ...(client.contacts.presence(nativeId) && {
              presence: client.contacts.presence(nativeId),
            }),
            canSend: canSend(nativeId),
            canCreateGroup: groupId !== undefined,
            ...(groupId && { groupKey: chats.token(groupId, groupId) }),
            ...(groupIds.length && {
              groupKeys: groupIds.map((id) => chats.token(id, id)),
            }),
          };
        }),
        groups: client.groups.list().map((group, index) => {
          const name = group.subject ?? "Unnamed group";
          const avatar = index < SIDEBAR_PREVIEW_COUNT ? avatarToken(group.groupId) : undefined;
          return {
            key: chats.token(group.groupId, group.groupId),
            name,
            initials: initials(name),
            ...(avatar && { avatar }),
            ...(group.participants !== undefined && {
              participantCount: group.participants.length,
            }),
            canSend: canSend(group.groupId),
          };
        }),
        ...(conversation && { conversation }),
      };
    },
    subscribe(listener) {
      if (closed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // eslint-disable-next-line complexity -- one exhaustive discriminated command boundary
    async command(command) {
      if (closed) throw new Error("WhatsApp application is closed");
      if (command.type === "acknowledge") {
        const id = operations.resolve(command.operation);
        if (!id) throw new TypeError("Unknown operation");
        await client.operations.acknowledge(id);
        return { type: "accepted" };
      }
      if (command.type === "group_create") {
        const participants = command.participants.map((key) =>
          required(chats.resolve(key), "contact"),
        );
        if (!participants.length || participants.some((id) => !canCreateGroupWith(id)))
          throw new TypeError("Groups may only include the configured proof peer");
        const group = await client.groups.create(
          requiredText(command.subject, "subject"),
          participants,
        );
        options.onGroupCreated?.(group.id);
        groupMetadata.set(group.id, group);
        announce();
        return { type: "group", key: chats.token(group.id, group.id) };
      }
      if (command.type === "mark_read") {
        const refs = command.messages.map((key) => required(messages.resolve(key), "message"));
        for (const ref of refs) assertAllowed(ref.chatId);
        return operationResult(await client.messages.markRead(refs));
      }
      if (
        command.type === "react" ||
        command.type === "unreact" ||
        command.type === "edit" ||
        command.type === "revoke"
      ) {
        const ref = required(messages.resolve(command.message), "message");
        assertAllowed(ref.chatId);
        if (command.type === "react")
          return operationResult(
            await client.messages.react(ref, requiredText(command.emoji, "emoji")),
          );
        if (command.type === "unreact") return operationResult(await client.messages.unreact(ref));
        if (command.type === "edit")
          return operationResult(
            await client.messages.edit(ref, requiredText(command.text, "text")),
          );
        return operationResult(await client.messages.revoke(ref));
      }
      const chatId = required(chats.resolve(command.chat), "chat");
      if (isGroupCommand(command)) {
        assertAllowed(chatId);
        if (command.type === "group_subject")
          await client.groups.updateSubject(chatId, requiredText(command.subject, "subject"));
        else if (command.type === "group_description")
          await client.groups.updateDescription(chatId, command.description?.trim() || undefined);
        else if (command.type === "group_participants") {
          const participants = command.participants.map((key) =>
            required(chats.resolve(key), "participant"),
          );
          if (command.action === "add" && participants.some((id) => !canCreateGroupWith(id)))
            throw new TypeError("Only the configured proof peer may be added");
          await client.groups.updateParticipants(chatId, participants, command.action);
        } else if (command.type === "group_setting")
          await client.groups.updateSetting(chatId, command.setting);
        else if (command.type === "group_invite")
          return { type: "invite", code: await client.groups.inviteCode(chatId) };
        else if (command.type === "group_revoke_invite")
          return { type: "invite", code: await client.groups.revokeInvite(chatId) };
        else if (command.type === "group_picture")
          await client.groups.updatePicture(
            chatId,
            await boundedBytes(command.source, 5 * 1024 * 1024),
          );
        else if (command.type === "group_remove_picture") await client.groups.removePicture(chatId);
        else await client.groups.leave(chatId);
        groupMetadata.delete(chatId);
        announce();
        return { type: "accepted" };
      }
      if (command.type === "typing") {
        assertAllowed(chatId);
        await client.messages.setTyping(chatId, command.on);
        return { type: "accepted" };
      }
      if (command.type === "load_older") {
        client.messages.older(chatId);
        return { type: "accepted" };
      }
      if (command.type === "request_phone_history") {
        assertAllowed(chatId);
        const oldest = client.messages.get(chatId).messages.at(-1);
        if (!oldest) throw new TypeError("No stored message can anchor phone history");
        return operationResult(
          await client.messages.requestPhoneHistory(chatId, {
            before: { ref: oldest.ref, timestamp: oldest.timestamp },
            count: command.count ?? 50,
          }),
        );
      }
      assertAllowed(chatId);
      const opts = sendOptions(command);
      const input = "source" in command ? binaryInput(command.source) : undefined;
      if (command.type === "send_text")
        return operationResult(
          await client.messages.send.text(chatId, requiredText(command.text, "text"), opts),
        );
      if (command.type === "send_image")
        return operationResult(
          await client.messages.send.image(chatId, input!, {
            ...opts,
            ...(command.caption && { caption: command.caption }),
          }),
        );
      if (command.type === "send_video")
        return operationResult(
          await client.messages.send.video(chatId, input!, {
            ...opts,
            ...(command.caption && { caption: command.caption }),
            ...(command.gifPlayback !== undefined && { gifPlayback: command.gifPlayback }),
          }),
        );
      if (command.type === "send_audio")
        return operationResult(
          await client.messages.send.audio(chatId, input!, {
            ...opts,
            ...(command.ptt !== undefined && { ptt: command.ptt }),
            ...(command.seconds !== undefined && { seconds: command.seconds }),
            ...(command.mimetype && { mimetype: command.mimetype }),
          }),
        );
      if (command.type === "send_document")
        return operationResult(
          await client.messages.send.document(chatId, input!, {
            ...opts,
            fileName: requiredText(command.fileName, "fileName"),
            mimetype: requiredText(command.mimetype, "mimetype"),
            ...(command.caption && { caption: command.caption }),
          }),
        );
      if (command.type === "send_sticker")
        return operationResult(await client.messages.send.sticker(chatId, input!, opts));
      if (command.type === "send_location")
        return operationResult(await client.messages.send.location(chatId, command.location, opts));
      return operationResult(await client.messages.send.contacts(chatId, command.contacts, opts));
    },
    async media(token) {
      const target = mediaRefs.resolve(token);
      if (!target) return undefined;
      const source = await media.open({ accountId, ref: target.ref });
      if (!source) return undefined;
      return {
        source,
        mimetype: target.mimetype ?? "application/octet-stream",
        ...(target.fileName && { fileName: target.fileName }),
      };
    },
    async avatar(token) {
      const target = avatars.resolve(token);
      if (!target) return undefined;
      if (target.source) return target.source;
      if (!options.resolveAvatar) return undefined;
      let pending = avatarLoads.get(target.nativeId);
      if (!pending) {
        pending = options
          .resolveAvatar(target.nativeId)
          .then((source) => avatarUrl(source))
          .catch(() => undefined);
        avatarLoads.set(target.nativeId, pending);
      }
      return pending;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const unsubscribe of subscriptions) unsubscribe();
      listeners.clear();
    },
  };
}

async function boundedBytes(
  source: Uint8Array | AsyncIterable<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  if (source instanceof Uint8Array) {
    if (source.byteLength > limit) throw new RangeError("Group picture is too large");
    return Uint8Array.from(source);
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of source) {
    length += chunk.byteLength;
    if (length > limit) throw new RangeError("Group picture is too large");
    chunks.push(Uint8Array.from(chunk));
  }
  const value = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    value.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return value;
}

function binaryInput(source: Uint8Array | AsyncIterable<Uint8Array>): BinaryInput {
  return source instanceof Uint8Array ? Buffer.from(source) : { stream: source };
}

function required<T>(value: T | undefined, kind: string): T {
  if (value === undefined) throw new TypeError(`Unknown ${kind}`);
  return value;
}

function requiredText(value: string, name: string): string {
  if (!value.trim()) throw new TypeError(`${name} must not be empty`);
  return value;
}
