/**
 * Frozen built-in assistant live tests that are known to fail on Claude Haiku 5.5 while the
 * built-in assistant path is held until after the alpha (#3000).
 *
 * Rules:
 * - Every listed test STILL runs in its nightly shard; nothing here skips a test.
 * - Only tests of the frozen built-in assistant belong here — never Check or Meetings tests.
 * - A listed failure is shown under "Known failing (frozen)" in the nightly summary and does not
 *   turn the night red.
 * - A listed test that starts passing turns the night red so this list never goes stale, unless
 *   `passesSomeRuns` records a measured partial pass rate (kept to a few entries, each with its
 *   issue and measured count).
 */
export interface KnownFailingEntry {
  /**
   * Exact Vitest `fullName` of the test (or its case prefix before ` run 1`..` run N` when `runs`
   * is set). Vitest's `test.each` / `describe.each` truncates long `$name`/`$title` interpolations
   * with `…`, so a few real `fullName`s contain `…`; `tests/eval/nightlyRealModel.test.ts` verifies
   * every entry against Vitest's collected live test names.
   */
  name: string;
  /** Live test file holding this test, relative to the repository root. */
  file: string;
  /** Tracking GitHub issue number. */
  issue: number;
  area: "built-in-assistant";
  reason: string;
  /**
   * When a live test generates `run 1`..`run N` as separate Vitest cases for one repeated trial,
   * list the case once with its run count so `knownFailingByName` matches all `N` runs.
   */
  runs?: number;
  /**
   * Measured partial pass rate for a frozen test that passes some nights and fails others.
   * Shown in the summary either way; turns the night red on neither pass nor fail.
   */
  passesSomeRuns?: string;
}

