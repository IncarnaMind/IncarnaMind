/**
 * The bars of `gates/call-help-earlier-calls.md` (#3005), computed from a paired run's rows of
 * either round's earlier-call set exactly as the file words them, and printed into its report. The
 * baseline is main's path (`calls-unmarked`), the candidate the branch (`today`). A pilot pairs
 * main's path with itself: then both arms are main's, and the section gives main's rate and how
 * many runs the gate's Claude Haiku 5.5 run needs, or, run with no judge, lists the replies to be
 * read by hand. In the second round two readers count bars 1 and 2 by hand, blind to the arm, and
 * the section gives the judge's count beside theirs.
 */
import { recordOf } from "./callHelpMarksReport";
import { EARLIER_CALL_SETS, type EarlierCallSet, orderOf } from "./earlierCallsRounds";
import type { ArmRun } from "./paired";
import type { PairedRow } from "./pairedReport";

const BUTTONS = ["say", "answer", "check"] as const;
const LANGUAGES = ["en", "zh-CN"] as const;
/** Main's `earlier-as-this` presses the gate needs to have shown the fault, and the pilot's aim. */
const SHOWN_AT = 4;
const PILOT_AIM = 6;
const PILOT_FLOOR = 3;
/** The share of the branch's "last time" questions bar 2 needs. */
const LAST_TIME_FLOOR = 0.75;
const SECOND_ROUND: EarlierCallSet = "call-help-earlier-calls-2";

const isButton = (row: PairedRow) => row.kind !== "last-time";
/** Which call of the pair was the earlier, by the round's list in the gate file. */
const ORDERS = [
  ["the earlier call brings the changes", "brings-changes"],
  ["the earlier call said it first", "said-first"],
] as const;
const CUT_LANGUAGES = [
  ["English", "en"],
  ["Chinese", "zh-CN"],
] as const;
const shownAsThis = (run: ArmRun) => run.failures.includes("earlier-as-this");
/** "Last time" answered as bar 2 reads it: the earlier call's words as said then, with when, cited. */
const answeredThen = (run: ArmRun) =>
  run.status === "done" && run.callReading?.thenWithWhen === true && run.cited === true;
/** Places with ✓ beside a sentence putting an earlier call's line on this call (reported only). */
const checkedOnThisCall = (run: ArmRun) =>
  (run.places ?? []).filter(
    (place) =>
      place.call === "earlier" &&
      place.passed &&
      (run.callReading?.asThisCall ?? []).includes(place.number),
  ).length;

const count = (
  rows: readonly PairedRow[],
  arm: "baseline" | "candidate",
  test: (run: ArmRun) => boolean,
) => rows.filter((row) => test(row[arm])).length;

const inOrder = (set: EarlierCallSet, order: (typeof ORDERS)[number][1]) => (row: PairedRow) =>
  orderOf(set, row.id) === order;

/** One reply listed for a hand read: its item, reply and places. */
function listed(row: PairedRow, run: ArmRun): string {
  const places = (run.places ?? [])
    .map(
      (place) =>
        `  - [${place.number}] ${place.call}${place.passed ? ", ✓" : ""}${place.found ? "" : ", quote not found"}: "${place.line}" (${place.source}; quote "${place.quote}")`,
    )
    .join("\n");
  return [`- ${row.id} run ${row.run}: ${run.text.replace(/\n+/g, " / ")}`, places]
    .filter(Boolean)
    .join("\n");
}

function byButtonAndLanguage(rows: readonly PairedRow[], arm: "baseline" | "candidate") {
  return BUTTONS.map((button) => {
    const cells = LANGUAGES.map((language) => {
      const cell = rows.filter((row) => row.kind === button && row.language === language);
      return `${count(cell, arm, shownAsThis)} of ${cell.length}`;
    });
    return `| ${button} | ${cells.join(" | ")} |`;
  });
}

function byOrder(
  rows: readonly PairedRow[],
  arms: readonly ("baseline" | "candidate")[],
  set: EarlierCallSet,
) {
  return ORDERS.map(([order, which]) => {
    const cell = rows.filter(inOrder(set, which));
    const shown = arms.reduce((sum, arm) => sum + count(cell, arm, shownAsThis), 0);
    return `${order}: ${shown} of ${cell.length * arms.length}`;
  }).join("; ");
}

/**
 * A count on each arm, in all, by order and by language: "main 3, the branch 1 (the earlier call
 * brings the changes: main 3, the branch 0; …; English: …; Chinese: …)".
 */
function armsByCut(
  rows: readonly PairedRow[],
  test: (run: ArmRun) => boolean,
  set: EarlierCallSet,
) {
  const both = (cell: readonly PairedRow[]) =>
    `main ${count(cell, "baseline", test)}, the branch ${count(cell, "candidate", test)}`;
  const cuts = [
    ...ORDERS.map(([name, which]) => `${name}: ${both(rows.filter(inOrder(set, which)))}`),
    ...CUT_LANGUAGES.map(
      ([name, language]) => `${name}: ${both(rows.filter((row) => row.language === language))}`,
    ),
  ];
  return `${both(rows)} (${cuts.join("; ")})`;
}

