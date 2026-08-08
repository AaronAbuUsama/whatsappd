/**
 * Per-file coverage comparison between two lcov artifacts.
 *
 * The aggregate floor has ~1.8 points of headroom, so the aggregate is not the
 * gate — a file can lose its only test while the aggregate rises, which is
 * exactly what a large refactor does. This compares file by file.
 *
 * **Percentages are integers in hundredths of a point.** Comparing floats for
 * "did not drop" turns a rounding artifact into a regression report; comparing
 * `Math.round(pct * 100)` does not.
 *
 * `src/runtime/projection.ts` and `src/runtime/runtime.ts` carry a ±0.3-point
 * branch tolerance, because branch counting on those two files is
 * non-deterministic run to run on this codebase while their line and function
 * numbers are identical every time (validation contract,
 * X-coverage-floor-never-drops). The tolerance is branch-only and file-named:
 * it is not a general loosening, and lines and functions are never tolerated.
 */

export interface FileCoverage {
  readonly path: string;
  readonly linesHit: number;
  readonly linesFound: number;
  readonly functionsHit: number;
  readonly functionsFound: number;
  readonly branchesHit: number;
  readonly branchesFound: number;
  readonly uncoveredLines: readonly number[];
}

export type CoverageMetric = "lines" | "branches" | "functions";

export interface CoverageRegression {
  readonly path: string;
  readonly metric: CoverageMetric;
  readonly baseHundredths: number;
  readonly headHundredths: number;
  readonly baseUncovered: number;
  readonly headUncovered: number;
}

export interface CoverageComparison {
  readonly baseFileCount: number;
  readonly headFileCount: number;
  readonly comparedFileCount: number;
  readonly newAtHead: readonly string[];
  readonly removedAtHead: readonly string[];
  readonly regressions: readonly CoverageRegression[];
  readonly denominatorOnly: readonly string[];
  readonly preExistingSourceIdentityCount: number;
  readonly headUncoveredSourceIdentityCount: number;
  readonly newlyUncoveredPreExisting: readonly string[];
  readonly uncoveredNewSource: readonly string[];
  readonly aggregateBase: Readonly<Record<CoverageMetric, number>>;
  readonly aggregateHead: Readonly<Record<CoverageMetric, number>>;
}

/** Branch-only, file-named tolerance in hundredths of a point. */
export const BRANCH_TOLERANCE_HUNDREDTHS: ReadonlyMap<string, number> = new Map([
  ["src/runtime/projection.ts", 30],
  ["src/runtime/runtime.ts", 30],
]);

export const hundredths = (hit: number, found: number): number =>
  found === 0 ? 10_000 : Math.round((hit / found) * 10_000);

export function parseLcov(text: string): ReadonlyMap<string, FileCoverage> {
  const files = new Map<string, FileCoverage>();
  let path: string | undefined;
  let counters: Record<string, number> = {};
  let uncoveredLines: number[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      path = line.slice(3);
      counters = {};
      uncoveredLines = [];
    } else if (path && /^(LH|LF|FNH|FNF|BRH|BRF):/u.test(line)) {
      const [key, value] = line.split(":");
      if (key && value !== undefined) counters[key] = Number(value);
    } else if (path && line.startsWith("DA:")) {
      const [lineNumber, hits] = line.slice(3).split(",");
      if (Number(hits) === 0 && lineNumber !== undefined) uncoveredLines.push(Number(lineNumber));
    } else if (line === "end_of_record" && path) {
      // lcov paths are absolute and carry the worktree they were measured in,
      // so they must be made relative or base and head never match at all.
      const relative = /(?:^|\/)(src\/.*)$/u.exec(path)?.[1] ?? path;
      files.set(relative, {
        path: relative,
        linesHit: counters.LH ?? 0,
        linesFound: counters.LF ?? 0,
        functionsHit: counters.FNH ?? 0,
        functionsFound: counters.FNF ?? 0,
        branchesHit: counters.BRH ?? 0,
        branchesFound: counters.BRF ?? 0,
        uncoveredLines,
      });
      path = undefined;
    }
  }
  return files;
}

const sourceLineIdentities = (source: string): readonly string[] => {
  const occurrences = new Map<string, number>();
  return source.split("\n").map((line) => {
    const occurrence = (occurrences.get(line) ?? 0) + 1;
    occurrences.set(line, occurrence);
    return `${occurrence}:${line}`;
  });
};

const uncoveredSourceIdentities = (
  file: FileCoverage,
  source: string | undefined,
): readonly string[] => {
  if (source === undefined) return [];
  const lines = sourceLineIdentities(source);
  return file.uncoveredLines.flatMap((line) => {
    const identity = lines[line - 1];
    return identity === undefined ? [] : [`${file.path}:${identity}`];
  });
};

const metricsOf = (file: FileCoverage): Record<CoverageMetric, number> => ({
  lines: hundredths(file.linesHit, file.linesFound),
  branches: hundredths(file.branchesHit, file.branchesFound),
  functions: hundredths(file.functionsHit, file.functionsFound),
});

const uncoveredOf = (file: FileCoverage, metric: CoverageMetric): number =>
  metric === "lines"
    ? file.linesFound - file.linesHit
    : metric === "branches"
      ? file.branchesFound - file.branchesHit
      : file.functionsFound - file.functionsHit;

