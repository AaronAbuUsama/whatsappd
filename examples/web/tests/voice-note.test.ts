import assert from "node:assert/strict";
import test from "node:test";
import { transcodeVoiceNote } from "../src/lib/voice-note.server.ts";

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

void test("browser recordings become Ogg Opus voice notes", async () => {
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
