/**
 * An optional, fire-and-forget observability seam. The session invokes the hook
 * at a handful of meaningful moments so a host can count, time, and alert
 * without parsing logs. Any error the hook throws is swallowed, so a faulty
 * metrics sink can never disrupt the connection.
 *
 * @packageDocumentation
 */
import type { InboundMessage } from "./message.ts";
import type { PresenceUpdate } from "./presence.ts";
import type { GroupUpdate } from "./group.ts";
import type { Status } from "./status.ts";
import type { Update } from "./update.ts";

export type MetricEvent =
  /** A connection state transition (`from` → `to` phase). */
  | { type: "transition"; from: Status["phase"]; to: Status["phase"] }
  /** A message crossed the inbound stream. */
  | { type: "message_in"; kind: InboundMessage["kind"]; live: boolean }
  /** An update crossed the updates stream. */
  | { type: "update_in"; kind: Update["kind"] }
  /** A WhatsApp address-book contact update crossed the contacts stream. */
  | { type: "contact_in"; hasDisplayName: boolean; identityCount: number }
  /** An ephemeral remote presence signal crossed the presence stream. */
  | { type: "presence_in"; kind: PresenceUpdate["kind"] }
  /** A WhatsApp group metadata or participant update crossed the groups stream. */
  | { type: "group_in"; kind: GroupUpdate["kind"] }
  /** A `send()` completed successfully. */
  | { type: "message_out" }
  /** A reconnect attempt is starting (`attempt` is the retry count). */
  | { type: "reconnect"; attempt: number };

/** The hook signature a consumer supplies as {@link SessionConfig.metrics}. */
export type MetricsHook = (event: MetricEvent) => void;
