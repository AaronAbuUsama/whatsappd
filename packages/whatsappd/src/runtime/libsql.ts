/* oxlint-disable max-lines -- SQL adapter stays cohesive; split only with a second SQL backend. */
import type { Client, Row, Transaction } from "@libsql/client";
import type { ContactUpdate } from "../model/contact.ts";
import type { GroupUpdate } from "../model/group.ts";
import type { ConversationSyncSource } from "../model/history.ts";
import type { MessageContext, MessageFlags } from "../model/message.ts";
import { refOf, type MessageRef } from "../model/outbound.ts";
import {
  libsqlCredentialStore,
  lazyLibsqlClient,
  type LazyLibsqlClient,
} from "../stores/libsql.ts";
import {
  StaleAccountClaimError,
  type AcceptedWhatsAppBatch,
  type AccountLease,
  type AccountLeaseStore,
  type AccountRecord,
  type ChatRecord,
  type ContactRecord,
  type DurableConversationSyncBatch,
  type DurableInboundMessage,
  type DurableMedia,
  type DurableUpdate,
  type GroupRecord,
  type MediaStore,
  type MessageReaction,
  type MessageReceipt,
  type MessageRecord,
  type MirrorAlias,
  type MirrorDelete,
  type MirrorRecord,
  type MirrorView,
  type WhatsAppBackend,
  type WhatsAppDataEvent,
  type WhatsAppDataStore,
  type WhatsAppPatch,
} from "./contracts.ts";
import {
  projectCurrentMirror,
  type CurrentMirrorMutation,
  type CurrentMirrorRecords,
} from "./projection.ts";
import { libsqlOperationStore } from "./libsql-operations.ts";
import { transact } from "./libsql-transaction.ts";
import { validatePage } from "./mirror-page.ts";

export interface LibsqlBackendOptions {
  readonly url: string;
  readonly authToken?: string;
  readonly accountId: string;
  readonly media: MediaStore;
}

export interface LibsqlBackend extends WhatsAppBackend, AsyncDisposable {
  close(): Promise<void>;
}

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS wa_auth (
        account TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (account, key)
      );
      CREATE TABLE IF NOT EXISTS wa_accounts (
        account_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        source_seq INTEGER NOT NULL DEFAULT 0 CHECK (source_seq >= 0),
        newest_fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (newest_fencing_token >= 0),
        account_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wa_accepted_batches (
        account_id TEXT NOT NULL,
        seq INTEGER NOT NULL CHECK (seq > 0),
        from_revision INTEGER NOT NULL CHECK (from_revision >= 0),
        revision INTEGER NOT NULL CHECK (revision >= from_revision),
        events_json TEXT NOT NULL,
        patch_json TEXT NOT NULL,
        PRIMARY KEY (account_id, seq)
      );
      CREATE TABLE IF NOT EXISTS wa_chats (
        account_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        data_json TEXT NOT NULL,
        PRIMARY KEY (account_id, chat_id)
      );
      CREATE TABLE IF NOT EXISTS wa_contacts (
        account_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        data_json TEXT NOT NULL,
        PRIMARY KEY (account_id, contact_id)
      );
      CREATE TABLE IF NOT EXISTS wa_contact_aliases (
        account_id TEXT NOT NULL,
        native_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        PRIMARY KEY (account_id, native_id)
      );
      CREATE INDEX IF NOT EXISTS wa_contact_alias_owner
        ON wa_contact_aliases (account_id, contact_id);
      CREATE TABLE IF NOT EXISTS wa_groups (
        account_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        data_json TEXT NOT NULL,
        PRIMARY KEY (account_id, group_id)
      );
      CREATE TABLE IF NOT EXISTS wa_messages (
        account_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        PRIMARY KEY (account_id, chat_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS wa_message_page
        ON wa_messages (account_id, chat_id, timestamp DESC, message_id DESC);
      CREATE TABLE IF NOT EXISTS wa_account_leases (
        account_id TEXT PRIMARY KEY,
        holder_id TEXT,
        expires_at INTEGER,
        fencing_counter INTEGER NOT NULL DEFAULT 0 CHECK (fencing_counter >= 0),
        CHECK ((holder_id IS NULL) = (expires_at IS NULL))
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS wa_operations (
        account_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        submitted_at INTEGER NOT NULL,
        operation_json TEXT NOT NULL,
        PRIMARY KEY (account_id, operation_id),
        UNIQUE (account_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS wa_operation_order
        ON wa_operations (account_id, submitted_at, operation_id);
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE wa_operations ADD COLUMN sequence INTEGER;
      UPDATE wa_operations
        SET sequence = rowid,
            operation_json = json_set(operation_json, '$.sequence', rowid)
        WHERE sequence IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS wa_operation_sequence
        ON wa_operations (account_id, sequence);
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS wa_pending_message_updates (
        account_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        data_json TEXT NOT NULL,
        PRIMARY KEY (account_id, chat_id, message_id)
      );
    `,
  },
] as const;

async function replaceEmptyLegacyOperationTable(transaction: Transaction): Promise<void> {
  const columns = await transaction.execute("PRAGMA table_info(wa_operations)");
  const names = new Set(columns.rows.map((row) => (typeof row.name === "string" ? row.name : "")));
  if (!names.has("input_json") || names.has("operation_json")) return;

  const count = await transaction.execute("SELECT COUNT(*) AS count FROM wa_operations");
  if (integer(count.rows[0]?.count, "legacy operation count") !== 0) {
    throw new Error("legacy wa_operations contains durable rows and cannot be replaced safely");
  }

  await transaction.executeMultiple(`
    DROP TABLE wa_operations;
    DELETE FROM wa_schema_migrations WHERE version >= 2;
  `);
}

async function migrate(client: Client): Promise<void> {
  const transaction = await client.transaction("write");
  try {
    await transaction.execute({
      sql: `CREATE TABLE IF NOT EXISTS wa_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      args: [],
    });
    await replaceEmptyLegacyOperationTable(transaction);
    const applied = await transaction.execute({
      sql: "SELECT version FROM wa_schema_migrations",
      args: [],
    });
    const versions = new Set(applied.rows.map((row) => integer(row.version, "migration version")));
    for (const migration of migrations) {
      if (versions.has(migration.version)) continue;
      await transaction.executeMultiple(migration.sql);
      await transaction.execute({
        sql: "INSERT INTO wa_schema_migrations (version) VALUES (?)",
        args: [migration.version],
      });
    }
    await transaction.commit();
  } catch (error) {
    if (!transaction.closed) await transaction.rollback().catch(() => {});
    throw error;
  } finally {
    transaction.close();
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`invalid libSQL ${label}`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`invalid libSQL ${label}`);
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`invalid libSQL ${label}`);
  return value;
}

function integer(value: unknown, label: string): number {
  const result = number(value, label);
  if (!Number.isSafeInteger(result)) throw new Error(`invalid libSQL ${label}`);
  return result;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`invalid libSQL ${label}`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label);
}

function optionalNumber(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : number(value, label);
}

