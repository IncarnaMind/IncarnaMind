/**
 * The bars of `gates/call-help-earlier-calls.md` (#3005), computed from a paired run's rows of the
 * earlier-call set exactly as the file words them, and printed into its report. The baseline is
 * main's path (`calls-unmarked`), the candidate the branch (`today`). A pilot pairs main's path
 * with itself: then both arms are main's, and the section gives main's rate and how many runs the
 * gate's Claude Haiku 5.5 run needs.
 */
import { recordOf } from "./callHelpMarksReport";
import type { ArmRun } from "./paired";
import type { PairedRow } from "./pairedReport";

const SET = "call-help-earlier-calls";
const BUTTONS = ["say", "answer", "check"] as const;
const LANGUAGES = ["en", "zh-CN"] as const;
/** Main's `earlier-as-this` presses the gate needs to have shown the fault, and the pilot's aim. */
const SHOWN_AT = 4;
const PILOT_AIM = 6;
const PILOT_FLOOR = 3;
/** The share of the branch's "last time" questions bar 2 needs. */
const LAST_TIME_FLOOR = 0.75;

const isButton = (row: PairedRow) => row.kind !== "last-time";
/**
 * Which call of the pair was the earlier: the one that changes what the other said (b, d: "we'd
 * start in March now") or the one that first said it (a, c), from the case's id ("en-b-then-a").
 */
