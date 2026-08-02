import { execFile } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const gitSha = /^[0-9a-f]{40}$/;
const runFile = promisify(execFile);
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
const observationKinds = new Set([
  "browser",
  "deterministic",
  "durability",
  "live-whatsapp",
  "native-backend",
  "opentui",
  "packed-consumer",
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

interface PublicVariantDeclaration {
  readonly symbol: string;
  readonly selector: string;
  readonly members: readonly string[];
}

interface CatalogueValidationContext {
  readonly whatsappdVersion?: string;
  readonly baileysVersion?: string;
  readonly publicVariants?: readonly PublicVariantDeclaration[];
  readonly publicSymbols?: readonly string[];
}

function isRepositoryPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value === value.trim() &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !/^[A-Za-z]:[\\/]/.test(value) &&
    !value.includes("\\") &&
    !value.split("/").includes("..")
  );
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

function publicSymbolNames(rootSource: string, testingSource: string): ReadonlySet<string> {
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

function unwrappedType(node: ts.TypeNode): ts.TypeNode {
  return ts.isParenthesizedTypeNode(node) ? unwrappedType(node.type) : node;
}

function literalStrings(node: ts.TypeNode): readonly string[] | null {
  const unwrapped = unwrappedType(node);
  if (
    ts.isLiteralTypeNode(unwrapped) &&
    (ts.isStringLiteral(unwrapped.literal) || ts.isNoSubstitutionTemplateLiteral(unwrapped.literal))
  ) {
    return [unwrapped.literal.text];
  }
  if (ts.isUnionTypeNode(unwrapped)) {
    const members = unwrapped.types.map(literalStrings);
    return members.every((member): member is readonly string[] => member !== null)
      ? members.flat()
      : null;
  }
  return null;
}

function propertyName(member: ts.TypeElement): string | null {
  if (!ts.isPropertySignature(member) || !member.name) return null;
  return ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : null;
}

type NamedTypeDeclaration = ts.TypeAliasDeclaration | ts.InterfaceDeclaration;

interface BranchProperties {
  readonly literals: ReadonlyMap<string, readonly string[]>;
  readonly required: readonly string[];
}

function branchProperties(
  node: ts.TypeNode,
  declarations: ReadonlyMap<string, NamedTypeDeclaration>,
): BranchProperties | null {
  const unwrapped = unwrappedType(node);
  if (ts.isTypeReferenceNode(unwrapped) && ts.isIdentifier(unwrapped.typeName)) {
    const declaration = declarations.get(unwrapped.typeName.text);
    if (!declaration) return null;
    if (ts.isInterfaceDeclaration(declaration)) {
      const literals = new Map<string, readonly string[]>();
      const required: string[] = [];
      for (const member of declaration.members) {
        const name = propertyName(member);
        if (!name || !ts.isPropertySignature(member)) continue;
        if (!member.questionToken) required.push(name);
        if (member.type) {
          const values = literalStrings(member.type);
          if (values) literals.set(name, values);
        }
      }
      return { literals, required };
    }
    return branchProperties(declaration.type, declarations);
  }
  if (ts.isIntersectionTypeNode(unwrapped)) {
    const parts = unwrapped.types.map((part) => branchProperties(part, declarations));
    if (parts.some((part) => part === null)) return null;
    const literals = new Map<string, readonly string[]>();
    const required: string[] = [];
    for (const part of parts as BranchProperties[]) {
      for (const [name, values] of part.literals) literals.set(name, values);
      required.push(...part.required);
    }
    return { literals, required };
  }
  if (!ts.isTypeLiteralNode(unwrapped)) return null;
  const literals = new Map<string, readonly string[]>();
  const required: string[] = [];
  for (const member of unwrapped.members) {
    const name = propertyName(member);
    if (!name || !ts.isPropertySignature(member)) continue;
    if (!member.questionToken) required.push(name);
    if (member.type) {
      const values = literalStrings(member.type);
      if (values) literals.set(name, values);
    }
  }
  return { literals, required };
}

function descriptorForType(
  node: ts.TypeNode,
  declarations: ReadonlyMap<string, NamedTypeDeclaration>,
  resolving: ReadonlySet<string> = new Set(),
): Omit<PublicVariantDeclaration, "symbol"> | null {
  const unwrapped = unwrappedType(node);
  if (ts.isTypeReferenceNode(unwrapped) && ts.isIdentifier(unwrapped.typeName)) {
    const name = unwrapped.typeName.text;
    const declaration = declarations.get(name);
    if (!declaration || !ts.isTypeAliasDeclaration(declaration) || resolving.has(name)) return null;
    return descriptorForType(declaration.type, declarations, new Set([...resolving, name]));
  }
  if (ts.isIntersectionTypeNode(unwrapped)) {
    for (const member of unwrapped.types) {
      const descriptor = descriptorForType(member, declarations, resolving);
      if (descriptor) return descriptor;
    }
    return null;
  }
  if (!ts.isUnionTypeNode(unwrapped)) return null;

  const values = unwrapped.types.map(literalStrings);
  if (values.every((value): value is readonly string[] => value !== null)) {
    return { selector: "value", members: [...new Set(values.flat())].sort() };
  }

  const branches = unwrapped.types.map((branch) => branchProperties(branch, declarations));
  if (branches.every((branch): branch is BranchProperties => branch !== null)) {
    const preferred = ["kind", "type", "phase", "status", "state", "method", "step"];
    const common = preferred.find((name) => branches.every((branch) => branch.literals.has(name)));
    if (common) {
      return {
        selector: common,
        members: [
          ...new Set(branches.flatMap((branch) => branch.literals.get(common) ?? [])),
        ].sort(),
      };
    }

    const keys = branches.map((branch) => branch.required[0] ?? null);
    if (keys.every((key): key is string => key !== null)) {
      return { selector: "property", members: [...new Set(keys)].sort() };
    }
  }

  return { selector: "unresolved", members: [] };
}

export function findClosedPublicVariants(
  rootSource: string,
  testingSource: string,
  sources: readonly { readonly path: string; readonly source: string }[],
): readonly PublicVariantDeclaration[] {
  const publicSymbols = publicSymbolNames(rootSource, testingSource);
  const parsed = [...sources, { path: "testing.ts", source: testingSource }].map(
    ({ path, source }) => {
      const file = ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      return file;
    },
  );
  const namedDeclarations = new Map<string, NamedTypeDeclaration>();
  for (const file of parsed) {
    for (const statement of file.statements) {
      if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
        namedDeclarations.set(statement.name.text, statement);
      }
    }
  }
  const declarations = parsed.flatMap((file) => {
    const found: PublicVariantDeclaration[] = [];
    for (const statement of file.statements) {
      if (!ts.isTypeAliasDeclaration(statement) || !publicSymbols.has(statement.name.text)) {
        continue;
      }
      const descriptor = descriptorForType(statement.type, namedDeclarations);
      if (descriptor) found.push({ symbol: statement.name.text, ...descriptor });
    }
    return found;
  });
  const unique = new Map<string, PublicVariantDeclaration>();
  for (const declaration of declarations) {
    const key = `${declaration.symbol}.${declaration.selector}`;
    const previous = unique.get(key);
    unique.set(
      key,
      previous
        ? {
            ...declaration,
            members: [...new Set([...previous.members, ...declaration.members])].sort(),
          }
        : declaration,
    );
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.symbol.localeCompare(right.symbol) || left.selector.localeCompare(right.selector),
  );
}

export function renderCapabilityCatalogue(input: unknown): string {
  if (
    !isRecord(input) ||
    !isRecord(input.audit) ||
    !Array.isArray(input.capabilities) ||
    !Array.isArray(input.implementations) ||
    !Array.isArray(input.observations)
  ) {
    throw new TypeError("invalid capability catalogue");
  }

  const capabilities = input.capabilities.filter(isRecord);
  const implementations = input.implementations.filter(isRecord);
  const observations = input.observations.filter(isRecord);
  const sourceIndexes = Array.isArray(input.sourceIndexes)
    ? input.sourceIndexes.filter(isRecord)
    : [];
  const interfaceDecision = isRecord(input.interfaceDecision) ? input.interfaceDecision : null;
  const currentPath = Array.isArray(input.currentPath) ? input.currentPath.filter(isRecord) : [];
  const exclusions = Array.isArray(input.exclusions) ? input.exclusions.filter(isRecord) : [];
  const publicSurfaceGroups = Array.isArray(input.publicSurfaceGroups)
    ? input.publicSurfaceGroups.filter(isRecord)
    : [];
  const backends = Array.isArray(input.backends) ? input.backends.filter(isRecord) : [];
  const reactBindings = Array.isArray(input.reactBindings)
    ? input.reactBindings.filter(isRecord)
    : [];
  const live = observations.filter((observation) => observation.kind === "live-whatsapp").length;
  const rendered = observations.filter(
    (observation) => observation.kind === "browser" || observation.kind === "opentui",
  ).length;
  const counts = new Map<string, number>();
  for (const observation of observations) {
    const kind = String(observation.kind);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }

  const lines = [
    "# SDK capability catalogue",
    "",
    "This generated engineering view is derived from `sdk-capabilities.json`.",
    "It inventories what exists and records exact observations separately.",
    "A source anchor establishes that code exists; it is not a behavioral observation.",
    "No observation kind implies another, and absence means not observed rather than failed.",
    "",
    `Audit baseline: whatsappd \`${cell(input.audit.whatsappdVersion)}\` at \`${cell(input.audit.whatsappdHead)}\`; Baileys \`${cell(input.audit.baileysVersion)}\`.`,
    "",
    `Current live WhatsApp observations: **${live}**`,
    "",
    `Current browser/OpenTUI renderer observations: **${rendered}**`,
    "",
  ];

  if (sourceIndexes.length > 0) {
    lines.push(
      "## Source indexes",
      "",
      "These exact source files ground structural inventory only. They do not establish behavior.",
      "",
      "| Key | Package | Source files | Scope |",
      "| --- | --- | --- | --- |",
    );
    for (const source of sourceIndexes) {
      const paths = Array.isArray(source.paths)
        ? source.paths
            .map((path) =>
              source.package === "baileys"
                ? `\`node_modules/baileys/${cell(path)}\``
                : `\`${cell(path)}\``,
            )
            .join("<br>")
        : "—";
      lines.push(
        `| \`${cell(source.key)}\` | \`${cell(source.package)}\` | ${paths} | ${cell(source.summary)} |`,
      );
    }
    lines.push("");
  }

  if (publicSurfaceGroups.length > 0) {
    lines.push(
      "## Current public structural surface",
      "",
      "Every root or testing-subpath export appears here once. This is structural inventory, not behavioral observation.",
      "",
      "| Surface | Current public symbols | Capability coverage |",
      "| --- | --- | --- |",
    );
    for (const group of publicSurfaceGroups) {
      const symbols = Array.isArray(group.symbols)
        ? group.symbols.map((symbol) => `\`${cell(symbol)}\``).join(", ")
        : "—";
      lines.push(`| ${cell(group.surface)} | ${symbols} | ${cell(group.coverage)} |`);
    }
    lines.push("");
  }

  if (interfaceDecision) {
    const example = Array.isArray(interfaceDecision.example)
      ? interfaceDecision.example.map(String)
      : [];
    const namespaces = Array.isArray(interfaceDecision.namespaces)
      ? interfaceDecision.namespaces.filter(isRecord)
      : [];
    const opened = Array.isArray(interfaceDecision.openedConversation)
      ? interfaceDecision.openedConversation.map((item) => `\`${cell(item)}\``).join(", ")
      : "—";
    lines.push(
      "## Selected application interface",
      "",
      `\`${cell(interfaceDecision.adr)}\` selects \`${cell(interfaceDecision.selected)}\`: one framework-independent Client owns synchronized application state, and React/OpenTUI bind it without creating another state store.`,
      "",
      "```ts",
      ...example,
      "```",
      "",
      "### Namespace inventory",
      "",
      "| Namespace | Scope |",
      "| --- | --- |",
    );
    for (const namespace of namespaces) {
      lines.push(`| \`${cell(namespace.name)}\` | ${cell(namespace.scope)} |`);
    }
    lines.push("", `Opened conversation: ${opened}.`, "");
    for (const [title, field] of [
      ["Operation semantics", "operationSemantics"],
      ["Resource ownership", "resourceOwnership"],
    ] as const) {
      lines.push(`### ${title}`, "");
      if (Array.isArray(interfaceDecision[field])) {
        for (const item of interfaceDecision[field]) lines.push(`- ${cell(item)}`);
      }
      lines.push("");
    }
    lines.push(
      "### Interface alternatives graded",
      "",
      "| Option | Floor-first | Reversible | Blast radius | Correctness | Parallelizable | Fit | Decision |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    );
    if (Array.isArray(interfaceDecision.alternatives)) {
      for (const alternative of interfaceDecision.alternatives.filter(isRecord)) {
        lines.push(
          `| \`${cell(alternative.option)}\` | ${cell(alternative.floorFirst)} | ${cell(alternative.reversible)} | ${cell(alternative.blastRadius)} | ${cell(alternative.correctness)} | ${cell(alternative.parallelizable)} | ${cell(alternative.fit)} | ${cell(alternative.decision)} |`,
        );
      }
    }
    lines.push("");
  }

  if (currentPath.length > 0) {
    lines.push(
      "## Current Runtime to Client path",
      "",
      "This is the current code path, not a target architecture or behavioral observation.",
      "",
      "| Step | Current behavior | Source anchors |",
      "| --- | --- | --- |",
    );
    for (const step of currentPath) {
      const anchors = Array.isArray(step.anchors)
        ? step.anchors
            .filter(isRecord)
            .map((anchor) => `\`${cell(anchor.path)}\` — ${cell(anchor.symbol)}`)
            .join("<br>")
        : "—";
      lines.push(`| ${cell(step.component)} | ${cell(step.behavior)} | ${anchors} |`);
    }
    lines.push("");
  }

  lines.push(
    "## Capability matrix",
    "",
    "| ID | Domain | Caller-facing outcome | Upstream | Source indexes | whatsappd | Target interface | Requirements / owner |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  );

  for (const capability of capabilities.sort((left, right) =>
    String(left.id).localeCompare(String(right.id)),
  )) {
    const upstream = isRecord(capability.upstream) ? capability.upstream : {};
    const current = isRecord(capability.current) ? capability.current : {};
    const sourceKeys = Array.isArray(upstream.sourceKeys)
      ? upstream.sourceKeys.map((key) => `\`${cell(key)}\``).join(", ")
      : "—";
    lines.push(
      `| \`${cell(capability.id)}\` | ${cell(capability.domain)} | ${cell(capability.outcome)} | ${cell(upstream.status)} | ${sourceKeys || "—"} | ${cell(current.status)} | ${cell(capability.target)} | ${cell(capability.requirements)} |`,
    );
  }

  if (backends.length > 0) {
    lines.push(
      "",
      "## Backend adapter matrix",
      "",
      "Structured data and media remain independent capabilities; an Adapter may provide one or several.",
      "",
      "| Adapter / delivery | Credentials | Accepted + current data | Leases | Commands | Media bytes | Trusted worker | Browser-safe direct use | Status / owner |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const backend of backends) {
      lines.push(
        `| ${cell(backend.adapter)} | ${cell(backend.credentials)} | ${cell(backend.data)} | ${cell(backend.leases)} | ${cell(backend.commands)} | ${cell(backend.media)} | ${cell(backend.trustedWorker)} | ${cell(backend.browser)} | ${cell(backend.status)} |`,
      );
    }
  }

  if (reactBindings.length > 0) {
    lines.push(
      "",
      "## React and renderer mapping",
      "",
      "One `@whatsappd/react` package serves browser React and OpenTUI React.",
      "Only shared WhatsApp behavior belongs in it; renderers keep presentation and platform effects.",
      "",
      "| Shared React behavior | Candidate shared surface | Renderer-owned behavior |",
      "| --- | --- | --- |",
    );
    for (const binding of reactBindings) {
      lines.push(
        `| ${cell(binding.behavior)} | ${cell(binding.shared)} | ${cell(binding.rendererOwned)} |`,
      );
    }
  }

  if (exclusions.length > 0) {
    lines.push(
      "",
      "## Explicit exclusions",
      "",
      "Upstream typing does not make protocol internals or host-product policy part of the public SDK.",
      "",
      "| Category | Disposition | Boundary |",
      "| --- | --- | --- |",
    );
    for (const exclusion of exclusions) {
      lines.push(
        `| \`${cell(exclusion.category)}\` | \`${cell(exclusion.disposition)}\` | ${cell(exclusion.summary)} |`,
      );
    }
  }

  lines.push("", "## Current implementation slices", "");
  if (implementations.length === 0) {
    lines.push("No current implementation slices are recorded.", "");
  } else {
    lines.push(
      "| ID | Capability | Exact outcome | Surface | Variant | Adapter | Source anchors | Notes |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const implementation of implementations.sort((left, right) =>
      String(left.id).localeCompare(String(right.id)),
    )) {
      const anchors = Array.isArray(implementation.anchors)
        ? implementation.anchors
            .filter(isRecord)
            .map((anchor) => `\`${cell(anchor.path)}\` — ${cell(anchor.symbol)}`)
            .join("<br>")
        : "—";
      lines.push(
        `| \`${cell(implementation.id)}\` | \`${cell(implementation.capabilityId)}\` | ${cell(implementation.outcome)} | \`${cell(implementation.surface)}\` | \`${cell(implementation.variant)}\` | \`${cell(implementation.adapter)}\` | ${anchors || "—"} | ${cell(implementation.notes)} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Recorded observations", "");
  if (observations.length === 0) {
    lines.push("No behavioral observations are currently recorded.", "");
  } else {
    lines.push(
      `Counts: ${[...counts]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([kind, count]) => `\`${kind}\` ${count}`)
        .join("; ")}.`,
      "",
      "| ID | Kind | Exact scenario | Covers | Surface | Environment | Lifecycle | Receipts |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const observation of observations.sort((left, right) =>
      String(left.id).localeCompare(String(right.id)),
    )) {
      const covers = Array.isArray(observation.covers)
        ? observation.covers.map((covered) => `\`${cell(covered)}\``).join("<br>")
        : "—";
      const receipts = Array.isArray(observation.receipts)
        ? observation.receipts
            .filter(isRecord)
            .map(
              (receipt) =>
                `\`${cell(receipt.path)}\` — ${cell(receipt.assertion)} — \`${cell(receipt.head)}\``,
            )
            .join("<br>")
        : "—";
      lines.push(
        `| \`${cell(observation.id)}\` | \`${cell(observation.kind)}\` | ${cell(observation.scenario)} | ${covers} | \`${cell(observation.surface)}\` | \`${cell(observation.environment)}\` | \`${cell(observation.lifecycle)}\` | ${receipts} |`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

interface CapabilityReferenceAdapter {
  isAncestor(head: string): Promise<boolean>;
  readAt(head: string, path: string): Promise<string>;
  readDependency(path: string): Promise<string>;
}

export async function validateCapabilityReferences(
  input: unknown,
  adapter: CapabilityReferenceAdapter,
): Promise<readonly string[]> {
  if (!isRecord(input) || !isRecord(input.audit)) return ["catalogue: audit must be an object"];
  const errors: string[] = [];
  const auditHead = typeof input.audit.whatsappdHead === "string" ? input.audit.whatsappdHead : "";
  const reads = new Map<string, Promise<string>>();
  const readAt = (head: string, path: string): Promise<string> => {
    const key = `${head}:${path}`;
    const existing = reads.get(key);
    if (existing) return existing;
    const pending = adapter.readAt(head, path);
    reads.set(key, pending);
    return pending;
  };

  if (Array.isArray(input.sourceIndexes)) {
    for (const value of input.sourceIndexes) {
      if (!isRecord(value) || !Array.isArray(value.paths)) continue;
      const key = String(value.key);
      const packageName = String(value.package);
      for (const path of value.paths) {
        if (typeof path !== "string") continue;
        try {
          if (packageName === "baileys") {
            await adapter.readDependency(path);
          } else {
            await readAt(auditHead, path);
          }
        } catch {
          errors.push(
            packageName === "baileys"
              ? `${key}: dependency source ${path} does not exist in baileys@${String(input.audit.baileysVersion)}`
              : `${key}: source ${path} does not exist at ${auditHead}`,
          );
        }
      }
    }
  }

  if (Array.isArray(input.currentPath)) {
    for (const value of input.currentPath) {
      if (!isRecord(value) || !Array.isArray(value.anchors)) continue;
      const component = String(value.component);
      for (const anchor of value.anchors) {
        if (
          !isRecord(anchor) ||
          typeof anchor.path !== "string" ||
          typeof anchor.symbol !== "string"
        ) {
          continue;
        }
        try {
          const source = await readAt(auditHead, anchor.path);
          if (!source.includes(anchor.symbol)) {
            errors.push(
              `${component}: source anchor ${anchor.path} does not contain ${anchor.symbol} at ${auditHead}`,
            );
          }
        } catch {
          errors.push(`${component}: source anchor ${anchor.path} does not exist at ${auditHead}`);
        }
      }
    }
  }

  if (Array.isArray(input.implementations)) {
    for (const value of input.implementations) {
      if (!isRecord(value) || !Array.isArray(value.anchors)) continue;
      const id = String(value.id);
      for (const anchor of value.anchors) {
        if (
          !isRecord(anchor) ||
          typeof anchor.path !== "string" ||
          typeof anchor.symbol !== "string"
        ) {
          continue;
        }
        try {
          const source = await readAt(auditHead, anchor.path);
          if (!source.includes(anchor.symbol)) {
            errors.push(
              `${id}: source anchor ${anchor.path} does not contain ${anchor.symbol} at ${auditHead}`,
            );
          }
        } catch {
          errors.push(`${id}: source anchor ${anchor.path} does not exist at ${auditHead}`);
        }
      }
    }
  }

  const ancestors = new Map<string, Promise<boolean>>();
  const isAncestor = (head: string): Promise<boolean> => {
    const existing = ancestors.get(head);
    if (existing) return existing;
    const pending = adapter.isAncestor(head);
    ancestors.set(head, pending);
    return pending;
  };
  if (Array.isArray(input.observations)) {
    for (const value of input.observations) {
      if (!isRecord(value) || !Array.isArray(value.receipts)) continue;
      const id = String(value.id);
      for (const receipt of value.receipts) {
        if (
          !isRecord(receipt) ||
          typeof receipt.path !== "string" ||
          typeof receipt.assertion !== "string" ||
          typeof receipt.head !== "string"
        ) {
          continue;
        }
        if (!(await isAncestor(receipt.head))) {
          errors.push(
            `${id}: receipt head ${receipt.head} is not an ancestor of the catalogue head`,
          );
        }
        try {
          const source = await readAt(receipt.head, receipt.path);
          const assertion = receipt.assertion.replace(/^\[[^\]]+\] /, "");
          if (receipt.path.startsWith("tests/") && !source.includes(assertion)) {
            errors.push(
              `${id}: ${receipt.path} does not contain assertion ${assertion} at ${receipt.head}`,
            );
          }
        } catch {
          errors.push(`${id}: receipt path ${receipt.path} does not exist at ${receipt.head}`);
        }
      }
    }
  }
  return errors;
}

export function validateCapabilityCatalogue(
  input: unknown,
  context: CatalogueValidationContext = {},
): readonly string[] {
  if (!isRecord(input)) return ["catalogue: must be an object"];

  const errors: string[] = [];
  rejectUnknownFields(
    errors,
    "catalogue",
    input,
    new Set([
      "version",
      "audit",
      "sourceIndexes",
      "interfaceDecision",
      "currentPath",
      "exclusions",
      "capabilities",
      "implementations",
      "observations",
      "backends",
      "reactBindings",
      "publicSurfaceGroups",
      "publicExports",
      "variantMappings",
      "variantExclusions",
    ]),
  );
  if (input.version !== 2) errors.push("catalogue: version must be 2");
  if (!isRecord(input.audit)) errors.push("catalogue: audit must be an object");
  if (!Array.isArray(input.capabilities)) errors.push("catalogue: capabilities must be an array");
  if (!Array.isArray(input.implementations)) {
    errors.push("catalogue: implementations must be an array");
  }
  if (!Array.isArray(input.observations)) errors.push("catalogue: observations must be an array");

  const sourceIndexKeys = new Set<string>();
  if (input.sourceIndexes !== undefined && !Array.isArray(input.sourceIndexes)) {
    errors.push("catalogue: sourceIndexes must be an array");
  }
  if (Array.isArray(input.sourceIndexes)) {
    for (const value of input.sourceIndexes) {
      if (!isRecord(value)) {
        errors.push("source index: every source index must be an object");
        continue;
      }
      const key = typeof value.key === "string" ? value.key : "source index";
      rejectUnknownFields(errors, key, value, new Set(["key", "package", "paths", "summary"]));
      if (!/^[BW]:[a-z][a-z0-9-]*$/.test(key)) {
        errors.push(`${key}: invalid source index key`);
      }
      if (sourceIndexKeys.has(key)) errors.push(`${key}: duplicate source index key`);
      sourceIndexKeys.add(key);
      const expectedPackage = key.startsWith("B:") ? "baileys" : "whatsappd";
      if (value.package !== expectedPackage) {
        errors.push(`${key}: package must be ${expectedPackage}`);
      }
      if (!Array.isArray(value.paths) || value.paths.length === 0) {
        errors.push(`${key}: paths must be a non-empty array`);
      } else {
        for (const path of value.paths) {
          if (!isRepositoryPath(path)) {
            errors.push(`${key}: every path must be repository-relative`);
          }
        }
      }
      if (typeof value.summary !== "string" || value.summary.trim() === "") {
        errors.push(`${key}: summary must be non-empty`);
      }
    }
  }

  if (input.publicExports !== undefined && !Array.isArray(input.publicExports)) {
    errors.push("catalogue: publicExports must be an array");
  }
  if (Array.isArray(input.publicExports)) {
    const exports = input.publicExports.filter((name): name is string => typeof name === "string");
    if (exports.length !== input.publicExports.length) {
      errors.push("catalogue: every publicExports entry must be a string");
    }
    if (new Set(exports).size !== exports.length) {
      errors.push("catalogue: publicExports must be unique");
    }
    for (const name of context.publicSymbols ?? []) {
      if (!exports.includes(name)) errors.push(`public export missing from catalogue: ${name}`);
    }
    for (const name of exports) {
      if (context.publicSymbols && !context.publicSymbols.includes(name)) {
        errors.push(`catalogue maps nonexistent public export: ${name}`);
      }
    }
  } else if (context.publicSymbols) {
    errors.push("catalogue: publicExports must be an array");
  }

  if (input.publicSurfaceGroups !== undefined && !Array.isArray(input.publicSurfaceGroups)) {
    errors.push("catalogue: publicSurfaceGroups must be an array");
  }
  if (Array.isArray(input.publicSurfaceGroups)) {
    const grouped: string[] = [];
    for (const value of input.publicSurfaceGroups) {
      if (!isRecord(value)) {
        errors.push("public surface group: every group must be an object");
        continue;
      }
      const label = typeof value.surface === "string" ? value.surface : "public surface group";
      rejectUnknownFields(errors, label, value, new Set(["surface", "symbols", "coverage"]));
      for (const field of ["surface", "coverage"] as const) {
        if (typeof value[field] !== "string" || value[field].trim() === "") {
          errors.push(`${label}: ${field} must be non-empty`);
        }
      }
      if (!Array.isArray(value.symbols) || value.symbols.length === 0) {
        errors.push(`${label}: symbols must be a non-empty array`);
      } else {
        for (const symbol of value.symbols) {
          if (typeof symbol !== "string" || symbol.trim() === "") {
            errors.push(`${label}: every symbol must be non-empty`);
          } else {
            grouped.push(symbol);
          }
        }
      }
    }
    if (new Set(grouped).size !== grouped.length) {
      errors.push("catalogue: public surface groups contain duplicate symbols");
    }
    if (Array.isArray(input.publicExports)) {
      const exports = input.publicExports.filter(
        (name): name is string => typeof name === "string",
      );
      for (const name of exports) {
        if (!grouped.includes(name))
          errors.push(`public export missing from structural group: ${name}`);
      }
      for (const name of grouped) {
        if (!exports.includes(name))
          errors.push(`structural group maps nonexistent export: ${name}`);
      }
    }
  }

  for (const [field, allowed] of [
    [
      "backends",
      new Set([
        "adapter",
        "credentials",
        "data",
        "leases",
        "commands",
        "media",
        "trustedWorker",
        "browser",
        "status",
      ]),
    ],
    ["reactBindings", new Set(["behavior", "shared", "rendererOwned"])],
    ["exclusions", new Set(["category", "disposition", "summary"])],
  ] as const) {
    const records = input[field];
    if (records !== undefined && !Array.isArray(records)) {
      errors.push(`catalogue: ${field} must be an array`);
      continue;
    }
    if (!Array.isArray(records)) continue;
    records.forEach((value, index) => {
      if (!isRecord(value)) {
        errors.push(`${field}[${index}]: must be an object`);
        return;
      }
      rejectUnknownFields(errors, `${field}[${index}]`, value, allowed);
      for (const name of allowed) {
        if (typeof value[name] !== "string" || value[name].trim() === "") {
          errors.push(`${field}[${index}].${name} must be non-empty`);
        }
      }
    });
  }

  if (input.currentPath !== undefined && !Array.isArray(input.currentPath)) {
    errors.push("catalogue: currentPath must be an array");
  }
  if (Array.isArray(input.currentPath)) {
    input.currentPath.forEach((value, index) => {
      if (!isRecord(value)) {
        errors.push(`currentPath[${index}]: must be an object`);
        return;
      }
      rejectUnknownFields(
        errors,
        `currentPath[${index}]`,
        value,
        new Set(["component", "behavior", "anchors"]),
      );
      for (const field of ["component", "behavior"] as const) {
        if (typeof value[field] !== "string" || value[field].trim() === "") {
          errors.push(`currentPath[${index}].${field} must be non-empty`);
        }
      }
      if (!Array.isArray(value.anchors) || value.anchors.length === 0) {
        errors.push(`currentPath[${index}].anchors must be a non-empty array`);
      } else {
        value.anchors.forEach((anchor, anchorIndex) => {
          if (!isRecord(anchor)) {
            errors.push(`currentPath[${index}].anchors[${anchorIndex}] must be an object`);
            return;
          }
          rejectUnknownFields(
            errors,
            `currentPath[${index}].anchors[${anchorIndex}]`,
            anchor,
            new Set(["path", "symbol"]),
          );
          if (!isRepositoryPath(anchor.path)) {
            errors.push(
              `currentPath[${index}].anchors[${anchorIndex}].path must be repository-relative`,
            );
          }
          if (typeof anchor.symbol !== "string" || anchor.symbol.trim() === "") {
            errors.push(`currentPath[${index}].anchors[${anchorIndex}].symbol must be non-empty`);
          }
        });
      }
    });
  }

  if (input.interfaceDecision !== undefined && !isRecord(input.interfaceDecision)) {
    errors.push("catalogue: interfaceDecision must be an object");
  }
  if (isRecord(input.interfaceDecision)) {
    const decision = input.interfaceDecision;
    rejectUnknownFields(
      errors,
      "interfaceDecision",
      decision,
      new Set([
        "adr",
        "selected",
        "alternatives",
        "namespaces",
        "openedConversation",
        "operationSemantics",
        "resourceOwnership",
        "example",
      ]),
    );
    for (const field of ["adr", "selected"] as const) {
      if (typeof decision[field] !== "string" || decision[field].trim() === "") {
        errors.push(`interfaceDecision.${field} must be non-empty`);
      }
    }
    if (!Array.isArray(decision.alternatives) || decision.alternatives.length === 0) {
      errors.push("interfaceDecision.alternatives must be a non-empty array");
    } else {
      decision.alternatives.forEach((value, index) => {
        if (!isRecord(value)) {
          errors.push(`interfaceDecision.alternatives[${index}] must be an object`);
          return;
        }
        const scores = [
          "floorFirst",
          "reversible",
          "blastRadius",
          "correctness",
          "parallelizable",
          "fit",
        ] as const;
        rejectUnknownFields(
          errors,
          `interfaceDecision.alternatives[${index}]`,
          value,
          new Set(["option", "decision", ...scores]),
        );
        for (const field of ["option", "decision"] as const) {
          if (typeof value[field] !== "string" || value[field].trim() === "") {
            errors.push(`interfaceDecision.alternatives[${index}].${field} must be non-empty`);
          }
        }
        for (const field of scores) {
          if (
            !Number.isInteger(value[field]) ||
            Number(value[field]) < 1 ||
            Number(value[field]) > 5
          ) {
            errors.push(`interfaceDecision.alternatives[${index}].${field} must be 1..5`);
          }
        }
      });
    }
    if (!Array.isArray(decision.namespaces) || decision.namespaces.length === 0) {
      errors.push("interfaceDecision.namespaces must be a non-empty array");
    } else {
      decision.namespaces.forEach((value, index) => {
        if (!isRecord(value)) {
          errors.push(`interfaceDecision.namespaces[${index}] must be an object`);
          return;
        }
        rejectUnknownFields(
          errors,
          `interfaceDecision.namespaces[${index}]`,
          value,
          new Set(["name", "scope"]),
        );
        for (const field of ["name", "scope"] as const) {
          if (typeof value[field] !== "string" || value[field].trim() === "") {
            errors.push(`interfaceDecision.namespaces[${index}].${field} must be non-empty`);
          }
        }
      });
    }
    for (const field of [
      "openedConversation",
      "operationSemantics",
      "resourceOwnership",
      "example",
    ] as const) {
      const values = decision[field];
      if (
        !Array.isArray(values) ||
        values.length === 0 ||
        values.some((value) => typeof value !== "string" || value.trim() === "")
      ) {
        errors.push(`interfaceDecision.${field} must be a non-empty string array`);
      }
    }
  }

  if (isRecord(input.audit)) {
    rejectUnknownFields(
      errors,
      "catalogue.audit",
      input.audit,
      new Set(["whatsappdVersion", "whatsappdHead", "baileysVersion"]),
    );
    for (const field of ["whatsappdVersion", "baileysVersion"] as const) {
      if (typeof input.audit[field] !== "string" || input.audit[field].trim() === "") {
        errors.push(`catalogue: audit.${field} must be non-empty`);
      }
    }
    if (typeof input.audit.whatsappdHead !== "string" || !gitSha.test(input.audit.whatsappdHead)) {
      errors.push("catalogue: audit.whatsappdHead must be a full git SHA");
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

  const capabilityIds = new Set<string>();
  if (Array.isArray(input.capabilities)) {
    for (const value of input.capabilities) {
      if (!isRecord(value)) {
        errors.push("capability: every capability must be an object");
        continue;
      }
      const id = typeof value.id === "string" ? value.id : "capability";
      rejectUnknownFields(
        errors,
        id,
        value,
        new Set(["id", "domain", "outcome", "upstream", "current", "target", "requirements"]),
      );
      if (!/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d{2}$/.test(id)) {
        errors.push(`${id}: invalid capability id`);
      }
      if (capabilityIds.has(id)) errors.push(`${id}: duplicate capability id`);
      capabilityIds.add(id);
      for (const field of ["domain", "outcome", "target", "requirements"] as const) {
        if (typeof value[field] !== "string" || value[field].trim() === "") {
          errors.push(`${id}: ${field} must be non-empty`);
        }
      }
      for (const field of ["upstream", "current"] as const) {
        const summary = value[field];
        if (!isRecord(summary)) {
          errors.push(`${id}: ${field} must be an object`);
          continue;
        }
        rejectUnknownFields(
          errors,
          `${id}.${field}`,
          summary,
          new Set(
            field === "upstream" ? ["status", "summary", "sourceKeys"] : ["status", "summary"],
          ),
        );
        if (typeof summary.status !== "string" || !slug.test(summary.status)) {
          errors.push(`${id}: ${field}.status must be one lowercase slug`);
        } else {
          const known = field === "upstream" ? upstreamStatuses : currentStatuses;
          if (!known.has(summary.status)) {
            errors.push(`${id}: unknown ${field}.status ${summary.status}`);
          }
        }
        if (typeof summary.summary !== "string" || summary.summary.trim() === "") {
          errors.push(`${id}: ${field}.summary must be non-empty`);
        }
        if (field === "upstream" && Array.isArray(input.sourceIndexes)) {
          if (!Array.isArray(summary.sourceKeys)) {
            errors.push(`${id}: upstream.sourceKeys must be an array`);
          } else {
            if (summary.status !== "not-applicable" && summary.sourceKeys.length === 0) {
              errors.push(`${id}: upstream.sourceKeys must name at least one source index`);
            }
            for (const key of summary.sourceKeys) {
              if (typeof key !== "string" || !sourceIndexKeys.has(key)) {
                errors.push(
                  `${id}: upstream.sourceKeys contains unknown source index ${String(key)}`,
                );
              }
            }
          }
        }
      }
    }
  }

  const implementationIds = new Set<string>();
  if (Array.isArray(input.implementations)) {
    for (const value of input.implementations) {
      if (!isRecord(value)) {
        errors.push("implementation: every implementation must be an object");
        continue;
      }
      const id = typeof value.id === "string" ? value.id : "implementation";
      rejectUnknownFields(
        errors,
        id,
        value,
        new Set([
          "id",
          "capabilityId",
          "outcome",
          "surface",
          "variant",
          "adapter",
          "anchors",
          "notes",
        ]),
      );
      if (typeof value.id !== "string" || value.id.trim() === "") {
        errors.push("implementation: id must be non-empty");
      }
      if (implementationIds.has(id)) errors.push(`${id}: duplicate implementation id`);
      implementationIds.add(id);
      if (typeof value.capabilityId !== "string" || !capabilityIds.has(value.capabilityId)) {
        errors.push(`${id}: unknown capability ${String(value.capabilityId)}`);
      }
      for (const field of ["outcome", "surface", "variant", "adapter"] as const) {
        if (typeof value[field] !== "string" || value[field].trim() === "") {
          errors.push(`${id}: ${field} must be non-empty`);
        }
      }
      if (!Array.isArray(value.anchors)) {
        errors.push(`${id}: anchors must be an array`);
      } else {
        value.anchors.forEach((anchor, index) => {
          if (!isRecord(anchor)) {
            errors.push(`${id}: anchors[${index}] must be an object`);
            return;
          }
          rejectUnknownFields(
            errors,
            `${id}: anchors[${index}]`,
            anchor,
            new Set(["path", "symbol"]),
          );
          if (!isRepositoryPath(anchor.path)) {
            errors.push(`${id}: anchors[${index}].path must be a repository-relative path`);
          }
          if (typeof anchor.symbol !== "string" || anchor.symbol.trim() === "") {
            errors.push(`${id}: anchors[${index}].symbol must be non-empty`);
          }
        });
      }
    }
  }

  const observationIds = new Set<string>();
  if (Array.isArray(input.observations)) {
    for (const value of input.observations) {
      if (!isRecord(value)) {
        errors.push("observation: every observation must be an object");
        continue;
      }
      const id = typeof value.id === "string" ? value.id : "observation";
      rejectUnknownFields(
        errors,
        id,
        value,
        new Set([
          "id",
          "kind",
          "scenario",
          "covers",
          "surface",
          "environment",
          "lifecycle",
          "receipts",
        ]),
      );
      if (typeof value.id !== "string" || !slug.test(value.id)) {
        errors.push(`${id}: id must be one lowercase slug`);
      }
      if (observationIds.has(id)) errors.push(`${id}: duplicate observation id`);
      observationIds.add(id);
      for (const field of ["kind", "surface", "environment", "lifecycle"] as const) {
        if (typeof value[field] !== "string" || !slug.test(value[field])) {
          errors.push(`${id}: ${field} must be one lowercase slug`);
        }
      }
      if (
        typeof value.kind === "string" &&
        slug.test(value.kind) &&
        !observationKinds.has(value.kind)
      ) {
        errors.push(`${id}: unknown observation kind ${value.kind}`);
      }
      if (typeof value.scenario !== "string" || value.scenario.trim() === "") {
        errors.push(`${id}: scenario must be non-empty`);
      }
      if (!Array.isArray(value.covers) || value.covers.length === 0) {
        errors.push(`${id}: covers must name at least one implementation`);
      } else {
        for (const covered of value.covers) {
          if (typeof covered !== "string" || !implementationIds.has(covered)) {
            errors.push(`${id}: covers unknown implementation ${String(covered)}`);
          }
        }
      }
      if (!Array.isArray(value.receipts) || value.receipts.length === 0) {
        errors.push(`${id}: receipts must contain at least one exact receipt`);
      } else {
        value.receipts.forEach((receipt, index) => {
          if (!isRecord(receipt)) {
            errors.push(`${id}: receipts[${index}] must be an object`);
            return;
          }
          rejectUnknownFields(
            errors,
            `${id}: receipts[${index}]`,
            receipt,
            new Set(["path", "assertion", "head"]),
          );
          if (!isRepositoryPath(receipt.path)) {
            errors.push(`${id}: receipts[${index}].path must be a repository-relative path`);
          }
          if (typeof receipt.assertion !== "string" || receipt.assertion.trim() === "") {
            errors.push(`${id}: receipts[${index}].assertion must be non-empty`);
          }
          if (typeof receipt.head !== "string" || !gitSha.test(receipt.head)) {
            errors.push(`${id}: receipts[${index}].head must be a full git SHA`);
          }
        });
      }
    }
  }

  const mappings = new Map<string, Record<string, unknown>>();
  if (input.variantMappings !== undefined && !Array.isArray(input.variantMappings)) {
    errors.push("catalogue: variantMappings must be an array");
  }
  if (Array.isArray(input.variantMappings)) {
    for (const value of input.variantMappings) {
      if (!isRecord(value)) {
        errors.push("variant mapping: every mapping must be an object");
        continue;
      }
      const symbol = typeof value.symbol === "string" ? value.symbol : "variant mapping";
      const selector = typeof value.selector === "string" ? value.selector : "";
      const key = `${symbol}.${selector}`;
      rejectUnknownFields(errors, key, value, new Set(["symbol", "selector", "members"]));
      if (mappings.has(key)) errors.push(`${key}: duplicate public variant mapping`);
      mappings.set(key, value);
      if (!isRecord(value.members)) {
        errors.push(`${key}: members must be an object`);
        continue;
      }
      for (const [member, covered] of Object.entries(value.members)) {
        if (!Array.isArray(covered) || covered.length === 0) {
          errors.push(`${key}.${member}: must cover at least one implementation`);
          continue;
        }
        for (const implementation of covered) {
          if (typeof implementation !== "string" || !implementationIds.has(implementation)) {
            errors.push(`${key}.${member}: unknown implementation ${String(implementation)}`);
          }
        }
      }
    }
  }

  const exclusions = new Map<string, string>();
  if (input.variantExclusions !== undefined && !Array.isArray(input.variantExclusions)) {
    errors.push("catalogue: variantExclusions must be an array");
  }
  if (Array.isArray(input.variantExclusions)) {
    for (const value of input.variantExclusions) {
      if (!isRecord(value)) {
        errors.push("variant exclusion: every exclusion must be an object");
        continue;
      }
      const symbol = typeof value.symbol === "string" ? value.symbol : "variant exclusion";
      rejectUnknownFields(errors, symbol, value, new Set(["symbol", "reason"]));
      if (typeof value.reason !== "string" || value.reason.trim() === "") {
        errors.push(`${symbol}: variant exclusion requires a reason`);
      }
      if (exclusions.has(symbol)) errors.push(`${symbol}: duplicate public variant exclusion`);
      exclusions.set(symbol, typeof value.reason === "string" ? value.reason : "");
    }
  }

  if (context.publicVariants) {
    const declarationKeys = new Set(
      context.publicVariants.map(({ symbol, selector }) => `${symbol}.${selector}`),
    );
    const declarationSymbols = new Set(context.publicVariants.map(({ symbol }) => symbol));
    for (const key of mappings.keys()) {
      if (!declarationKeys.has(key)) {
        errors.push(`${key}: maps nonexistent public closed variant`);
      }
    }
    for (const symbol of exclusions.keys()) {
      if (!declarationSymbols.has(symbol)) {
        errors.push(`${symbol}: excludes nonexistent public closed variant`);
      }
    }
  }

  for (const declaration of context.publicVariants ?? []) {
    const key = `${declaration.symbol}.${declaration.selector}`;
    const mapping = mappings.get(key);
    if (mapping && exclusions.has(declaration.symbol)) {
      errors.push(`${declaration.symbol}: cannot be both mapped and excluded`);
      continue;
    }
    if (!mapping) {
      if (!exclusions.has(declaration.symbol)) {
        errors.push(`${key}: exported closed variant must be mapped or explicitly excluded`);
      }
      continue;
    }
    const members = isRecord(mapping.members) ? mapping.members : {};
    for (const member of declaration.members) {
      if (!(member in members)) {
        errors.push(`${key}: missing public variant mapping for ${member}`);
      }
    }
    for (const member of Object.keys(members)) {
      if (!declaration.members.includes(member)) {
        errors.push(`${key}: maps nonexistent public variant ${member}`);
      }
    }
  }
  return errors;
}

async function main(): Promise<void> {
  const catalogueUrl = new URL("../docs/sdk-capabilities.json", import.meta.url);
  const renderedUrl = new URL("../docs/sdk-capabilities.md", import.meta.url);
  const [catalogueText, rootSource, testingSource, packageText, sourceNames] = await Promise.all([
    readFile(catalogueUrl, "utf8"),
    readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/testing.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readdir(new URL("../src", import.meta.url), { recursive: true }),
  ]);
  const sourceFiles = await Promise.all(
    sourceNames
      .filter((name) => name.endsWith(".ts"))
      .map(async (name) => ({
        path: name,
        source: await readFile(new URL(`../src/${name}`, import.meta.url), "utf8"),
      })),
  );
  const catalogue: unknown = JSON.parse(catalogueText);
  const packageJson = JSON.parse(packageText) as {
    version: string;
    dependencies: { baileys: string };
  };
  const errors = [
    ...validateCapabilityCatalogue(catalogue, {
      whatsappdVersion: packageJson.version,
      baileysVersion: packageJson.dependencies.baileys,
      publicSymbols: findPublicSymbols(rootSource, testingSource),
      publicVariants: findClosedPublicVariants(rootSource, testingSource, sourceFiles),
    }),
  ];
  errors.push(
    ...(await validateCapabilityReferences(catalogue, {
      async isAncestor(head) {
        try {
          await runFile("git", ["merge-base", "--is-ancestor", head, "HEAD"], {
            cwd: new URL("../", import.meta.url),
          });
          return true;
        } catch {
          return false;
        }
      },
      async readAt(head, path) {
        const { stdout } = await runFile("git", ["show", `${head}:${path}`], {
          cwd: new URL("../", import.meta.url),
          maxBuffer: 10 * 1024 * 1024,
        });
        return stdout;
      },
      async readDependency(path) {
        return readFile(new URL(`../node_modules/baileys/${path}`, import.meta.url), "utf8");
      },
    })),
  );
  if (errors.length > 0) throw new Error(errors.join("\n"));

  const rendered = renderCapabilityCatalogue(catalogue);
  if (process.argv.includes("--write")) {
    await writeFile(renderedUrl, rendered);
    return;
  }
  const checkedIn = await readFile(renderedUrl, "utf8");
  if (checkedIn !== rendered) {
    throw new Error("docs/sdk-capabilities.md is stale; run pnpm generate:sdk-capabilities");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