function strings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`invalid libSQL ${label}`);
  return value.map((entry, index) => string(entry, `${label}[${index}]`));
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parsed(value: unknown, label: string): unknown {
  try {
    return JSON.parse(string(value, label));
  } catch (error) {
    throw new Error(`invalid libSQL ${label}`, { cause: error });
  }
}

function accountRecord(value: unknown): AccountRecord {
  const record = object(value, "account record");
  return {
    accountId: string(record.accountId, "account.accountId"),
    ...(optionalNumber(record.lastConnectedAt, "account.lastConnectedAt") !== undefined && {
      lastConnectedAt: number(record.lastConnectedAt, "account.lastConnectedAt"),
    }),
    ...(optionalNumber(record.lastDisconnectedAt, "account.lastDisconnectedAt") !== undefined && {
      lastDisconnectedAt: number(record.lastDisconnectedAt, "account.lastDisconnectedAt"),
    }),
  };
}

function chatRecord(value: unknown): ChatRecord {
  const record = object(value, "chat record");
  return {
    accountId: string(record.accountId, "chat.accountId"),
    chatId: string(record.chatId, "chat.chatId"),
    isGroup: boolean(record.isGroup, "chat.isGroup"),
    ...(optionalString(record.subject, "chat.subject") !== undefined && {
      subject: string(record.subject, "chat.subject"),
    }),
    lastMessageAt: number(record.lastMessageAt, "chat.lastMessageAt"),
  };
}

function contactRecord(value: unknown): ContactRecord {
  const record = object(value, "contact record");
  const imgUrl = record.imgUrl;
  if (imgUrl !== undefined && imgUrl !== null && typeof imgUrl !== "string")
    throw new Error("invalid libSQL contact.imgUrl");
  return {
    accountId: string(record.accountId, "contact.accountId"),
    contactId: string(record.contactId, "contact.contactId"),
    nativeIds: strings(record.nativeIds, "contact.nativeIds"),
    ...(optionalString(record.displayName, "contact.displayName") !== undefined && {
      displayName: string(record.displayName, "contact.displayName"),
    }),
    ...(optionalString(record.profileName, "contact.profileName") !== undefined && {
      profileName: string(record.profileName, "contact.profileName"),
    }),
    ...(optionalString(record.verifiedName, "contact.verifiedName") !== undefined && {
      verifiedName: string(record.verifiedName, "contact.verifiedName"),
    }),
    ...(optionalString(record.username, "contact.username") !== undefined && {
      username: string(record.username, "contact.username"),
    }),
    ...(imgUrl !== undefined && { imgUrl }),
    ...(optionalString(record.about, "contact.about") !== undefined && {
      about: string(record.about, "contact.about"),
    }),
    ...(optionalNumber(record.lastSeenAt, "contact.lastSeenAt") !== undefined && {
      lastSeenAt: number(record.lastSeenAt, "contact.lastSeenAt"),
    }),
  };
}

function participants(value: unknown): readonly { readonly id: string; readonly role?: string }[] {
  if (!Array.isArray(value)) throw new Error("invalid libSQL group.participants");
  return value.map((entry, index) => {
    const participant = object(entry, `group.participants[${index}]`);
    return {
      id: string(participant.id, `group.participants[${index}].id`),
      ...(optionalString(participant.role, `group.participants[${index}].role`) !== undefined && {
        role: string(participant.role, `group.participants[${index}].role`),
      }),
    };
  });
}

function groupRecord(value: unknown): GroupRecord {
  const record = object(value, "group record");
  const participantsKnown =
    record.participantsKnown === undefined
      ? Array.isArray(record.participants) && record.participants.length > 0
      : boolean(record.participantsKnown, "group.participantsKnown");
  const roster = participantsKnown ? participants(record.participants) : undefined;
  return {
    accountId: string(record.accountId, "group.accountId"),
    groupId: string(record.groupId, "group.groupId"),
    ...(optionalString(record.subject, "group.subject") !== undefined && {
      subject: string(record.subject, "group.subject"),
    }),
    ...(roster !== undefined && { participants: roster }),
  };
}

function address(value: unknown, label: string): MessageRecord["sender"] {
  const record = object(value, label);
  const mode = string(record.mode, `${label}.mode`);
  if (mode !== "lid" && mode !== "pn") throw new Error(`invalid libSQL ${label}.mode`);
  return {
    id: string(record.id, `${label}.id`),
    mode,
    ...(optionalString(record.alt, `${label}.alt`) !== undefined && {
      alt: string(record.alt, `${label}.alt`),
    }),
  };
}

function messageReceipts(value: unknown): readonly MessageReceipt[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("invalid libSQL message.receipts");
  return value.map((entry, index) => {
    const label = `message.receipts[${index}]`;
    const receipt = object(entry, label);
    const status = string(receipt.status, `${label}.status`);
    if (
      status !== "pending" &&
      status !== "server_ack" &&
      status !== "delivered" &&
      status !== "read" &&
      status !== "played" &&
      status !== "error"
    )
      throw new Error(`invalid libSQL ${label}.status`);
    const by = optionalString(receipt.by, `${label}.by`);
    const at = optionalNumber(receipt.at, `${label}.at`);
    return {
      subject: string(receipt.subject, `${label}.subject`),
      status,
      ...(by !== undefined && { by }),
      ...(at !== undefined && { at }),
    };
  });
}

function messageReactions(value: unknown): readonly MessageReaction[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("invalid libSQL message.reactions");
  return value.map((entry, index) => {
    const label = `message.reactions[${index}]`;
    const reaction = object(entry, label);
    const by = optionalString(reaction.by, `${label}.by`);
    const at = optionalNumber(reaction.at, `${label}.at`);
    return {
      subject: string(reaction.subject, `${label}.subject`),
      emoji: string(reaction.emoji, `${label}.emoji`),
      ...(by !== undefined && { by }),
      ...(at !== undefined && { at }),
    };
  });
}

