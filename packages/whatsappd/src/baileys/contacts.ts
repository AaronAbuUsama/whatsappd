import { isContactNativeId, type ContactUpdate } from "../model/contact.ts";

export interface ContactNativeIds {
  readonly id?: string | null;
  readonly lid?: string | null;
  readonly phoneNumber?: string | null;
}

interface ContactLike extends ContactNativeIds {
  readonly name?: string | null;
  readonly notify?: string | null;
  readonly verifiedName?: string | null;
  readonly username?: string | null;
  readonly imgUrl?: string | null;
  readonly status?: string | null;
}

function text(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function unique(values: readonly (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (!value || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

export function contactNativeIds(contact: ContactNativeIds): string[] {
  return unique([text(contact.id), text(contact.phoneNumber), text(contact.lid)]);
}

export function mapContactUpdates(
  contacts: readonly ContactLike[],
  at = Date.now(),
): ContactUpdate[] {
  const out: ContactUpdate[] = [];
  for (const contact of contacts) {
    const nativeIds = contactNativeIds(contact);
    const id = nativeIds[0];
    if (!id || !nativeIds.every(isContactNativeId)) continue;
    out.push({
      id,
      nativeIds,
      ...(text(contact.name) ? { displayName: text(contact.name) } : {}),
      ...(text(contact.notify) ? { profileName: text(contact.notify) } : {}),
      ...(text(contact.verifiedName) ? { verifiedName: text(contact.verifiedName) } : {}),
      ...(text(contact.username) ? { username: text(contact.username) } : {}),
      ...(contact.imgUrl !== undefined ? { imgUrl: contact.imgUrl } : {}),
      ...(text(contact.status) ? { status: text(contact.status) } : {}),
      at,
    });
  }
  return out;
}
