import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const gitSha = /^[0-9a-f]{40}$/;
const nonCurrentDisposition =
  /^`(?:available-in-baileys|deferred|application-owned|intentionally-internal|unsupported-upstream|research-required)`/;
const proofRungs = ["P0", "P1", "P2", "P3", "P4", "P5", "P6"] as const;
const surfaces = new Set([
  "backend",
  "credential-store",
  "data-store",
  "lease-store",
  "mapper",
  "media-store",
  "production-session",
  "runtime",
  "runtime-client",
  "state-machine",
  "testing-export",
  "testing-session",
]);
const adapters = new Set([
  "baileys-mapper",
  "baileys-session",
  "file-credentials",
  "file-media",
  "libsql-credentials",
  "libsql-data",
  "libsql-file-media",
  "libsql-lease",
  "libsql-runtime",
  "memory-backend",
  "memory-credentials",
  "memory-data",
  "memory-lease",
  "memory-machine",
  "memory-media",
  "memory-runtime",
  "testing",
]);
const lifecycles = new Set([
  "concurrent",
  "deterministic",
  "expiry",
  "live",
  "migration",
  "real-database",
  "release",
  "replacement",
  "restart",
  "rollback",
  "same-process",
]);
const claimFields = new Set([
  "id",
  "capabilityId",
  "outcome",
  "surface",
  "variant",
  "adapter",
  "lifecycle",
  "implementation",
  "support",
  "requiredRung",
  "provenRung",
  "gap",
  "evidence",
]);

function rejectUnknownFields(
  errors: string[],
  label: string,
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label}: unexpected field ${key}`);
  }
}

function rungIndex(value: unknown): number {
  return proofRungs.indexOf(value as (typeof proofRungs)[number]);
}

interface ValidationContext {
  readonly catalogueMarkdown?: string;
}

function cell(value: unknown): string {
  const rendered =
    value === undefined || value === null
      ? "—"
      : typeof value === "string"
        ? value
        : (JSON.stringify(value) ?? "—");
  return rendered.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function statusFor(claim: Record<string, unknown>): string {
  if (claim.implementation === "implemented" && claim.support === "supported") {
    return "implemented-and-proven";
  }
  if (claim.implementation === "implemented" && claim.support === "unproven") {
    return "implemented-unproven";
  }
  return "intentionally-internal";
}

export function findUndocumentedPublicSymbols(
  rootSource: string,
  testingSource: string,
  catalogueMarkdown: string,
): readonly string[] {
  const symbols = new Set<string>();
  for (const match of rootSource.matchAll(/export(?:\s+type)?\s*\{([^}]*)\}\s*from/g)) {
    for (const item of match[1]!.split(",")) {
      const name = item
        .trim()
        .split(/\s+as\s+/)
        .at(-1);
      if (name) symbols.add(name);
    }
  }
  for (const match of testingSource.matchAll(
    /^export\s+(?:declare\s+)?(?:interface|type|function|class|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    symbols.add(match[1]!);
  }

  const inventory = catalogueMarkdown
    .split("## Current public structural surface")[1]
    ?.split("## Selected application interface")[0];
  if (inventory === undefined) return [...symbols].sort();
  return [...symbols].filter((symbol) => !inventory.includes(`\`${symbol}\``)).sort();
}

