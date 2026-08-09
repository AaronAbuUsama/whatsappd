/**
 * Issue #18 live proof runner — on-demand WhatsApp history semantics.
 *
 *   node --experimental-strip-types tests/history-proof.ts
 *
 * Connects the canonical proof account (config in .proof-private/config.json:
 * { "credentialDb": "/abs/path/credentials.db", "account": "proof" }), records
 * every conversation-sync batch into a disposable sqlite observation store, and
 * exposes a REPL to drive the P4 matrix:
 *
 *   chats            list chats seen this run (idx, jid, msgs, oldest known)
 *   req <idx> [n]    submit requestHistory anchored at the chat's oldest known
 *                    message (default count 50); prints the receipt id
 *   status           per request: correlated batches, chunk orders, newly
 *                    stored counts, boundary verdict
 *   oracle           database-oracle cross-check (supporting evidence):
 *                    counts/order of accepted identities around each
 *                    requested boundary, straight from sqlite
 *   note <text>      timestamp a free-form operator note (e.g. "phone offline")
 *   quit             stop the session, release the lease, write the matrix
 *
 * Receipts stay sanitized: chat JIDs and message ids never leave the terminal —
 * the observation store and matrix JSON hold only per-run-salted sha256
 * prefixes, timestamps, counts, and request ids (whatsappd-generated, not
 * native). The salt lives in process memory only.
 *
 * One worker per live account: an operator sentinel (mkdir + heartbeat) next
 * to the shared credential store, held only while this process is connected.
 * Acquisition refuses an existing lock — recovery from a crashed holder is a
 * manual rmdir guided by the printed heartbeat age; a token close-on-loss
 * check backstops operator error. The product-grade ADR-0009 lease is issue
 * #20 backend work, not this harness.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { createSession, qrAuth, refOf } from "../packages/whatsappd/src/index.ts";
import { libsqlStore } from "../packages/whatsappd/src/stores/libsql.ts";
import type {
  ConversationSyncBatch,
  InboundMessage,
} from "../packages/whatsappd/src/model/index.ts";
import type { MessageRef } from "../packages/whatsappd/src/model/outbound.ts";
import { guardedSender, resolveAllowlistedTarget } from "./send-guard.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const privateDir = path.join(here, "..", ".proof-private");

interface Anchor {
  readonly ref: MessageRef;
  readonly timestamp: number;
}

export interface BoundaryRow {
  readonly msgHash: string;
  readonly timestamp: number;
}

export interface BoundaryVerdict {
  readonly returned: number;
  readonly olderThanAnchor: number;
  readonly atAnchorTimestamp: number;
  readonly newerThanAnchor: number;
  readonly anchorRedelivered: boolean;
  readonly oldestReturned: number | null;
  readonly newestReturned: number | null;
}

/** Pure boundary analysis: how do returned rows sit relative to the anchor? */
export function boundaryVerdict(
  anchorTimestamp: number,
  anchorHash: string,
  rows: readonly BoundaryRow[],
): BoundaryVerdict {
  let older = 0;
  let at = 0;
  let newer = 0;
  let anchorRedelivered = false;
  let oldest: number | null = null;
  let newest: number | null = null;
  for (const row of rows) {
    if (row.msgHash === anchorHash) anchorRedelivered = true;
    if (row.timestamp < anchorTimestamp) older++;
    else if (row.timestamp === anchorTimestamp) at++;
    else newer++;
    if (oldest === null || row.timestamp < oldest) oldest = row.timestamp;
    if (newest === null || row.timestamp > newest) newest = row.timestamp;
  }
  return {
    returned: rows.length,
    olderThanAnchor: older,
    atAnchorTimestamp: at,
    newerThanAnchor: newer,
    anchorRedelivered,
    oldestReturned: oldest,
    newestReturned: newest,
  };
}

// Per-run random salt, never persisted: an unsalted hash of a jid is
// reversible by hashing candidate phone numbers against a committed receipt.
// Identities stay stable within a run — all the oracle needs.
const hashSalt = randomBytes(16);
const hashChat = (jid: string): string =>
  createHash("sha256").update(hashSalt).update(jid).digest("hex").slice(0, 12);
const hashMsg = (m: { chatId: string; id: string; fromMe: boolean }): string =>
  createHash("sha256")
    .update(hashSalt)
    .update(`${m.chatId}|${m.id}|${m.fromMe}`)
    .digest("hex")
    .slice(0, 16);

