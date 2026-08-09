/// <reference types="node" />

/**
 * Derives execution state from GitHub. Nothing here is written down anywhere.
 *
 *   pnpm state
 *
 * `docs/EXECUTION-STATE.md` used to answer "what is the next node?" in prose,
 * and prose cannot be re-derived when an issue closes. It was last edited on
 * the day it already disagreed with the graph it described: #106 had merged,
 * #119 had closed, and #127 had been filed as a new blocker of #107 — none of
 * which its diagram knew. Nothing in the repository linked to it, so nothing
 * failed when it went stale.
 *
 * GitHub already holds every fact that document restated. Each issue names its
 * own edges under a `## Blocked by` heading, and an issue is open or closed.
 * That is a graph, and a graph can be printed on demand.
 *
 * The durable half — decisions, semantics that must not be collapsed, proof
 * gates — is not state and lives in `docs/standing-decisions.md`.
 */
import { execFileSync } from "node:child_process";

export interface Node {
  readonly number: number;
  readonly title: string;
  readonly closed: boolean;
  readonly labels: readonly string[];
  readonly blockers: readonly number[];
}

/** Labels that mean an issue is specified enough to start. */
const READY = ["ready-for-agent", "ready-for-human"];

/**
 * The issue numbers under a `## Blocked by` heading.
 *
 * Only the first reference on each bullet counts. Blocker bullets carry prose
 * that names other issues and PRs — "#106 … **Closed**: PR #125 merged" — and
 * every one of those trailing references is commentary, not an edge.
 */
export function parseBlockers(body: string): readonly number[] {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{2,4} +blocked by\s*$/i.test(line.trim()));
  if (start === -1) return [];

  const blockers: number[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6} /.test(line)) break; // the next heading ends the section
    const bullet = /^\s*[-*] [^\n]*?#(\d+)/.exec(line);
    if (bullet) blockers.push(Number(bullet[1]));
  }
  return [...new Set(blockers)];
}

export type Standing =
  | { readonly kind: "frontier"; readonly ready: boolean }
  | { readonly kind: "blocked"; readonly by: readonly number[] }
  | { readonly kind: "loose" }
  | { readonly kind: "deferred" }
  | { readonly kind: "closed" };

/**
 * Where one node stands, given every node.
 *
 * A node is on the graph when it declares blockers or something declares it as
 * one. Without the second half the frontier itself disappears from the graph
 * view the moment its own blockers close — #127 declares none and is exactly
 * the node an executor needs to see.
 */
export function classify(node: Node, all: readonly Node[]): Standing {
  if (node.closed) return { kind: "closed" };
  if (node.labels.includes("deferred")) return { kind: "deferred" };

  const open = new Map(all.map((other) => [other.number, other]));
  const blocking = node.blockers.filter((number) => !open.get(number)?.closed);
  if (blocking.length > 0) return { kind: "blocked", by: blocking };

  const depended = all.some((other) => !other.closed && other.blockers.includes(node.number));
  if (node.blockers.length === 0 && !depended) return { kind: "loose" };

  return { kind: "frontier", ready: node.labels.some((label) => READY.includes(label)) };
}

interface RawIssue {
  number: number;
  title: string;
  state: string;
  body: string;
  labels: { name: string }[];
}

function gh(args: readonly string[]): string {
  return execFileSync("gh", [...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function load(): readonly Node[] {
  const raw: RawIssue[] = JSON.parse(
    gh([
      "issue",
      "list",
      "--state",
      "all",
      "--limit",
      "400",
      "--json",
      "number,title,state,body,labels",
    ]),
  );
  return raw
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      closed: issue.state === "CLOSED",
      labels: issue.labels.map((label) => label.name),
      blockers: parseBlockers(issue.body ?? ""),
    }))
    .sort((a, b) => a.number - b.number);
}

function line(node: Node): string {
  const labels = node.labels.length > 0 ? ` [${node.labels.join(" ")}]` : "";
  return `  #${node.number} ${node.title}${labels}`;
}

function main(): void {
  const nodes = load();
  const standing = new Map(nodes.map((node) => [node.number, classify(node, nodes)]));
  const of = (kind: Standing["kind"]) =>
    nodes.filter((node) => standing.get(node.number)?.kind === kind);

  const frontier = of("frontier");
  console.log(`FRONTIER (${frontier.length}) — open, every declared blocker closed`);
  for (const node of frontier) {
    const state = standing.get(node.number);
    const warn =
      state?.kind === "frontier" && !state.ready
        ? "\n    ⚠ not labelled ready-for-agent/ready-for-human — not dispatchable"
        : "";
    console.log(line(node) + warn);
  }

  const blocked = of("blocked");
  console.log(`\nBLOCKED (${blocked.length})`);
  for (const node of blocked) {
    const state = standing.get(node.number);
    const by = state?.kind === "blocked" ? state.by.map((number) => `#${number}`).join(", ") : "";
    console.log(`${line(node)}\n    waiting on ${by}`);
  }

  const loose = of("loose");
  console.log(
    `\nOPEN, NOT ON THE GRAPH (${loose.length}) — no blockers declared, nothing declares them`,
  );
  for (const node of loose) console.log(line(node));

  console.log(`\nDEFERRED: ${of("deferred").length}   CLOSED: ${of("closed").length}`);

  const prs = JSON.parse(
    gh(["pr", "list", "--state", "open", "--json", "number,title,isDraft"]),
  ) as {
    number: number;
    title: string;
    isDraft: boolean;
  }[];
  console.log(`\nOPEN PULL REQUESTS (${prs.length})`);
  for (const pr of prs) console.log(`  #${pr.number} ${pr.title}${pr.isDraft ? " (draft)" : ""}`);
}

// The test imports the two pure functions above; only the CLI entry runs `gh`.
if (process.argv[1]?.endsWith("execution-state.ts")) main();
