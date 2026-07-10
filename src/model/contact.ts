/**
 * A contact / address-book update, normalized from a WhatsApp contact event.
 * Consume these to keep a local read model of contacts in sync.
 */
export interface ContactUpdate {
  /** The primary WhatsApp contact id from the event. */
  readonly id: string;
  /** Candidate identities for matching existing records, ordered by confidence. */
  readonly nativeIds: readonly string[];
  /** The saved address-book name, when present. */
  readonly displayName?: string;
  /** The profile/push name set by the remote user, when present. */
  readonly profileName?: string;
  /** A business-verified name, when present. */
  readonly verifiedName?: string;
  /** The contact's WhatsApp username, when present. */
  readonly username?: string;
  /**
   * The profile-photo URL: a URL string, `null` when the contact has none, or
   * omitted when the event carried no photo information.
   */
  readonly imgUrl?: string | null;
  /** The contact's status/about text, when present. */
  readonly status?: string;
  /** When the update occurred, as a millisecond epoch timestamp. */
  readonly at?: number;
}
