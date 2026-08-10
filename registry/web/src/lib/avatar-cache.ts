const loads = new Map<string, Promise<string | undefined>>();

export function avatarSource(
  source: string,
  load: (url: string) => Promise<Response> = (url) => fetch(url, { cache: "no-store" }),
): Promise<string | undefined> {
  const existing = loads.get(source);
  if (existing) return existing;
  const pending = load(source)
    .then(async (response) => {
      if (!response.ok) return undefined;
      return URL.createObjectURL(await response.blob());
    })
    .catch(() => undefined);
  loads.set(source, pending);
  return pending;
}

export function clearAvatarCache(): void {
  for (const pending of loads.values())
    void pending.then((source) => {
      if (source) URL.revokeObjectURL(source);
    });
  loads.clear();
}
