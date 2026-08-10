import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import ffmpegPath from "ffmpeg-static";

const execute = promisify(execFile);
export const VOICE_NOTE_INPUT_LIMIT_BYTES = 32 * 1024 * 1024;
const VOICE_NOTE_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const VOICE_NOTE_DURATION_LIMIT_SECONDS = 5 * 60;
const VOICE_NOTE_CONVERSION_TIMEOUT_MS = 60_000;

export type StagedVoiceNote = {
  readonly source: AsyncIterable<Uint8Array>;
  cleanup(): Promise<void>;
};

async function* boundedInput(source: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  let length = 0;
  for await (const chunk of source) {
    length += chunk.byteLength;
    if (length > VOICE_NOTE_INPUT_LIMIT_BYTES) throw new RangeError("Voice note is too large");
    yield chunk;
  }
}

export async function transcodeVoiceNote(
  source: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<StagedVoiceNote> {
  if (!ffmpegPath) throw new Error("The voice-note converter is unavailable on this platform");
  const directory = await mkdtemp(join(tmpdir(), "whatsappd-voice-note-"));
  const input = join(directory, "input");
  const output = join(directory, "voice-note.ogg");
  try {
    await pipeline(Readable.from(boundedInput(source)), createWriteStream(input, { flags: "wx" }), {
      signal,
    });
    await execute(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        input,
        "-vn",
        "-ac",
        "1",
        "-c:a",
        "libopus",
        "-application",
        "voip",
        "-b:a",
        "32k",
        "-t",
        String(VOICE_NOTE_DURATION_LIMIT_SECONDS),
        "-fs",
        String(VOICE_NOTE_OUTPUT_LIMIT_BYTES),
        output,
      ],
      { maxBuffer: 64 * 1024, signal, timeout: VOICE_NOTE_CONVERSION_TIMEOUT_MS },
    );
    if ((await stat(output)).size > VOICE_NOTE_OUTPUT_LIMIT_BYTES)
      throw new RangeError("Converted voice note is too large");
    return {
      source: createReadStream(output),
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
