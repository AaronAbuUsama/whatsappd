import { readFile } from "node:fs/promises";

import { expect, test } from "./_expect.ts";
import {
  findUndocumentedPublicSymbols,
  renderCapabilityEvidence,
  validateCapabilityEvidence,
} from "../scripts/sdk-capabilities.ts";

test("a proven capability claim requires an exact evidence receipt", () => {
  const errors = validateCapabilityEvidence({
    version: 1,
    audit: {
      whatsappdHead: "b27d3641a46935248ca414b4ec9bfd801ce88850",
      baileysVersion: "7.0.0-rc14",
    },
    claims: [
      {
        id: "MEDIA-03.edit-retention.file-media.restart",
        capabilityId: "MEDIA-03",
        outcome: "retain the old and new media objects after an edit and process replacement",
        surface: "media-store",
        variant: "generic-media",
        adapter: "file-media",
        lifecycle: "restart",
        implementation: "implemented",
        support: "supported",
        requiredRung: "P2",
        provenRung: "P2",
        evidence: [],
      },
    ],
  });

  expect(errors.join("\n")).toContain(
    "MEDIA-03.edit-retention.file-media.restart: proven claims require at least one exact evidence receipt",
  );
});

test("a capability claim names one value for every proof dimension", () => {
  const errors = validateCapabilityEvidence({
    version: 1,
    audit: {
      whatsappdHead: "b27d3641a46935248ca414b4ec9bfd801ce88850",
      baileysVersion: "7.0.0-rc14",
    },
    claims: [
      {
        id: "MEDIA-01.capture.libsql.restart",
        capabilityId: "MEDIA-01",
        outcome: "capture inbound attachment bytes before publishing accepted state",
        surface: "runtime-client",
        variant: ["image", "audio"],
        adapter: "libsql-file-media",
        lifecycle: "restart",
        implementation: "implemented",
        support: "supported",
        requiredRung: "P2",
        provenRung: "P2",
        evidence: [
          {
            path: "tests/libsql-backend.test.ts",
            assertion:
              "new libSQL, file media, Runtime, and Client instances reconstruct image and voice bytes",
            head: "b27d3641a46935248ca414b4ec9bfd801ce88850",
          },
        ],
      },
    ],
  });

  expect(errors.join("\n")).toContain(
    "MEDIA-01.capture.libsql.restart: variant must be one lowercase slug, not a grouped value",
  );
});

test("an evidence receipt names the exact assertion and git head", () => {
  const errors = validateCapabilityEvidence({
    version: 1,
    audit: {
      whatsappdHead: "b27d3641a46935248ca414b4ec9bfd801ce88850",
      baileysVersion: "7.0.0-rc14",
    },
    claims: [
      {
        id: "TEST-01.construct-text.testing.deterministic",
        capabilityId: "TEST-01",
        outcome: "construct one deterministic text message",
        surface: "testing-export",
        variant: "text",
        adapter: "testing",
        lifecycle: "deterministic",
        implementation: "implemented",
        support: "supported",
        requiredRung: "P1",
        provenRung: "P1",
        evidence: [{ path: "tests/testing.test.ts", head: "latest" }],
      },
    ],
  });

  expect(errors.join("\n")).toContain(
    "TEST-01.construct-text.testing.deterministic: evidence[0].assertion must name an exact test, receipt, symbol, or decision",
  );
  expect(errors.join("\n")).toContain(
    "TEST-01.construct-text.testing.deterministic: evidence[0].head must be a full git SHA",
  );
});

