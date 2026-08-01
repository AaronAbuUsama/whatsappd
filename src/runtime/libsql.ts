import type { Client, Row, Transaction } from "@libsql/client";
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
  type GroupRecord,
  type MediaStore,
  type MessageRecord,
  type MirrorDelete,
  type MirrorRecord,
  type StoredMessagePageOptions,
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
] as const;

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

async function transact<T>(
  client: LazyLibsqlClient,
  mode: "read" | "write",
  work: (transaction: Transaction) => Promise<T>,
): Promise<T> {
  return client.run(async (opened) => {
    const transaction = await opened.transaction(mode);
    try {
      const result = await work(transaction);
      await transaction.commit();
      return result;
    } catch (error) {
      if (!transaction.closed) await transaction.rollback().catch(() => {});
      throw error;
    } finally {
      transaction.close();
    }
  });
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
  return {
    accountId: string(record.accountId, "group.accountId"),
    groupId: string(record.groupId, "group.groupId"),
    ...(optionalString(record.subject, "group.subject") !== undefined && {
      subject: string(record.subject, "group.subject"),
    }),
    participants: participants(record.participants),
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

function messageRecord(value: unknown): MessageRecord {
  const record = object(value, "message record");
  if (record.kind !== "text") throw new Error("invalid libSQL message.kind");
  return {
    accountId: string(record.accountId, "message.accountId"),
    chatId: string(record.chatId, "message.chatId"),
    messageId: string(record.messageId, "message.messageId"),
    sender: address(record.sender, "message.sender"),
    fromMe: boolean(record.fromMe, "message.fromMe"),
    timestamp: number(record.timestamp, "message.timestamp"),
    kind: "text",
    text: string(record.text, "message.text"),
  };
}

function validateMessage(value: unknown, label: string): void {
  const message = object(value, label);
  string(message.id, `${label}.id`);
  string(message.chatId, `${label}.chatId`);
  address(message.sender, `${label}.sender`);
  boolean(message.fromMe, `${label}.fromMe`);
  number(message.timestamp, `${label}.timestamp`);
  boolean(message.live, `${label}.live`);
  boolean(message.isGroup, `${label}.isGroup`);
  optionalString(message.keyParticipant, `${label}.keyParticipant`);
  optionalString(message.pushName, `${label}.pushName`);
  if (message.context !== undefined) {
    const context = object(message.context, `${label}.context`);
    if (context.quoted !== undefined) {
      const quoted = object(context.quoted, `${label}.context.quoted`);
      string(quoted.id, `${label}.context.quoted.id`);
      string(quoted.from, `${label}.context.quoted.from`);
    }
    if (context.mentions !== undefined) strings(context.mentions, `${label}.context.mentions`);
  }
  if (message.flags !== undefined) {
    const flags = object(message.flags, `${label}.flags`);
    for (const field of ["viewOnce", "ephemeral", "edited"])
      if (flags[field] !== undefined) boolean(flags[field], `${label}.flags.${field}`);
  }
  const kind = string(message.kind, `${label}.kind`);
  if (kind === "text") string(message.text, `${label}.text`);
  else if (["image", "video", "audio", "document", "sticker"].includes(kind)) {
    const media = object(message.media, `${label}.media`);
    if ("download" in media) throw new Error(`invalid libSQL ${label}.media.download`);
    for (const field of ["mimetype", "fileName", "caption"])
      optionalString(media[field], `${label}.media.${field}`);
    for (const field of ["fileLength", "seconds", "width", "height"])
      optionalNumber(media[field], `${label}.media.${field}`);
    if (media.ptt !== undefined) boolean(media.ptt, `${label}.media.ptt`);
    optionalString(message.text, `${label}.text`);
  } else if (kind === "location") {
    number(message.lat, `${label}.lat`);
    number(message.lng, `${label}.lng`);
    optionalString(message.name, `${label}.name`);
    optionalString(message.address, `${label}.address`);
  } else if (kind === "contacts") {
    if (!Array.isArray(message.contacts)) throw new Error(`invalid libSQL ${label}.contacts`);
    for (const [index, value] of message.contacts.entries()) {
      const contact = object(value, `${label}.contacts[${index}]`);
      optionalString(contact.name, `${label}.contacts[${index}].name`);
      string(contact.vcard, `${label}.contacts[${index}].vcard`);
    }
  } else if (kind === "poll") {
    string(message.name, `${label}.name`);
    strings(message.options, `${label}.options`);
    number(message.selectableCount, `${label}.selectableCount`);
  } else if (kind === "unsupported") string(message.rawType, `${label}.rawType`);
  else throw new Error(`invalid libSQL ${label}.kind`);
}

function validateRef(value: unknown, label: string): void {
  const ref = object(value, label);
  string(ref.id, `${label}.id`);
  string(ref.chatId, `${label}.chatId`);
  boolean(ref.fromMe, `${label}.fromMe`);
  optionalString(ref.participant, `${label}.participant`);
}

function validateUpdate(value: unknown, label: string): void {
  const update = object(value, label);
  validateRef(update.ref, `${label}.ref`);
  optionalNumber(update.at, `${label}.at`);
  switch (update.kind) {
    case "receipt":
      if (
        !["pending", "server_ack", "delivered", "read", "played", "error"].includes(
          string(update.status, `${label}.status`),
        )
      )
        throw new Error(`invalid libSQL ${label}.status`);
      optionalString(update.by, `${label}.by`);
      return;
    case "reaction":
      optionalString(update.emoji, `${label}.emoji`);
      optionalString(update.by, `${label}.by`);
      boolean(update.removed, `${label}.removed`);
      return;
    case "edit":
      validateMessage(update.message, `${label}.message`);
      return;
    case "revoke":
      optionalString(update.by, `${label}.by`);
      return;
    default:
      throw new Error(`invalid libSQL ${label}.kind`);
  }
}

function validateContact(value: unknown, label: string): void {
  const contact = object(value, label);
  string(contact.id, `${label}.id`);
  strings(contact.nativeIds, `${label}.nativeIds`);
  for (const field of ["displayName", "profileName", "verifiedName", "username", "status"])
    optionalString(contact[field], `${label}.${field}`);
  if (contact.imgUrl !== undefined && contact.imgUrl !== null && typeof contact.imgUrl !== "string")
    throw new Error(`invalid libSQL ${label}.imgUrl`);
  optionalNumber(contact.at, `${label}.at`);
}

function validateGroup(value: unknown, label: string): void {
  const group = object(value, label);
  string(group.id, `${label}.id`);
  number(group.at, `${label}.at`);
  if (group.kind === "metadata") {
    optionalString(group.subject, `${label}.subject`);
    if (group.participants !== undefined) participants(group.participants);
  } else if (group.kind === "participants") {
    if (
      !["add", "remove", "promote", "demote", "modify"].includes(
        string(group.action, `${label}.action`),
      )
    )
      throw new Error(`invalid libSQL ${label}.action`);
    participants(group.participants);
  } else throw new Error(`invalid libSQL ${label}.kind`);
}

function validateConversationSync(value: unknown, label: string): void {
  const batch = object(value, label);
  const context = object(batch.context, `${label}.context`);
  if (
    !["initial_bootstrap", "recent", "on_demand", "full", "unknown"].includes(
      string(context.source, `${label}.context.source`),
    )
  )
    throw new Error(`invalid libSQL ${label}.context.source`);
  const projection = object(context.projection, `${label}.context.projection`);
  const mode = string(projection.mode, `${label}.context.projection.mode`);
  if (mode !== "upsert" && mode !== "authoritative_replacement")
    throw new Error(`invalid libSQL ${label}.context.projection.mode`);
  if (context.isLatest !== undefined) boolean(context.isLatest, `${label}.context.isLatest`);
  optionalNumber(context.chunkOrder, `${label}.context.chunkOrder`);
  optionalNumber(context.progress, `${label}.context.progress`);
  optionalString(context.requestSessionId, `${label}.context.requestSessionId`);
  if (mode === "authoritative_replacement") {
    const scope = projection.scope;
    if (scope !== "account")
      string(
        object(scope, `${label}.context.projection.scope`).chatId,
        `${label}.context.projection.scope.chatId`,
      );
  }
  if (
    !Array.isArray(batch.chats) ||
    !Array.isArray(batch.contacts) ||
    !Array.isArray(batch.messages)
  )
    throw new Error(`invalid libSQL ${label}`);
  for (const [index, value] of batch.chats.entries()) {
    const chat = object(value, `${label}.chats[${index}]`);
    string(chat.id, `${label}.chats[${index}].id`);
    boolean(chat.isGroup, `${label}.chats[${index}].isGroup`);
    optionalString(chat.subject, `${label}.chats[${index}].subject`);
    optionalNumber(chat.lastMessageAt, `${label}.chats[${index}].lastMessageAt`);
    if (chat.participants !== undefined) participants(chat.participants);
  }
  for (const [index, value] of batch.contacts.entries())
    validateContact(value, `${label}.contacts[${index}]`);
  for (const [index, value] of batch.messages.entries())
    validateMessage(value, `${label}.messages[${index}]`);
}

function dataEvents(value: unknown): readonly WhatsAppDataEvent[] {
  if (!Array.isArray(value)) throw new Error("invalid libSQL accepted events");
  return value.map((entry, index) => {
    const observation = object(entry, `accepted events[${index}]`);
    number(observation.observedAt, `accepted events[${index}].observedAt`);
    const event = object(observation.event, `accepted events[${index}].event`);
    switch (event.type) {
      case "message":
        validateMessage(event.message, `accepted events[${index}].event.message`);
        break;
      case "update":
        validateUpdate(event.update, `accepted events[${index}].event.update`);
        break;
      case "conversation_sync":
        validateConversationSync(event.batch, `accepted events[${index}].event.batch`);
        break;
      case "contact":
        validateContact(event.contact, `accepted events[${index}].event.contact`);
        break;
      case "group":
        validateGroup(event.group, `accepted events[${index}].event.group`);
        break;
      case "last_seen":
        string(event.contactId, `accepted events[${index}].event.contactId`);
        number(event.at, `accepted events[${index}].event.at`);
        break;
      case "account_connection":
        if (event.kind !== "connected" && event.kind !== "disconnected")
          throw new Error(`invalid libSQL accepted events[${index}].event.kind`);
        number(event.at, `accepted events[${index}].event.at`);
        break;
      default:
        throw new Error(`invalid libSQL accepted events[${index}].event.type`);
    }
    return entry as WhatsAppDataEvent;
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
  return { type: "contact", contactId: string(record.contactId, "patch delete contactId") };
}

function patch(value: unknown): WhatsAppPatch {
  const record = object(value, "patch");
  if (!Array.isArray(record.upserts)) throw new Error("invalid libSQL patch upserts");
  if (record.deletes !== undefined && !Array.isArray(record.deletes))
    throw new Error("invalid libSQL patch deletes");
  return {
    accountId: string(record.accountId, "patch accountId"),
    fromRevision: integer(record.fromRevision, "patch fromRevision"),
    revision: integer(record.revision, "patch revision"),
    upserts: record.upserts.map(mirrorRecord),
    ...(record.deletes !== undefined && { deletes: record.deletes.map(mirrorDelete) }),
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
  };
}

async function applyMutation(
  transaction: Transaction,
  accountId: string,
  mutation: CurrentMirrorMutation,
): Promise<void> {
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
        args: [accountId, record.group.groupId, json(record.group)],
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

function validatePage(options: StoredMessagePageOptions | undefined): number {
  const limit = options?.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError(`limit must be a positive integer, got ${limit}`);
  const before = options?.before;
  if (
    before &&
    (!Number.isFinite(before.timestamp) ||
      !Number.isSafeInteger(before.timestamp) ||
      !before.messageId)
  )
    throw new RangeError("before must contain an integer timestamp and messageId");
  return limit;
}

function libsqlDataStore(client: LazyLibsqlClient): WhatsAppDataStore {
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
          projection.upserts.length === 0 && projection.deletes.length === 0
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
            json(batch.patch),
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

    snapshot(accountId) {
      return transact(client, "read", async (transaction) => {
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
      });
    },

    async messages(accountId, chatId, options) {
      const limit = validatePage(options);
      return transact(client, "read", async (transaction) => {
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
      });
    },

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
    close,
    [Symbol.asyncDispose]: close,
  };
}