export function renderCapabilityEvidence(input: unknown): string {
  if (!isRecord(input) || !isRecord(input.audit) || !Array.isArray(input.claims)) {
    throw new TypeError("invalid capability evidence");
  }
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const value of input.claims) {
    if (!isRecord(value) || typeof value.capabilityId !== "string") continue;
    const group = groups.get(value.capabilityId) ?? [];
    group.push(value);
    groups.set(value.capabilityId, group);
  }

  const lines = [
    "# SDK current evidence ledger",
    "",
    "This generated view is the exact current-proof companion to",
    "[the SDK capability catalogue](sdk-capabilities.md). Edit",
    "`sdk-capability-evidence.json`, then run `pnpm generate:sdk-capabilities`.",
    "Broad capability records never carry proof rungs; they link here instead.",
    "",
    `Audit baseline: whatsappd \`${cell(input.audit.whatsappdHead)}\`; Baileys \`${cell(input.audit.baileysVersion)}\`.`,
    "",
    "`supported` means the exact claim reaches its required rung. `unproven` means",
    "the implementation exists but the named gap remains. `internal` evidence proves",
    "only the mapper, state machine, or testing Adapter named by that row.",
    "",
  ];

  for (const capabilityId of [...groups.keys()].sort()) {
    lines.push(`## ${capabilityId}`, "");
    lines.push(
      "| Claim | Exact outcome | Surface | Variant | Adapter | Lifecycle | Status | Implementation | Support | Required | Proven | Evidence | Gap |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const claim of (groups.get(capabilityId) ?? []).sort((a, b) =>
      String(a.id).localeCompare(String(b.id)),
    )) {
      const evidence = Array.isArray(claim.evidence)
        ? claim.evidence
            .filter(isRecord)
            .map((receipt) => {
              const path = cell(receipt.path);
              return `[\`${path}\`](../${path}) — ${cell(receipt.assertion)} — \`${cell(receipt.head)}\``;
            })
            .join("<br>")
        : "—";
      lines.push(
        `| \`${cell(claim.id)}\` | ${cell(claim.outcome)} | \`${cell(claim.surface)}\` | \`${cell(claim.variant)}\` | \`${cell(claim.adapter)}\` | \`${cell(claim.lifecycle)}\` | \`${statusFor(claim)}\` | \`${cell(claim.implementation)}\` | \`${cell(claim.support)}\` | \`${cell(claim.requiredRung)}\` | ${claim.provenRung === null ? "—" : `\`${cell(claim.provenRung)}\``} | ${evidence} | ${cell(claim.gap)} |`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function validateCapabilityEvidence(
  input: unknown,
  context: ValidationContext = {},
): readonly string[] {
  if (!isRecord(input) || !Array.isArray(input.claims)) {
    return ["catalogue: claims must be an array"];
  }

  const errors: string[] = [];
  rejectUnknownFields(errors, "catalogue", input, new Set(["version", "audit", "claims"]));
  if (input.version !== 1) errors.push("catalogue: version must be 1");
  if (isRecord(input.audit)) {
    rejectUnknownFields(
      errors,
      "catalogue.audit",
      input.audit,
      new Set(["whatsappdHead", "baileysVersion"]),
    );
  }
  if (
    !isRecord(input.audit) ||
    typeof input.audit.whatsappdHead !== "string" ||
    !gitSha.test(input.audit.whatsappdHead)
  ) {
    errors.push("catalogue: audit.whatsappdHead must be a full git SHA");
  }
  if (
    !isRecord(input.audit) ||
    typeof input.audit.baileysVersion !== "string" ||
    input.audit.baileysVersion.trim() === ""
  ) {
    errors.push("catalogue: audit.baileysVersion must be non-empty");
  }
  const claimCapabilities = new Set(
    input.claims
      .filter(isRecord)
      .map((claim) => claim.capabilityId)
      .filter((id): id is string => typeof id === "string"),
  );
  if (context.catalogueMarkdown) {
    const linkedCapabilities = new Set<string>();
    const backendMatrix = context.catalogueMarkdown
      .split("## Backend capability matrix")[1]
      ?.split("\n## ")[0];
    if (backendMatrix && /implemented-(?:and-proven|unproven)|\bP[0-6]\b/.test(backendMatrix)) {
      errors.push(
        "backend capability matrix: summary rows must not aggregate proof status or rungs",
      );
    }
    for (const line of context.catalogueMarkdown.split("\n")) {
      const capability = /^\| `([A-Z][A-Z0-9-]+)`\s*\|/.exec(line)?.[1];
      if (capability && /\bP[0-6]\b/.test(line)) {
        errors.push(
          `${capability}: broad capability rows may reference atomic claims but must not state proof rungs`,
        );
      }
      if (capability && line.includes(`sdk-capability-evidence.md#${capability.toLowerCase()}`)) {
        linkedCapabilities.add(capability);
        if (!claimCapabilities.has(capability)) {
          errors.push(`${capability}: current-claims link has no atomic evidence records`);
        }
      }
      if (capability) {
        const cells = line
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim());
        const current = cells.length === 6 ? cells[3] : undefined;
        if (
          current &&
          !current.includes(`sdk-capability-evidence.md#${capability.toLowerCase()}`) &&
          !nonCurrentDisposition.test(current)
        ) {
          errors.push(
            `${capability}: current column must link atomic claims or state a non-current disposition`,
          );
        }
      }
    }
    for (const capability of claimCapabilities) {
      if (!linkedCapabilities.has(capability)) {
        errors.push(
          `${capability}: atomic evidence records are not linked by their broad capability row`,
        );
      }
    }
  }
  const ids = new Set<string>();
  for (const value of input.claims) {
    if (!isRecord(value)) {
      errors.push("claim: every claim must be an object");
      continue;
    }
    const id = typeof value.id === "string" ? value.id : "claim";
    rejectUnknownFields(errors, id, value, claimFields);
    const capabilityId = typeof value.capabilityId === "string" ? value.capabilityId : "";
    const claimId = new RegExp(
      `^${capabilityId.replaceAll("-", "\\-")}\\.[a-z0-9]+(?:-[a-z0-9]+)*(?:\\.[a-z0-9]+(?:-[a-z0-9]+)*)+$`,
    );
    if (!capabilityId || !claimId.test(id)) {
      errors.push(
        `${id}: id must begin with capabilityId ${capabilityId || "<missing>"} and use dot-separated slugs`,
      );
    }
    if (ids.has(id)) errors.push(`${id}: duplicate claim id`);
    ids.add(id);
    if (typeof value.outcome !== "string" || value.outcome.trim() === "") {
      errors.push(`${id}: outcome must be non-empty`);
    }
    for (const dimension of ["surface", "variant", "adapter", "lifecycle"] as const) {
      if (typeof value[dimension] !== "string" || !slug.test(value[dimension])) {
        errors.push(`${id}: ${dimension} must be one lowercase slug, not a grouped value`);
      }
    }
    for (const [dimension, values] of [
      ["surface", surfaces],
      ["adapter", adapters],
      ["lifecycle", lifecycles],
    ] as const) {
      if (typeof value[dimension] === "string" && !values.has(value[dimension])) {
        errors.push(`${id}: unknown ${dimension} ${value[dimension]}`);
      }
    }
    if (value.implementation !== "implemented") {
      errors.push(`${id}: implementation must be implemented`);
    }
    if (!(["supported", "unproven", "internal"] as const).includes(value.support as never)) {
      errors.push(`${id}: support must be supported, unproven, or internal`);
    }
    if (rungIndex(value.requiredRung) < 0) {
      errors.push(`${id}: requiredRung must be P0-P6`);
    }
    if (value.provenRung !== null && rungIndex(value.provenRung) < 0) {
      errors.push(`${id}: provenRung must be null or P0-P6`);
    }
    const evidence = value.evidence;
    if (!Array.isArray(evidence)) {
      errors.push(`${id}: evidence must be an array`);
    }
    if (
      value.support === "supported" &&
      (rungIndex(value.provenRung) < rungIndex(value.requiredRung) ||
        rungIndex(value.provenRung) < 0)
    ) {
      errors.push(`${id}: supported claims must reach requiredRung ${String(value.requiredRung)}`);
    }
    if (
      value.support === "unproven" &&
      (typeof value.gap !== "string" || value.gap.trim() === "")
    ) {
      errors.push(`${id}: unproven claims require a concrete gap`);
    }
    if (
      typeof value.provenRung === "string" &&
      (!Array.isArray(evidence) || evidence.length === 0)
    ) {
      errors.push(`${id}: proven claims require at least one exact evidence receipt`);
    }
    if (Array.isArray(evidence)) {
      evidence.forEach((receipt, index) => {
        if (!isRecord(receipt)) {
          errors.push(`${id}: evidence[${index}] must be an object`);
          return;
        }
        rejectUnknownFields(
          errors,
          `${id}: evidence[${index}]`,
          receipt,
          new Set(["path", "assertion", "head"]),
        );
        if (typeof receipt.path !== "string" || receipt.path.trim() === "") {
          errors.push(`${id}: evidence[${index}].path must be non-empty`);
        }
        if (typeof receipt.assertion !== "string" || receipt.assertion.trim() === "") {
          errors.push(
            `${id}: evidence[${index}].assertion must name an exact test, receipt, symbol, or decision`,
          );
        }
        if (typeof receipt.head !== "string" || !gitSha.test(receipt.head)) {
          errors.push(`${id}: evidence[${index}].head must be a full git SHA`);
        } else if (isRecord(input.audit) && receipt.head !== input.audit.whatsappdHead) {
          errors.push(`${id}: evidence[${index}].head must equal audit.whatsappdHead`);
        }
      });
    }
  }
  return errors;
}