test("every receipt is scoped to the catalogue's exact implementation head", () => {
  const errors = validateCapabilityEvidence({
    version: 1,
    audit: {
      whatsappdHead: "b27d3641a46935248ca414b4ec9bfd801ce88850",
      baileysVersion: "7.0.0-rc14",
    },
    claims: [
      {
        id: "TEST-01.construct.testing-export.deterministic",
        capabilityId: "TEST-01",
        outcome: "construct a deterministic text message",
        surface: "testing-export",
        variant: "text",
        adapter: "testing",
        lifecycle: "deterministic",
        implementation: "implemented",
        support: "supported",
        requiredRung: "P1",
        provenRung: "P1",
        evidence: [
          {
            path: "tests/testing.test.ts",
            assertion: "reply stays in handler context and records a correctly quoted send",
            head: "88ddce83f2aa278f3612c62239f4a2af0443cb16",
          },
        ],
      },
    ],
  });

  expect(errors.join("\n")).toContain(
    "TEST-01.construct.testing-export.deterministic: evidence[0].head must equal audit.whatsappdHead",
  );
});

test("a supported claim must reach its required proof rung", () => {
  const errors = validateCapabilityEvidence({
    version: 1,
    audit: {
      whatsappdHead: "b27d3641a46935248ca414b4ec9bfd801ce88850",
      baileysVersion: "7.0.0-rc14",
    },
    claims: [
      {
        id: "CHAT-08.mark-read.production-session.deterministic",
        capabilityId: "CHAT-08",
        outcome: "mark real message references read through the production Session",
        surface: "production-session",
        variant: "message-reference",
        adapter: "baileys-session",
        lifecycle: "deterministic",
        implementation: "implemented",
        support: "supported",
        requiredRung: "P1",
        provenRung: null,
        gap: "no production Session command test",
        evidence: [],
      },
    ],
  });

  expect(errors.join("\n")).toContain(
    "CHAT-08.mark-read.production-session.deterministic: supported claims must reach requiredRung P1",
  );
});

test("an unproven implemented claim records the exact missing proof", () => {
  const errors = validateCapabilityEvidence({
    version: 1,
    audit: {
      whatsappdHead: "b27d3641a46935248ca414b4ec9bfd801ce88850",
      baileysVersion: "7.0.0-rc14",
    },
    claims: [
      {
        id: "LIVE-02.recording.runtime-client.deterministic",
        capabilityId: "LIVE-02",
        outcome: "observe recording through the Runtime and Client",
        surface: "runtime-client",
        variant: "recording",
        adapter: "memory-runtime",
        lifecycle: "deterministic",
        implementation: "implemented",
        support: "unproven",
        requiredRung: "P1",
        provenRung: null,
        evidence: [],
      },
    ],
  });

  expect(errors.join("\n")).toContain(
    "LIVE-02.recording.runtime-client.deterministic: unproven claims require a concrete gap",
  );
});

test("capability claim identifiers are unique", () => {
  const claim = {
    id: "TEST-02.emit.testing.deterministic",
    capabilityId: "TEST-02",
    outcome: "emit a normalized event through an awaited subscription",
    surface: "testing-export",
    variant: "normalized-event",
    adapter: "testing",
    lifecycle: "deterministic",
    implementation: "implemented",
    support: "supported",
    requiredRung: "P1",
    provenRung: "P1",
    evidence: [
      {
        path: "tests/testing.test.ts",
        assertion: "a later update waits for the suspended message handler",
        head: "b27d3641a46935248ca414b4ec9bfd801ce88850",
      },
    ],
  };
  const errors = validateCapabilityEvidence({
    version: 1,
    audit: {
      whatsappdHead: "b27d3641a46935248ca414b4ec9bfd801ce88850",
      baileysVersion: "7.0.0-rc14",
    },
    claims: [claim, { ...claim }],
  });

  expect(errors.join("\n")).toContain("TEST-02.emit.testing.deterministic: duplicate claim id");
});

