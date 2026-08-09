import type { GroupParticipant, GroupParticipantAction, GroupUpdate } from "../model/group.ts";

interface GroupParticipantLike {
  readonly id?: string | null;
  readonly admin?: string | null;
  readonly isAdmin?: boolean | null;
  readonly isSuperAdmin?: boolean | null;
}

interface GroupMetadataLike {
  readonly id?: string | null;
  readonly subject?: string | null;
  readonly participants?: readonly GroupParticipantLike[] | null;
}

interface GroupParticipantsUpdateLike {
  readonly id?: string | null;
  readonly action?: string | null;
  readonly participants?: readonly GroupParticipantLike[] | null;
}

const participantActions = new Set<GroupParticipantAction>([
  "add",
  "remove",
  "promote",
  "demote",
  "modify",
]);

function text(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function roleOf(participant: GroupParticipantLike): string | undefined {
  const admin = text(participant.admin);
  if (admin) return admin;
  if (participant.isSuperAdmin) return "superadmin";
  if (participant.isAdmin) return "admin";
  return undefined;
}

function mapParticipant(participant: GroupParticipantLike): GroupParticipant | undefined {
  const id = text(participant.id);
  if (!id) return undefined;
  const role = roleOf(participant);
  return { id, ...(role ? { role } : {}) };
}

function mapParticipants(
  participants: readonly GroupParticipantLike[] | null | undefined,
): GroupParticipant[] | undefined {
  if (!participants) return undefined;
  const out: GroupParticipant[] = [];
  for (const participant of participants) {
    const mapped = mapParticipant(participant);
    if (mapped) out.push(mapped);
  }
  return out;
}

function isParticipantAction(value: string): value is GroupParticipantAction {
  return participantActions.has(value as GroupParticipantAction);
}

export function mapGroupMetadataUpdates(
  groups: readonly GroupMetadataLike[],
  at = Date.now(),
): GroupUpdate[] {
  const out: GroupUpdate[] = [];
  for (const group of groups) {
    const id = text(group.id);
    if (!id) continue;
    const participants = mapParticipants(group.participants);
    out.push({
      kind: "metadata",
      id,
      ...(text(group.subject) ? { subject: text(group.subject) } : {}),
      ...(participants ? { participants } : {}),
      at,
    });
  }
  return out;
}

export function mapGroupParticipantsUpdate(
  update: GroupParticipantsUpdateLike,
  at = Date.now(),
): GroupUpdate | undefined {
  const id = text(update.id);
  const action = text(update.action);
  if (!id || !action || !isParticipantAction(action)) return undefined;
  const participants = mapParticipants(update.participants) ?? [];
  if (participants.length === 0) return undefined;
  return {
    kind: "participants",
    id,
    action,
    participants,
    at,
  };
}
