/**
 * Attribute the defect ledger's review rounds to the pull requests that ran
 * them.
 *
 * `X-four-round-ceiling-forces-replan` is a **per-PR** rule: at most four
 * rounds per pull request, with the numeric counter restarting at 1 for each
 * one while the class history above it does not reset. The check this replaces
 * took a single `Math.max` over every `### Round N` heading in the document and
 * compared it to 4.
 *
 * That number cannot see the rule. A global maximum is blind to which PR ran
 * which round, so it cannot tell a counter that restarted per PR from one that
 * carried over — and carrying over is precisely the PR #93/#94 failure this
 * ledger exists to prevent, where one review loop was relabelled as two
 * attempts. It also lets a replan recorded on any one PR satisfy the ceiling
 * for every other.
 *
 * Attribution is mechanical rather than editorial: each round heading carries
 * the commit it was requested against, and a commit belongs to exactly one pull
 * request. A heading whose sha matches no mission PR is a finding, not a
 * silently dropped row — an unattributed round is exactly how a review loop
 * goes unrecorded.
 */

/** A `### Round N — \`sha\`` heading, as written. */
export interface LedgerRoundHeading {
  readonly round: number;
  readonly commit: string;
  /** The `## ` section the heading sits under, used to scope the replan text. */
  readonly section: string;
}

export interface PullRequestRounds {
  readonly number: number;
  /** Round headings whose commit is one of this PR's commits. */
  readonly roundsAttributed: number;
  readonly highestRoundNumber: number;
  readonly lowestRoundNumber: number;
  /** The counter restarts per PR. Vacuously true for a PR with no rounds. */
  readonly counterRestartsAtOne: boolean;
  /** Exactly 1..N, with no duplicate label and no missing round. */
  readonly roundNumbersSequential: boolean;
  readonly withinCeiling: boolean;
  /** The ceiling forces a replan; below it, one is permitted but not required. */
  readonly replanRequired: boolean;
  readonly replanRecorded: boolean;
}

export interface LedgerRoundReport {
  readonly headings: readonly LedgerRoundHeading[];
  readonly pullRequests: readonly PullRequestRounds[];
  /** Headings whose commit belongs to no mission PR. Any is a refusal. */
  readonly unattributedCommits: readonly string[];
  /** One shared class list rather than a per-PR one — the "does not reset" shape. */
  readonly classCount: number;
  readonly classSectionCount: number;
  readonly classIds: readonly number[];
  readonly missingRequiredClassIds: readonly number[];
}

const ROUND_HEADING = /^### Round (\d+) — `([0-9a-f]{7,40})`/gmu;
const CLASS_HEADING = /^### C(\d+) —/gmu;
const REPLAN = /Replanned rather than patched again/u;

/** Defect classes present before the release-candidate review began. */
export const REQUIRED_DEFECT_CLASS_IDS = [1, 2, 3, 4, 5, 6, 8, 9, 10] as const;

/** The section a character offset falls in, by `## ` heading. */
function sectionsOf(text: string): readonly { readonly title: string; readonly body: string }[] {
  const matches = [...text.matchAll(/^## (.+)$/gmu)];
  return matches.map((match, index) => ({
    title: match[1]!.trim(),
    body: text.slice(match.index!, matches[index + 1]?.index ?? text.length),
  }));
}

/**
 * Read the ledger against the commits each pull request actually carries.
 *
 * `commitsByPullRequest` comes from the GitHub API, so the attribution is
 * against the durable graph rather than against a name written in prose beside
 * the round.
 */
export function parseLedgerRounds(
  ledgerText: string,
  commitsByPullRequest: ReadonlyMap<number, readonly string[]>,
  roundCeiling: number,
  requiredClassIds: readonly number[] = [],
): LedgerRoundReport {
  const sections = sectionsOf(ledgerText);
  const sectionFor = (offset: number): string => {
    let title = "";
    let cursor = -1;
    for (const match of ledgerText.matchAll(/^## (.+)$/gmu))
      if (match.index! <= offset && match.index! > cursor) {
        cursor = match.index!;
        title = match[1]!.trim();
      }
    return title;
  };

  const headings: LedgerRoundHeading[] = [...ledgerText.matchAll(ROUND_HEADING)].map((match) => ({
    round: Number(match[1]),
    commit: match[2]!,
    section: sectionFor(match.index!),
  }));

  // A commit prefix identifies a PR when either side is a prefix of the other:
  // the ledger writes seven characters and the API returns forty.
  const ownerOf = (commit: string): number | undefined => {
    for (const [number, commits] of commitsByPullRequest)
      if (commits.some((sha) => sha.startsWith(commit) || commit.startsWith(sha))) return number;
    return undefined;
  };

  const pullRequests = [...commitsByPullRequest.keys()].map((number): PullRequestRounds => {
    const mine = headings.filter((heading) => ownerOf(heading.commit) === number);
    const numbers = mine.map(({ round }) => round);
    const sortedNumbers = [...numbers].sort((left, right) => left - right);
    const highestRoundNumber = numbers.length === 0 ? 0 : Math.max(...numbers);
    const lowestRoundNumber = numbers.length === 0 ? 0 : Math.min(...numbers);
    const roundNumbersSequential =
      numbers.length === 0 ||
      (new Set(numbers).size === numbers.length &&
        sortedNumbers.every((round, index) => round === index + 1));
    // Scoped to this PR's own sections: a replan recorded on another PR says
    // nothing about this one, which is what a single global boolean asserted.
    const bodies = sections
      .filter((section) => mine.some((heading) => heading.section === section.title))
      .map(({ body }) => body)
      .join("\n");
    const replanRequired = highestRoundNumber >= roundCeiling;
    return {
      number,
      roundsAttributed: mine.length,
      highestRoundNumber,
      lowestRoundNumber,
      counterRestartsAtOne: numbers.length === 0 || lowestRoundNumber === 1,
      roundNumbersSequential,
      withinCeiling:
        roundNumbersSequential && mine.length <= roundCeiling && highestRoundNumber <= roundCeiling,
      replanRequired,
      replanRecorded: REPLAN.test(bodies),
    };
  });

  const classIds = [...ledgerText.matchAll(CLASS_HEADING)]
    .map((match) => Number(match[1]))
    .sort((left, right) => left - right);
  const classIdSet = new Set(classIds);

  return {
    headings,
    pullRequests,
    unattributedCommits: headings
      .filter((heading) => ownerOf(heading.commit) === undefined)
      .map(({ commit }) => commit),
    classCount: classIds.length,
    // The class list lives under one `## Classes` heading shared by every PR.
    // A second one would be a per-PR class history, which is the reset the
    // contract forbids.
    classSectionCount: sections.filter(({ title }) => title === "Classes").length,
    classIds,
    missingRequiredClassIds: [...new Set(requiredClassIds)]
      .filter((id) => !classIdSet.has(id))
      .sort((left, right) => left - right),
  };
}
