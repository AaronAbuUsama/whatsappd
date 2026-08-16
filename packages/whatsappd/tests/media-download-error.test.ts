/**
 * The classifier is unit-tested in `errors.test.ts`. This file proves the other
 * half: that the download thunk actually routes through it, so no Baileys `Boom`
 * — and therefore no signed CDN url — reaches a consumer.
 *
 * `mock.module` is the only seam available. `downloadMediaMessage` is imported
 * by name inside `src/baileys/download.ts`, so the specifier has to be replaced
 * before that module is first loaded — hence the dynamic import below.
 */
import { mock } from "node:test";
import pino from "pino";
import type { WAMessage, WASocket } from "baileys";
import { expect, test } from "./_expect.ts";

let nextFailure: unknown;
const baileys = await import("baileys");

mock.module("baileys", {
  namedExports: {
    ...baileys,
    downloadMediaMessage: async (): Promise<Buffer> => {
      throw nextFailure;
    },
  },
});

// Both imports must follow the mock: anything that pulls in `src/baileys/`
// eagerly would bind the real `downloadMediaMessage` first and win the cache.
const { mediaDownloader } = await import("../src/baileys/download.ts");
const { MediaDownloadError } = await import("../src/errors.ts");
type MediaDownloadError = InstanceType<typeof MediaDownloadError>;

const CDN_URL = "https://mmg.whatsapp.net/d/f/SIGNED-TOKEN.enc";
const socket = { updateMediaMessage: async () => ({}) } as unknown as WASocket;
const raw = {} as WAMessage;

const downloadFailure = async (failure: unknown): Promise<MediaDownloadError> => {
  nextFailure = failure;
  const download = mediaDownloader(socket, pino({ level: "silent" }))(raw);
  try {
    await download();
  } catch (error) {
    return error as MediaDownloadError;
  }
  throw new Error("expected the download to reject");
};

test("a failed download rejects with a classified error, not the upstream Boom", async () => {
  const error = await downloadFailure({
    message: `Failed to fetch stream from ${CDN_URL}`,
    output: { statusCode: 429 },
    data: { url: CDN_URL },
  });

  expect(error instanceof MediaDownloadError).toBe(true);
  expect(error.reason).toBe("throttled");
  expect(error.statusCode).toBe(429);
  expect(error.retryable).toBe(true);
  expect(error.message).not.toContain("mmg.whatsapp.net");
});

test("expired media is distinguishable from a throttle at the download seam", async () => {
  const expired = await downloadFailure({ output: { statusCode: 410 }, data: { url: CDN_URL } });
  expect(expired.reason).toBe("expired");
  expect(expired.retryable).toBe(false);
});

test("a decryption failure carries no status and is not retryable", async () => {
  const undecryptable = await downloadFailure(new Error("Invalid media key"));
  expect(undecryptable.reason).toBe("unknown");
  expect(undecryptable.statusCode).toBe(undefined);
  expect(undecryptable.retryable).toBe(false);
  expect(undecryptable.message).not.toContain("Invalid media key");
});
