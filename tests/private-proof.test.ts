import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "./_expect.ts";
import {
  PrivateProofInUseError,
  runPrivateProof,
  runPrivateProofCommand,
  type OpenLiveSession,
} from "./private-proof.ts";

const execFileAsync = promisify(execFile);

async function sha256(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function createPrivateFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "whatsappd-private-proof-"));
  const privateDir = join(root, ".proof-private");
  const sourceDb = join(root, "source.db");
  const credentialDb = join(root, "credentials.db");
  await mkdir(privateDir);
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "proof@example.invalid"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Private Proof"], { cwd: root });
  await writeFile(join(root, "tracked"), "proof\n");
  await execFileAsync("git", ["add", "tracked"], { cwd: root });
  await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: root });
  await execFileAsync("sqlite3", [
    sourceDb,
    "CREATE TABLE raw_event (id TEXT PRIMARY KEY, ts TEXT NOT NULL, payload JSON, sender TEXT);",
  ]);
  await execFileAsync("sqlite3", [
    credentialDb,
    "CREATE TABLE wa_auth (account TEXT, key TEXT, value TEXT);",
  ]);
  await writeFile(
    join(privateDir, "config.json"),
    `${JSON.stringify({ sourceDb, credentialDb, account: "private-account-id" })}\n`,
  );
  return root;
}

test("a second P4 proof fails before opening WhatsApp", async () => {
  const root = await createPrivateFixture();
  let openCount = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const openLiveSession: OpenLiveSession = async () => {
    openCount++;
    if (openCount === 1) await held;
    return { paired: false };
  };
  const dependencies = { root, openLiveSession };
  const first = runPrivateProof("p4", true, dependencies);

  while (openCount === 0) await new Promise((resolve) => setImmediate(resolve));
  let error: unknown;
  try {
    await runPrivateProof("p4", true, dependencies);
  } catch (caught) {
    error = caught;
  }

  expect(error instanceof PrivateProofInUseError).toBe(true);
  expect(openCount).toBe(1);
  release();
  await first;
  expect(openCount).toBe(2);
});

