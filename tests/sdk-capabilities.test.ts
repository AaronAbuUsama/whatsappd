import { readFile } from "node:fs/promises";

import { expect, test } from "./_expect.ts";
import {
  findPublicSymbols,
  renderCapabilityCatalogue,
  validateCapabilityCatalogue,
} from "../scripts/sdk-capabilities.ts";

function catalogue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 3,
    audit: { whatsappdVersion: "0.2.2", baileysVersion: "7.0.0-rc14" },
    verification: {
      automatedTests: "available",
      liveWhatsApp: "not-run",
      browserReact: "not-run",
      openTui: "not-run",
    },
    interfaceDecision: {
      selected: "namespaces-plus-opened-conversation",
      namespaces: [{ name: "chats", scope: "list and open chats" }],
      example: ['await conversation.send.text("Hello");'],
    },
    publicExports: ["createSession"],
    capabilities: [
      {
        id: "MSG-OUT-01",
        domain: "messages",
        outcome: "Send text.",
        upstream: { status: "available", summary: "Baileys sends text." },
        current: { status: "implemented", summary: "The Session sends text." },
        target: "conversation.send.text",
        requirements: "Shipped low-level; friendly Client pending.",
      },
    ],
    backends: [],
    reactBindings: [],
    ...overrides,
  };
}

test("the catalogue accepts capability facts without an evidence graph", () => {
  expect(
    validateCapabilityCatalogue(catalogue(), {
      whatsappdVersion: "0.2.2",
      baileysVersion: "7.0.0-rc14",
      publicSymbols: ["createSession"],
    }),
  ).toEqual([]);

  expect(validateCapabilityCatalogue(catalogue({ observations: [] })).join("\n")).toContain(
    "catalogue: unexpected field observations",
  );
  expect(validateCapabilityCatalogue(catalogue({ implementations: [] })).join("\n")).toContain(
    "catalogue: unexpected field implementations",
  );
  expect(validateCapabilityCatalogue(catalogue({ variantMappings: [] })).join("\n")).toContain(
    "catalogue: unexpected field variantMappings",
  );
});

test("the catalogue rejects ambiguous status and export inventory", () => {
  const duplicate = (catalogue().capabilities as unknown[])[0];
  const errors = validateCapabilityCatalogue(
    catalogue({
      capabilities: [
        duplicate,
        duplicate,
        {
          id: "BAD-01",
          domain: "messages",
          outcome: "Guess.",
          upstream: { status: "probably", summary: "Guess." },
          current: { status: "works", summary: "Guess." },
          target: "unknown",
          requirements: "unknown",
        },
      ],
      publicExports: ["missingExport"],
    }),
    { publicSymbols: ["createSession"] },
  ).join("\n");

  expect(errors).toContain("MSG-OUT-01: duplicate capability id");
  expect(errors).toContain("BAD-01: unknown upstream.status probably");
  expect(errors).toContain("BAD-01: unknown current.status works");
  expect(errors).toContain("catalogue: missing public export createSession");
  expect(errors).toContain("catalogue: lists nonexistent public export missingExport");

  const matrixErrors = validateCapabilityCatalogue(
    catalogue({
      backends: [{}],
      reactBindings: [{ behavior: "state", shared: "hook", rendererOwned: "view", extra: "x" }],
    }),
  ).join("\n");
  expect(matrixErrors).toContain("backends[0] must contain every required non-empty string");
  expect(matrixErrors).toContain("reactBindings[0]: unexpected field extra");
});

test("the generated view separates the inventory from real-world verification", () => {
  const rendered = renderCapabilityCatalogue(catalogue());

  expect(rendered).toContain("Live WhatsApp account: **not run**");
  expect(rendered).toContain("Browser React: **not run**");
  expect(rendered).toContain("Automated tests do not establish real-account or rendered behavior.");
  expect(rendered).toContain("conversation.send.text");
  expect(rendered).not.toContain("Implementation slices");
  expect(rendered).not.toContain("Exact observations");
});

test("the checked-in catalogue is complete and generated without drift", async () => {
  const [catalogueText, rendered, rootSource, testingSource, packageText] = await Promise.all([
    readFile(new URL("../docs/sdk-capabilities.json", import.meta.url), "utf8"),
    readFile(new URL("../docs/sdk-capabilities.md", import.meta.url), "utf8"),
    readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/testing.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  const input = JSON.parse(catalogueText) as Record<string, unknown>;
  const packageJson = JSON.parse(packageText) as {
    version: string;
    dependencies: { baileys: string };
  };

  expect(
    validateCapabilityCatalogue(input, {
      whatsappdVersion: packageJson.version,
      baileysVersion: packageJson.dependencies.baileys,
      publicSymbols: findPublicSymbols(rootSource, testingSource),
    }),
  ).toEqual([]);
  expect((input.capabilities as unknown[]).length).toBe(167);
  expect((input.publicExports as unknown[]).length).toBe(106);
  const messagePersistence = (input.capabilities as Record<string, unknown>[]).find(
    ({ id }) => id === "DATA-08",
  ) as { current: { status: string; summary: string } };
  expect(messagePersistence.current).toEqual({
    status: "implemented",
    summary: "Current whatsappd implements this capability.",
  });
  const domainTombstones = (input.capabilities as Record<string, unknown>[]).find(
    ({ id }) => id === "DATA-09",
  ) as { current: { status: string; summary: string } };
  expect(domainTombstones.current.status).toBe("partial");
  expect(domainTombstones.current.summary).toContain("message revocation tombstones");
  expect(Object.keys(input).sort()).toEqual([
    "audit",
    "backends",
    "capabilities",
    "interfaceDecision",
    "publicExports",
    "reactBindings",
    "verification",
    "version",
  ]);
  expect(rendered).toBe(renderCapabilityCatalogue(input));
});
