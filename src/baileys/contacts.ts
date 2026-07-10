import type { ContactUpdate } from "../model/contact.ts";

interface ContactLike {
  readonly id?: string | null;
  readonly lid?: string | null;
  readonly phoneNumber?: string | null;
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

export function mapContactUpdates(
  contacts: readonly ContactLike[],
  at = Date.now(),
): ContactUpdate[] {
  const out: ContactUpdate[] = [];
  for (const contact of contacts) {
    const nativeIds = unique([text(contact.id), text(contact.phoneNumber), text(contact.lid)]);
    const id = nativeIds[0];
    if (!id) continue;
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
