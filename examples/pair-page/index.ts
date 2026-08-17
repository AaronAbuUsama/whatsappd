/**
 * Pair an account in a browser, and watch the first sync arrive.
 *
 * The counterpart to `examples/qr-cli`, which prints a QR and stops talking. A
 * first sync takes minutes, so this serves one self-refreshing screen over
 * `node:http` on 127.0.0.1 and pushes every change with SSE — status, live
 * counts, and which kinds of history WhatsApp is sending. A static page cannot
 * be told anything, which is the whole defect it exists to fix.
 *
 * It reads. There is no `send`, `markRead`, or `setTyping` call anywhere in
 * this example, so it cannot message anyone whatever it is pointed at.
 *
 *   pnpm example:pair                  pair into ./examples/pair-page/.account
 *   pnpm example:pair --home=/tmp/x    pair into a scratch directory instead
 *   pnpm example:pair --demo           cycle every state with no socket
 *   pnpm example:pair --summary=out.json   write sanitized counts on exit
 *
 * `--demo` is the useful one while editing the screen: it walks every status
 * this page can render, including the failures, without touching WhatsApp.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import qrcode from "qrcode-terminal";
import { page, qrPath } from "./page.ts";
import {
  createSession,
  qrAuth,
  type ConversationSyncSource,
  type FaultReason,
  type Status,
} from "../../packages/whatsappd/src/index.ts";
import { libsqlStore } from "../../packages/whatsappd/src/stores/libsql.ts";

// `qrcode-terminal` only prints ASCII; its vendored encoder is what exposes the
// module matrix, and a matrix is all an SVG QR needs. Reached through
// `createRequire` because the vendor directory ships CommonJS with no types.
const req = createRequire(import.meta.url);
const QR = req("qrcode-terminal/vendor/QRCode") as new (
  type: number,
  errorCorrectLevel: number,
) => {
  addData(s: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(r: number, c: number): boolean;
};
const ECL = req("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel") as { L: number };

const arg = (n: string): string | undefined =>
  process.argv
    .find((a) => a.startsWith(`--${n}=`))
    ?.split("=")
    .slice(1)
    .join("=");
const DEMO = process.argv.includes("--demo");
const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = arg("home") ?? join(HERE, ".account");
const SUMMARY = arg("summary");
const started = Date.now();
const say = (m: string): void => {
  const s = Math.floor((Date.now() - started) / 1000);
  console.log(
    `[${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}] ${m}`,
  );
};
mkdirSync(HOME, { recursive: true });

// ── the state the screen renders ─────────────────────────────────────────────
/** Which kinds of history arrived, and how much. The counts the screen shows. */
const kinds: Record<ConversationSyncSource, number> = {
  initial_bootstrap: 0,
  recent: 0,
  full: 0,
  on_demand: 0,
  unknown: 0,
};

interface View {
  view: "wait" | "qr" | "sheet";
  title: string;
  label: string;
  detail: string;
  icon: "scan" | "wait" | "done" | "stop";
  tone: "working" | "ok" | "stop";
  qr: { d: string; n: number; expiresAt: number; lifetime: number } | null;
  kinds: Record<ConversationSyncSource, number>;
  /** When the last history batch arrived. The page turns this into "quiet for N". */
  lastBatchAt: number;
  chats: number;
  chatsTotal: number;
  messages: number;
  oldest: number | null;
}
let state: View = {
  view: "wait",
  title: "Link WhatsApp",
  label: "Starting up",
  detail: "",
  icon: "wait",
  tone: "working",
  qr: null,
  kinds: { ...kinds },
  lastBatchAt: 0,
  chats: 0,
  chatsTotal: 0,
  messages: 0,
  oldest: null,
};

const clients = new Set<{ write(c: string): void }>();
function push(next: Partial<View>): void {
  state = { ...state, ...next };
  const frame = `data: ${JSON.stringify(state)}\n\n`;
  for (const c of clients) c.write(frame);
}

/** Encode a payload once; the page draws it as one path. */
function encode(payload: string, expiresAt: number): View["qr"] {
  const q = new QR(-1, ECL.L);
  q.addData(payload);
  q.make();
  const n = q.getModuleCount();
  return {
    d: qrPath((r, c) => q.isDark(r, c), n),
    n,
    expiresAt,
    lifetime: Math.max(1, expiresAt - Date.now()),
  };
}

/** The terminal and qr.txt fallbacks — a QR in a piped log is unscannable. */
function alsoToTerminal(payload: string): void {
  if (process.stdout.isTTY) qrcode.generate(payload, { small: true });
  const ascii: string[] = [];
  qrcode.generate(payload, { small: true }, (art: string) => ascii.push(art));
  writeFileSync(join(HERE, "qr.txt"), ascii.join("\n"), "utf8");
}

// ── server ───────────────────────────────────────────────────────────────────
const server = createServer((req, res) => {
  if (req.url === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify(state)}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page(JSON.stringify(state)));
});

