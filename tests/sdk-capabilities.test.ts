import { readFile, readdir } from "node:fs/promises";

import { expect, test } from "./_expect.ts";
import {
  findClosedPublicVariants,
  findPublicSymbols,
  renderCapabilityCatalogue,
  validateCapabilityCatalogue,
  validateCapabilityReferences,
} from "../scripts/sdk-capabilities.ts";

const head = "b27d3641a46935248ca414b4ec9bfd801ce88850";

function emptyCatalogue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    audit: {
      whatsappdVersion: "0.2.2",
      whatsappdHead: head,
      baileysVersion: "7.0.0-rc14",
    },
    capabilities: [],
    implementations: [],
    observations: [],
    ...overrides,
  };
}

test("availability is independent from observations and global proof verdicts are invalid", () => {
  expect(
    validateCapabilityCatalogue(
      emptyCatalogue({
        capabilities: [
          {
            id: "MSG-IN-02",
            domain: "messages",
            outcome: "Receive an image",
            upstream: { status: "available", summary: "Baileys exposes image messages." },
            current: { status: "implemented", summary: "Public inbound image message." },
            target: "conversation.messages",
            requirements: "Injected media storage",
          },
        ],
      }),
    ),
  ).toEqual([]);

  expect(
    validateCapabilityCatalogue(emptyCatalogue({ supported: true, provenRung: "P2" })),
  ).toEqual(["catalogue: unexpected field supported", "catalogue: unexpected field provenRung"]);
});

test("observations name exact implementations and safe immutable receipts", () => {
  const errors = validateCapabilityCatalogue(
    emptyCatalogue({
      observations: [
        {
          id: "vague-proof",
          kind: "durability",
          scenario: "",
          covers: ["MSG-IN-02.image.runtime-client"],
          surface: "runtime-client",
          environment: "libsql",
          lifecycle: "restart",
          receipts: [{ path: "../outside.test.ts", assertion: "", head: "latest" }],
          provenRung: "P2",
        },
      ],
    }),
  ).join("\n");

  expect(errors).toContain("vague-proof: unexpected field provenRung");
  expect(errors).toContain("vague-proof: scenario must be non-empty");
  expect(errors).toContain(
    "vague-proof: covers unknown implementation MSG-IN-02.image.runtime-client",
  );
  expect(errors).toContain("vague-proof: receipts[0].path must be a repository-relative path");
  expect(errors).toContain("vague-proof: receipts[0].assertion must be non-empty");
  expect(errors).toContain("vague-proof: receipts[0].head must be a full git SHA");
});

test("the audit baseline must match the package versions being checked", () => {
  expect(
    validateCapabilityCatalogue(emptyCatalogue(), {
      whatsappdVersion: "0.2.3",
      baileysVersion: "7.0.0-rc15",
    }),
  ).toEqual([
    "catalogue: audit.whatsappdVersion 0.2.2 does not match package version 0.2.3",
    "catalogue: audit.baileysVersion 7.0.0-rc14 does not match package dependency 7.0.0-rc15",
  ]);
});

test("fact and observation vocabularies reject invented statuses", () => {
  const errors = validateCapabilityCatalogue(
    emptyCatalogue({
      capabilities: [
        {
          id: "MSG-IN-02",
          domain: "messages",
          outcome: "Receive an image",
          upstream: { status: "probably", summary: "Unreviewed guess." },
          current: { status: "works", summary: "Unreviewed guess." },
          target: "conversation.messages",
          requirements: "Injected media storage",
        },
      ],
      observations: [
        {
          id: "image-check",
          kind: "trust-me",
          scenario: "an image exists",
          covers: ["missing"],
          surface: "runtime-client",
          environment: "memory",
          lifecycle: "deterministic",
          receipts: [{ path: "tests/inbound.test.ts", assertion: "image", head }],
        },
      ],
    }),
  ).join("\n");

  expect(errors).toContain("MSG-IN-02: unknown upstream.status probably");
  expect(errors).toContain("MSG-IN-02: unknown current.status works");
  expect(errors).toContain("image-check: unknown observation kind trust-me");
});

test("upstream capability facts name a checked source index", () => {
  expect(
    validateCapabilityCatalogue(
      emptyCatalogue({
        sourceIndexes: [
          {
            key: "B:messages",
            package: "baileys",
            paths: ["lib/Types/Message.d.ts"],
            summary: "Public message declarations",
          },
        ],
        capabilities: [
          {
            id: "MSG-IN-02",
            domain: "messages",
            outcome: "Receive an image",
            upstream: {
              status: "available",
              summary: "Baileys exposes image messages.",
              sourceKeys: ["B:missing"],
            },
            current: { status: "implemented", summary: "Public inbound image message." },
            target: "conversation.messages",
            requirements: "Injected media storage",
          },
        ],
      }),
    ),
  ).toEqual(["MSG-IN-02: upstream.sourceKeys contains unknown source index B:missing"]);
});

