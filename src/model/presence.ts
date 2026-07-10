/**
 * Ephemeral WhatsApp presence. These signals are stream-only: they should drive
 * live UI affordances and expire quickly, not become durable message history.
 */
export type PresenceKind = "typing" | "recording" | "available" | "idle" | "unavailable";

export interface PresenceUpdate {
  readonly chatId: string;
  readonly participant?: string;
  readonly kind: PresenceKind;
  readonly at?: number;
}