test("capability claims use the closed atomic evidence schema", () => {
  const errors = validateCapabilityEvidence({
    version: 2,
    unexpected: true,
    audit: {
      whatsappdHead: "latest",
      baileysVersion: "7.0.0-rc14",
      branch: "master",
    },
    claims: [
      {
        id: "wrong-prefix",
        capabilityId: "MEDIA-03",
        outcome: "",
        surface: "runtimeclient",
        variant: "generic-media",
        adapter: "libsqlfilemedia",
        lifecycle: "restarted",
        implementation: "maybe",
        support: "probably",
        requiredRung: "P9",
        provenRung: "P8",
        evidence: [{ path: "", assertion: "some assertion", head: "latest", line: 1 }],
        typo: "accepted",
      },
    ],
  });

  expect(errors.join("\n")).toContain("catalogue: unexpected field unexpected");
  expect(errors.join("\n")).toContain("catalogue: version must be 1");
  expect(errors.join("\n")).toContain("catalogue.audit: unexpected field branch");
  expect(errors.join("\n")).toContain("catalogue: audit.whatsappdHead must be a full git SHA");
  expect(errors.join("\n")).toContain(
    "wrong-prefix: id must begin with capabilityId MEDIA-03 and use dot-separated slugs",
  );
  expect(errors.join("\n")).toContain("wrong-prefix: outcome must be non-empty");
  expect(errors.join("\n")).toContain("wrong-prefix: unexpected field typo");
  expect(errors.join("\n")).toContain("wrong-prefix: unknown surface runtimeclient");
  expect(errors.join("\n")).toContain("wrong-prefix: unknown adapter libsqlfilemedia");
  expect(errors.join("\n")).toContain("wrong-prefix: unknown lifecycle restarted");
  expect(errors.join("\n")).toContain("wrong-prefix: implementation must be implemented");
  expect(errors.join("\n")).toContain(
    "wrong-prefix: support must be supported, unproven, or internal",
  );
  expect(errors.join("\n")).toContain("wrong-prefix: requiredRung must be P0-P6");
  expect(errors.join("\n")).toContain("wrong-prefix: provenRung must be null or P0-P6");
  expect(errors.join("\n")).toContain("wrong-prefix: evidence[0].path must be non-empty");
  expect(errors.join("\n")).toContain("wrong-prefix: evidence[0]: unexpected field line");
});

test("every atomic claim belongs to and is linked by one broad catalogue row", () => {
  const errors = validateCapabilityEvidence(
    {
      version: 1,
      audit: {
        whatsappdHead: "b27d3641a46935248ca414b4ec9bfd801ce88850",
        baileysVersion: "7.0.0-rc14",
      },
      claims: [
        {
          id: "MEDIA-03.edit-retention.file-media.restart",
          capabilityId: "MEDIA-03",
          outcome: "retain old and new bytes after restart",
          surface: "runtime-client",
          variant: "generic-media",
          adapter: "libsql-file-media",
          lifecycle: "restart",
          implementation: "implemented",
          support: "unproven",
          requiredRung: "P2",
          provenRung: "P0",
          gap: "no replacement-process edit assertion",
          evidence: [
            {
              path: "src/runtime/file-media.ts",
              assertion: "fileMediaStore content-addressed put and read implementation",
              head: "b27d3641a46935248ca414b4ec9bfd801ce88850",
            },
          ],
        },
      ],
    },
    {
      catalogueMarkdown:
        "| `MEDIA-02` | Read media. | n/a | See [atomic current claims](sdk-capability-evidence.md#media-02). | Transparent | Media capability |",
    },
  );

  expect(errors.join("\n")).toContain(
    "MEDIA-02: current-claims link has no atomic evidence records",
  );
  expect(errors.join("\n")).toContain(
    "MEDIA-03: atomic evidence records are not linked by their broad capability row",
  );
});

test("the structural inventory reports every undocumented public symbol", () => {
  expect(
    findUndocumentedPublicSymbols(
      'export { createSession, memoryStore as store } from "./index.ts";',
      "export interface TextInput {}\nexport function textMessage() {}",
      [
        "## Current public structural surface",
        "`createSession`, `TextInput`",
        "## Selected application interface",
      ].join("\n"),
    ),
  ).toEqual(["store", "textMessage"]);
});