const aggregate = (files: Iterable<FileCoverage>): Record<CoverageMetric, number> => {
  let lh = 0;
  let lf = 0;
  let fnh = 0;
  let fnf = 0;
  let brh = 0;
  let brf = 0;
  for (const file of files) {
    lh += file.linesHit;
    lf += file.linesFound;
    fnh += file.functionsHit;
    fnf += file.functionsFound;
    brh += file.branchesHit;
    brf += file.branchesFound;
  }
  return {
    lines: hundredths(lh, lf),
    branches: hundredths(brh, brf),
    functions: hundredths(fnh, fnf),
  };
};

/**
 * Compare two lcov artifacts file by file.
 *
 * Throws on an empty comparison rather than returning a clean report: an
 * absence check over no corpus is the shape this mission keeps finding, and a
 * comparator that "passes" when both sides failed to parse is worse than none.
 */
export function compareCoverage(
  baseText: string,
  headText: string,
  options: {
    readonly onlyPrefix?: string;
    readonly baseSources?: ReadonlyMap<string, string>;
    readonly headSources?: ReadonlyMap<string, string>;
  } = {},
): CoverageComparison {
  const prefix = options.onlyPrefix ?? "src/";
  const keep = (path: string): boolean => path.startsWith(prefix);
  const base = [...parseLcov(baseText).values()].filter((file) => keep(file.path));
  const head = [...parseLcov(headText).values()].filter((file) => keep(file.path));
  const headByPath = new Map(head.map((file) => [file.path, file]));
  const baseByPath = new Map(base.map((file) => [file.path, file]));

  const regressions: CoverageRegression[] = [];
  const removedAtHead: string[] = [];
  const denominatorOnly: string[] = [];
  const preExistingSourceIdentities = new Set<string>();
  const baseUncoveredSourceIdentities = new Set<string>();
  const headUncoveredSourceIdentities = new Set<string>();
  const uncoveredNewSource: string[] = [];
  let comparedFileCount = 0;

  if ((options.baseSources === undefined) !== (options.headSources === undefined))
    throw new Error("refusing source-identity comparison with only one source corpus");

  if (options.baseSources && options.headSources) {
    for (const [filePath, source] of options.baseSources) {
      if (!keep(filePath)) continue;
      for (const identity of sourceLineIdentities(source))
        preExistingSourceIdentities.add(`${filePath}:${identity}`);
      const baseFile = baseByPath.get(filePath);
      if (baseFile)
        for (const identity of uncoveredSourceIdentities(baseFile, source))
          baseUncoveredSourceIdentities.add(identity);
    }
    for (const headFile of head) {
      const source = options.headSources.get(headFile.path);
      for (const identity of uncoveredSourceIdentities(headFile, source)) {
        headUncoveredSourceIdentities.add(identity);
        if (!preExistingSourceIdentities.has(identity)) uncoveredNewSource.push(identity);
      }
    }
  }

  for (const baseFile of base) {
    const headFile = headByPath.get(baseFile.path);
    if (!headFile) {
      removedAtHead.push(baseFile.path);
      continue;
    }
    comparedFileCount++;
    const baseMetrics = metricsOf(baseFile);
    const headMetrics = metricsOf(headFile);
    let regressed = false;
    for (const metric of ["lines", "branches", "functions"] as const) {
      const tolerance =
        metric === "branches" ? (BRANCH_TOLERANCE_HUNDREDTHS.get(baseFile.path) ?? 0) : 0;
      if (headMetrics[metric] < baseMetrics[metric] - tolerance) {
        regressed = true;
        regressions.push({
          path: baseFile.path,
          metric,
          baseHundredths: baseMetrics[metric],
          headHundredths: headMetrics[metric],
          baseUncovered: uncoveredOf(baseFile, metric),
          headUncovered: uncoveredOf(headFile, metric),
        });
      }
    }
    // A percentage can fall while nothing new became uncovered, because the
    // file's covered code shrank around the same misses — 97/100 becomes 27/30.
    // That is a different fact from losing coverage of code that had it, and it
    // is reported as its own category rather than being silently forgiven or
    // silently counted. It never suppresses the regression; it annotates it.
    if (
      regressed &&
      uncoveredOf(headFile, "lines") <= uncoveredOf(baseFile, "lines") &&
      uncoveredOf(headFile, "functions") <= uncoveredOf(baseFile, "functions") &&
      uncoveredOf(headFile, "branches") <= uncoveredOf(baseFile, "branches")
    ) {
      denominatorOnly.push(baseFile.path);
    }
  }

  if (comparedFileCount === 0)
    throw new Error("refusing a coverage comparison over no files: the corpus is empty");
  if (
    options.baseSources &&
    options.headSources &&
    (preExistingSourceIdentities.size === 0 || headUncoveredSourceIdentities.size === 0)
  )
    throw new Error(
      "refusing a source-identity comparison over an empty source or uncovered corpus",
    );

  const newlyUncoveredPreExisting = [...headUncoveredSourceIdentities]
    .filter(
      (identity) =>
        preExistingSourceIdentities.has(identity) && !baseUncoveredSourceIdentities.has(identity),
    )
    .sort();

  return {
    baseFileCount: base.length,
    headFileCount: head.length,
    comparedFileCount,
    newAtHead: head
      .filter((file) => !baseByPath.has(file.path))
      .map((file) => file.path)
      .sort(),
    removedAtHead: removedAtHead.sort(),
    regressions,
    denominatorOnly: denominatorOnly.sort(),
    preExistingSourceIdentityCount: preExistingSourceIdentities.size,
    headUncoveredSourceIdentityCount: headUncoveredSourceIdentities.size,
    newlyUncoveredPreExisting,
    uncoveredNewSource: uncoveredNewSource.sort(),
    aggregateBase: aggregate(base),
    aggregateHead: aggregate(head),
  };
}
