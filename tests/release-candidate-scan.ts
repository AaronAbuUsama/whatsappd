/**
 * The manifest and leak rules for the packed 0.3.0 tarball.
 *
 * Separated from the runner so the same functions the release proof relies on
 * are the ones the unit test drives — including the planted positives. A
 * self-test that exercises a different code path than the real scan certifies a
 * command nobody runs.
 */

/** The only non-`dist/` entries `files` is allowed to ship. */
export const INTENDED_ROOT_FILES: readonly string[] = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "package.json",
];

/**
 * Entry shapes that must never reach the tarball.
 *
 * The size gate catches a bundled dependency; only this catches a receipt or a
 * private path entering `files`. Held as pattern **sources** so the test can
 * assert each one still matches the thing it names.
 */
export const FORBIDDEN_TARBALL_ENTRY_SOURCES = [
  String.raw`^tests/`,
  String.raw`^\.proof-receipts/`,
  String.raw`^\.proof-private/`,
  String.raw`^\.changeset/`,
  String.raw`^docs/`,
  String.raw`\.map$`,
  String.raw`\.db$`,
] as const;

/** Account-shaped id patterns, as sources so the test can prove each one sees. */
export const ACCOUNT_SHAPED_SOURCE = [
  String.raw`\d{7,}(?::\d+)?@s\.whatsapp\.net`,
  String.raw`\d{7,}@lid`,
  String.raw`\d{7,}(?:-\d{7,})?@g\.us`,
] as const;

/**
 * Account-shaped ids the shipped package is expected to contain.
 *
 * These are the ids in the published JSDoc and README examples. The set is
 * checked in rather than derived from the artifact: derived, it would absorb
 * whatever the tarball happened to hold and could never fail. A new id in
 * `dist/` is a finding, and an id leaving this list is a finding too.
 */
export const PACKED_ALLOWLISTED_ACCOUNT_IDS = [
  "15551234567@s.whatsapp.net",
  "15551234567:12@s.whatsapp.net",
] as const;

/**
 * The planted positive.
 *
 * A plain, visible, allowlisted-synthetic group id — not one of the ids the
 * package is expected to ship — beside a private proof path. Both are the
 * shapes the real scan exists to catch, and it sits in a dotfile because that
 * is the corpus half a default `rg` and a non-recursive listing both miss.
 */
export const PLANTED_LEAK_CANARY =
  '{"chatId":"120363042384062365@g.us","log":".proof-private/packed.log"}';

export interface PackedCorpusFile {
  readonly path: string;
  readonly contents: string;
}

export interface PackedCorpusScan {
  readonly filesScanned: number;
  readonly hiddenFiles: number;
  /** Account-shaped ids the package is not sanctioned to ship. */
  readonly accountShapedHits: number;
  /** Of those, the ones found inside a dotfile. */
  readonly hitsInHiddenFiles: number;
  /** Sanctioned example ids, reported so an empty artifact cannot pass as clean. */
  readonly allowlistedSyntheticHits: number;
  readonly privatePathHits: number;
}

const isHidden = (entry: string): boolean =>
  entry.split("/").some((segment) => segment.startsWith("."));

export function scanPackedCorpus(corpus: readonly PackedCorpusFile[]): PackedCorpusScan {
  const patterns = ACCOUNT_SHAPED_SOURCE.map((source) => new RegExp(source, "gu"));
  const allowlisted = new Set<string>(PACKED_ALLOWLISTED_ACCOUNT_IDS);
  let hiddenFiles = 0;
  let accountShapedHits = 0;
  let hitsInHiddenFiles = 0;
  let allowlistedSyntheticHits = 0;
  let privatePathHits = 0;

  for (const file of corpus) {
    const hidden = isHidden(file.path);
    if (hidden) hiddenFiles += 1;
    if (file.contents.includes(".proof-private")) privatePathHits += 1;
    for (const pattern of patterns) {
      for (const [match] of file.contents.matchAll(pattern)) {
        if (allowlisted.has(match)) {
          allowlistedSyntheticHits += 1;
          continue;
        }
        accountShapedHits += 1;
        if (hidden) hitsInHiddenFiles += 1;
      }
    }
  }

  return {
    filesScanned: corpus.length,
    hiddenFiles,
    accountShapedHits,
    hitsInHiddenFiles,
    allowlistedSyntheticHits,
    privatePathHits,
  };
}