test("the checked-in capability evidence satisfies the atomic claim contract", async () => {
  const [evidence, catalogueMarkdown, evidenceMarkdown, rootSource, testingSource] =
    await Promise.all([
      readFile(new URL("../docs/sdk-capability-evidence.json", import.meta.url), "utf8"),
      readFile(new URL("../docs/sdk-capabilities.md", import.meta.url), "utf8"),
      readFile(new URL("../docs/sdk-capability-evidence.md", import.meta.url), "utf8"),
      readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/testing.ts", import.meta.url), "utf8"),
    ]);
  const parsed: unknown = JSON.parse(evidence);
  expect(
    validateCapabilityEvidence(parsed, {
      catalogueMarkdown,
    }),
  ).toEqual([]);
  const capabilityIds = [...catalogueMarkdown.matchAll(/^\| `([A-Z][A-Z0-9-]+)`\s*\|/gm)].map(
    (match) => match[1],
  );
  expect(capabilityIds.length).toBe(167);
  expect(new Set(capabilityIds).size).toBe(capabilityIds.length);
  expect(findUndocumentedPublicSymbols(rootSource, testingSource, catalogueMarkdown)).toEqual([]);
  expect(evidenceMarkdown).toBe(renderCapabilityEvidence(parsed));
});

test("checked-in receipts resolve to files and exact test assertions", async () => {
  const evidence = JSON.parse(
    await readFile(new URL("../docs/sdk-capability-evidence.json", import.meta.url), "utf8"),
  ) as {
    claims: {
      id: string;
      capabilityId: string;
      surface: string;
      variant: string;
      support: string;
      evidence: { path: string; assertion: string }[];
    }[];
  };
  const sources = new Map<string, string>();

  for (const claim of evidence.claims) {
    for (const receipt of claim.evidence) {
      let source = sources.get(receipt.path);
      if (source === undefined) {
        source = await readFile(new URL(`../${receipt.path}`, import.meta.url), "utf8");
        sources.set(receipt.path, source);
      }
      if (!receipt.path.startsWith("tests/")) continue;
      const assertion = receipt.assertion.replace(/^\[[^\]]+\] /, "");
      expect(source).toContain(assertion);
      if (claim.surface === "runtime-client" && claim.support === "supported") {
        const start = source.indexOf(assertion) + assertion.length;
        const nextTest = source.indexOf("\ntest(", start);
        const body = source.slice(start, nextTest < 0 ? source.length : nextTest);
        expect(/\bclient\b|WhatsAppClient|\.client\b/.test(body)).toBe(true);
      }
      if (claim.capabilityId === "TEST-02" && claim.support === "supported") {
        const start = source.indexOf(assertion) + assertion.length;
        const nextTest = source.indexOf("\ntest(", start);
        const body = source.slice(start, nextTest < 0 ? source.length : nextTest);
        const eventType =
          claim.variant === "conversation-sync" ? "conversation_sync" : claim.variant;
        expect(body).toContain(`type: "${eventType}"`);
      }
    }
  }
});

test("broad capability rows cannot carry proof rungs", () => {
  const errors = validateCapabilityEvidence(
    {
      version: 1,
      audit: {
        whatsappdHead: "b27d3641a46935248ca414b4ec9bfd801ce88850",
        baileysVersion: "7.0.0-rc14",
      },
      claims: [],
    },
    {
      catalogueMarkdown:
        "| `MEDIA-03` | Preserve old bytes after edits. | n/a | implemented P1/P2 | Transparent | Media capability |",
    },
  );

  expect(errors.join("\n")).toContain(
    "MEDIA-03: broad capability rows may reference atomic claims but must not state proof rungs",
  );
});

test("backend summary rows cannot aggregate capability proof", () => {
  const errors = validateCapabilityEvidence(
    {
      version: 1,
      audit: {
        whatsappdHead: "b27d3641a46935248ca414b4ec9bfd801ce88850",
        baileysVersion: "7.0.0-rc14",
      },
      claims: [],
    },
    {
      catalogueMarkdown: [
        "## Backend capability matrix",
        "",
        "| Adapter | Status / owner |",
        "| --- | --- |",
        "| Memory | implemented-and-proven P1; shipped |",
        "",
        "## React and renderer mapping",
      ].join("\n"),
    },
  );

  expect(errors.join("\n")).toContain(
    "backend capability matrix: summary rows must not aggregate proof status or rungs",
  );
});

