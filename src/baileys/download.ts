/**
 * Media download-handle factory. Bytes never sit in the event stream — each
 * inbound media message carries a `download()` thunk that fetches and decrypts
 * on demand. The thunk closes over the live socket so expired media is
 * transparently re-uploaded via `updateMediaMessage` (the only way to recover a
 * stale `directPath`). This is the one impure piece; the inbound mapper stays
 * pure and just receives the factory.
 */
import { downloadMediaMessage, type WAMessage, type WASocket } from "baileys";
import type { Logger } from "pino";

/** A no-arg fetch-and-decrypt-now. */
export type DownloadThunk = () => Promise<Buffer>;

/** Given the live socket, produce a per-message download-thunk factory. */
export function mediaDownloader(sock: WASocket, logger: Logger): (raw: WAMessage) => DownloadThunk {
  return (raw) => () =>
    downloadMediaMessage(raw, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
}

/** Default when no socket is wired (pure tests): the handle exists but won't fetch. */
export const noDownloader = (_raw: WAMessage): DownloadThunk => {
  return () => Promise.reject(new Error("no downloader bound to this message"));
};
