import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import ffmpegPath from "ffmpeg-static";

const execute = promisify(execFile);

export type StagedVoiceNote = {
  readonly source: AsyncIterable<Uint8Array>;
  cleanup(): Promise<void>;
};

export async function transcodeVoiceNote(
  source: AsyncIterable<Uint8Array>,
): Promise<StagedVoiceNote> {
  if (!ffmpegPath) throw new Error("The voice-note converter is unavailable on this platform");
  const directory = await mkdtemp(join(tmpdir(), "whatsappd-voice-note-"));
  const input = join(directory, "input");
  const output = join(directory, "voice-note.ogg");
  try {
    await pipeline(Readable.from(source), createWriteStream(input, { flags: "wx" }));
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
        output,
      ],
      { maxBuffer: 64 * 1024 },
    );
    return {
      source: createReadStream(output),
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
