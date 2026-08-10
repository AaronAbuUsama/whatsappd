import assert from "node:assert/strict";
import test from "node:test";
import { createWhatsAppClient, createWhatsAppRuntime, memoryBackend } from "whatsappd";
import { createTestWhatsAppSession, textMessage } from "whatsappd/testing";
import { createWhatsAppApplication } from "../src/lib/whatsapp-application.ts";
import { transcodeVoiceNote, VOICE_NOTE_INPUT_LIMIT_BYTES } from "../src/lib/voice-note.server.ts";

function silentWav(): Uint8Array {
  const samples = 8_000;
  const value = Buffer.alloc(44 + samples * 2);
  value.write("RIFF", 0);
  value.writeUInt32LE(value.length - 8, 4);
  value.write("WAVEfmt ", 8);
  value.writeUInt32LE(16, 16);
  value.writeUInt16LE(1, 20);
  value.writeUInt16LE(1, 22);
  value.writeUInt32LE(8_000, 24);
  value.writeUInt32LE(16_000, 28);
  value.writeUInt16LE(2, 32);
  value.writeUInt16LE(16, 34);
  value.write("data", 36);
  value.writeUInt32LE(samples * 2, 40);
  return value;
}

async function waitForSend(values: readonly unknown[]): Promise<void> {
  await Promise.race([
    (async () => {
      while (values.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    })(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Timed out waiting for the voice-note send")), 1_000),
    ),
  ]);
}

void test("recorded audio becomes an Ogg Opus voice note", async () => {
  const voice = await transcodeVoiceNote(
    (async function* () {
      yield silentWav();
    })(),
  );
  try {
    const chunks: Uint8Array[] = [];
    for await (const chunk of voice.source) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).subarray(0, 4).toString(), "OggS");
  } finally {
    await voice.cleanup();
  }
});

void test("converted recordings cross the public Client as accepted PTT audio", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "voice-browser",
    backend,
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  const application = createWhatsAppApplication({
    accountId: "voice-browser",
    client,
    media: backend.media,
  });
  const voice = await transcodeVoiceNote(
    (async function* () {
      yield silentWav();
    })(),
  );
  try {
    await driver.emit({ type: "connection", status: { phase: "online" } });
    await driver.emit({
      type: "message",
      message: textMessage({
        id: "fixture-message",
        chatId: "fixture-peer",
        text: "Fixture",
        timestamp: 1,
      }),
    });
    const chat = (await application.state()).chats[0]?.key;
    assert.ok(chat);
    const result = await application.command({
      type: "send_audio",
      chat,
      source: voice.source,
      ptt: true,
      mimetype: "audio/ogg; codecs=opus",
    });
    assert.equal(result.type, "operation");
    await waitForSend(driver.commands.sent);
    const sent = driver.commands.sent[0]?.content;
    assert.ok(sent && "audio" in sent);
    assert.equal(sent.ptt, true);
    assert.equal(sent.mimetype, "audio/ogg; codecs=opus");
  } finally {
    await voice.cleanup();
    await application.close();
    await client.close();
    await runtime.stop();
  }
});

void test("an aborted conversion rejects without publishing a voice note", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    transcodeVoiceNote(
      (async function* () {
        yield silentWav();
      })(),
      controller.signal,
    ),
    { name: "AbortError" },
  );
});

void test("voice-note conversion rejects input beyond its hard byte bound", async () => {
  const chunk = new Uint8Array(1024 * 1024);
  await assert.rejects(
    transcodeVoiceNote(
      (async function* () {
        for (let length = 0; length <= VOICE_NOTE_INPUT_LIMIT_BYTES; length += chunk.byteLength)
          yield chunk;
      })(),
    ),
    { name: "RangeError", message: "Voice note is too large" },
  );
});