test("P2 snapshots and restarts the fixed private corpus without changing its source", async () => {
  const root = await createPrivateFixture();
  const privateDir = join(root, ".proof-private");
  const sourceDb = join(root, "source.db");
  const credentialDb = join(root, "credentials.db");
  const privateBody = "meet me at the private place";
  const privateJid = "15551234567@s.whatsapp.net";
  const privateCredential = "private-device-credential";
  const { stdout: headOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
  const gitHead = headOutput.trim();
  await execFileAsync("sqlite3", [
    sourceDb,
    [
      `INSERT INTO raw_event VALUES ('pbRecord0000002', '2026-07-29T10:00:00Z', '${privateBody}', '${privateJid}');`,
      "INSERT INTO raw_event VALUES ('pbRecord0000001', '2026-07-28T10:00:00Z', '{}', 'private');",
    ].join(" "),
  ]);
  await execFileAsync("sqlite3", [
    credentialDb,
    `INSERT INTO wa_auth VALUES ('private-account-id', 'creds', '${privateCredential}');`,
  ]);
  const sourceBefore = await sha256(sourceDb);

  const receipt = await runPrivateProof("p2", false, {
    root,
    openLiveSession: async () => {
      throw new Error("P2 must not open WhatsApp");
    },
  });
  const retained = JSON.parse(
    await readFile(join(privateDir, "p2-receipt.json"), "utf8"),
  ) as typeof receipt;
  const published = JSON.stringify(retained);

  expect(receipt).toEqual(retained);
  expect(retained.tier).toBe("P2");
  expect(retained.gitHead).toBe(gitHead);
  expect(retained.sourceChecksumBefore).toBe(sourceBefore);
  expect(retained.sourceChecksumAfter).toBe(sourceBefore);
  expect(retained.snapshotRestarted).toBe(true);
  expect(retained.recordCount).toBe(2);
  expect(retained.orderedIdDigest).toBe(
    "891c9bb72ef9fbfc8234cb8b70b93b5e733fe6561bbf3bf59bc2e4b7afdc254d",
  );
  expect(retained.timestampBounds).toEqual({
    min: "2026-07-28T10:00:00Z",
    max: "2026-07-29T10:00:00Z",
  });
  expect(retained.revisionBounds).toBe(null);
  expect(published).not.toContain(privateBody);
  expect(published).not.toContain(privateJid);
  expect(published).not.toContain(privateCredential);
  expect(published).not.toContain(sourceDb);
  expect(published).not.toContain(credentialDb);
  expect(published).not.toContain("private-account-id");

  const { stdout: count } = await execFileAsync("sqlite3", [
    "-readonly",
    join(privateDir, "run", "corpus.db"),
    "SELECT COUNT(*) FROM raw_event;",
  ]);
  expect(count.trim()).toBe("2");
  expect(await sha256(sourceDb)).toBe(sourceBefore);
});

test("P4 retains only a sanitized database-backed reconnect receipt", async () => {
  const root = await createPrivateFixture();
  const privateDir = join(root, ".proof-private");
  const sourceDb = join(root, "source.db");
  const credentialDb = join(root, "credentials.db");
  const privateCredential = "private-device-credential";
  await execFileAsync("sqlite3", [
    sourceDb,
    "INSERT INTO raw_event VALUES ('pbRecord0000001', '2026-07-28T10:00:00Z', '{}', 'private');",
  ]);
  await execFileAsync("sqlite3", [
    credentialDb,
    `INSERT INTO wa_auth VALUES ('private-account-id', 'creds', '${privateCredential}');`,
  ]);
  const openedWith: unknown[] = [];

  const receipt = (await runPrivateProof("p4", true, {
    root,
    openLiveSession: async (input) => {
      openedWith.push(input);
      return { paired: false };
    },
  })) as {
    tier: string;
    reconnected: boolean;
    sourceChecksumBefore: string;
    sourceChecksumAfter: string;
  };
  const retained = JSON.parse(
    await readFile(join(privateDir, "p4-receipt.json"), "utf8"),
  ) as typeof receipt;
  const published = JSON.stringify(retained);

  expect(openedWith.length).toBe(2);
  expect(openedWith[0]).toMatchObject({
    credentialDb,
    account: "private-account-id",
  });
  expect(openedWith[1]).toMatchObject({
    credentialDb,
    account: "private-account-id",
  });
  expect(receipt).toEqual(retained);
  expect(receipt.tier).toBe("P4");
  expect(receipt.reconnected).toBe(true);
  expect(receipt.sourceChecksumAfter).toBe(receipt.sourceChecksumBefore);
  expect(published).not.toContain(privateCredential);
  expect(published).not.toContain(sourceDb);
  expect(published).not.toContain(credentialDb);
  expect(published).not.toContain("private-account-id");
});

test("SIGINT and SIGTERM cancel P4 and release the fixed lock", async () => {
  const root = await createPrivateFixture();
  for (const signalName of ["SIGTERM", "SIGINT"] as const) {
    let opened!: () => void;
    const didOpen = new Promise<void>((resolve) => (opened = resolve));
    let release!: () => void;
    const fallback = new Promise<void>((resolve) => (release = resolve));
    const proof = runPrivateProof("p4", true, {
      root,
      openLiveSession: async ({ signal }) => {
        opened();
        await Promise.race([
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
          fallback,
        ]);
        return { paired: false };
      },
    });
    await didOpen;
    const handled = process.emit(signalName);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    let error: unknown;
    try {
      await proof;
    } catch (caught) {
      error = caught;
    }

    expect(handled).toBe(true);
    expect(String(error)).toContain("private P4 proof cancelled");
  }
  const resumed = await runPrivateProof("p4", true, {
    root,
    openLiveSession: async () => ({ paired: false }),
  });
  expect((resumed as { reconnected: boolean }).reconnected).toBe(true);
});

test("P4 rejects a restart that asks to pair again", async () => {
  const root = await createPrivateFixture();
  let opens = 0;
  let error: unknown;
  try {
    await runPrivateProof("p4", true, {
      root,
      openLiveSession: async () => ({ paired: ++opens === 2 }),
    });
  } catch (caught) {
    error = caught;
  }

  expect(opens).toBe(2);
  expect(String(error)).toContain("P4 reconnect");
});

test("the P4 command requires the exact live-account confirmation", async () => {
  const root = await createPrivateFixture();
  let opens = 0;
  let error: unknown;
  try {
    await runPrivateProofCommand(["p4"], {
      root,
      openLiveSession: async () => {
        opens++;
        return { paired: false };
      },
    });
  } catch (caught) {
    error = caught;
  }

  expect(String(error)).toContain("proof:p4 --confirm-live-account");
  expect(opens).toBe(0);
});

test("package scripts expose only the two fixed private proof commands", async () => {
  const packageJson = JSON.parse(
    await readFile(join(import.meta.dirname, "..", "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };

  expect(packageJson.scripts["proof:p2"]).toBe(
    "node --experimental-strip-types tests/private-proof.ts p2",
  );
  expect(packageJson.scripts["proof:p4"]).toBe(
    "node --experimental-strip-types tests/private-proof.ts p4",
  );
});
