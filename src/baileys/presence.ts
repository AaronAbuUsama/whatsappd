import type { PresenceKind, PresenceUpdate } from "../model/presence.ts";

interface PresenceDataLike {
  readonly lastKnownPresence?: string | null;
}

interface PresenceUpdateLike {
  readonly id?: string | null;
  readonly presences?: Record<string, PresenceDataLike | undefined> | null;
}

function kindOf(value: string | null | undefined): PresenceKind | undefined {
  switch (value) {
    case "composing":
      return "typing";
    case "recording":
      return "recording";
    case "available":
      return "available";
    case "paused":
      return "idle";
    case "unavailable":
      return "unavailable";
    default:
      return undefined;
  }
}

export function mapPresenceUpdate(update: PresenceUpdateLike, at = Date.now()): PresenceUpdate[] {
  const chatId = update.id ?? undefined;
  if (!chatId || !update.presences) return [];

  const out: PresenceUpdate[] = [];
  for (const [participant, presence] of Object.entries(update.presences)) {
    const kind = kindOf(presence?.lastKnownPresence);
    if (!kind) continue;
    out.push({
      chatId,
      participant,
      kind,
      at,
    });
  }
  return out;
}