function messageRecord(value: unknown): MessageRecord {
  const record = object(value, "message record");
  const accountId = string(record.accountId, "message.accountId");
  const chatId = string(record.chatId, "message.chatId");
  const messageId = string(record.messageId, "message.messageId");
  const fromMe = boolean(record.fromMe, "message.fromMe");
  const pushName = optionalString(record.pushName, "message.pushName");
  const editedAt = optionalNumber(record.editedAt, "message.editedAt");
  const sender = address(record.sender, "message.sender");
  const base = {
    accountId,
    chatId,
    messageId,
    sender,
    ref:
      record.ref === undefined
        ? refOf({ id: messageId, chatId, sender, fromMe, isGroup: chatId.endsWith("@g.us") })
        : messageRef(record.ref, "message.ref"),
    fromMe,
    timestamp: number(record.timestamp, "message.timestamp"),
    ...(pushName !== undefined && { pushName }),
    ...(record.context !== undefined && {
      context: messageContext(record.context, "message.context"),
    }),
    ...(record.flags !== undefined && { flags: messageFlags(record.flags, "message.flags") }),
    receipts: messageReceipts(record.receipts),
    reactions: messageReactions(record.reactions),
    ...(editedAt !== undefined && { editedAt }),
  };
  switch (record.kind) {
    case "text":
      return { ...base, kind: "text", text: string(record.text, "message.text") };
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker": {
      const text = optionalString(record.text, "message.text");
      return {
        ...base,
        kind: record.kind,
        media: durableMedia(record.media, "message.media"),
        ...(text !== undefined && { text }),
      };
    }
    case "location": {
      const name = optionalString(record.name, "message.name");
      const locationAddress = optionalString(record.address, "message.address");
      return {
        ...base,
        kind: "location",
        lat: number(record.lat, "message.lat"),
        lng: number(record.lng, "message.lng"),
        ...(name !== undefined && { name }),
        ...(locationAddress !== undefined && { address: locationAddress }),
      };
    }
    case "contacts":
      if (!Array.isArray(record.contacts)) throw new Error("invalid libSQL message.contacts");
      return {
        ...base,
        kind: "contacts",
        contacts: record.contacts.map((value, index) => {
          const contact = object(value, `message.contacts[${index}]`);
          const name = optionalString(contact.name, `message.contacts[${index}].name`);
          return {
            ...(name !== undefined && { name }),
            vcard: string(contact.vcard, `message.contacts[${index}].vcard`),
          };
        }),
      };
    case "poll": {
      const votes = record.votes;
      if (votes !== undefined && !Array.isArray(votes))
        throw new Error("invalid libSQL message.votes");
      return {
        ...base,
        kind: "poll",
        name: string(record.name, "message.name"),
        options: strings(record.options, "message.options"),
        selectableCount: number(record.selectableCount, "message.selectableCount"),
        ...(votes !== undefined && {
          votes: votes.map((value, index) => {
            const vote = object(value, `message.votes[${index}]`);
            return {
              option: string(vote.option, `message.votes[${index}].option`),
              voters: strings(vote.voters, `message.votes[${index}].voters`),
            };
          }),
        }),
      };
    }
    case "unsupported":
      return { ...base, kind: "unsupported", rawType: string(record.rawType, "message.rawType") };
    case "revoked": {
      const revokedAt = optionalNumber(record.revokedAt, "message.revokedAt");
      const revokedBy = optionalString(record.revokedBy, "message.revokedBy");
      return {
        ...base,
        kind: "revoked",
        ...(revokedAt !== undefined && { revokedAt }),
        ...(revokedBy !== undefined && { revokedBy }),
      };
    }
    default:
      throw new Error("invalid libSQL message.kind");
  }
}

function durableMedia(value: unknown, label: string, allowLegacyMetadata = false): DurableMedia {
  const media = object(value, label);
  if ("download" in media) throw new Error(`invalid libSQL ${label}.download`);
  const metadata = {
    ...(optionalString(media.mimetype, `${label}.mimetype`) !== undefined && {
      mimetype: string(media.mimetype, `${label}.mimetype`),
    }),
    ...(optionalNumber(media.fileLength, `${label}.fileLength`) !== undefined && {
      fileLength: number(media.fileLength, `${label}.fileLength`),
    }),
    ...(optionalString(media.fileName, `${label}.fileName`) !== undefined && {
      fileName: string(media.fileName, `${label}.fileName`),
    }),
    ...(optionalNumber(media.seconds, `${label}.seconds`) !== undefined && {
      seconds: number(media.seconds, `${label}.seconds`),
    }),
    ...(media.ptt !== undefined && { ptt: boolean(media.ptt, `${label}.ptt`) }),
    ...(optionalNumber(media.width, `${label}.width`) !== undefined && {
      width: number(media.width, `${label}.width`),
    }),
    ...(optionalNumber(media.height, `${label}.height`) !== undefined && {
      height: number(media.height, `${label}.height`),
    }),
    ...(optionalString(media.caption, `${label}.caption`) !== undefined && {
      caption: string(media.caption, `${label}.caption`),
    }),
  };
  if (media.state === "stored") {
    if ("reason" in media) throw new Error(`invalid libSQL ${label}.reason`);
    const byteLength = integer(media.byteLength, `${label}.byteLength`);
    if (byteLength < 0) throw new Error(`invalid libSQL ${label}.byteLength`);
    return { ...metadata, state: "stored", ref: string(media.ref, `${label}.ref`), byteLength };
  }
  if (media.state === "failed") {
    if ("ref" in media || "byteLength" in media) throw new Error(`invalid libSQL ${label}.ref`);
    const reason = string(media.reason, `${label}.reason`);
    if (reason !== "download_failed" && reason !== "store_failed")
      throw new Error(`invalid libSQL ${label}.reason`);
    return { ...metadata, state: "failed", reason };
  }
  if (
    allowLegacyMetadata &&
    media.state === undefined &&
    !("ref" in media) &&
    !("byteLength" in media) &&
    !("reason" in media)
  )
    return { ...metadata, state: "failed", reason: "download_failed" };
  throw new Error(`invalid libSQL ${label}.state`);
}

function messageContext(value: unknown, label: string): MessageContext {
  const context = object(value, label);
  const quoted =
    context.quoted === undefined ? undefined : object(context.quoted, `${label}.quoted`);
  return {
    ...(quoted !== undefined && {
      quoted: {
        id: string(quoted.id, `${label}.quoted.id`),
        from: string(quoted.from, `${label}.quoted.from`),
      },
    }),
    ...(context.mentions !== undefined && {
      mentions: strings(context.mentions, `${label}.mentions`),
    }),
  };
}

function messageFlags(value: unknown, label: string): MessageFlags {
  const flags = object(value, label);
  return {
    ...(flags.viewOnce !== undefined && {
      viewOnce: boolean(flags.viewOnce, `${label}.viewOnce`),
    }),
    ...(flags.ephemeral !== undefined && {
      ephemeral: boolean(flags.ephemeral, `${label}.ephemeral`),
    }),
    ...(flags.edited !== undefined && { edited: boolean(flags.edited, `${label}.edited`) }),
  };
}

