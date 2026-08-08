export function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`invalid libSQL operation ${label}`);
  return value;
}

export function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error(`invalid libSQL operation ${label}`);
  return value;
}

export function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`invalid libSQL operation ${label}`);
  return value;
}

export function optionalInteger(value: unknown, label: string): number | undefined {
  return value === null || value === undefined ? undefined : integer(value, label);
}

export function parsed(value: unknown, label: string): unknown {
  try {
    return JSON.parse(text(value, label));
  } catch (error) {
    throw new Error(`invalid libSQL operation ${label}`, { cause: error });
  }
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`invalid libSQL operation ${label}`);
  return value as Record<string, unknown>;
}

export function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error(`invalid libSQL operation ${label}`);
}

export function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`invalid libSQL operation ${label}`);
  return value;
}
