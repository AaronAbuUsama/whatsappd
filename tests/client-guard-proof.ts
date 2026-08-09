import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestWhatsAppSession } from "../packages/whatsappd/src/testing.ts";
import {
  captureClientGuardProofRunStart,
  writeClientGuardProofReceipt,
} from "./client-proof-receipt.ts";
import { guardedSender, resolveAllowlistedTargetForTest, SendRefusedError } from "./send-guard.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function digits(length: number): string {
  return Array.from(randomBytes(length), (byte) => String(byte % 10)).join("");
}

function generatedChatId(): string {
  return `${digits(15)}@s.whatsapp.net`;
}

async function run(): Promise<void> {
  const runStart = captureClientGuardProofRunStart(root);
  const directory = await mkdtemp(path.join(os.tmpdir(), "whatsappd-client-guard-proof-"));
  const allowlistPath = path.join(directory, "send-allowlist.json");
  const listedTarget = generatedChatId();
  const unlistedTarget = generatedChatId();
  const messageCanary = randomBytes(18).toString("hex");

  try {
    await writeFile(allowlistPath, JSON.stringify({ chats: [listedTarget] }), "utf8");
    const driver = createTestWhatsAppSession();
    let refusal: SendRefusedError | undefined;
    try {
      const target = resolveAllowlistedTargetForTest(unlistedTarget, allowlistPath);
      await guardedSender(driver.session).send(target, { text: messageCanary });
    } catch (error) {
      if (error instanceof SendRefusedError) refusal = error;
      else throw error;
    }
    if (refusal?.reason !== "target_not_allowlisted") {
      throw new Error("the generated unlisted target did not produce the expected refusal");
    }

    const receipt = writeClientGuardProofReceipt(root, {
      runStart,
      finalizedAt: new Date().toISOString(),
      knownValues: [unlistedTarget, listedTarget, messageCanary],
      guard: {
        targetSha256: createHash("sha256").update(unlistedTarget).digest("hex"),
        targetLength: unlistedTarget.length,
        refusalReason: refusal.reason,
        sessionSendInvocations: driver.commands.sent.length,
      },
    });
    process.stdout.write(
      `${JSON.stringify({
        receipt: path.relative(root, receipt.file),
        refusalReason: refusal.reason,
        sessionSendInvocations: driver.commands.sent.length,
        patternHits: receipt.scan.patternHits,
        knownValueHits: receipt.scan.knownValueHits,
        nonEmpty: receipt.scan.nonEmpty,
      })}\n`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await run();
}