test("public closed variants are derived from exported TypeScript declarations", () => {
  expect(
    findClosedPublicVariants(
      'export type { GroupParticipantAction, InboundMessage, Outbound, Update } from "./model.ts";',
      [
        'export type TestEvent = { type: "message" } | { type: "presence" };',
        "export type TestAlias = TestEvent;",
      ].join("\n"),
      [
        {
          path: "model.ts",
          source: [
            'export type GroupParticipantAction = "add" | "remove" | "demote";',
            "export type InboundMessage = Base & (",
            '  | { kind: "text"; text: string }',
            '  | { kind: "image" | "video"; media: unknown }',
            ");",
            "export type Outbound =",
            "  | { text: string }",
            "  | { image: Uint8Array }",
            "  | { delete: string };",
            'export interface ReceiptUpdate { kind: "receipt"; status: string }',
            'export interface EditUpdate { kind: "edit"; text: string }',
            "export type Update = ReceiptUpdate | EditUpdate;",
          ].join("\n"),
        },
      ],
    ),
  ).toEqual([
    {
      symbol: "GroupParticipantAction",
      selector: "value",
      members: ["add", "demote", "remove"],
    },
    { symbol: "InboundMessage", selector: "kind", members: ["image", "text", "video"] },
    { symbol: "Outbound", selector: "property", members: ["delete", "image", "text"] },
    { symbol: "TestAlias", selector: "type", members: ["message", "presence"] },
    { symbol: "TestEvent", selector: "type", members: ["message", "presence"] },
    { symbol: "Update", selector: "kind", members: ["edit", "receipt"] },
  ]);
});

test("every exported closed variant is mapped or explicitly excluded", () => {
  const errors = validateCapabilityCatalogue(
    emptyCatalogue({
      capabilities: [
        {
          id: "GROUP-01",
          domain: "groups",
          outcome: "Observe participant changes",
          upstream: { status: "available", summary: "Baileys emits participant changes." },
          current: { status: "implemented", summary: "The Runtime projects group rosters." },
          target: "groups.subscribe",
          requirements: "Current data",
        },
      ],
      implementations: [
        {
          id: "GROUP-01.participant-add.runtime-client",
          capabilityId: "GROUP-01",
          outcome: "observe a participant addition",
          surface: "runtime-client",
          variant: "participant-add",
          adapter: "memory-runtime",
          anchors: [],
        },
      ],
      variantMappings: [
        {
          symbol: "GroupParticipantAction",
          selector: "value",
          members: { add: ["GROUP-01.participant-add.runtime-client"] },
        },
      ],
      variantExclusions: [],
    }),
    {
      publicVariants: [
        {
          symbol: "GroupParticipantAction",
          selector: "value",
          members: ["add", "remove"],
        },
      ],
    },
  );

  expect(errors).toEqual([
    "GroupParticipantAction.value: missing public variant mapping for remove",
  ]);
});

test("stale variant mappings and exclusions cannot outlive their public types", () => {
  expect(
    validateCapabilityCatalogue(
      emptyCatalogue({
        variantMappings: [{ symbol: "Removed", selector: "value", members: {} }],
        variantExclusions: [{ symbol: "AlsoRemoved", reason: "used to be generic" }],
      }),
      { publicVariants: [] },
    ),
  ).toEqual([
    "Removed.value: maps nonexistent public closed variant",
    "AlsoRemoved: excludes nonexistent public closed variant",
  ]);
});

test("the generated view separates availability, observations, and future bindings", () => {
  const rendered = renderCapabilityCatalogue(
    emptyCatalogue({
      capabilities: [
        {
          id: "MSG-IN-02",
          domain: "messages",
          outcome: "Receive an image",
          upstream: { status: "available", summary: "Baileys exposes image messages." },
          current: { status: "implemented", summary: "Public inbound image message." },
          target: "conversation.messages",
          requirements: "Injected media storage",
        },
      ],
      backends: [
        {
          adapter: "libSQL",
          credentials: "yes",
          data: "yes",
          leases: "yes",
          commands: "no",
          media: "injected",
          trustedWorker: "yes",
          browser: "no",
          status: "shipped",
        },
      ],
      reactBindings: [
        {
          behavior: "Opened conversation state",
          shared: "useConversation",
          rendererOwned: "Transcript layout",
        },
      ],
    }),
  );

  expect(rendered).toContain("Current live WhatsApp observations: **0**");
  expect(rendered).toContain("Current browser/OpenTUI renderer observations: **0**");
  expect(rendered).toContain("No behavioral observations are currently recorded.");
  expect(rendered).toContain(
    "| `MSG-IN-02` | messages | Receive an image | available | — | implemented |",
  );
  expect(rendered).toContain("| libSQL | yes | yes | yes | no | injected | yes | no | shipped |");
  expect(rendered).toContain("| Opened conversation state | useConversation | Transcript layout |");
  expect(rendered.includes("provenRung")).toBe(false);
  expect(rendered.includes("supported")).toBe(false);
});