function durableMessage(value: unknown, label: string): DurableInboundMessage {
  const message = object(value, label);
  const keyParticipant = optionalString(message.keyParticipant, `${label}.keyParticipant`);
  const pushName = optionalString(message.pushName, `${label}.pushName`);
  const base = {
    id: string(message.id, `${label}.id`),
    chatId: string(message.chatId, `${label}.chatId`),
    sender: address(message.sender, `${label}.sender`),
    ...(keyParticipant !== undefined && { keyParticipant }),
    ...(pushName !== undefined && { pushName }),
    fromMe: boolean(message.fromMe, `${label}.fromMe`),
    timestamp: number(message.timestamp, `${label}.timestamp`),
    live: boolean(message.live, `${label}.live`),
    isGroup: boolean(message.isGroup, `${label}.isGroup`),
    ...(message.context !== undefined && {
      context: messageContext(message.context, `${label}.context`),
    }),
    ...(message.flags !== undefined && {
      flags: messageFlags(message.flags, `${label}.flags`),
    }),
  };
  const kind = string(message.kind, `${label}.kind`);
  switch (kind) {
    case "text":
      return { ...base, kind, text: string(message.text, `${label}.text`) };
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker": {
      const text = optionalString(message.text, `${label}.text`);
      return {
        ...base,
        kind,
        // Before durable capture, accepted source retained metadata only. It
        // remains readable as an explicit failure; current mirror rows stay
        // strict through messageRecord().
        media: durableMedia(message.media, `${label}.media`, true),
        ...(text !== undefined && { text }),
      };
    }
    case "location": {
      const name = optionalString(message.name, `${label}.name`);
      const locationAddress = optionalString(message.address, `${label}.address`);
      return {
        ...base,
        kind,
        lat: number(message.lat, `${label}.lat`),
        lng: number(message.lng, `${label}.lng`),
        ...(name !== undefined && { name }),
        ...(locationAddress !== undefined && { address: locationAddress }),
      };
    }
    case "contacts":
      if (!Array.isArray(message.contacts)) throw new Error(`invalid libSQL ${label}.contacts`);
      return {
        ...base,
        kind,
        contacts: message.contacts.map((value, index) => {
          const contact = object(value, `${label}.contacts[${index}]`);
          const name = optionalString(contact.name, `${label}.contacts[${index}].name`);
          return {
            ...(name !== undefined && { name }),
            vcard: string(contact.vcard, `${label}.contacts[${index}].vcard`),
          };
        }),
      };
    case "poll":
      return {
        ...base,
        kind,
        name: string(message.name, `${label}.name`),
        options: strings(message.options, `${label}.options`),
        selectableCount: number(message.selectableCount, `${label}.selectableCount`),
      };
    case "unsupported":
      return { ...base, kind, rawType: string(message.rawType, `${label}.rawType`) };
    default:
      throw new Error(`invalid libSQL ${label}.kind`);
  }
}

function messageRef(value: unknown, label: string): MessageRef {
  const ref = object(value, label);
  const participant = optionalString(ref.participant, `${label}.participant`);
  return {
    id: string(ref.id, `${label}.id`),
    chatId: string(ref.chatId, `${label}.chatId`),
    fromMe: boolean(ref.fromMe, `${label}.fromMe`),
    ...(participant !== undefined && { participant }),
  };
}

function durableUpdate(value: unknown, label: string): DurableUpdate {
  const update = object(value, label);
  const at = optionalNumber(update.at, `${label}.at`);
  const base = { ref: messageRef(update.ref, `${label}.ref`), ...(at !== undefined && { at }) };
  switch (update.kind) {
    case "receipt": {
      const status = string(update.status, `${label}.status`);
      const by = optionalString(update.by, `${label}.by`);
      switch (status) {
        case "pending":
        case "server_ack":
        case "delivered":
        case "read":
        case "played":
        case "error":
          return { ...base, kind: "receipt", status, ...(by !== undefined && { by }) };
        default:
          throw new Error(`invalid libSQL ${label}.status`);
      }
    }
    case "reaction": {
      const emoji = optionalString(update.emoji, `${label}.emoji`);
      const by = optionalString(update.by, `${label}.by`);
      return {
        ...base,
        kind: "reaction",
        ...(emoji !== undefined && { emoji }),
        ...(by !== undefined && { by }),
        removed: boolean(update.removed, `${label}.removed`),
      };
    }
    case "edit":
      return { ...base, kind: "edit", message: durableMessage(update.message, `${label}.message`) };
    case "revoke": {
      const by = optionalString(update.by, `${label}.by`);
      return { ...base, kind: "revoke", ...(by !== undefined && { by }) };
    }
    case "poll_votes": {
      if (!Array.isArray(update.votes)) throw new Error(`invalid libSQL ${label}.votes`);
      return {
        ...base,
        kind: "poll_votes",
        votes: update.votes.map((value, index) => {
          const vote = object(value, `${label}.votes[${index}]`);
          const voteAt = optionalNumber(vote.at, `${label}.votes[${index}].at`);
          return {
            by: string(vote.by, `${label}.votes[${index}].by`),
            selectedOptionIds: strings(
              vote.selectedOptionIds,
              `${label}.votes[${index}].selectedOptionIds`,
            ),
            ...(voteAt !== undefined && { at: voteAt }),
          };
        }),
      };
    }
    default:
      throw new Error(`invalid libSQL ${label}.kind`);
  }
}

function contactUpdate(value: unknown, label: string): ContactUpdate {
  const contact = object(value, label);
  if (contact.imgUrl !== undefined && contact.imgUrl !== null && typeof contact.imgUrl !== "string")
    throw new Error(`invalid libSQL ${label}.imgUrl`);
  const displayName = optionalString(contact.displayName, `${label}.displayName`);
  const profileName = optionalString(contact.profileName, `${label}.profileName`);
  const verifiedName = optionalString(contact.verifiedName, `${label}.verifiedName`);
  const username = optionalString(contact.username, `${label}.username`);
  const status = optionalString(contact.status, `${label}.status`);
  const at = optionalNumber(contact.at, `${label}.at`);
  return {
    id: string(contact.id, `${label}.id`),
    nativeIds: strings(contact.nativeIds, `${label}.nativeIds`),
    ...(displayName !== undefined && { displayName }),
    ...(profileName !== undefined && { profileName }),
    ...(verifiedName !== undefined && { verifiedName }),
    ...(username !== undefined && { username }),
    ...(contact.imgUrl !== undefined && { imgUrl: contact.imgUrl }),
    ...(status !== undefined && { status }),
    ...(at !== undefined && { at }),
  };
}

function groupUpdate(value: unknown, label: string): GroupUpdate {
  const group = object(value, label);
  const base = {
    id: string(group.id, `${label}.id`),
    at: number(group.at, `${label}.at`),
  };
  if (group.kind === "metadata") {
    const subject = optionalString(group.subject, `${label}.subject`);
    return {
      ...base,
      kind: "metadata",
      ...(subject !== undefined && { subject }),
      ...(group.participants !== undefined && { participants: participants(group.participants) }),
    };
  }
  if (group.kind !== "participants") throw new Error(`invalid libSQL ${label}.kind`);
  const action = string(group.action, `${label}.action`);
  switch (action) {
    case "add":
    case "remove":
    case "promote":
    case "demote":
    case "modify":
      return {
        ...base,
        kind: "participants",
        action,
        participants: participants(group.participants),
      };
    default:
      throw new Error(`invalid libSQL ${label}.action`);
  }
}

function conversationSource(value: unknown, label: string): ConversationSyncSource {
  const source = string(value, label);
  switch (source) {
    case "initial_bootstrap":
    case "recent":
    case "on_demand":
    case "full":
    case "unknown":
      return source;
    default:
      throw new Error(`invalid libSQL ${label}`);
  }
}

