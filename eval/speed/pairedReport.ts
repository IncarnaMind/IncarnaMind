/**
 * What a paired run comes to (README.md › Paired runs), per model and set: each arm's times,
 * calls and tokens, the candidate against the baseline item by item, and the quality guards, each
 * held or not; then every item, both arms side by side.
 */
import type { ArmRun, Language, SetId } from "./paired";
import { percentile } from "./report";

export interface PairedRow {
  set: SetId;
  id: string;
  kind: string;
  language: Language;
  model: string;
  /** Which time this item ran, from 1. */
  run: number;
  baseline: ArmRun;
  candidate: ArmRun;
}

/** The candidate gave a false Supported on an item the baseline didn't: the run stops there. */
export const newFalseSupported = (row: Pick<PairedRow, "baseline" | "candidate">) =>
  row.candidate.falseSupported > row.baseline.falseSupported;

export interface Guard {
  name: string;
  baseline: number;
  candidate: number;
  /** Items the baseline had right and the candidate not, and the other way round. */
  lost: number;
  gained: number;
  /** How many fewer items the candidate may have and still hold. */
  allowed: number;
  holds: boolean;
}

type Flag = (run: ArmRun) => boolean;

/**
 * A guard over the items both arms finished that it applies to (`counted`). One where more is
 * better holds with up to `margin` fewer items in 30; one where more is worse, with none new.
 */
function guard(
  name: string,
  rows: readonly PairedRow[],
  good: Flag,
  counted: Flag,
  higherIsBetter: boolean,
  margin = 0,
): Guard | null {
  const both = rows.filter(
    (row) =>
      row.baseline.status === "done" &&
      row.candidate.status === "done" &&
      counted(row.baseline) &&
      counted(row.candidate),
  );
  if (both.length === 0) return null;
  const baseline = both.filter((row) => good(row.baseline)).length;
  const candidate = both.filter((row) => good(row.candidate)).length;
  const lost = both.filter((row) =>
    higherIsBetter
      ? good(row.baseline) && !good(row.candidate)
      : !good(row.baseline) && good(row.candidate),
  ).length;
  const gained = both.filter((row) =>
    higherIsBetter
      ? !good(row.baseline) && good(row.candidate)
      : good(row.baseline) && !good(row.candidate),
  ).length;
  const allowed = higherIsBetter ? Math.floor((both.length * margin) / 30) : 0;
  return {
    name,
    baseline,
    candidate,
    lost,
    gained,
    allowed,
    holds: higherIsBetter ? candidate >= baseline - allowed : lost === 0,
  };
}

/**
 * The plan's gate on the items both arms finished: no fewer items citing their expected
 * Passages, judged right, or with every Citation found than `margin` in 30 allows (none by
 * default); no new false Supported, duplicate Answer or change claimed that no Tool made; and no
 * more items failing to run.
 */
export function guards(rows: readonly PairedRow[], margin = 0): Guard[] {
  const all: Flag = () => true;
  const found: Flag = (run) => run.citations > 0 && run.found === run.citations;
  return [
    guard(
      "Expected Passages cited",
      rows,
      (run) => run.cited === true,
      (run) => run.cited !== null,
      true,
      margin,
    ),
    guard(
      "Judged right",
      rows,
      (run) => run.grade === "right",
      (run) => run.grade !== null,
      true,
      margin,
    ),
    guard("Every Citation found", rows, found, (run) => run.citations > 0, true, margin),
    guard("False Supported", rows, (run) => run.falseSupported > 0, all, false),
    guard("Duplicate Answer", rows, (run) => run.duplicate, all, false),
    guard(
      "Change claimed, none made",
      rows,
      (run) => run.failures.includes("unbacked"),
      all,
      false,
    ),
    guard(
      "Other guard failed",
      rows,
      (run) => run.failures.some((kind) => kind !== "unbacked"),
      all,
      false,
    ),
    {
      name: "Failed to run",
      baseline: rows.filter((row) => row.baseline.status === "failed").length,
      candidate: rows.filter((row) => row.candidate.status === "failed").length,
      lost: rows.filter(
        (row) => row.baseline.status === "done" && row.candidate.status === "failed",
      ).length,
      gained: rows.filter(
        (row) => row.baseline.status === "failed" && row.candidate.status === "done",
      ).length,
      allowed: 0,
      holds:
        rows.filter((row) => row.candidate.status === "failed").length <=
        rows.filter((row) => row.baseline.status === "failed").length,
    },
  ].flatMap((each) => (each ? [each] : []));
}

export const seconds = (ms: number | null) => (ms === null ? "–" : `${(ms / 1000).toFixed(1)} s`);
const known = (values: readonly (number | null)[]) =>
  values.filter((value): value is number => value !== null);