function pilotSection(rows: readonly PairedRow[], model: string, set: EarlierCallSet): string[] {
  const presses = rows.filter(isButton);
  const judged = rows.some((row) => row.baseline.callReading || row.candidate.callReading);
  if (!judged) {
    return [
      `**Pilot, ${model}: main's path against itself, with no judge.** The ${presses.length} button presses' replies are read by hand: the first sample's, then the second's apart.`,
      "",
      "The first sample, for the hand read:",
      ...presses.map((row) => listed(row, row.baseline)),
      "",
      "The second sample:",
      ...presses.map((row) => listed(row, row.candidate)),
    ];
  }
  const replies = presses.length * 2;
  const shown = count(presses, "baseline", shownAsThis) + count(presses, "candidate", shownAsThis);
  const rate = replies === 0 ? 0 : shown / replies;
  const perRun = rate * 8 * BUTTONS.length;
  const runsFor = (aim: number) => (perRun === 0 ? null : Math.ceil(aim / perRun));
  return [
    `**Pilot, ${model}: main's path against itself.** ${shown} of ${replies} of main's button replies are \`earlier-as-this\` (${(rate * 100).toFixed(1)}%), so a run of the gate's 24 presses an arm expects ${perRun.toFixed(2)} on main's arm.`,
    `Runs for an expected ${PILOT_AIM}: ${runsFor(PILOT_AIM) ?? "none reach it"}; for an expected ${PILOT_FLOOR}: ${runsFor(PILOT_FLOOR) ?? "none reach it"}. The gate file says how the stop then sets the runs.`,
    `By order: ${byOrder(presses, ["baseline", "candidate"], set)}.`,
    "",
    "Every reply, for the hand read:",
    ...presses.flatMap((row) => [listed(row, row.baseline), listed(row, row.candidate)]),
  ];
}

function gateSection(rows: readonly PairedRow[], model: string, set: EarlierCallSet): string[] {
  const byHand = set === SECOND_ROUND;
  const buttons = rows.filter(isButton);
  const lastTime = rows.filter((row) => !isButton(row));
  const done = (run: ArmRun) => run.status === "done";
  const both = (cell: readonly PairedRow[]) =>
    cell.filter((row) => done(row.baseline) && done(row.candidate));
  const mainShown = count(both(buttons), "baseline", shownAsThis);
  const branchShown = count(both(buttons), "candidate", shownAsThis);
  const bar1 = byHand
    ? "counted by two readers blind to the arm; the judge's count beside theirs"
    : branchShown > 0
      ? "fails"
      : mainShown >= SHOWN_AT
        ? "holds"
        : `not shown: main's arm shows ${mainShown}, fewer than ${SHOWN_AT}, and the branch none. For the proof, not a pass: it is brought for a decision before any larger run. For the guard, it holds`;
  const asked = both(lastTime);
  const mainThen = count(asked, "baseline", answeredThen);
  const branchThen = count(asked, "candidate", answeredThen);
  const floor = Math.ceil(asked.length * LAST_TIME_FLOOR);
  const bar2 = byHand
    ? "counted by two readers blind to the arm; the judge's count beside theirs"
    : branchThen >= mainThen && branchThen >= floor
      ? "holds"
      : "fails";
  const right = (run: ArmRun) => run.grade === "right";
  const mainRight = count(both(buttons), "baseline", right);
  const branchRight = count(both(buttons), "candidate", right);
  const withFalse = (run: ArmRun) => run.falseSupported > 0;
  const mainFalse = count(both(rows), "baseline", withFalse);
  const branchFalse = count(both(rows), "candidate", withFalse);
  const newFalse = both(rows).filter(
    (row) => withFalse(row.candidate) && !withFalse(row.baseline),
  ).length;
  const bar4 = byHand
    ? `${branchFalse <= mainFalse ? "holds on the count" : "fails"}.** Items with a false Supported, the branch no more than main's, and none the change caused, each of the branch's read by hand: ${armsByCut(both(rows), withFalse, set)}. New on the branch: ${newFalse}.`
    : `${newFalse === 0 ? "holds" : "fails"}.** Items with a false Supported on the branch and none on main: ${newFalse}. With any false Supported: ${armsByCut(both(rows), withFalse, set)}.`;
  const failedMain = rows.filter((row) => row.baseline.status === "failed").length;
  const failedBranch = rows.filter((row) => row.candidate.status === "failed").length;
  return [
    `**Bar 1, never this call's, ${model}: ${bar1}.** Button presses both arms finished: ${both(buttons).length}. \`earlier-as-this\`: main ${mainShown}, the branch ${branchShown}.`,
    "",
    `By order: main ${byOrder(both(buttons), ["baseline"], set)}; the branch ${byOrder(both(buttons), ["candidate"], set)}.`,
    "",
    "| Button | main, English | main, Chinese |",
    "|---|---|---|",
    ...byButtonAndLanguage(both(buttons), "baseline"),
    "",
    "| Button | the branch, English | the branch, Chinese |",
    "|---|---|---|",
    ...byButtonAndLanguage(both(buttons), "candidate"),
    "",
    `**Bar 2, last time still answered, ${model}: ${bar2}.** Of ${asked.length} "last time" questions both arms finished, given as said then, with when, and cited: main ${mainThen}, the branch ${branchThen} (at least ${floor} needed). By order and language: ${armsByCut(asked, answeredThen, set)}.`,
    "",
    `**Bar 3, no worse on this call, ${model}: ${branchRight >= mainRight ? "holds" : "fails"}.** Button replies graded right: ${armsByCut(both(buttons), right, set)}.`,
    "",
    `**Bar 4, no new false Supported, ${model}: ${bar4}`,
    ...(byHand
      ? rows.flatMap((row) =>
          withFalse(row.candidate) ? [`the branch: ${listed(row, row.candidate)}`] : [],
        )
      : []),
    "",
    `**Bar 5, no more items failing, ${model}: ${failedBranch <= failedMain ? "holds" : "fails"}.** Failed to run: ${armsByCut(rows, (run) => run.status === "failed", set)}.`,
    "",
    `**Reported, ${model}: ✓ beside an earlier call's line in a sentence saying the other side said, asked or wants it in this call:** main ${rows.reduce((sum, row) => sum + checkedOnThisCall(row.baseline), 0)} places, the branch ${rows.reduce((sum, row) => sum + checkedOnThisCall(row.candidate), 0)}.`,
    "",
    `**Reported, ${model}: every \`earlier-as-this\` reply, with its places.**`,
    ...rows.flatMap((row) => [
      ...(shownAsThis(row.baseline) ? [`main: ${listed(row, row.baseline)}`] : []),
      ...(shownAsThis(row.candidate) ? [`the branch: ${listed(row, row.candidate)}`] : []),
    ]),
  ];
}