function conversationSync(value: unknown, label: string): DurableConversationSyncBatch {
  const batch = object(value, label);
  const context = object(batch.context, `${label}.context`);
  const projection = object(context.projection, `${label}.context.projection`);
  const mode = string(projection.mode, `${label}.context.projection.mode`);
  if (mode !== "upsert" && mode !== "authoritative_replacement")
    throw new Error(`invalid libSQL ${label}.context.projection.mode`);
  if (
    !Array.isArray(batch.chats) ||
    !Array.isArray(batch.contacts) ||
    !Array.isArray(batch.messages) ||
    (batch.updates !== undefined && !Array.isArray(batch.updates))
  )
    throw new Error(`invalid libSQL ${label}`);
  const isLatest =
    context.isLatest === undefined
      ? undefined
      : boolean(context.isLatest, `${label}.context.isLatest`);
  const chunkOrder = optionalNumber(context.chunkOrder, `${label}.context.chunkOrder`);
  const progress = optionalNumber(context.progress, `${label}.context.progress`);
  const requestSessionId = optionalString(
    context.requestSessionId,
    `${label}.context.requestSessionId`,
  );
  const projectionValue: DurableConversationSyncBatch["context"]["projection"] =
    mode === "upsert"
      ? { mode: "upsert" }
      : {
          mode: "authoritative_replacement",
          scope:
            projection.scope === "account"
              ? "account"
              : {
                  chatId: string(
                    object(projection.scope, `${label}.context.projection.scope`).chatId,
                    `${label}.context.projection.scope.chatId`,
                  ),
                },
        };
  return {
    context: {
      source: conversationSource(context.source, `${label}.context.source`),
      ...(isLatest !== undefined && { isLatest }),
      ...(chunkOrder !== undefined && { chunkOrder }),
      ...(progress !== undefined && { progress }),
      ...(requestSessionId !== undefined && { requestSessionId }),
      projection: projectionValue,
    },
    chats: batch.chats.map((value, index) => {
      const chat = object(value, `${label}.chats[${index}]`);
      const subject = optionalString(chat.subject, `${label}.chats[${index}].subject`);
      const lastMessageAt = optionalNumber(
        chat.lastMessageAt,
        `${label}.chats[${index}].lastMessageAt`,
      );
      return {
        id: string(chat.id, `${label}.chats[${index}].id`),
        isGroup: boolean(chat.isGroup, `${label}.chats[${index}].isGroup`),
        ...(subject !== undefined && { subject }),
        ...(lastMessageAt !== undefined && { lastMessageAt }),
        ...(chat.participants !== undefined && { participants: participants(chat.participants) }),
      };
    }),
    contacts: batch.contacts.map((value, index) => {
      const contact = object(value, `${label}.contacts[${index}]`);
      const displayName = optionalString(
        contact.displayName,
        `${label}.contacts[${index}].displayName`,
      );
      return {
        id: string(contact.id, `${label}.contacts[${index}].id`),
        nativeIds: strings(contact.nativeIds, `${label}.contacts[${index}].nativeIds`),
        ...(displayName !== undefined && { displayName }),
      };
    }),
    messages: batch.messages.map((message, index) =>
      durableMessage(message, `${label}.messages[${index}]`),
    ),
    updates: (batch.updates ?? []).map((update, index) =>
      durableUpdate(update, `${label}.updates[${index}]`),
    ),
  };
}

function dataEvents(value: unknown): readonly WhatsAppDataEvent[] {
  if (!Array.isArray(value)) throw new Error("invalid libSQL accepted events");
  return value.map((entry, index): WhatsAppDataEvent => {
    const label = `accepted events[${index}]`;
    const observation = object(entry, label);
    const observedAt = number(observation.observedAt, `${label}.observedAt`);
    const event = object(observation.event, `${label}.event`);
    switch (event.type) {
      case "message":
        return {
          observedAt,
          event: {
            type: "message",
            message: durableMessage(event.message, `${label}.event.message`),
          },
        };
      case "update":
        return {
          observedAt,
          event: { type: "update", update: durableUpdate(event.update, `${label}.event.update`) },
        };
      case "conversation_sync":
        return {
          observedAt,
          event: {
            type: "conversation_sync",
            batch: conversationSync(event.batch, `${label}.event.batch`),
          },
        };
      case "contact":
        return {
          observedAt,
          event: {
            type: "contact",
            contact: contactUpdate(event.contact, `${label}.event.contact`),
          },
        };
      case "group":
        return {
          observedAt,
          event: { type: "group", group: groupUpdate(event.group, `${label}.event.group`) },
        };
      case "last_seen":
        return {
          observedAt,
          event: {
            type: "last_seen",
            contactId: string(event.contactId, `${label}.event.contactId`),
            at: number(event.at, `${label}.event.at`),
          },
        };
      case "account_connection":
        if (event.kind !== "connected" && event.kind !== "disconnected")
          throw new Error(`invalid libSQL ${label}.event.kind`);
        return {
          observedAt,
          event: {
            type: "account_connection",
            kind: event.kind,
            at: number(event.at, `${label}.event.at`),
          },
        };
      default:
        throw new Error(`invalid libSQL ${label}.event.type`);
    }
  });
}

function mirrorRecord(value: unknown): MirrorRecord {
  const record = object(value, "patch upsert");
  switch (record.type) {
    case "account":
      return { type: "account", account: accountRecord(record.account) };
    case "chat":
      return { type: "chat", chat: chatRecord(record.chat) };
    case "contact":
      return { type: "contact", contact: contactRecord(record.contact) };
    case "group":
      return { type: "group", group: groupRecord(record.group) };
    case "message":
      return { type: "message", message: messageRecord(record.message) };
    default:
      throw new Error("invalid libSQL patch upsert type");
  }
}

function mirrorDelete(value: unknown): MirrorDelete {
  const record = object(value, "patch delete");
  if (record.type !== "contact") throw new Error("invalid libSQL patch delete type");
  return {
    type: "contact",
    contactId: string(record.contactId, "patch delete contactId"),
    ...(record.freedNativeIds !== undefined && {
      freedNativeIds: strings(record.freedNativeIds, "patch delete freedNativeIds"),
    }),
  };
}

function mirrorAlias(value: unknown): MirrorAlias {
  const record = object(value, "patch alias");
  return {
    nativeId: string(record.nativeId, "patch alias nativeId"),
    contactId: string(record.contactId, "patch alias contactId"),
  };
}

function patch(value: unknown): WhatsAppPatch {
  const record = object(value, "patch");
  if (!Array.isArray(record.upserts)) throw new Error("invalid libSQL patch upserts");
  if (record.deletes !== undefined && !Array.isArray(record.deletes))
    throw new Error("invalid libSQL patch deletes");
  if (record.aliases !== undefined && !Array.isArray(record.aliases))
    throw new Error("invalid libSQL patch aliases");
  const upserts = record.upserts.map(mirrorRecord);
  // A batch written before the patch carried aliases has none recorded, but
  // every alias it would have carried is derivable from its own contact
  // upserts: each record names the native ids it owns, and a record is only
  // upserted when those changed. Replaying the derived set in order reaches
  // the same Address Resolution as replaying the deltas would, because a
  // redundant alias sets a key to the value it already holds — so a consumer
  // reading from revision 0 across an upgrade is not left with a partial map.
  const aliases =
    record.aliases !== undefined
      ? record.aliases.map(mirrorAlias)
      : upserts.flatMap((upsert) =>
          upsert.type === "contact"
            ? upsert.contact.nativeIds.map((nativeId) => ({
                nativeId,
                contactId: upsert.contact.contactId,
              }))
            : [],
        );
  return {
    accountId: string(record.accountId, "patch accountId"),
    fromRevision: integer(record.fromRevision, "patch fromRevision"),
    revision: integer(record.revision, "patch revision"),
    upserts,
    ...(record.deletes !== undefined && { deletes: record.deletes.map(mirrorDelete) }),
    ...(aliases.length > 0 && { aliases }),
  };
}

