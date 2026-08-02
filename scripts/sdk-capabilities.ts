import { readFile, writeFile } from "node:fs/promises";

const upstreamStatuses = new Set([
  "available",
  "not-applicable",
  "partial",
  "research-required",
  "unsupported",
]);
const currentStatuses = new Set([
  "application-owned",
  "implemented",
  "internal",
  "not-implemented",
  "partial",
  "unsupported",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

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

function publicSymbolNames(rootSource: string, testingSource: string): ReadonlySet<string> {
  // ponytail: the current entry points use re-export blocks plus direct testing
  // declarations; use a TypeScript parser only if those source shapes change.
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
  return symbols;
}

export function findPublicSymbols(rootSource: string, testingSource: string): readonly string[] {
  return [...publicSymbolNames(rootSource, testingSource)].sort();
}

export interface CatalogueValidationContext {
  readonly whatsappdVersion?: string;
  readonly baileysVersion?: string;
  readonly publicSymbols?: readonly string[];
}

export function validateCapabilityCatalogue(
  input: unknown,
  context: CatalogueValidationContext = {},
): string[] {
  if (!isRecord(input)) return ["catalogue: must be an object"];
  const errors: string[] = [];
  rejectUnknownFields(
    errors,
    "catalogue",
    input,
    new Set([
      "version",
      "audit",
      "verification",
      "interfaceDecision",
      "publicExports",
      "capabilities",
      "backends",
      "reactBindings",
    ]),
  );
  if (input.version !== 3) errors.push("catalogue: version must be 3");

  if (!isRecord(input.audit)) {
    errors.push("catalogue: audit must be an object");
  } else {
    rejectUnknownFields(
      errors,
      "audit",
      input.audit,
      new Set(["whatsappdVersion", "baileysVersion"]),
    );
    for (const field of ["whatsappdVersion", "baileysVersion"] as const) {
      if (!nonEmpty(input.audit[field])) errors.push(`audit.${field} must be non-empty`);
    }
    if (context.whatsappdVersion && input.audit.whatsappdVersion !== context.whatsappdVersion) {
      errors.push(
        `catalogue: audit.whatsappdVersion ${String(input.audit.whatsappdVersion)} does not match package version ${context.whatsappdVersion}`,
      );
    }
    if (context.baileysVersion && input.audit.baileysVersion !== context.baileysVersion) {
      errors.push(
        `catalogue: audit.baileysVersion ${String(input.audit.baileysVersion)} does not match package dependency ${context.baileysVersion}`,
      );
    }
  }

  if (!isRecord(input.verification)) {
    errors.push("catalogue: verification must be an object");
  } else {
    rejectUnknownFields(
      errors,
      "verification",
      input.verification,
      new Set(["automatedTests", "liveWhatsApp", "browserReact", "openTui"]),
    );
    for (const field of ["automatedTests", "liveWhatsApp", "browserReact", "openTui"] as const) {
      if (!nonEmpty(input.verification[field])) {
        errors.push(`verification.${field} must be non-empty`);
      }
    }
  }

  if (!isRecord(input.interfaceDecision)) {
    errors.push("catalogue: interfaceDecision must be an object");
  } else {
    rejectUnknownFields(
      errors,
      "interfaceDecision",
      input.interfaceDecision,
      new Set([
        "adr",
        "selected",
        "namespaces",
        "openedConversation",
        "operationSemantics",
        "resourceOwnership",
        "example",
      ]),
    );
    if (!nonEmpty(input.interfaceDecision.selected)) {
      errors.push("interfaceDecision.selected must be non-empty");
    }
    if (!Array.isArray(input.interfaceDecision.namespaces)) {
      errors.push("interfaceDecision.namespaces must be an array");
    } else {
      input.interfaceDecision.namespaces.forEach((namespace, index) => {
        if (!isRecord(namespace) || !nonEmpty(namespace.name) || !nonEmpty(namespace.scope)) {
          errors.push(`interfaceDecision.namespaces[${index}] must name a scope`);
        }
      });
    }
    if (
      !Array.isArray(input.interfaceDecision.example) ||
      !input.interfaceDecision.example.every(nonEmpty)
    ) {
      errors.push("interfaceDecision.example must be a string array");
    }
    for (const field of [
      "openedConversation",
      "operationSemantics",
      "resourceOwnership",
    ] as const) {
      const value = input.interfaceDecision[field];
      if (value !== undefined && (!Array.isArray(value) || !value.every(nonEmpty))) {
        errors.push(`interfaceDecision.${field} must be a string array`);
      }
    }
  }

  const exports = Array.isArray(input.publicExports)
    ? input.publicExports.filter((value): value is string => nonEmpty(value))
    : [];
  if (!Array.isArray(input.publicExports) || exports.length !== input.publicExports.length) {
    errors.push("catalogue: publicExports must be a string array");
  }
  if (new Set(exports).size !== exports.length) {
    errors.push("catalogue: publicExports must not contain duplicates");
  }
  if (context.publicSymbols) {
    const actual = new Set(context.publicSymbols);
    const catalogued = new Set(exports);
    for (const symbol of actual) {
      if (!catalogued.has(symbol)) errors.push(`catalogue: missing public export ${symbol}`);
    }
    for (const symbol of catalogued) {
      if (!actual.has(symbol)) errors.push(`catalogue: lists nonexistent public export ${symbol}`);
    }
  }

  const capabilityIds = new Set<string>();
  if (!Array.isArray(input.capabilities)) {
    errors.push("catalogue: capabilities must be an array");
  } else {
    for (const value of input.capabilities) {
      if (!isRecord(value)) {
        errors.push("capability: every capability must be an object");
        continue;
      }
      const id = nonEmpty(value.id) ? value.id : "capability";
      rejectUnknownFields(
        errors,
        id,
        value,
        new Set(["id", "domain", "outcome", "upstream", "current", "target", "requirements"]),
      );
      if (!nonEmpty(value.id)) errors.push("capability: id must be non-empty");
      if (capabilityIds.has(id)) errors.push(`${id}: duplicate capability id`);
      capabilityIds.add(id);
      for (const field of ["domain", "outcome", "target", "requirements"] as const) {
        if (!nonEmpty(value[field])) errors.push(`${id}: ${field} must be non-empty`);
      }
      for (const field of ["upstream", "current"] as const) {
        const fact = value[field];
        if (!isRecord(fact)) {
          errors.push(`${id}: ${field} must be an object`);
          continue;
        }
        rejectUnknownFields(errors, `${id}.${field}`, fact, new Set(["status", "summary"]));
        if (!nonEmpty(fact.summary)) errors.push(`${id}: ${field}.summary must be non-empty`);
        if (!nonEmpty(fact.status)) {
          errors.push(`${id}: ${field}.status must be non-empty`);
        } else {
          const known = field === "upstream" ? upstreamStatuses : currentStatuses;
          if (!known.has(fact.status)) errors.push(`${id}: unknown ${field}.status ${fact.status}`);
        }
      }
    }
  }

  for (const [field, required] of [
    [
      "backends",
      [
        "adapter",
        "credentials",
        "data",
        "leases",
        "commands",
        "media",
        "trustedWorker",
        "browser",
        "status",
      ],
    ],
    ["reactBindings", ["behavior", "shared", "rendererOwned"]],
  ] as const) {
    if (!Array.isArray(input[field])) {
      errors.push(`catalogue: ${field} must be an array`);
    } else {
      input[field].forEach((row, index) => {
        if (!isRecord(row)) {
          errors.push(`${field}[${index}] must contain only non-empty strings`);
          return;
        }
        rejectUnknownFields(errors, `${field}[${index}]`, row, new Set(required));
        if (required.some((name) => !nonEmpty(row[name]))) {
          errors.push(`${field}[${index}] must contain every required non-empty string`);
        }
      });
    }
  }
  return errors;
}

function cell(value: unknown): string {
  return (typeof value === "string" ? value : "—").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function words(value: unknown): string {
  return cell(value).replaceAll("-", " ");
}

export function renderCapabilityCatalogue(input: unknown): string {
  const errors = validateCapabilityCatalogue(input);
  if (errors.length > 0 || !isRecord(input)) throw new TypeError("invalid capability catalogue");
  const audit = input.audit as Record<string, string>;
  const verification = input.verification as Record<string, string>;
  const decision = input.interfaceDecision as Record<string, unknown>;
  const capabilities = input.capabilities as Record<string, unknown>[];
  const lines = [
    "# SDK capability catalogue",
    "",
    "This generated inventory answers what Baileys exposes, what whatsappd exposes today, and what friendly interface is planned. It is a roadmap and documentation source, not a claim that every row has been exercised against a live account.",
    "",
    `Audit versions: whatsappd \`${cell(audit.whatsappdVersion)}\`; Baileys \`${cell(audit.baileysVersion)}\`.`,
    "",
    "## Verification status",
    "",
    `- Automated repository checks: **${words(verification.automatedTests)}**`,
    `- Live WhatsApp account: **${words(verification.liveWhatsApp)}**`,
    `- Browser React: **${words(verification.browserReact)}**`,
    `- OpenTUI: **${words(verification.openTui)}**`,
    "",
    "Automated tests do not establish real-account or rendered behavior.",
    "",
    "## Target Client shape",
    "",
    `Selected interface: \`${cell(decision.selected)}\`${nonEmpty(decision.adr) ? ` (${decision.adr})` : ""}.`,
    "",
    "```ts",
    ...((decision.example as string[]) ?? []),
    "```",
    "",
    "### Namespaces",
    "",
    "| Namespace | Scope |",
    "| --- | --- |",
  ];
  for (const namespace of decision.namespaces as Record<string, string>[]) {
    lines.push(`| \`${cell(namespace.name)}\` | ${cell(namespace.scope)} |`);
  }
  const opened = decision.openedConversation as string[] | undefined;
  if (opened?.length) {
    lines.push("", `Opened conversation: ${opened.map((name) => `\`${cell(name)}\``).join(", ")}.`);
  }
  for (const [title, field] of [
    ["Operation semantics", "operationSemantics"],
    ["Resource ownership", "resourceOwnership"],
  ] as const) {
    const items = decision[field] as string[] | undefined;
    if (!items?.length) continue;
    lines.push("", `### ${title}`, "", ...items.map((item) => `- ${item}`));
  }

  lines.push(
    "",
    "## Capability inventory",
    "",
    "| ID | Area | Caller outcome | Baileys | whatsappd now | Current note | Planned friendly interface | Planning note |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const capability of capabilities) {
    const upstream = capability.upstream as Record<string, string>;
    const current = capability.current as Record<string, string>;
    lines.push(
      `| \`${cell(capability.id)}\` | ${cell(capability.domain)} | ${cell(capability.outcome)} | ${cell(upstream.status)}: ${cell(upstream.summary)} | ${cell(current.status)} | ${cell(current.summary)} | ${cell(capability.target)} | ${cell(capability.requirements)} |`,
    );
  }

  lines.push("", "## Backend inventory", "");
  const backends = input.backends as Record<string, string>[];
  if (backends.length === 0) {
    lines.push("No backend entries.");
  } else {
    const columns = Object.keys(backends[0]!);
    lines.push(
      `| ${columns.map(cell).join(" | ")} |`,
      `| ${columns.map(() => "---").join(" | ")} |`,
      ...backends.map((row) => `| ${columns.map((column) => cell(row[column])).join(" | ")} |`),
    );
  }

  lines.push("", "## Shared React behavior", "");
  const bindings = input.reactBindings as Record<string, string>[];
  if (bindings.length === 0) {
    lines.push("No React binding entries.");
  } else {
    lines.push(
      "| Behavior | Shared binding | Renderer-owned work |",
      "| --- | --- | --- |",
      ...bindings.map(
        (row) => `| ${cell(row.behavior)} | ${cell(row.shared)} | ${cell(row.rendererOwned)} |`,
      ),
    );
  }

  lines.push(
    "",
    "## Current public exports",
    "",
    ...(input.publicExports as string[]).map((name) => `- \`${name}\``),
  );
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const catalogueUrl = new URL("../docs/sdk-capabilities.json", import.meta.url);
  const renderedUrl = new URL("../docs/sdk-capabilities.md", import.meta.url);
  const [catalogueText, rootSource, testingSource, packageText] = await Promise.all([
    readFile(catalogueUrl, "utf8"),
    readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/testing.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  const catalogue: unknown = JSON.parse(catalogueText);
  const packageJson = JSON.parse(packageText) as {
    version: string;
    dependencies: { baileys: string };
  };
  const errors = validateCapabilityCatalogue(catalogue, {
    whatsappdVersion: packageJson.version,
    baileysVersion: packageJson.dependencies.baileys,
    publicSymbols: findPublicSymbols(rootSource, testingSource),
  });
  if (errors.length > 0) throw new Error(errors.join("\n"));

  const rendered = renderCapabilityCatalogue(catalogue);
  if (process.argv.includes("--write")) {
    await writeFile(renderedUrl, rendered);
    return;
  }
  if ((await readFile(renderedUrl, "utf8")) !== rendered) {
    throw new Error("docs/sdk-capabilities.md is stale; run pnpm generate:sdk-capabilities");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