test("a broad current-claims link requires at least one atomic claim", () => {
  const errors = validateCapabilityEvidence(
    {
      version: 1,
      audit: {
        whatsappdHead: "b27d3641a46935248ca414b4ec9bfd801ce88850",
        baileysVersion: "7.0.0-rc14",
      },
      claims: [],
    },
    {
      catalogueMarkdown:
        "| `MEDIA-03` | Preserve old bytes after edits. | n/a | See [atomic current claims](sdk-capability-evidence.md#media-03). | Transparent | Media capability |",
    },
  );

  expect(errors.join("\n")).toContain(
    "MEDIA-03: current-claims link has no atomic evidence records",
  );
});

test("a broad capability row links atomic claims or states a non-current disposition", () => {
  const errors = validateCapabilityEvidence(
    {
      version: 1,
      audit: {
        whatsappdHead: "b27d3641a46935248ca414b4ec9bfd801ce88850",
        baileysVersion: "7.0.0-rc14",
      },
      claims: [],
    },
    {
      catalogueMarkdown:
        "| `STATUS-02` | Receive status messages. | available | `partial-or-unstable`: may normalize | target | owner |",
    },
  );

  expect(errors.join("\n")).toContain(
    "STATUS-02: current column must link atomic claims or state a non-current disposition",
  );
});

test("the evidence renderer gives every capability a stable human-readable anchor", () => {
  const markdown = renderCapabilityEvidence({
    version: 1,
    audit: {
      whatsappdHead: "b27d3641a46935248ca414b4ec9bfd801ce88850",
      baileysVersion: "7.0.0-rc14",
    },
    claims: [
      {
        id: "MEDIA-03.edit-retention.file-media.restart",
        capabilityId: "MEDIA-03",
        outcome: "retain old and new bytes after restart",
        surface: "runtime-client",
        variant: "generic-media",
        adapter: "libsql-file-media",
        lifecycle: "restart",
        implementation: "implemented",
        support: "unproven",
        requiredRung: "P2",
        provenRung: "P0",
        gap: "no replacement-process edit assertion",
        evidence: [
          {
            path: "src/runtime/file-media.ts",
            assertion: "fileMediaStore content-addressed put and read implementation",
            head: "b27d3641a46935248ca414b4ec9bfd801ce88850",
          },
        ],
      },
    ],
  });

  expect(markdown).toContain("## MEDIA-03");
  expect(markdown).toContain("`MEDIA-03.edit-retention.file-media.restart`");
  expect(markdown).toContain("`implemented-unproven`");
  expect(markdown).toContain("no replacement-process edit assertion");
  expect(markdown.endsWith("\n\n")).toBe(false);
});

test("reviewed current claims retain exact surfaces, variants, and receipts", async () => {
  const evidence = JSON.parse(
    await readFile(new URL("../docs/sdk-capability-evidence.json", import.meta.url), "utf8"),
  ) as {
    claims: {
      id: string;
      capabilityId: string;
      variant: string;
      evidence: { assertion: string }[];
    }[];
  };
  const claims = new Map(evidence.claims.map((claim) => [claim.id, claim]));

  expect(claims.get("CHAT-01.snapshot.runtime-client.deterministic")?.evidence[0]?.assertion).toBe(
    "the Snapshot Window carries no message window for any chat",
  );
  expect(
    evidence.claims
      .filter((claim) => claim.capabilityId === "TEST-02")
      .map((claim) => claim.variant)
      .sort(),
  ).toEqual([
    "connection",
    "contact",
    "conversation-sync",
    "group",
    "message",
    "presence",
    "update",
  ]);
  expect(claims.get("DATA-08.text.data-store.real-database")?.evidence[0]?.assertion).toBe(
    "[libSQL data] caller mutation cannot alter committed source or mirror values",
  );
});
