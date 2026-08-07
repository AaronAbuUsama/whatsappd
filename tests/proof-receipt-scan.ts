export type ReceiptFieldType =
  | "hash"
  | "digest"
  | "count"
  | "length"
  | "boolean"
  | "enum"
  | "iso8601"
  | "git_sha"
  | "free_form";

export interface ReceiptFieldSchema {
  readonly type: ReceiptFieldType;
  readonly values?: readonly string[];
}

export const receiptField = (
  type: ReceiptFieldType,
  values?: readonly string[],
): ReceiptFieldSchema => ({ type, values });

export interface ReceiptScanReport {
  readonly schemaUnknownFields: number;
  readonly schemaInvalidFields: number;
  readonly patternHits: number;
  readonly knownValueHits: number;
  readonly freeFormFields: number;
  readonly digestFields: number;
  readonly receiptByteLength: number;
  readonly nonEmpty: boolean;
  readonly floorPassed: boolean;
}

interface PrimitiveLeaf {
  readonly path: string;
  readonly value: string | number | boolean | null;
}

function primitiveLeaves(value: unknown, pointer = ""): PrimitiveLeaf[] {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [{ path: pointer, value }];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [{ path: pointer, value: null }];
    return value.flatMap((entry, index) => primitiveLeaves(entry, `${pointer}/${index}`));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [{ path: pointer, value: null }];
    return entries.flatMap(([key, entry]) =>
      primitiveLeaves(entry, `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`),
    );
  }
  return [{ path: pointer, value: null }];
}

function schemaPath(pointer: string): string {
  return pointer.replace(/\/\d+(?=\/|$)/g, "/*");
}

function validIso8601(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return false;
  const canonical = parsed.toISOString();
  return value === canonical || value === canonical.replace(/\.000Z$/u, "Z");
}

function fieldIsValid(schema: ReceiptFieldSchema, value: PrimitiveLeaf["value"]): boolean {
  switch (schema.type) {
    case "hash":
      return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
    case "digest":
      return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
    case "count":
    case "length":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    case "boolean":
      return typeof value === "boolean";
    case "enum":
      return typeof value === "string" && schema.values?.includes(value) === true;
    case "iso8601":
      return typeof value === "string" && validIso8601(value);
    case "git_sha":
      return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
    case "free_form":
      return typeof value === "string";
  }
}

function freeFormPatternHits(value: string): number {
  let hits = 0;
  if (/\d{7,}/u.test(value.replace(/[\s\-().+]/gu, ""))) hits++;
  if (/@(s\.whatsapp\.net|g\.us|lid|broadcast|newsletter)/u.test(value)) hits++;
  if (/[A-Za-z0-9+/_-]{32,}={0,2}/u.test(value)) hits++;
  if (/(?:[A-Za-z0-9+/_-]+={0,2},){2,}[A-Za-z0-9+/_-]+={0,2}/u.test(value)) hits++;
  if (value.includes(".proof-private")) hits++;
  return hits;
}

export function scanSchemaDrivenReceipt(
  receipt: unknown,
  knownValues: readonly string[],
  schema: ReadonlyMap<string, ReceiptFieldSchema>,
): ReceiptScanReport {
  const serialized = JSON.stringify(receipt);
  const leaves = primitiveLeaves(receipt);
  let schemaUnknownFields = 0;
  let schemaInvalidFields = 0;
  let patternHits = 0;
  let freeFormFields = 0;
  let digestFields = 0;

  for (const leaf of leaves) {
    const fieldSchema = schema.get(schemaPath(leaf.path));
    if (!fieldSchema) {
      schemaUnknownFields++;
      continue;
    }
    if (!fieldIsValid(fieldSchema, leaf.value)) schemaInvalidFields++;
    if (fieldSchema.type === "free_form") {
      freeFormFields++;
      if (typeof leaf.value === "string") patternHits += freeFormPatternHits(leaf.value);
    }
    if (fieldSchema.type === "digest") digestFields++;
  }

  const knownValueHits = knownValues.filter(
    (value) => value.length > 0 && serialized.includes(value),
  ).length;
  const receiptByteLength = Buffer.byteLength(serialized);
  const nonEmpty = receiptByteLength > 2 && leaves.length > 0;
  const floorPassed = nonEmpty && freeFormFields > 0 && digestFields > 0;
  return {
    schemaUnknownFields,
    schemaInvalidFields,
    patternHits,
    knownValueHits,
    freeFormFields,
    digestFields,
    receiptByteLength,
    nonEmpty,
    floorPassed,
  };
}
