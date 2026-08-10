import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertNoPrivateMaterial, stateLabFixtureSources } from "../tests/privacy-check.ts";

type Attachment = {
  readonly name: string;
  readonly contentType: string;
  readonly body?: string;
  readonly path?: string;
};
type Result = {
  readonly status: string;
  readonly attachments?: readonly Attachment[];
  readonly steps?: readonly { readonly title: string }[];
};
type Test = { readonly projectName: string; readonly results?: readonly Result[] };
type Spec = { readonly title: string; readonly tests?: readonly Test[] };
type Suite = { readonly suites?: readonly Suite[]; readonly specs?: readonly Spec[] };
type Run = {
  readonly id: string;
  readonly title: string;
  readonly project: string;
  readonly status: string;
  readonly features: readonly string[];
  readonly assertions: readonly string[];
  readonly screenshot: string;
  readonly video: string;
};
type SemanticProof = {
  readonly id: "WC-40" | "WC-41" | "WC-42";
  readonly rung: "P6";
  readonly status: "passed";
  readonly assertions: readonly string[];
};

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = path.resolve(webRoot, "../..");
const execFile = promisify(execFileCallback);
const evidence = path.join(repository, ".artifacts/evidence");
const media = path.join(evidence, "media");
const report = path.join(evidence, "index.html");
const results = JSON.parse(readFileSync(path.join(evidence, "results.json"), "utf8")) as Suite;
const contract = readFileSync(
  path.join(repository, "docs/architecture/web-client-feature-contract.md"),
  "utf8",
);

const specs: Spec[] = [];
const collect = (suite: Suite): void => {
  specs.push(...(suite.specs ?? []));
  for (const child of suite.suites ?? []) collect(child);
};
collect(results);

rmSync(media, { recursive: true, force: true });
mkdirSync(media, { recursive: true });
const slug = (value: string): string =>
  value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
const runs: Run[] = [];
for (const spec of specs)
  for (const test of spec.tests ?? [])
    for (const [attempt, result] of (test.results ?? []).entries()) {
      const id = slug(`${spec.title}-${test.projectName}-${attempt}`);
      const assertions = (result.steps ?? []).map(({ title }) => title);
      if (assertions.some((title) => !/^WC-\d+(?: WC-\d+)*:/u.test(title)))
        throw new Error(`${spec.title} has an assertion without a WC id`);
      const features = [
        ...new Set(`${spec.title}\n${assertions.join("\n")}`.match(/WC-\d+/gu) ?? []),
      ];
      const screenshotAttachment = result.attachments?.find(
        ({ contentType }) => contentType === "image/png",
      );
      const videoAttachment = result.attachments?.find(
        ({ contentType }) => contentType === "video/webm",
      );
      if (!screenshotAttachment?.body || !videoAttachment?.path)
        throw new Error(
          `${spec.title} ${test.projectName} is missing screenshot or video evidence`,
        );
      const screenshot = `media/${id}.png`;
      const video = `media/${id}.webm`;
      writeFileSync(
        path.join(evidence, screenshot),
        Buffer.from(screenshotAttachment.body, "base64"),
      );
      copyFileSync(videoAttachment.path, path.join(evidence, video));
      runs.push({
        id,
        title: spec.title,
        project: test.projectName,
        status: result.status,
        features,
        assertions,
        screenshot,
        video,
      });
    }

if (!runs.length || runs.some(({ status }) => status !== "passed"))
  throw new Error("Evidence report requires a non-empty all-passing browser run");

await execFile(
  process.execPath,
  [
    "--experimental-strip-types",
    path.join(repository, "packages/whatsappd/smoke/packed-consumer.ts"),
  ],
  { cwd: repository },
);
await execFile(
  process.execPath,
  [
    "--experimental-strip-types",
    path.join(repository, ".github/scripts/packed-renderer-examples.ts"),
    "--web",
  ],
  { cwd: repository },
);
await execFile("pnpm", ["--filter", "@whatsappd/docs", "registry:build"], {
  cwd: repository,
});
await execFile(
  process.execPath,
  [
    "--experimental-strip-types",
    "--test",
    "--test-name-pattern=canonical registry|hosted namespace|web items|web block",
    path.join(repository, "apps/docs/tests/registry.test.ts"),
  ],
  { cwd: repository },
);
const semanticProofs: readonly SemanticProof[] = [
  {
    id: "WC-40",
    rung: "P6",
    status: "passed",
    assertions: ["Web registry source matches the example and installs into a clean consumer"],
  },
  {
    id: "WC-41",
    rung: "P6",
    status: "passed",
    assertions: ["Packed @whatsappd/react stays renderer-neutral and drives the web example"],
  },
  {
    id: "WC-42",
    rung: "P6",
    status: "passed",
    assertions: ["Packed packages and registry source pass clean-consumer proofs"],
  },
];
writeFileSync(
  path.join(evidence, "semantic-results.json"),
  `${JSON.stringify(semanticProofs, undefined, 2)}\n`,
);