/** The judge's Citations line for each number a reply shows, from its saved places. */
export function citedOfPlaces(places: NonNullable<ArmRun["places"]>): string[] {
  const seen = new Set<number>();
  return places.flatMap((place) => {
    if (seen.has(place.number)) return [];
    seen.add(place.number);
    const documentName = place.source.split(" · ").slice(1, 3).join(" · ");
    const call = place.call === "earlier" ? "the earlier call" : "this call";
    return [
      `[${place.number}] ${documentName} (${call}): “${place.quote}” (${place.found ? "found" : "not found"})`,
    ];
  });
}

/**
 * The earlier call's start as the judge was given it: kept with the reply since this tool, else the
 * start a source line of that call shows in the case's replies, else none.
 */
export function earlierStartedOf(rows: readonly PairedRow[], caseId: string): string {
  const own = rows.find((row) => row.id.startsWith(`${caseId}-`));
  const kept = own?.baseline.callReading?.earlierStarted;
  if (kept) return kept;
  for (const row of rows.filter((each) => each.id.startsWith(`${caseId}-`))) {
    for (const run of [row.baseline, row.candidate]) {
      for (const place of run.places ?? []) {
        const shown =
          place.call === "earlier" ? /(?:started|开始于) (.+)$/.exec(place.source) : null;
        if (shown?.[1]) return shown[1];
      }
    }
  }
  return "";
}

/** The gate's sections of a paired run's report, one a round's set it holds, or null when it holds neither. */
export function earlierCallsSection(
  all: readonly PairedRow[],
  arms: readonly [string, string],
): string | null {
  const pilot = arms[0] === arms[1];
  const sections = EARLIER_CALL_SETS.flatMap((set) => {
    const rows = all.filter((row) => row.set === set);
    if (rows.length === 0) return [];
    const lines = [
      `## The earlier-call gate (\`gates/call-help-earlier-calls.md\`)${set === SECOND_ROUND ? ", round 2" : ""}${pilot ? ": the pilot" : ""}`,
      "",
    ];
    for (const model of [...new Set(rows.map((row) => row.model))]) {
      const cell = rows.filter((row) => row.model === model);
      const record = recordOf(cell);
      lines.push(
        `**Requests, ${model}:** ${record.requests} model requests in the record, ${record.unfinished} of them ended other than finished.`,
        "",
      );
      if (record.voids.length > 0) {
        lines.push(
          `**Void, ${model}: its bars are not read, and it isn't run again before its reasons are read.** ${record.voids.join("; ")}.`,
          "",
        );
      }
      lines.push(...(pilot ? pilotSection(cell, model, set) : gateSection(cell, model, set)), "");
    }
    return [lines.join("\n")];
  });
  return sections.length === 0 ? null : sections.join("\n");
}
