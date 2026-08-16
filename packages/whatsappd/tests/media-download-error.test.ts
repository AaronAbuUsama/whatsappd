/**
 * The classifier is unit-tested in `errors.test.ts`. This file proves the other
 * half: that the download thunk actually routes through it, so no Baileys `Boom`
 * — and therefore no signed CDN url — reaches a consumer.
 *
 * The failing fetch is injected rather than module-mocked. `mock.module` works
 * on Node 24 and takes the whole file down on Node 22, and an experimental API
 * is a poor thing to owe a version matrix for when the module can just accept a
 * replaceable protocol constructor, as `openSocketWith` already does.
 */
import type { downloadMediaMessage, WAMessage, WASocket } from "baileys";
import pino from "pino";
import { expect, test } from "./_expect.ts";
import { MediaDownloadError } from "../src/index.ts";
import { mediaDownloader } from "../src/baileys/download.ts";

const CDN_URL = "https://mmg.whatsapp.net/d/f/SIGNED-TOKEN.enc";
const socket = { updateMediaMessage: async () => ({}) } as unknown as WASocket;
const raw = {} as WAMessage;
const logger = pino({ level: "silent" });

const downloadFailure = async (failure: unknown): Promise<MediaDownloadError> => {
  const fetch = (() => {
    throw failure;
  }) as unknown as typeof downloadMediaMessage;
  const download = mediaDownloader(socket, logger, fetch)(raw);
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
  expect(JSON.stringify(error)).not.toContain("mmg.whatsapp.net");
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

test("a successful download is handed back untouched", async () => {
  const bytes = Buffer.from("media");
  const fetch = (async () => bytes) as unknown as typeof downloadMediaMessage;
  const download = mediaDownloader(socket, logger, fetch)(raw);
  expect(await download()).toBe(bytes);
});