const features = [...contract.matchAll(/^### (WC-\d+) — (.+)$/gmu)].map((match) => ({
  id: match[1]!,
  title: match[2]!,
}));
if (!features.length) throw new Error("No WC features found in the source contract");

const escape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const featureIndex = features
  .map((feature) => {
    const evidenceRuns = runs.filter(({ features: ids }) => ids.includes(feature.id));
    const semanticProof = semanticProofs.find(({ id }) => id === feature.id);
    const passed = evidenceRuns.length > 0 || semanticProof !== undefined;
    return `<article id="${feature.id.toLowerCase()}">
      <h2>${feature.id} — ${escape(feature.title)}</h2>
      <p class="${passed ? "passed" : "pending"}">${evidenceRuns.length ? "P5 browser evidence recorded" : semanticProof ? "P6 semantic proof recorded" : "Evidence pending"}</p>
      ${
        evidenceRuns.length
          ? `<ul>${evidenceRuns.map((run) => `<li><a href="#${run.id}">${escape(run.project)} — ${escape(run.title)}</a></li>`).join("")}</ul>`
          : semanticProof
            ? `<ul>${semanticProof.assertions.map((assertion) => `<li>${escape(assertion)}</li>`).join("")}</ul>`
            : "<p>No browser assertion has been recorded for this feature yet.</p>"
      }
    </article>`;
  })
  .join("");
const runIndex = runs
  .map(
    (run) => `<article id="${run.id}" class="run">
      <h2>${escape(run.project)} — ${escape(run.title)}</h2>
      <p class="passed">Passed</p>
      <ul>${run.assertions.map((assertion) => `<li>${escape(assertion)}</li>`).join("")}</ul>
      <a href="./${run.screenshot}"><img src="./${run.screenshot}" alt="${escape(run.title)} ${escape(run.project)} screenshot" loading="lazy" /></a>
      <video controls preload="metadata" src="./${run.video}"></video>
    </article>`,
  )
  .join("");
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>whatsappd web client evidence</title><style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#0b141a;color:#e9edef}body{margin:0}main{width:min(1100px,calc(100% - 32px));margin:32px auto 80px}nav{display:flex;gap:12px;flex-wrap:wrap}a{color:#53bdeb}section{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin-block:24px}article{border:1px solid #283842;border-radius:12px;background:#111b21;padding:16px;min-width:0}h1{font-size:clamp(28px,5vw,46px)}h2{font-size:16px}.passed{color:#25d366}.pending{color:#f4b860}.run{grid-column:1/-1}.run img,.run video{display:block;width:100%;max-height:620px;object-fit:contain;background:#05090c;margin-top:12px}code{background:#202c33;padding:2px 5px;border-radius:4px}
</style></head><body><main>
<p>PRIVATE LOCAL ARTIFACT · INVENTED STATE-LAB DATA ONLY</p><h1>whatsappd web client evidence</h1>
<p>${runs.length} browser runs passed across fixed desktop, tablet, and mobile viewports. Every feature is indexed honestly; pending means no P5 claim.</p>
<nav><a href="./report/index.html">Playwright report</a><a href="#runs">Recorded runs</a></nav>
<section aria-label="WC evidence index">${featureIndex}</section>
<h1 id="runs">Recorded runs</h1><section>${runIndex}</section>
</main></body></html>`;

const fixture = stateLabFixtureSources(pathToFileURL(`${webRoot}/`));
assertNoPrivateMaterial(fixture.source, "state-lab repository fixtures");
assertNoPrivateMaterial(
  JSON.stringify(runs.map(({ screenshot: _screenshot, video: _video, ...run }) => run)),
  "evidence metadata",
);
assertNoPrivateMaterial(JSON.stringify(semanticProofs), "semantic evidence metadata");
assertNoPrivateMaterial(html, "evidence HTML");
writeFileSync(report, html);
console.log(
  `evidence-report: ${runs.length}/${runs.length} browser runs and ${semanticProofs.length}/${semanticProofs.length} semantic proofs passed; ${features.length} WC ids indexed; privacy scan passed`,
);