// Only run the live harness when executed directly, so the pure helpers above
// stay importable from unit tests without opening a socket.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(readFileSync(path.join(privateDir, "config.json"), "utf8")) as {
    credentialDb: string;
    account: string;
  };
  if (!isAbsolute(config.credentialDb) || !config.account) {
    throw new Error("config.json requires an absolute credentialDb and an account");
  }

  // One worker per live ACCOUNT (ADR-0009 scope): the sentinel is keyed by
  // the account name and lives NEXT TO the shared credential store, so
  // parallel lanes (e.g. issue #19) contend per account, while unrelated
  // accounts sharing a directory do not. mkdir is atomic; EEXIST means
  // someone else owns it. Acquired only at connection time (below), so a
  // setup crash can never strand it.
  const accountKey = config.account.replace(/[^A-Za-z0-9_-]/g, "_");
  const lease = path.join(path.dirname(config.credentialDb), `live-${accountKey}.lock`);
  let releaseLease = (): void => {}; // bound after the lease exists (below)

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const dbPath = path.join(privateDir, `observations-${runId}.db`);
  const logPath = path.join(privateDir, `transport-${runId}.log`);
  // Capture-at-source rule: every property a receipt will assert (head, tree
  // state, log identity) is recorded HERE, at run time, in the observation
  // store. The receipt writer transcribes; it never re-derives.
  const repoRoot = path.join(here, "..");
  const runHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).toString().trim();
  const runDirty =
    execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot }).toString().trim() !== "";
  if (runDirty) {
    console.error("⚠ dirty tree — this run's observations will NOT be receiptable (ADR-0017)");
  }
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE run(
      run_id TEXT NOT NULL,
      git_head TEXT NOT NULL,
      dirty INTEGER NOT NULL,
      log_path TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      lease_token TEXT,
      finalized_at INTEGER
    );
    CREATE TABLE batch(
      seq INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      chunk_order INTEGER,
      is_latest INTEGER,
      progress INTEGER,
      request_session_id TEXT,
      message_count INTEGER NOT NULL,
      received_at INTEGER NOT NULL
    );
    CREATE TABLE message(
      batch_seq INTEGER NOT NULL REFERENCES batch(seq),
      chat_hash TEXT NOT NULL,
      msg_hash TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      from_me INTEGER NOT NULL
    );
    CREATE TABLE request(
      request_id TEXT PRIMARY KEY,
      chat_hash TEXT NOT NULL,
      anchor_msg_hash TEXT NOT NULL,
      anchor_timestamp INTEGER NOT NULL,
      count INTEGER NOT NULL,
      submitted_at INTEGER NOT NULL
    );
    CREATE TABLE note(at INTEGER NOT NULL, text TEXT NOT NULL);
  `);
  const insertBatch = db.prepare(
    "INSERT INTO batch(source, chunk_order, is_latest, progress, request_session_id, message_count, received_at) VALUES(?,?,?,?,?,?,?)",
  );
  const insertMessage = db.prepare(
    "INSERT INTO message(batch_seq, chat_hash, msg_hash, timestamp, from_me) VALUES(?,?,?,?,?)",
  );
  const insertRequest = db.prepare(
    "INSERT INTO request(request_id, chat_hash, anchor_msg_hash, anchor_timestamp, count, submitted_at) VALUES(?,?,?,?,?,?)",
  );
  const insertNote = db.prepare("INSERT INTO note(at, text) VALUES(?,?)");
  db.prepare(
    "INSERT INTO run(run_id, git_head, dirty, log_path, started_at) VALUES(?,?,?,?,?)",
  ).run(runId, runHead, runDirty ? 1 : 0, logPath, Date.now());

  // In-memory only (never persisted): real chat jids and oldest-known anchors.
  const chats = new Map<string, { count: number; oldest?: Anchor & { hash: string } }>();
  // Every message identity observed so far. Each request snapshots this set
  // synchronously before submission, so "newly stored" is exact membership —
  // no timestamp comparison, no same-millisecond ties in either direction.
  const seenIds = new Set<string>();
  const seenAtSubmit = new Map<string, ReadonlySet<string>>();
  // Set when a store write fails after a transport action succeeded: the
  // observations no longer reflect the run, so it must never finalize.
  let observationsIncomplete = false;

  function track(m: InboundMessage): void {
    const entry = chats.get(m.chatId) ?? { count: 0 };
    entry.count++;
    if (m.timestamp > 0 && (!entry.oldest || m.timestamp < entry.oldest.timestamp)) {
      entry.oldest = { ref: refOf(m), timestamp: m.timestamp, hash: hashMsg(m) };
    }
    chats.set(m.chatId, entry);
    const hash = hashMsg(m);
    seenIds.add(hash);
  }

  function recordBatch(batch: ConversationSyncBatch): void {
    const c = batch.context;
    let seq: number;
    try {
      seq = Number(
        insertBatch.run(
          c.source,
          c.chunkOrder ?? null,
          c.isLatest == null ? null : c.isLatest ? 1 : 0,
          c.progress ?? null,
          c.requestSessionId ?? null,
          batch.messages.length,
          Date.now(),
        ).lastInsertRowid,
      );
      for (const m of batch.messages) {
        insertMessage.run(seq, hashChat(m.chatId), hashMsg(m), m.timestamp, m.fromMe ? 1 : 0);
        track(m);
      }
    } catch (err) {
      // A delivered-but-unrecorded batch makes the store incomplete: the run
      // must never finalize. Rethrow so the awaited subscription fails the
      // pipeline (ADR-0013) rather than silently continuing with lost data.
      observationsIncomplete = true;
      console.error("⚠ batch insert failed — run is no longer receiptable:", err);
      throw err;
    }
    const tag = c.requestSessionId ? ` req=${c.requestSessionId}` : "";
    console.log(
      `\n📦 batch#${seq} source=${c.source} chunk=${c.chunkOrder ?? "-"} latest=${c.isLatest ?? "-"} progress=${c.progress ?? "-"} msgs=${batch.messages.length}${tag}`,
    );
  }

  // The runner owns its transport log: the file target always records at
  // debug (so delivery-ack stanzas are captured regardless of console
  // verbosity) and its path is bound to the run in the observation store.
  const logger = pino(
    { level: "debug" },
    pino.transport({
      targets: [
        {
          target: "pino-pretty",
          level: process.env.LOG_LEVEL ?? "warn",
          options: { colorize: true, destination: 1 },
        },
        { target: "pino/file", level: "debug", options: { destination: logPath } },
      ],
    }),
  );
  const session = createSession({
    store: libsqlStore({ url: `file:${config.credentialDb}`, account: config.account }),
    auth: qrAuth(),
    logger,
  });
  const sender = guardedSender(session);

  session.subscribe({
    conversationSync(batch) {
      recordBatch(batch);
    },
    message(m) {
      if (!m.live) return;
      track(m);
    },
    connection(ev) {
      if (ev.phase === "pairing" && ev.pairing.step === "challenge_live" && ev.pairing.qr) {
        console.log("\n📱 credentials expired — scan in WhatsApp → Linked devices:\n");
        qrcode.generate(ev.pairing.qr, { small: true });
      } else if (ev.phase === "online") {
        console.log("\n🟢 ONLINE — type `chats` once batches settle, then `req <idx> [n]`.");
      } else if (ev.phase === "backing_off") {
        console.log(`🔻 ${ev.reason} — retrying`);
      } else if (ev.phase === "logged_out" || ev.phase === "suspended") {
        console.log(`⛔ ${ev.phase} (${ev.reason})`);
      }
    },
  });

  const sortedChats = (): Array<[string, { count: number; oldest?: Anchor & { hash: string } }]> =>
    [...chats.entries()].sort((a, b) => b[1].count - a[1].count);

  function showStatus(): void {
    const requests = db.prepare("SELECT * FROM request ORDER BY submitted_at").all() as Array<
      Record<string, unknown>
    >;
    if (requests.length === 0) console.log("no requests submitted yet");
    for (const r of requests) {
      const id = r.request_id as string;
      const rows = db
        .prepare(
          `SELECT b.seq, b.chunk_order, b.progress, b.is_latest, b.message_count
             FROM batch b WHERE b.request_session_id = ? ORDER BY b.seq`,
        )
        .all(id) as Array<Record<string, unknown>>;
      const msgs = db
        .prepare(
          `SELECT m.msg_hash AS msgHash, m.timestamp
             FROM message m JOIN batch b ON b.seq = m.batch_seq
            WHERE b.request_session_id = ? AND m.timestamp > 0`,
        )
        .all(id) as unknown as BoundaryRow[];
      const baseline = seenAtSubmit.get(id);
      // Distinct identities on both sides: chunked redelivery of one message
      // is one newly accepted identity, not several.
      const distinct = new Set(msgs.map((m) => m.msgHash));
      const fresh = baseline
        ? `${[...distinct].filter((h) => !baseline.has(h)).length}/${distinct.size} distinct`
        : "unknown (no submission snapshot)";
      const verdict = boundaryVerdict(
        r.anchor_timestamp as number,
        r.anchor_msg_hash as string,
        msgs,
      );
      const chatHash = typeof r.chat_hash === "string" ? r.chat_hash : "unknown";
      const count = typeof r.count === "number" ? r.count : "unknown";
      console.log(`\n▶ request ${id} chat=${chatHash} count=${count}`);
      console.log(
        `  correlated batches: ${rows.length} ${JSON.stringify(rows.map((b) => ({ seq: b.seq, chunk: b.chunk_order, progress: b.progress, latest: b.is_latest, msgs: b.message_count })))}`,
      );
      console.log(`  newly stored (absent from the pre-submission snapshot): ${fresh}`);
      console.log(`  boundary: ${JSON.stringify(verdict)}`);
    }
    const orphan = db
      .prepare(
        "SELECT seq, source, request_session_id FROM batch WHERE source = 'on_demand' AND (request_session_id IS NULL OR request_session_id NOT IN (SELECT request_id FROM request))",
      )
      .all();
    if (orphan.length > 0)
      console.log(`\n⚠ uncorrelated on_demand batches: ${JSON.stringify(orphan)}`);
  }

  function showOracle(): void {
    // Database-oracle cross-check (supporting evidence, ADR-0017): counts and
    // order of accepted stable identities around each requested boundary —
    // the phone response remains the source of truth. Zero-timestamp rows are
    // excluded, matching the receipt writer's oracle.
    const rows = db
      .prepare(
        `SELECT r.request_id,
                COUNT(m.msg_hash)                                        AS returned,
                SUM(CASE WHEN m.timestamp <  r.anchor_timestamp THEN 1 ELSE 0 END) AS older,
                SUM(CASE WHEN m.timestamp >= r.anchor_timestamp THEN 1 ELSE 0 END) AS at_or_newer,
                MIN(m.timestamp) AS oldest, MAX(m.timestamp) AS newest,
                COUNT(DISTINCT m.msg_hash) AS distinct_ids
           FROM request r
           LEFT JOIN batch b ON b.request_session_id = r.request_id
           LEFT JOIN message m ON m.batch_seq = b.seq AND m.timestamp > 0
          GROUP BY r.request_id ORDER BY r.submitted_at`,
      )
      .all();
    console.log(JSON.stringify(rows, null, 2));
  }

  let quitting = false;
  async function quit(): Promise<void> {
    if (quitting) return; // a second quit/SIGINT must not race the first
    quitting = true;
    console.log("…stopping");
    let stopFailed = false;
    try {
      await session.stop();
    } catch (err) {
      stopFailed = true;
      console.error("session stop failed:", err);
    } finally {
      releaseLease();
    }
    // Drain the transport log BEFORE stamping finalization: the writer's
    // finalized-run guard must imply the log already carries every queued
    // stanza, or a receipt could record late acknowledgements as absent.
    // flush() is awaited via its completion callback, with a bounded race so
    // a wedged transport cannot hang shutdown.
    const flushConfirmed = await Promise.race([
      new Promise<boolean>((resolve) => {
        try {
          // The callback is error-bearing: a transport I/O failure means the
          // log may be incomplete, which is NOT a confirmed flush.
          logger.flush((err?: Error) => resolve(err == null));
        } catch {
          resolve(false);
        }
      }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
    ]);
    // Finalization marker: the receipt writer refuses a run without one, so
    // a receipt can never transcribe a still-connected run's outcomes as
    // absent. An unconfirmed flush leaves the run UNfinalized — better an
    // unreceiptable run than a receipt over a possibly incomplete log.
    // A failed stop means the socket may outlive this point and produce
    // stanzas after the marker — same disqualifier as an unconfirmed flush.
    const unfinalizable = !flushConfirmed
      ? "transport flush unconfirmed"
      : observationsIncomplete
        ? "observation store incomplete"
        : stopFailed
          ? "socket teardown unconfirmed"
          : undefined;
    if (unfinalizable == null) {
      try {
        db.prepare("UPDATE run SET finalized_at = ?").run(Date.now());
      } catch (err) {
        console.error("run finalization failed:", err);
      }
    } else {
      console.error(`⚠ ${unfinalizable} — run left unfinalized and therefore unreceiptable`);
    }
    // The matrix is written even when teardown failed — observations are the
    // point of the run and must survive a bad stop.
    try {
      const matrix = {
        runId,
        gitHead: runHead,
        batches: db.prepare("SELECT * FROM batch ORDER BY seq").all(),
        requests: db.prepare("SELECT * FROM request ORDER BY submitted_at").all(),
        notes: db.prepare("SELECT * FROM note ORDER BY at").all(),
      };
      const out = path.join(privateDir, `matrix-${runId}.json`);
      await writeFile(out, `${JSON.stringify(matrix, null, 2)}\n`);
      console.log(`📄 matrix → ${out}\n🗄 observations → ${dbPath}`);
    } catch (err) {
      console.error("matrix write failed:", err);
    }
    process.exit(stopFailed ? 1 : 0);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "history> " });
  // Commands run strictly serialized: a later `quit` (typed or SIGINT-queued)
  // can only start after every in-flight command — e.g. a `req` awaiting
  // submission — has completed its observation-store writes, so finalization
  // can never race a pending insert.
  let commandChain = Promise.resolve();
  const handleCommand = async (line: string): Promise<void> => {
    const [cmd, ...args] = line.trim().split(/\s+/);
    try {
      switch (cmd) {
        case "chats": {
          sortedChats().forEach(([jid, c], i) => {
            const o = c.oldest;
            console.log(
              `${String(i).padStart(3)}  ${jid}  msgs=${c.count}  oldest=${o ? new Date(o.timestamp).toISOString() : "-"}`,
            );
          });
          break;
        }
        case "req": {
          const idx = Number(args[0]);
          const entry = sortedChats()[idx];
          if (!entry) throw new Error(`no chat at index ${args[0]} — run \`chats\``);
          const [jid, c] = entry;
          if (!c.oldest) throw new Error(`no anchored message known for ${jid}`);
          const count = args[1] ? Number(args[1]) : 50;
          // Freshness baseline is captured BEFORE submission: a batch that
          // lands while the submit promise is pending is request-triggered
          // and must not be classified as pre-existing.
          const submittedAt = Date.now();
          // Synchronous snapshot BEFORE the await: exact membership baseline
          // for "newly stored", immune to same-millisecond ordering.
          const baseline: ReadonlySet<string> = new Set(seenIds);
          const { requestId } = await session.requestHistory(
            { ref: c.oldest.ref, timestamp: c.oldest.timestamp },
            { count },
          );
          seenAtSubmit.set(requestId, baseline);
          try {
            insertRequest.run(
              requestId,
              hashChat(jid),
              c.oldest.hash,
              c.oldest.timestamp,
              count,
              submittedAt,
            );
          } catch (err) {
            // A submitted-but-unrecorded request makes the store incomplete:
            // the run must never finalize into a receipt.
            observationsIncomplete = true;
            console.error("⚠ request insert failed — run is no longer receiptable:", err);
          }
          console.log(
            `📨 submitted ${requestId} (chat=${hashChat(jid)}, anchor=${new Date(c.oldest.timestamp).toISOString()}, count=${count}) — submission receipt only; watch for on_demand batches`,
          );
          break;
        }
        case "send": {
          // Anchor bootstrap: a returning device receives no history redelivery,
          // so an empty run has no requestable anchors until traffic exists.
          const target = args[0]?.includes("@") ? args[0] : sortedChats()[Number(args[0])]?.[0];
          if (!target) throw new Error(`no chat for ${args[0]} — pass an index or a full jid`);
          const text = args.slice(1).join(" ") || `issue18 anchor ${Date.now()}`;
          await sender.send(resolveAllowlistedTarget(target), { text });
          console.log("📤 sent allowlisted anchor");
          break;
        }
        case "status":
          showStatus();
          break;
        case "oracle":
          showOracle();
          break;
        case "note":
          // Notes end up in committed receipts: strip anything shaped like a
          // native address (E.164 / long digit runs) before it is stored.
          insertNote.run(Date.now(), args.join(" ").replace(/\+?\d{7,15}/g, "<redacted>"));
          console.log("noted");
          break;
        case "quit":
          await quit();
          break;
        case "":
          break;
        default:
          console.log(
            "commands: chats | req <idx> [n] | send <idx|jid> [text] | status | oracle | note <text> | quit",
          );
      }
    } catch (err) {
      console.error(`✖ ${(err as Error).message}`);
    }
    rl.prompt();
  };
  rl.on("line", (line) => {
    commandChain = commandChain.then(() => handleCommand(line));
  });
  let sigints = 0;
  process.on("SIGINT", () => {
    sigints++;
    if (sigints >= 2) {
      // Escape hatch for a hung command: exit without finalization — the run
      // stays unreceiptable, which is the honest outcome for a torn shutdown.
      console.error("\nforce exit without finalization (second SIGINT)");
      process.exit(130);
    }
    commandChain = commandChain.then(() => quit());
  });

  // Operator sentinel, deliberately NOT a self-healing lease: acquisition
  // always refuses an existing lock and never steals it — automatic stale
  // takeover is what creates clobbering/TOCTOU races between a stalled holder
  // and its successor, and a REPL harness has an operator present by
  // definition. Recovery from a SIGKILLed holder is one manual rmdir, guided
  // by the heartbeat age printed on refusal. If an operator removes a lease
  // whose holder was actually alive, both processes fail CLOSED: the resumed
  // holder sees a foreign token and quits; in the worst suspension-timed
  // interleaving the successor quits instead — either way at most one socket
  // survives. The product-grade lease with real fencing tokens is backend
  // store work (ADR-0009, issue #20), not this harness.
  const heartbeatFile = path.join(lease, "heartbeat");
  const leaseToken = `${process.pid}:${runId}`;
  const HEARTBEAT_MS = 15_000;
  const STALE_HINT_MS = 60_000;
  const ownsLease = (): boolean => {
    try {
      return readFileSync(heartbeatFile, "utf8") === leaseToken;
    } catch {
      return false;
    }
  };
  releaseLease = (): void => {
    if (!ownsLease()) return; // a successor's lease is not ours to delete
    try {
      rmSync(lease, { recursive: true, force: true }); // lease dir + heartbeat file
    } catch {
      /* already released */
    }
  };
  const acquireLease = (): void => {
    try {
      mkdirSync(lease);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let ageMs: number | undefined;
      try {
        ageMs = Date.now() - statSync(heartbeatFile).mtimeMs;
      } catch {
        /* no heartbeat file — holder died mid-acquire, or pre-heartbeat era */
      }
      const age =
        ageMs == null ? "no heartbeat file" : `heartbeat ${Math.round(ageMs / 1000)}s old`;
      // No heartbeat = a holder that died mid-acquire: recovery guidance
      // applies just as much as to a stale heartbeat.
      const hint =
        ageMs == null || ageMs > STALE_HINT_MS
          ? " (likely a crashed holder — verify no proof runner is alive, then remove the directory manually)"
          : "";
      console.error(
        `⛔ lease held: ${lease} (${age}) — another worker owns the live account${hint}.`,
      );
      process.exit(2);
    }
    writeFileSync(heartbeatFile, leaseToken);
    // Bind the observations to the runner that held the account (part of the
    // capture-at-source provenance the receipt transcribes). A failure here
    // must not strand the just-created lease.
    try {
      db.prepare("UPDATE run SET lease_token = ?").run(leaseToken);
    } catch (err) {
      releaseLease();
      throw err;
    }
  };
  acquireLease();
  const heartbeat = setInterval(() => {
    if (!ownsLease()) {
      // A successor took over while this process was stalled. Its lease is
      // not ours to refresh or release — close our socket and get out.
      // Shutdown rides the command FIFO so an in-flight command's store
      // writes land before finalization, same as every other quit path.
      console.error("⛔ lease lost to another worker after a stall — closing the socket");
      clearInterval(heartbeat);
      commandChain = commandChain.then(() => quit());
      return;
    }
    try {
      writeFileSync(heartbeatFile, leaseToken);
    } catch {
      /* lease dir vanished — the ownsLease check above handles the fallout */
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  console.log(`lease acquired: ${lease}\nconnecting account "${config.account}"…`);
  rl.prompt();
  try {
    await session.start();
  } finally {
    clearInterval(heartbeat);
    releaseLease(); // held only while connected — including when start() rejects
  }
}