function acceptedBatch(row: Row): AcceptedWhatsAppBatch {
  const accountId = string(row.account_id, "accepted account_id");
  const seq = integer(row.seq, "accepted seq");
  const fromRevision = integer(row.from_revision, "accepted from_revision");
  const revision = integer(row.revision, "accepted revision");
  const events = dataEvents(parsed(row.events_json, "accepted events_json"));
  const decodedPatch = patch(parsed(row.patch_json, "accepted patch_json"));
  if (
    decodedPatch.accountId !== accountId ||
    decodedPatch.fromRevision !== fromRevision ||
    decodedPatch.revision !== revision
  )
    throw new Error("invalid libSQL accepted batch columns");
  for (const upsert of decodedPatch.upserts) {
    const recordAccountId =
      upsert.type === "account"
        ? upsert.account.accountId
        : upsert.type === "chat"
          ? upsert.chat.accountId
          : upsert.type === "contact"
            ? upsert.contact.accountId
            : upsert.type === "group"
              ? upsert.group.accountId
              : upsert.message.accountId;
    if (recordAccountId !== accountId) throw new Error("invalid libSQL patch record scope");
  }
  return { accountId, seq, fromRevision, revision, events, patch: decodedPatch };
}

async function accountState(
  transaction: Transaction,
  accountId: string,
): Promise<
  | {
      readonly revision: number;
      readonly sourceSeq: number;
      readonly newestFencingToken: number;
      readonly account: AccountRecord;
    }
  | undefined
> {
  const result = await transaction.execute({
    sql: `SELECT revision, source_seq, newest_fencing_token, account_json
      FROM wa_accounts WHERE account_id = ?`,
    args: [accountId],
  });
  const row = result.rows[0];
  if (!row) return undefined;
  const account = accountRecord(parsed(row.account_json, "account_json"));
  if (account.accountId !== accountId) throw new Error("invalid libSQL account scope");
  return {
    revision: integer(row.revision, "account revision"),
    sourceSeq: integer(row.source_seq, "account source_seq"),
    newestFencingToken: integer(row.newest_fencing_token, "account fencing token"),
    account,
  };
}

async function ensureAccount(transaction: Transaction, accountId: string): Promise<void> {
  await transaction.execute({
    sql: `INSERT INTO wa_accounts (account_id, account_json) VALUES (?, ?)
      ON CONFLICT(account_id) DO NOTHING`,
    args: [accountId, json({ accountId })],
  });
}

function scoped<T extends { readonly accountId: string }>(
  record: T,
  accountId: string,
  label: string,
): T {
  if (record.accountId !== accountId) throw new Error(`invalid libSQL ${label} scope`);
  return record;
}

function oneRecord<T extends { readonly accountId: string }>(
  transaction: Transaction,
  accountId: string,
  sql: string,
  args: readonly (string | number)[],
  decode: (value: unknown) => T,
  matches: (record: T) => boolean,
  label: string,
): Promise<T | undefined> {
  return transaction.execute({ sql, args: [...args] }).then((result) => {
    const value = result.rows[0]?.data_json;
    if (value === undefined) return undefined;
    const record = scoped(decode(parsed(value, `${label} data_json`)), accountId, label);
    if (!matches(record)) throw new Error(`invalid libSQL ${label} identity`);
    return record;
  });
}

function projectionRecords(
  transaction: Transaction,
  accountId: string,
  account: AccountRecord,
): CurrentMirrorRecords {
  return {
    account: async () => account,
    chat: (chatId) =>
      oneRecord(
        transaction,
        accountId,
        "SELECT data_json FROM wa_chats WHERE account_id = ? AND chat_id = ?",
        [accountId, chatId],
        chatRecord,
        (record) => record.chatId === chatId,
        "chat",
      ),
    contact: (contactId) =>
      oneRecord(
        transaction,
        accountId,
        "SELECT data_json FROM wa_contacts WHERE account_id = ? AND contact_id = ?",
        [accountId, contactId],
        contactRecord,
        (record) => record.contactId === contactId,
        "contact",
      ),
    async contactId(nativeId) {
      const result = await transaction.execute({
        sql: "SELECT contact_id FROM wa_contact_aliases WHERE account_id = ? AND native_id = ?",
        args: [accountId, nativeId],
      });
      const value = result.rows[0]?.contact_id;
      return value === undefined ? undefined : string(value, "contact alias owner");
    },
    group: (groupId) =>
      oneRecord(
        transaction,
        accountId,
        "SELECT data_json FROM wa_groups WHERE account_id = ? AND group_id = ?",
        [accountId, groupId],
        groupRecord,
        (record) => record.groupId === groupId,
        "group",
      ),
    message: (chatId, messageId) =>
      oneRecord(
        transaction,
        accountId,
        `SELECT data_json FROM wa_messages
          WHERE account_id = ? AND chat_id = ? AND message_id = ?`,
        [accountId, chatId, messageId],
        messageRecord,
        (record) => record.chatId === chatId && record.messageId === messageId,
        "message",
      ),
    async pendingUpdates(chatId, messageId) {
      const result = await transaction.execute({
        sql: `SELECT data_json FROM wa_pending_message_updates
          WHERE account_id = ? AND chat_id = ? AND message_id = ?`,
        args: [accountId, chatId, messageId],
      });
      const value = result.rows[0]?.data_json;
      if (value === undefined) return [];
      const updates = parsed(value, "pending message updates data_json");
      if (!Array.isArray(updates)) throw new Error("invalid libSQL pending message updates");
      return updates.map((update, index) => durableUpdate(update, `pending updates[${index}]`));
    },
  };
}