const spread = (values: readonly (number | null)[]) => {
  const some = known(values);
  return `${seconds(percentile(some, 0.5))} / ${seconds(percentile(some, 0.9))}`;
};
const mean = (values: readonly number[]) =>
  values.length === 0
    ? "–"
    : (values.reduce((sum, each) => sum + each, 0) / values.length).toFixed(2);

/** The candidate's time against the baseline's on the items both have: the median difference, and how often it is sooner. */
function paired(rows: readonly PairedRow[], pick: (run: ArmRun) => number | null): string {
  const pairs = rows.flatMap((row) => {
    const a = pick(row.baseline);
    const b = pick(row.candidate);
    return a === null || b === null ? [] : [{ a, b }];
  });
  if (pairs.length === 0) return "–";
  const difference = percentile(
    pairs.map(({ a, b }) => b - a),
    0.5,
  ) as number;
  const sooner = pairs.filter(({ a, b }) => b < a).length;
  return `${difference <= 0 ? "−" : "+"}${seconds(Math.abs(difference))}, sooner in ${sooner} of ${pairs.length}`;
}

export function pairedSection(
  rows: readonly PairedRow[],
  names: [string, string],
  margin = 0,
): string {
  const [a, b] = names;
  const of = (pick: (run: ArmRun) => number | null) =>
    `| ${spread(rows.map((row) => pick(row.baseline)))} | ${spread(rows.map((row) => pick(row.candidate)))} | ${paired(rows, pick)} |`;
  const tokens = (run: (row: PairedRow) => ArmRun) => {
    const median = (pick: (each: ArmRun) => number) =>
      percentile(
        rows.map((row) => pick(run(row))),
        0.5,
      ) ?? "–";
    return `${median((each) => each.inputTokens)} / ${median((each) => each.outputTokens)}`;
  };
  const found = (run: (row: PairedRow) => ArmRun) =>
    `${rows.reduce((sum, row) => sum + run(row).found, 0)} of ${rows.reduce((sum, row) => sum + run(row).citations, 0)}`;
  const oneCall = (run: (row: PairedRow) => ArmRun) => {
    const done = rows.map(run).filter((each) => each.status === "done");
    return `${done.filter((each) => each.answerCalls === 1).length} of ${done.length}`;
  };
  const rule = (each: Guard) =>
    `| ${each.name} | ${each.baseline} | ${each.candidate} | ${each.lost} / ${each.gained} | ${each.holds ? "yes" : "**no**"}${each.allowed > 0 ? ` (${each.allowed} fewer allowed)` : ""} |`;
  return [
    `| | ${a} | ${b} | ${b} against ${a}, item by item |`,
    "|---|---|---|---|",
    `| First sign (median / p90) ${of((run) => run.firstSignMs)}`,
    `| First words ${of((run) => run.firstWordsMs)}`,
    `| Done ${of((run) => run.doneMs)}`,
    `| Model calls (mean) | ${mean(rows.map((row) => row.baseline.modelCalls))} | ${mean(rows.map((row) => row.candidate.modelCalls))} | |`,
    `| Tokens in / out (median) | ${tokens((row) => row.baseline)} | ${tokens((row) => row.candidate)} | |`,
    `| Citations found | ${found((row) => row.baseline)} | ${found((row) => row.candidate)} | |`,
    `| Answered in one call | ${oneCall((row) => row.baseline)} | ${oneCall((row) => row.candidate)} | |`,
    "",
    `| Guard, items both finished | ${a} | ${b} | lost / gained | holds |`,
    "|---|---|---|---|---|",
    ...guards(rows, margin).map(rule),
  ].join("\n");
}

/** What an arm's run of an item came to, beyond its times. */
export const outcomeOf = (run: ArmRun) =>
  [
    run.status === "failed" ? `failed: ${(run.error ?? "").slice(0, 60)}` : null,
    run.cited === null ? null : run.cited ? "cited" : "not cited",
    run.grade,
    run.citations > 0 ? `found ${run.found}/${run.citations}` : null,
    run.falseSupported > 0 ? `${run.falseSupported} false Supported` : null,
    run.duplicate ? "twice" : null,
    ...run.failures,
  ]
    .filter(Boolean)
    .join(", ");

export function itemTable(rows: readonly PairedRow[], names: [string, string]): string {
  const [a, b] = names;
  return [
    `| Item | Language | Words, ${a} / ${b} | Done | Calls | ${a} | ${b} |`,
    "|---|---|---|---|---|---|---|",
    ...rows.map(
      (row) =>
        `| ${row.id}${row.run > 1 ? ` #${row.run}` : ""} | ${row.language} | ${seconds(row.baseline.firstWordsMs)} / ${seconds(row.candidate.firstWordsMs)} | ${seconds(row.baseline.doneMs)} / ${seconds(row.candidate.doneMs)} | ${row.baseline.modelCalls} / ${row.candidate.modelCalls} | ${outcomeOf(row.baseline)} | ${outcomeOf(row.candidate)} |`,
    ),
  ].join("\n");
}
