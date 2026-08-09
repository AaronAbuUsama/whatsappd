export interface GroupParticipant {
  readonly id: string;
  readonly phoneJid?: string;
  readonly lid?: string;
  readonly role?: string;
}

export interface GroupMetadata {
  readonly id: string;
  readonly subject?: string;
  readonly description?: string;
  readonly announcement?: boolean;
  readonly locked?: boolean;
  readonly participants: readonly GroupParticipant[];
}

export type GroupParticipantAction = "add" | "remove" | "promote" | "demote" | "modify";

export type GroupSetting = "announcement" | "not_announcement" | "locked" | "unlocked";

export interface GroupParticipantUpdateResult {
  readonly id?: string;
  readonly status: string;
}

export type GroupUpdate =
  | {
      readonly kind: "metadata";
      readonly id: string;
      readonly subject?: string;
      readonly participants?: readonly GroupParticipant[];
      readonly at: number;
    }
  | {
      readonly kind: "participants";
      readonly id: string;
      readonly action: GroupParticipantAction;
      readonly participants: readonly GroupParticipant[];
      readonly at: number;
    };
