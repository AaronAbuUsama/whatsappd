import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  access,
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { humanUiContext } from "agentic-tui-kit";
import { createWhatsAppTuiHarness } from "./app.tsx";
import { createFixtureApplication } from "./fixture.ts";

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const arguments_ = process.argv.slice(2).filter((value) => value !== "--");
const finalize = arguments_[0] === "--finalize";
const output = resolve(arguments_[finalize ? 1 : 0] ?? join(".artifacts", "opentui", timestamp));
const inspector = finalize ? arguments_[2] : undefined;
if (finalize && !inspector) {
  throw new Error("Finalization requires the inspector name after the evidence directory");
}
const temporary = await mkdtemp(join(tmpdir(), "whatsappd-agentic-tui-evidence-"));
const artifactNames = [
  "desktop.png",
  "desktop.txt",
  "narrow.png",
  "narrow.txt",
  "journey.mp4",
  "actions.jsonl",
] as const;

const ensureFfmpeg = async (): Promise<void> => {
  const bun = (globalThis as { Bun?: { which(name: string): string | null } }).Bun;
  if (bun?.which("ffmpeg")) return;
  const candidates = ["/opt/homebrew/opt/ffmpeg/bin/ffmpeg", "/usr/local/opt/ffmpeg/bin/ffmpeg"];
  const executable = await Promise.any(
    candidates.map(async (candidate) => (await access(candidate), candidate)),
  ).catch(() => {
    throw new Error("ffmpeg is required for Kit PNG/MP4 evidence capture");
  });
  if (process.env.WHATSAPPD_EVIDENCE_RESTARTED) {
    throw new Error(`Bun could not resolve ffmpeg at ${executable}`);
  }
  execFileSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: `${dirname(executable)}:${process.env.PATH ?? ""}`,
      WHATSAPPD_EVIDENCE_RESTARTED: "1",
    },
  });
  process.exit(0);
};

const revision = (() => {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
  return dirty ? `${head}-dirty` : head;
})();