async function main(): Promise<void> {
  const evidenceUrl = new URL("../docs/sdk-capability-evidence.json", import.meta.url);
  const catalogueUrl = new URL("../docs/sdk-capabilities.md", import.meta.url);
  const renderedUrl = new URL("../docs/sdk-capability-evidence.md", import.meta.url);
  const [evidenceText, catalogueMarkdown, rootSource, testingSource] = await Promise.all([
    readFile(evidenceUrl, "utf8"),
    readFile(catalogueUrl, "utf8"),
    readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/testing.ts", import.meta.url), "utf8"),
  ]);
  const evidence: unknown = JSON.parse(evidenceText);
  const errors = [...validateCapabilityEvidence(evidence, { catalogueMarkdown })];
  const undocumented = findUndocumentedPublicSymbols(rootSource, testingSource, catalogueMarkdown);
  if (undocumented.length > 0) {
    errors.push(`public symbols missing from structural inventory: ${undocumented.join(", ")}`);
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));

  const rendered = renderCapabilityEvidence(evidence);
  if (process.argv.includes("--write")) {
    await writeFile(renderedUrl, rendered);
    return;
  }
  const checkedIn = await readFile(renderedUrl, "utf8");
  if (checkedIn !== rendered) {
    throw new Error("docs/sdk-capability-evidence.md is stale; run pnpm generate:sdk-capabilities");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