server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/`;
  say(`screen: ${url}`);
  spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  if (DEMO) void demo();
  else live();
});

/**
 * Fault reasons are enum values, not sentences. Putting `logged_out_remote.` on
 * a screen names the code path rather than the problem; a person needs to know
 * what happened and whether to do anything.
 *
 * Typed as a total `Record<FaultReason, string>` on purpose. A partial map is
 * how this drifts: whatsappd adding a reason would silently fall through to the
 * generic wording, and the cases that most need a sentence are exactly the
 * terminal ones nobody sees while developing. Total, it fails the type-check
 * instead — the compiler is the reminder.
 */
const REASON: Record<FaultReason, string> = {
  restart_required: "WhatsApp asked the connection to restart.",
  connection_lost: "The connection dropped.",
  timed_out: "The connection timed out.",
  service_unavailable: "WhatsApp is unreachable right now.",
  logged_out_remote: "This device was unlinked from WhatsApp on your phone.",
  connection_replaced: "Another session took over this device link.",
  credentials_invalid: "WhatsApp refused the account.",
  multidevice_mismatch: "WhatsApp rejected this device link.",
  bad_session: "The saved credential is no longer valid.",
  pairing_rejected: "WhatsApp rejected the pairing attempt.",
  intentional: "The connection was closed on purpose.",
  unknown: "The connection failed for an unrecognised reason.",
};

const humanReason = (reason: FaultReason): string => REASON[reason];

// ── the mapping: every screen state is a value whatsappd already publishes ───
function onStatus(status: Status): void {
  switch (status.phase) {
    case "connecting":
      return push({
        view: "wait",
        label: "Connecting to WhatsApp",
        detail: "",
        icon: "wait",
        tone: "working",
        qr: null,
      });

    case "pairing": {
      if (status.pairing.step === "challenge_live") {
        const payload = status.pairing.qr;
        if (!payload) return;
        alsoToTerminal(payload);
        return push({
          view: "qr",
          label: "Scan with your phone",
          icon: "scan",
          tone: "working",
          detail: "The code refreshes on its own. You don't need to reload.",
          qr: encode(payload, status.pairing.expiresAt),
        });
      }
      if (status.pairing.step === "restart_pending")
        return push({
          view: "wait",
          label: "Scanned — linking your account",
          detail: "",
          icon: "wait",
          tone: "working",
          qr: null,
        });
      return push({
        view: "wait",
        label: "Waiting for a code",
        detail: "",
        icon: "wait",
        tone: "working",
      });
    }

    case "authenticated":
      return push({
        view: "sheet",
        title: "Syncing your account",
        icon: "wait",
        tone: "working",
        qr: null,
        label: status.sync.step === "draining" ? "Authenticating" : "Pulling your history",
        detail:
          status.sync.step === "syncing" && status.sync.progress !== undefined
            ? `${Math.round(status.sync.progress)}% of the first pass`
            : "This takes a while the first time.",
      });

    case "online":
      return push({
        view: "sheet",
        title: "Syncing your account",
        label: "Linked — history still arriving",
        icon: "done",
        tone: "ok",
        // Deliberately not "done". The RECENT phase completing is what puts the
        // session online; FULL batches keep coming afterwards and nothing marks
        // the last of them. The quiet line below reports the only fact there is.
        detail: "Leave this open — later batches still arrive after this point.",
        qr: null,
      });

    case "backing_off":
      // Not an error, and not a hang — the state that today looks like both.
      return push({
        view: "sheet",
        label: `Connection dropped — reconnecting (attempt ${status.retryAttempt})`,
        detail: `${humanReason(status.reason)} Nothing is lost; it retries on its own.`,
        icon: "wait",
        tone: "working",
      });

    case "logged_out":
    case "suspended":
      return push({
        view: "wait",
        title: "Not linked",
        label:
          status.phase === "logged_out" ? "This device was unlinked" : "The account is unavailable",
        detail: `${humanReason(status.reason)} Run the command again to link a new device.`,
        icon: "stop",
        tone: "stop",
        qr: null,
      });

    default:
      return;
  }
}

// ── live ─────────────────────────────────────────────────────────────────────
function live(): void {
  say(`home: ${HOME}`);
  const seenChats = new Set<string>();
  const session = createSession({
    store: libsqlStore({ url: `file:${join(HOME, "whatsapp.db")}` }),
    auth: qrAuth(),
  });

  session.subscribe({
    connection(status) {
      say(`phase: ${status.phase}`);
      onStatus(status);
    },
    // Where the counts actually come from. Kept cheap on purpose: this callback
    // runs on whatsappd's own event pipeline, and blocking it stalls the
    // connection state machine (AaronAbuUsama/whatsappd#200).
    conversationSync(batch) {
      // An empty batch is news too, not a no-op: WhatsApp typing a reply
      // ON_DEMAND with no rows is it saying "there is nothing older"
      // (whatsappd#207). Count the kind before looking at the contents.
      kinds[batch.context.source] += 1;
      // One line per batch. The screen shows totals, which is right for someone
      // watching it, and useless afterwards for saying what actually arrived and
      // when. This is what made a real run readable: the empty `unknown +0 msgs`
      // batch and the seven `full` ones are only visible here.
      say(
        `batch: ${batch.context.source} +${batch.messages.length} msgs, +${batch.chats.length} chats`,
      );
      // `HistoryChat.id`, not `chatId` — the spike this came from used the wrong
      // field, so every chat collapsed to one undefined entry and the counter
      // stuck at 1. Type-checking against the package caught it.
      for (const c of batch.chats) seenChats.add(c.id);
      let oldest = state.oldest;
      for (const m of batch.messages) if (!oldest || m.timestamp < oldest) oldest = m.timestamp;
      push({
        kinds: { ...kinds },
        lastBatchAt: Date.now(),
        chats: seenChats.size,
        chatsTotal: Math.max(state.chatsTotal, seenChats.size),
        messages: state.messages + batch.messages.length,
        oldest,
      });
    },
  });

  // A run is only evidence if it leaves something readable behind, and the
  // only safe thing to write is counts: no jid, chat id, subject, or body. The
  // oldest timestamp becomes an age in days for the same reason.
  const writeSummary = (): void => {
    if (!SUMMARY) return;
    const oldest = state.oldest;
    writeFileSync(
      SUMMARY,
      `${JSON.stringify(
        {
          kinds,
          chats: state.chats,
          messages: state.messages,
          oldestAgeDays: oldest ? Math.round((Date.now() - oldest) / 864e5) : null,
          elapsedSeconds: Math.round((Date.now() - started) / 1000),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    say(`summary: ${SUMMARY}`);
  };
  process.on("SIGINT", () => {
    writeSummary();
    process.exit(0);
  });

  void session.start().catch((err: unknown) => {
    say(`!! start failed: ${String(err)}`);
    push({
      view: "wait",
      title: "Not linked",
      label: "Could not start",
      detail: String(err),
      icon: "stop",
      tone: "stop",
    });
  });
}

// ── demo: every state, no socket — so the screen can be checked without pairing ──
async function demo(): Promise<void> {
  const wait = async (ms: number): Promise<void> => {
    await new Promise((r) => setTimeout(r, ms));
    // `onStatus` owns the title on several branches, so re-assert the warning
    // after every transition rather than trusting it to survive one.
    if (!state.title.startsWith("Demo")) push({ title: `Demo — ${state.title.toLowerCase()}` });
  };
  const fake = `2@${"Ab9".repeat(12)},${"k".repeat(43)}=,${"i".repeat(43)}=,${"x".repeat(10)}`;
  // Demo mode must never be mistakable for the real thing. The payload below is
  // synthetic, so the code on screen cannot scan — and a QR that looks right and
  // silently fails is worse than no QR at all. Say so, on the screen, throughout.
  push({ title: "Demo — this code is not real and will not scan" });
  onStatus({ phase: "connecting" });
  await wait(1400);
  for (let i = 0; i < 2; i++) {
    onStatus({
      phase: "pairing",
      pairing: {
        step: "challenge_live",
        method: "qr",
        qr: fake + i,
        expiresAt: Date.now() + 20_000,
      },
    });
    await wait(20_000);
  }
  onStatus({ phase: "pairing", pairing: { step: "restart_pending" } });
  await wait(1800);
  onStatus({ phase: "authenticated", sync: { step: "draining" } });
  await wait(2200);
  for (let p = 0; p <= 100; p += 4) {
    onStatus({ phase: "authenticated", sync: { step: "syncing", progress: p } });
    kinds.recent = Math.max(kinds.recent, Math.ceil(p / 12));
    kinds.initial_bootstrap = p > 0 ? 1 : 0;
    push({
      kinds: { ...kinds },
      lastBatchAt: Date.now(),
      chats: Math.round(913 * (p / 100)),
      chatsTotal: 913,
      messages: Math.round(2739 * (p / 100)),
      // walks back toward the real floor the mirror holds, 2022-06-27
      oldest: p > 8 ? Date.UTC(2026, 7, 16) - (p / 100) * 1511 * 864e5 : null,
    });
    if (p === 48) {
      onStatus({
        phase: "backing_off",
        reason: "restart_required",
        retryAttempt: 1,
        nextRetryAt: Date.now() + 4000,
      });
      await wait(3200);
    }
    await wait(320);
  }
  onStatus({ phase: "online" });
  // Hold here: the quiet line only means anything once nothing is arriving, so
  // a demo that races past it never shows the state it exists to explain.
  await wait(40_000);
  onStatus({ phase: "logged_out", reason: "logged_out_remote" });
}
