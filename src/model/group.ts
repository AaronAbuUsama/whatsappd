export interface GroupParticipant {
  readonly id: string;
  readonly role?: string;
}

export interface GroupMetadata {
  readonly id: string;
  readonly subject?: string;
  readonly participants: readonly GroupParticipant[];
}

export type GroupParticipantAction = "add" | "remove" | "promote" | "demote" | "modify";

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
