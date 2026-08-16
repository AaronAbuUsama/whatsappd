/**
 * Media download-handle factory. Bytes never sit in the event payload — each
 * inbound media message carries a `download()` thunk that fetches and decrypts
 * on demand. The thunk closes over the live socket so expired media is
 * transparently re-uploaded via `updateMediaMessage` (the only way to recover a
 * stale `directPath`). This is the one impure piece; the inbound mapper stays
 * pure and just receives the factory.
 */
import { downloadMediaMessage, type WAMessage, type WASocket } from "baileys";
import type { Logger } from "pino";
import { classifyMediaDownload } from "../errors.ts";

/** A no-arg fetch-and-decrypt-now. */
export type DownloadThunk = () => Promise<Buffer>;

/**
 * Given the live socket, produce a per-message download-thunk factory.
 *
 * `fetch` is the replaceable protocol constructor, same seam as
 * `openSocketWith` — the conversion below is only worth having if a test can
 * make the real thing fail.
 */
export function mediaDownloader(
  sock: WASocket,
  logger: Logger,
  fetch: typeof downloadMediaMessage = downloadMediaMessage,
): (raw: WAMessage) => DownloadThunk {
  return (raw) => async () => {
    try {
      return await fetch(raw, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
    } catch (error) {
      // The status only exists on the Boom, and the Boom is the one thing that
      // must not leave this directory — it carries the signed CDN URL.
      throw classifyMediaDownload(error);
    }
  };
}

/** Default when no socket is wired (pure tests): the handle exists but won't fetch. */
export const noDownloader = (_raw: WAMessage): DownloadThunk => {
  return () => Promise.reject(new Error("no downloader bound to this message"));
};