async function applyMutation(
  transaction: Transaction,
  accountId: string,
  mutation: CurrentMirrorMutation,
): Promise<void> {
  if (mutation.type === "pending_updates") {
    if (mutation.updates.length === 0) {
      await transaction.execute({
        sql: `DELETE FROM wa_pending_message_updates
          WHERE account_id = ? AND chat_id = ? AND message_id = ?`,
        args: [accountId, mutation.chatId, mutation.messageId],
      });
    } else {
      await transaction.execute({
        sql: `INSERT INTO wa_pending_message_updates (account_id, chat_id, message_id, data_json)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(account_id, chat_id, message_id) DO UPDATE SET data_json = excluded.data_json`,
        args: [accountId, mutation.chatId, mutation.messageId, json(mutation.updates)],
      });
    }
    return;
  }
  if (mutation.type === "contact_alias") {
    await transaction.execute({
      sql: `INSERT INTO wa_contact_aliases (account_id, native_id, contact_id) VALUES (?, ?, ?)
        ON CONFLICT(account_id, native_id) DO UPDATE SET contact_id = excluded.contact_id`,
      args: [accountId, mutation.nativeId, mutation.contactId],
    });
    return;
  }
  if (mutation.type === "delete") {
    await transaction.execute({
      sql: "DELETE FROM wa_contacts WHERE account_id = ? AND contact_id = ?",
      args: [accountId, mutation.record.contactId],
    });
    return;
  }
  const record = mutation.record;
  switch (record.type) {
    case "account":
      await transaction.execute({
        sql: "UPDATE wa_accounts SET account_json = ? WHERE account_id = ?",
        args: [json(record.account), accountId],
      });
      return;
    case "chat":
      await transaction.execute({
        sql: `INSERT INTO wa_chats (account_id, chat_id, data_json) VALUES (?, ?, ?)
          ON CONFLICT(account_id, chat_id) DO UPDATE SET data_json = excluded.data_json`,
        args: [accountId, record.chat.chatId, json(record.chat)],
      });
      return;
    case "contact":
      await transaction.execute({
        sql: `INSERT INTO wa_contacts (account_id, contact_id, data_json) VALUES (?, ?, ?)
          ON CONFLICT(account_id, contact_id) DO UPDATE SET data_json = excluded.data_json`,
        args: [accountId, record.contact.contactId, json(record.contact)],
      });
      return;
    case "group":
      await transaction.execute({
        sql: `INSERT INTO wa_groups (account_id, group_id, data_json) VALUES (?, ?, ?)
          ON CONFLICT(account_id, group_id) DO UPDATE SET data_json = excluded.data_json`,
        args: [
          accountId,
          record.group.groupId,
          json({
            ...record.group,
            participantsKnown: record.group.participants !== undefined,
          }),
        ],
      });
      return;
    case "message":
      await transaction.execute({
        sql: `INSERT INTO wa_messages (account_id, chat_id, message_id, timestamp, data_json)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(account_id, chat_id, message_id) DO UPDATE SET
            timestamp = excluded.timestamp, data_json = excluded.data_json`,
        args: [
          accountId,
          record.message.chatId,
          record.message.messageId,
          record.message.timestamp,
          json(record.message),
        ],
      });
  }
}