const ORDERS = [
  ["the earlier call brings the changes", /^[a-z]{2}-[bd]-then-/],
  ["the earlier call said it first", /^[a-z]{2}-[ac]-then-/],
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

function byOrder(rows: readonly PairedRow[], arms: readonly ("baseline" | "candidate")[]) {
  return ORDERS.map(([order, pattern]) => {
    const cell = rows.filter((row) => pattern.test(row.id));
    const shown = arms.reduce((sum, arm) => sum + count(cell, arm, shownAsThis), 0);
    return `${order}: ${shown} of ${cell.length * arms.length}`;
  }).join("; ");
}

/** A count on each arm, in all and by order: "main 3, the branch 1 (… : main 3, the branch 0; …)". */
function armsByOrder(rows: readonly PairedRow[], test: (run: ArmRun) => boolean) {
  const both = (cell: readonly PairedRow[]) =>
    `main ${count(cell, "baseline", test)}, the branch ${count(cell, "candidate", test)}`;
  const orders = ORDERS.map(
    ([order, pattern]) => `${order}: ${both(rows.filter((row) => pattern.test(row.id)))}`,
  );
  return `${both(rows)} (${orders.join("; ")})`;
}

function pilotSection(rows: readonly PairedRow[], model: string): string[] {
  const presses = rows.filter(isButton);
  const replies = presses.length * 2;
  const shown = count(presses, "baseline", shownAsThis) + count(presses, "candidate", shownAsThis);
  const rate = replies === 0 ? 0 : shown / replies;
  const perRun = rate * 8 * BUTTONS.length;
  const runsFor = (aim: number) => (perRun === 0 ? null : Math.ceil(aim / perRun));
  return [
    `**Pilot, ${model}: main's path against itself.** ${shown} of ${replies} of main's button replies are \`earlier-as-this\` (${(rate * 100).toFixed(1)}%), so a run of the gate's 24 presses an arm expects ${perRun.toFixed(2)} on main's arm.`,
    `Runs for an expected ${PILOT_AIM}: ${runsFor(PILOT_AIM) ?? "none reach it"}; for an expected ${PILOT_FLOOR}: ${runsFor(PILOT_FLOOR) ?? "none reach it"}. The gate file says how the stop then sets the runs.`,
    `By order: ${byOrder(presses, ["baseline", "candidate"])}.`,
    "",
    "Every reply, for the hand read:",
    ...presses.flatMap((row) => [listed(row, row.baseline), listed(row, row.candidate)]),
  ];
}

function gateSection(rows: readonly PairedRow[], model: string): string[] {
  const buttons = rows.filter(isButton);
  const lastTime = rows.filter((row) => !isButton(row));
  const done = (run: ArmRun) => run.status === "done";
  const both = (cell: readonly PairedRow[]) =>
    cell.filter((row) => done(row.baseline) && done(row.candidate));
  const mainShown = count(both(buttons), "baseline", shownAsThis);
  const branchShown = count(both(buttons), "candidate", shownAsThis);
  const bar1 =
    branchShown > 0
      ? "fails"
      : mainShown >= SHOWN_AT
        ? "holds"
        : `not shown: main's arm shows ${mainShown}, fewer than ${SHOWN_AT}, and the branch none. For the proof, not a pass: it is brought for a decision before any larger run. For the guard, it holds`;
  const asked = both(lastTime);
  const mainThen = count(asked, "baseline", answeredThen);
  const branchThen = count(asked, "candidate", answeredThen);
  const floor = Math.ceil(asked.length * LAST_TIME_FLOOR);
  const bar2 = branchThen >= mainThen && branchThen >= floor ? "holds" : "fails";
  const right = (run: ArmRun) => run.grade === "right";
  const mainRight = count(both(buttons), "baseline", right);
  const branchRight = count(both(buttons), "candidate", right);
  const newFalse = both(rows).filter(
    (row) => row.candidate.falseSupported > 0 && row.baseline.falseSupported === 0,
  ).length;
  const failedMain = rows.filter((row) => row.baseline.status === "failed").length;
  const failedBranch = rows.filter((row) => row.candidate.status === "failed").length;
  return [
    `**Bar 1, never this call's, ${model}: ${bar1}.** Button presses both arms finished: ${both(buttons).length}. \`earlier-as-this\`: main ${mainShown}, the branch ${branchShown}.`,
    "",
    `By order: main ${byOrder(both(buttons), ["baseline"])}; the branch ${byOrder(both(buttons), ["candidate"])}.`,
    "",
    "| Button | main, English | main, Chinese |",
    "|---|---|---|",
    ...byButtonAndLanguage(both(buttons), "baseline"),
    "",
    "| Button | the branch, English | the branch, Chinese |",
    "|---|---|---|",
    ...byButtonAndLanguage(both(buttons), "candidate"),
    "",
    `**Bar 2, last time still answered, ${model}: ${bar2}.** Of ${asked.length} "last time" questions both arms finished, given as said then, with when, and cited: main ${mainThen}, the branch ${branchThen} (at least ${floor} needed). By order: ${armsByOrder(asked, answeredThen)}.`,
    "",
    `**Bar 3, no worse on this call, ${model}: ${branchRight >= mainRight ? "holds" : "fails"}.** Button replies graded right: ${armsByOrder(both(buttons), right)}.`,
    "",
    `**Bar 4, no new false Supported, ${model}: ${newFalse === 0 ? "holds" : "fails"}.** Items with a false Supported on the branch and none on main: ${newFalse}. With any false Supported: ${armsByOrder(both(rows), (run) => run.falseSupported > 0)}.`,
    "",
    `**Bar 5, no more items failing, ${model}: ${failedBranch <= failedMain ? "holds" : "fails"}.** Failed to run: ${armsByOrder(rows, (run) => run.status === "failed")}.`,
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

/** The gate's section of a paired run's report, or null when the run holds none of the set. */
export function earlierCallsSection(
  all: readonly PairedRow[],
  arms: readonly [string, string],
): string | null {
  const rows = all.filter((row) => row.set === SET);
  if (rows.length === 0) return null;
  const pilot = arms[0] === arms[1];
  const lines = [
    `## The earlier-call gate (\`gates/call-help-earlier-calls.md\`)${pilot ? ": the pilot" : ""}`,
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
    lines.push(...(pilot ? pilotSection(cell, model) : gateSection(cell, model)), "");
  }
  return lines.join("\n");
}