export const NIGHTLY_KNOWN_FAILING: readonly KnownFailingEntry[] = [
  {
    name: "Answer language, live: Anthropic with its key a short English Question over Chinese a…",
    file: "tests/live/answerLanguage.live.test.ts",
    issue: 3000,
    area: "built-in-assistant",
    reason: "Frozen built-in assistant path: Answer citations still checking when asserted",
  },
  {
    name: "Answer language, live: Anthropic with its key a Chinese Question over English Documen…",
    file: "tests/live/answerLanguage.live.test.ts",
    issue: 3000,
    area: "built-in-assistant",
    reason: "Frozen built-in assistant path: Answer citations still checking when asserted",
  },
  {
    name: "The Citations an Answer left out, on a real model each marker an Answer wrote without a record ends as a Citation found",
    file: "tests/live/citationsAsked.live.test.ts",
    issue: 3000,
    area: "built-in-assistant",
    reason: "Frozen built-in assistant path: no unrecorded marker resolved to Citation found",
  },
  {
    name: "claimed changes, live: Anthropic zh-CN: it edits a paragraph and says it added a t… 3 runs mark the claim every time",
    file: "tests/live/claimedChanges.live.test.ts",
    issue: 3000,
    area: "built-in-assistant",
    reason: "Frozen built-in assistant path: edit-claim marking intermittent on Haiku 5.5",
    passesSomeRuns: "1 of 3 runs passed on 2026-11-26",
  },
  {
    name: "the assistant's own summary claims, live: Anthropic zh-CN: the rewrite applied, some old text not … 3 runs leave the claim alone",
    file: "tests/live/ownSummaryClaims.live.test.ts",
    issue: 3000,
    area: "built-in-assistant",
    reason: "Frozen built-in assistant path: summary-claim check intermittent on Haiku 5.5",
    passesSomeRuns: "2 of 3 runs passed on 2026-11-26",
  },
  {
    name: "the assistant's own summary claims, live: Anthropic en: made longer, one sentence marked 3 runs leave the claim alone",
    file: "tests/live/ownSummaryClaims.live.test.ts",
    issue: 3000,
    area: "built-in-assistant",
    reason: "Frozen built-in assistant path: 0 of 3 runs passed on 2026-11-26",
  },
  {
    name: "training, store budget: a real model traces each figure to its assumptions and works out a what-if from the workbook",
    file: "tests/live/workbookFormulas.live.test.ts",
    issue: 3000,
    area: "built-in-assistant",
    reason: "Frozen built-in assistant path: workbook Answer missed 1 figure trace",
  },
  {
    name: "held out: a real model traces each figure to its assumptions and works out a what-if from the workbook",
    file: "tests/live/workbookFormulas.live.test.ts",
    issue: 3000,
    area: "built-in-assistant",
    reason: "Frozen built-in assistant path: workbook Answer missed 3 figure traces",
  },
  {
    name: "The assistant does what the User can in the app, live: Anthropic Anthropic: everyday requests run the one list's commands, in English and Chinese",
    file: "tests/live/assistantAppCommands.live.test.ts",
    issue: 3800,
    area: "built-in-assistant",
    reason: "Frozen built-in assistant path: Organize/Check routing and mixed replies (#3800)",
  },
  {
    name: "The assistant runs the app's commands, live: Anthropic claude-haiku-5-5: renames, moves, tags, exports and adds files on everyday requests, in English and Chinese",
    file: "tests/live/assistantCommands.live.test.ts",
    issue: 3000,
    area: "built-in-assistant",
    reason: "Frozen built-in assistant path: move-to-folder command missed",
  },
  {
    name: "Make the summary longer in a Note the assistant made, live: Anthropic Anthropic: the second request is carried out in the same Note, whose title stays",
    file: "tests/live/assistantNewNote.live.test.ts",
    issue: 3000,
    area: "built-in-assistant",
    reason: "Frozen built-in assistant path: 3 of 5 follow-up requests passed",
  },
  {
    name: "Where Citations go, live: Anthropic an Answer with Citations, added to a Mind, exports the same way in both modes",
    file: "tests/live/citationPlace.live.test.ts",
    issue: 3000,
    area: "built-in-assistant",
    reason: "Frozen built-in assistant path: unexpected PDF notes on exported Answer",
  },
  {
    name: "claimed commands, live (#2407): refused-opened-en 3 runs flag the reply only when it claims what wasn't done",
    file: "tests/live/claimedCommands.live.test.ts",
    issue: 3000,
    area: "built-in-assistant",
    reason: "Frozen built-in assistant path: refused-opened-en flagged 2 of 3 runs",
  },
  {
    name: "A Document with no headings, live: Anthropic its Citations name the Document and the paragraph, never '§ Start'",
    file: "tests/live/noHeadingCitation.live.test.ts",
    issue: 3000,
    area: "built-in-assistant",
    reason: "Frozen built-in assistant path: 0 citations recorded on no-heading Document",
  },
  {
    name: "Edit with AI, live: 14 honest edits are never refused for what they cite (#2424)",
    file: "tests/live/editPlacedCheck.live.test.ts",
    issue: 3000,
    area: "built-in-assistant",
    reason: "Frozen built-in assistant path: 3 of 14 honest edits refused as not-placed",
  },
  {
    name: "'This folder' in the assistant, live claude-haiku-5-5: a Folder in scope, the Library, or a Note in front is carried out and asks nothing; with none it asks, naming them",
    file: "tests/live/folderReference.live.test.ts",
    issue: 3799,
    area: "built-in-assistant",
    reason: "Frozen built-in assistant path: Note in Folder reads outside Folder (#3799)",
  },
  {
    name: "A Skill script whose package isn't included, on claude-haiku-5-5 own: first/rent (zh-CN)",
    file: "tests/live/skillScriptMissingPackage.live.test.ts",
    issue: 3000,
    area: "built-in-assistant",
    reason: "Frozen built-in assistant path: assistant intermittently skipped the Skill script",
    runs: 3,
    passesSomeRuns: "2 of 3 runs passed on 2026-11-26",
  },
  {
    name: "A Skill script whose package isn't included, on claude-haiku-5-5 own: fresh/glossary (en)",
    file: "tests/live/skillScriptMissingPackage.live.test.ts",
    issue: 3000,
    area: "built-in-assistant",
    reason: "Frozen built-in assistant path: assistant intermittently skipped the Skill script",
    runs: 3,
    passesSomeRuns: "1 of 3 runs passed on 2026-11-26",
  },
];

export const knownFailingNames = (entry: KnownFailingEntry): string[] =>
  entry.runs === undefined
    ? [entry.name]
    : Array.from({ length: entry.runs }, (_, index) => `${entry.name} run ${index + 1}`);

export const knownFailingByName = (
  entries: readonly KnownFailingEntry[] = NIGHTLY_KNOWN_FAILING,
): ReadonlyMap<string, KnownFailingEntry> =>
  new Map(entries.flatMap((entry) => knownFailingNames(entry).map((name) => [name, entry])));