function libsqlDataStore(client: LazyLibsqlClient): WhatsAppDataStore {
  /**
   * One account's mirror, answered through an already-open read transaction.
   * Neither read opens a second one — which is what would let a page disagree
   * with the snapshot taken beside it, and would deadlock against the shared
   * local-client queue.
   */
  const view = (transaction: Transaction, accountId: string): MirrorView => {
    return {
      async snapshot() {
        const state = await accountState(transaction, accountId);
        if (!state)
          return {
            accountId,
            revision: 0,
            account: { accountId },
            chats: [],
            contacts: [],
            contactAliases: {},
            groups: [],
          };
        const chatRows = await transaction.execute({
          sql: "SELECT chat_id, data_json FROM wa_chats WHERE account_id = ? ORDER BY chat_id",
          args: [accountId],
        });
        const contactRows = await transaction.execute({
          sql: `SELECT contact_id, data_json FROM wa_contacts
            WHERE account_id = ? ORDER BY contact_id`,
          args: [accountId],
        });
        const aliasRows = await transaction.execute({
          sql: `SELECT native_id, contact_id FROM wa_contact_aliases
            WHERE account_id = ? ORDER BY native_id`,
          args: [accountId],
        });
        const groupRows = await transaction.execute({
          sql: "SELECT group_id, data_json FROM wa_groups WHERE account_id = ? ORDER BY group_id",
          args: [accountId],
        });
        const chats = chatRows.rows.map((row) => {
          const record = scoped(
            chatRecord(parsed(row.data_json, "chat data_json")),
            accountId,
            "chat",
          );
          if (record.chatId !== string(row.chat_id, "chat chat_id"))
            throw new Error("invalid libSQL chat identity");
          return record;
        });
        const contacts = contactRows.rows.map((row) => {
          const record = scoped(
            contactRecord(parsed(row.data_json, "contact data_json")),
            accountId,
            "contact",
          );
          if (record.contactId !== string(row.contact_id, "contact contact_id"))
            throw new Error("invalid libSQL contact identity");
          return record;
        });
        const contactIds = new Set(contacts.map(({ contactId }) => contactId));
        const contactAliases = Object.fromEntries(
          aliasRows.rows.map((row) => {
            const nativeId = string(row.native_id, "contact alias native_id");
            const contactId = string(row.contact_id, "contact alias contact_id");
            if (!contactIds.has(contactId)) throw new Error("invalid libSQL contact alias owner");
            return [nativeId, contactId];
          }),
        );
        const groups = groupRows.rows.map((row) => {
          const record = scoped(
            groupRecord(parsed(row.data_json, "group data_json")),
            accountId,
            "group",
          );
          if (record.groupId !== string(row.group_id, "group group_id"))
            throw new Error("invalid libSQL group identity");
          return record;
        });
        return {
          accountId,
          revision: state.revision,
          account: state.account,
          chats,
          contacts,
          contactAliases,
          groups,
        };
      },

      async messages(chatId, options) {
        const limit = validatePage(options);
        const state = await accountState(transaction, accountId);
        const before = options?.before;
        const result = await transaction.execute({
          sql: `SELECT message_id, timestamp, data_json FROM wa_messages
            WHERE account_id = ? AND chat_id = ?
              ${before ? "AND (timestamp < ? OR (timestamp = ? AND message_id < ?))" : ""}
            ORDER BY timestamp DESC, message_id DESC LIMIT ?`,
          args: before
            ? [accountId, chatId, before.timestamp, before.timestamp, before.messageId, limit + 1]
            : [accountId, chatId, limit + 1],
        });
        const rows = result.rows.slice(0, limit);
        const messages = rows.map((row) => {
          const record = scoped(
            messageRecord(parsed(row.data_json, "message data_json")),
            accountId,
            "message",
          );
          if (
            record.chatId !== chatId ||
            record.messageId !== string(row.message_id, "message message_id") ||
            record.timestamp !== number(row.timestamp, "message timestamp")
          )
            throw new Error("invalid libSQL message identity");
          return record;
        });
        const last = result.rows.length > limit ? messages.at(-1) : undefined;
        return {
          accountId,
          chatId,
          revision: state?.revision ?? 0,
          messages,
          ...(last && { nextBefore: { timestamp: last.timestamp, messageId: last.messageId } }),
        };
      },
    };
  };

  const read: WhatsAppDataStore["read"] = (accountId, fn) =>
    transact(client, "read", (transaction) => fn(view(transaction, accountId)));

  return {
    async accept(accountId, events, fencingToken) {
      if (!Number.isSafeInteger(fencingToken) || fencingToken < 0)
        throw new RangeError(`fencingToken must be a non-negative integer, got ${fencingToken}`);
      const ownedEvents = structuredClone(events);
      return transact(client, "write", async (transaction) => {
        await ensureAccount(transaction, accountId);
        const state = await accountState(transaction, accountId);
        if (!state) throw new Error("libSQL account was not created");
        if (fencingToken < state.newestFencingToken)
          throw new StaleAccountClaimError(accountId, fencingToken, state.newestFencingToken);

        const projection = await projectCurrentMirror(
          projectionRecords(transaction, accountId, state.account),
          accountId,
          ownedEvents,
        );
        const revision =
          projection.upserts.length === 0 &&
          projection.deletes.length === 0 &&
          projection.aliases.length === 0
            ? state.revision
            : state.revision + 1;
        const batch: AcceptedWhatsAppBatch = {
          accountId,
          seq: state.sourceSeq + 1,
          fromRevision: state.revision,
          revision,
          events: ownedEvents,
          patch: {
            accountId,
            fromRevision: state.revision,
            revision,
            upserts: projection.upserts,
            ...(projection.deletes.length > 0 && { deletes: projection.deletes }),
            ...(projection.aliases.length > 0 && { aliases: projection.aliases }),
          },
        };

        for (const mutation of projection.mutations)
          await applyMutation(transaction, accountId, mutation);
        await transaction.execute({
          sql: `INSERT INTO wa_accepted_batches
            (account_id, seq, from_revision, revision, events_json, patch_json)
            VALUES (?, ?, ?, ?, ?, ?)`,
          args: [
            accountId,
            batch.seq,
            batch.fromRevision,
            batch.revision,
            json(batch.events),
            // `aliases` is written even when empty, so its *absence* means one
            // thing only: a row stored before the patch carried them. An
            // ordinary batch that changed a contact without changing Address
            // Resolution omits it from the patch it returns, and a decoder
            // reading absence as "legacy" would invent deltas for that row.
            json({ ...batch.patch, aliases: projection.aliases }),
          ],
        });
        await transaction.execute({
          sql: `UPDATE wa_accounts SET revision = ?, source_seq = ?, newest_fencing_token = ?
            WHERE account_id = ?`,
          args: [revision, batch.seq, Math.max(fencingToken, state.newestFencingToken), accountId],
        });
        return structuredClone(batch);
      });
    },

    async claim(accountId, fencingToken) {
      if (!Number.isSafeInteger(fencingToken) || fencingToken < 0)
        throw new RangeError(`fencingToken must be a non-negative integer, got ${fencingToken}`);
      await transact(client, "write", async (transaction) => {
        await ensureAccount(transaction, accountId);
        const state = await accountState(transaction, accountId);
        if (!state) throw new Error("libSQL account was not created");
        if (fencingToken < state.newestFencingToken)
          throw new StaleAccountClaimError(accountId, fencingToken, state.newestFencingToken);
        await transaction.execute({
          sql: "UPDATE wa_accounts SET newest_fencing_token = ? WHERE account_id = ?",
          args: [fencingToken, accountId],
        });
      });
    },

    read,
    snapshot: (accountId) => read(accountId, (mirror) => mirror.snapshot()),
    messages: (accountId, chatId, options) =>
      read(accountId, (mirror) => mirror.messages(chatId, options)),

    accepted(accountId, afterSeq, limit = 100) {
      if (!Number.isInteger(limit) || limit < 1)
        return Promise.reject(new RangeError(`limit must be a positive integer, got ${limit}`));
      return transact(client, "read", async (transaction) => {
        const result = await transaction.execute({
          sql: `SELECT account_id, seq, from_revision, revision, events_json, patch_json
            FROM wa_accepted_batches WHERE account_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
          args: [accountId, afterSeq, limit],
        });
        return result.rows.map(acceptedBatch);
      });
    },
  };
}

const databaseNow = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

function lease(row: Row): AccountLease {
  return {
    accountId: string(row.account_id, "lease account_id"),
    holderId: string(row.holder_id, "lease holder_id"),
    fencingToken: integer(row.fencing_counter, "lease fencing_counter"),
    expiresAt: integer(row.expires_at, "lease expires_at"),
  };
}

function libsqlLeaseStore(client: LazyLibsqlClient): AccountLeaseStore {
  return {
    acquire(accountId, holderId, ttlMs) {
      return transact(client, "write", async (transaction) => {
        const result = await transaction.execute({
          sql: `INSERT INTO wa_account_leases
              (account_id, holder_id, expires_at, fencing_counter)
            VALUES (?, ?, ${databaseNow} + ?, 1)
            ON CONFLICT(account_id) DO UPDATE SET
              holder_id = excluded.holder_id,
              expires_at = excluded.expires_at,
              fencing_counter = wa_account_leases.fencing_counter + 1
            WHERE wa_account_leases.holder_id IS NULL
               OR wa_account_leases.expires_at <= ${databaseNow}
            RETURNING account_id, holder_id, expires_at, fencing_counter`,
          args: [accountId, holderId, ttlMs],
        });
        const acquired = result.rows[0];
        if (acquired) return { acquired: true as const, lease: lease(acquired) };
        const current = await transaction.execute({
          sql: "SELECT expires_at FROM wa_account_leases WHERE account_id = ?",
          args: [accountId],
        });
        return {
          acquired: false as const,
          heldUntil: integer(current.rows[0]?.expires_at, "lease heldUntil"),
        };
      });
    },

    renew(held, ttlMs) {
      return transact(client, "write", async (transaction) => {
        const result = await transaction.execute({
          sql: `UPDATE wa_account_leases SET expires_at = ${databaseNow} + ?
            WHERE account_id = ? AND holder_id = ? AND fencing_counter = ?
              AND expires_at > ${databaseNow}
            RETURNING account_id, holder_id, expires_at, fencing_counter`,
          args: [ttlMs, held.accountId, held.holderId, held.fencingToken],
        });
        const renewed = result.rows[0];
        if (renewed) return { renewed: true as const, lease: lease(renewed) };
        const current = await transaction.execute({
          sql: `SELECT holder_id, expires_at, fencing_counter FROM wa_account_leases
            WHERE account_id = ?`,
          args: [held.accountId],
        });
        const row = current.rows[0];
        const same =
          row &&
          row.holder_id === held.holderId &&
          integer(row.fencing_counter, "lease fencing_counter") === held.fencingToken;
        return { renewed: false as const, reason: same ? ("expired" as const) : ("lost" as const) };
      });
    },

    release(held) {
      return transact(client, "write", async (transaction) => {
        const result = await transaction.execute({
          sql: `UPDATE wa_account_leases SET holder_id = NULL, expires_at = NULL
            WHERE account_id = ? AND holder_id = ? AND fencing_counter = ?`,
          args: [held.accountId, held.holderId, held.fencingToken],
        });
        return result.rowsAffected === 1;
      });
    },
  };
}

export function libsqlBackend(options: LibsqlBackendOptions): LibsqlBackend {
  const client = lazyLibsqlClient(options, migrate);
  const close = (): Promise<void> => client.close();
  return {
    credentials: libsqlCredentialStore(client, options.accountId),
    data: libsqlDataStore(client),
    leases: libsqlLeaseStore(client),
    media: options.media,
    operations: libsqlOperationStore(client),
    close,
    [Symbol.asyncDispose]: close,
  };
}