test("source anchors and observations resolve at their exact git commits", async () => {
  const errors = await validateCapabilityReferences(
    emptyCatalogue({
      sourceIndexes: [
        {
          key: "B:socket",
          package: "baileys",
          paths: ["lib/Socket/missing.d.ts"],
          summary: "Public socket declarations",
        },
      ],
      implementations: [
        {
          id: "MSG-IN-02.image.mapper",
          anchors: [{ path: "src/inbound.ts", symbol: "toInbound" }],
        },
      ],
      observations: [
        {
          id: "image-check",
          receipts: [
            {
              path: "tests/inbound.test.ts",
              assertion: "image reaches the Client",
              head: "88ddce83f2aa278f3612c62239f4a2af0443cb16",
            },
          ],
        },
      ],
    }),
    {
      async isAncestor() {
        return false;
      },
      async readAt(commit, path) {
        return commit === head && path === "src/inbound.ts"
          ? "mapInbound"
          : 'test("another assertion", () => {})';
      },
      async readDependency() {
        throw new Error("missing");
      },
    },
  );

  expect(errors).toEqual([
    "B:socket: dependency source lib/Socket/missing.d.ts does not exist in baileys@7.0.0-rc14",
    `MSG-IN-02.image.mapper: source anchor src/inbound.ts does not contain toInbound at ${head}`,
    "image-check: receipt head 88ddce83f2aa278f3612c62239f4a2af0443cb16 is not an ancestor of the catalogue head",
    "image-check: tests/inbound.test.ts does not contain assertion image reaches the Client at 88ddce83f2aa278f3612c62239f4a2af0443cb16",
  ]);
});

test("the checked-in catalogue is complete, current, and generated without drift", async () => {
  const [catalogueText, rendered, rootSource, testingSource, packageText, sourceNames] =
    await Promise.all([
      readFile(new URL("../docs/sdk-capabilities.json", import.meta.url), "utf8"),
      readFile(new URL("../docs/sdk-capabilities.md", import.meta.url), "utf8"),
      readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/testing.ts", import.meta.url), "utf8"),
      readFile(new URL("../package.json", import.meta.url), "utf8"),
      readdir(new URL("../src", import.meta.url), { recursive: true }),
    ]);
  const catalogue = JSON.parse(catalogueText) as Record<string, unknown>;
  const packageJson = JSON.parse(packageText) as {
    version: string;
    dependencies: { baileys: string };
  };
  const sourceFiles = await Promise.all(
    sourceNames
      .filter((name) => name.endsWith(".ts"))
      .map(async (name) => ({
        path: name,
        source: await readFile(new URL(`../src/${name}`, import.meta.url), "utf8"),
      })),
  );

  expect(
    validateCapabilityCatalogue(catalogue, {
      whatsappdVersion: packageJson.version,
      baileysVersion: packageJson.dependencies.baileys,
      publicSymbols: findPublicSymbols(rootSource, testingSource),
      publicVariants: findClosedPublicVariants(rootSource, testingSource, sourceFiles),
    }),
  ).toEqual([]);
  expect((catalogue.publicExports as unknown[]).length).toBe(104);
  expect((catalogue.sourceIndexes as unknown[]).length).toBe(15);
  expect((catalogue.currentPath as unknown[]).length).toBe(6);
  expect((catalogue.exclusions as unknown[]).length).toBe(3);
  expect((catalogue.capabilities as unknown[]).length).toBe(167);
  expect((catalogue.implementations as unknown[]).length).toBe(291);
  expect((catalogue.observations as unknown[]).length).toBe(123);
  expect((catalogue.variantMappings as unknown[]).length).toBe(19);
  expect((catalogue.variantExclusions as unknown[]).length).toBe(6);
  expect((catalogue.publicSurfaceGroups as unknown[]).length).toBe(10);
  expect((catalogue.backends as unknown[]).length).toBe(9);
  expect((catalogue.reactBindings as unknown[]).length).toBe(6);
  expect(
    (catalogue.observations as { kind: string }[]).filter(
      (observation) => observation.kind === "live-whatsapp",
    ).length,
  ).toBe(0);
  expect(catalogueText).not.toContain('"supported":');
  expect(catalogueText).not.toContain('"requiredRung":');
  expect(catalogueText).not.toContain('"provenRung":');
  expect(renderCapabilityCatalogue(catalogue)).toContain("## Source indexes");
  expect(renderCapabilityCatalogue(catalogue)).toContain("## Current Runtime to Client path");
  expect(renderCapabilityCatalogue(catalogue)).toContain("## Explicit exclusions");
  expect(renderCapabilityCatalogue(catalogue)).toContain("send.document");
  expect(renderCapabilityCatalogue(catalogue)).toContain("flat-method-collection");
  expect(rendered).toBe(renderCapabilityCatalogue(catalogue));
});