try {
  const { driveHeadlessTui, writeEvidencePack } = await import("agentic-tui-kit/testing");
  if (finalize) {
    for (const name of artifactNames) await copyFile(join(output, name), join(temporary, name));
    const journey = JSON.parse(await readFile(join(output, "journey.raw.json"), "utf8"));
    const capturedRevision = (await readFile(join(output, "revision.txt"), "utf8")).trim();
    const finalOutput = join(output, "final");
    const inspected = (notes: string) => ({ by: inspector as string, notes });
    await writeEvidencePack({
      directory: finalOutput,
      revision: capturedRevision,
      journey,
      claims: [
        {
          id: "AT-DESKTOP",
          description:
            "Desktop WhatsApp state, transcript, typed actions, and Kit-owned workbench are visible and executable.",
          artifacts: [
            { name: "desktop.txt", path: join(temporary, "desktop.txt"), kind: "screen" },
            { name: "actions.jsonl", path: join(temporary, "actions.jsonl"), kind: "actions" },
            {
              name: "desktop.png",
              path: join(temporary, "desktop.png"),
              kind: "image",
              inspected: inspected(
                "Desktop layout, transcript, operation state, and composer checked.",
              ),
            },
            {
              name: "journey.mp4",
              path: join(temporary, "journey.mp4"),
              kind: "video",
              inspected: inspected("Recorded section and typed-action journey checked."),
            },
          ],
        },
        {
          id: "AT-NARROW",
          description:
            "Narrow layout begins as a chat list and opens the conversation through keyboard navigation.",
          artifacts: [
            { name: "narrow.txt", path: join(temporary, "narrow.txt"), kind: "screen" },
            {
              name: "narrow.png",
              path: join(temporary, "narrow.png"),
              kind: "image",
              inspected: inspected(
                "Narrow conversation layout and absence of horizontal clipping checked.",
              ),
            },
          ],
        },
      ],
    });

    const html = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>whatsappd Agentic TUI evidence</title>
<style>body{font:16px system-ui;background:#0b141a;color:#e9edef;max-width:1200px;margin:auto;padding:2rem}img,video{max-width:100%;border:1px solid #2a3942;margin-bottom:2rem}a{color:#53bdeb}code{background:#202c33;padding:.2rem}</style>
<h1>whatsappd Agentic TUI evidence</h1>
<p>Revision <code>${capturedRevision}</code>. Deterministic fixture only; privacy scan passed. Inspected by ${inspector}.</p>
<h2>Desktop</h2><img src="desktop.png" alt="Desktop Agentic TUI"><video controls src="journey.mp4"></video>
<h2>Narrow</h2><img src="narrow.png" alt="Narrow Agentic TUI">
<p><a href="report.json">Evidence report</a> · <a href="desktop.txt">Desktop screen</a> · <a href="narrow.txt">Narrow screen</a> · <a href="actions.jsonl">Action history</a></p>`;
    await writeFile(join(finalOutput, "index.html"), html);
    const htmlHash = createHash("sha256").update(html).digest("hex");
    await appendFile(join(finalOutput, "checksums.sha256"), `${htmlHash}  index.html\n`);
    for (const name of artifactNames) await rm(join(output, name));
    await rm(join(output, "journey.raw.json"));
    await rm(join(output, "revision.txt"));
    console.log(finalOutput);
    await rm(temporary, { recursive: true, force: true });
    process.exit(0);
  }

  await ensureFfmpeg();
  const desktopFixture = createFixtureApplication();
  const desktopApp = createWhatsAppTuiHarness(desktopFixture.application);
  const desktop = await driveHeadlessTui(desktopApp.definition, {
    viewport: { width: 120, height: 38 },
    name: "WhatsApp feature-compatible desktop state lab",
  });
  await desktop.expect.text("outcome_unknown");
  await desktop.screenshot(join(temporary, "desktop.png"));
  await desktop.invoke(desktopApp.actions.setSection, { section: "groups" }, humanUiContext);
  await desktop.expect.text("Unknown roster");
  await desktop.invoke(desktopApp.actions.setSection, { section: "contacts" }, humanUiContext);
  await desktop.expect.text("avatar");
  await desktop.invoke(desktopApp.actions.setSection, { section: "chats" }, humanUiContext);
  await desktop.invoke(
    desktopApp.actions.submit,
    { input: "fixture durable send" },
    humanUiContext,
  );
  await desktop.invoke(
    desktopApp.actions.messageAction,
    { kind: "history", count: 50 },
    humanUiContext,
  );
  await writeFile(join(temporary, "desktop.txt"), `${await desktop.screen()}\n`);
  await writeFile(
    join(temporary, "actions.jsonl"),
    `${desktop.runtime.actions
      .invocations()
      .map((invocation) => JSON.stringify(invocation))
      .join("\n")}\n`,
  );
  await desktop.recording(join(temporary, "journey.mp4"));
  const journey = desktop.record();
  await desktop.finish();

  const narrowFixture = createFixtureApplication();
  const narrowApp = createWhatsAppTuiHarness(narrowFixture.application);
  const narrow = await driveHeadlessTui(narrowApp.definition, {
    viewport: { width: 58, height: 24 },
    name: "WhatsApp feature-compatible narrow state lab",
  });
  await narrow.expect.text("TST");
  await narrow.expect.absent("WhatsApp state lab");
  await narrow.key("enter");
  await narrow.expect.text("WhatsApp state lab");
  await narrow.screenshot(join(temporary, "narrow.png"));
  await writeFile(join(temporary, "narrow.txt"), `${await narrow.screen()}\n`);
  await narrow.finish();

  const privacyInput = await Promise.all(
    ["desktop.txt", "narrow.txt", "actions.jsonl"].map((name) =>
      readFile(join(temporary, name), "utf8"),
    ),
  );
  if (/@s\.whatsapp\.net|@g\.us|SECRET-|BEGIN PRIVATE KEY|Noise_/.test(privacyInput.join("\n"))) {
    throw new Error("evidence privacy scan rejected a real-account or credential-shaped value");
  }

  await mkdir(output, { recursive: true });
  for (const name of artifactNames) await copyFile(join(temporary, name), join(output, name));
  await writeFile(join(output, "journey.raw.json"), `${JSON.stringify(journey)}\n`);
  await writeFile(join(output, "revision.txt"), `${revision}\n`);
  console.log(
    `${output}\nInspect the PNG and MP4, then run evidence:finalize with this directory.`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
