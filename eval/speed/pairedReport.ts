/**
 * What a paired run comes to (README.md › Paired runs), per model and set: each arm's times,
 * calls and tokens, the candidate against the baseline item by item, and the quality guards, each
 * held or not; then every item, both arms side by side.
 */
import type { ArmRun, Language, RequestTiming, SetId } from "./paired";
import { percentile } from "./report";

export interface PairedRow {
  set: SetId;
  id: string;
  kind: string;
  language: Language;
  model: string;
  /** Which time this item ran, from 1. */
  run: number;
  /** The arm that ran first in this pair: 0 the baseline, 1 the candidate. */
  first: 0 | 1;
  baseline: ArmRun;
  candidate: ArmRun;
}

/**
 * Which arm goes first in each pair of a run (#2791). The order turns from pair to pair within each
 * cell of the run, a model on a set in one language (`cellOf`), so in each cell each arm goes first
 * in half the pairs, give or take one, whatever groups, models and languages the run holds:
 * neither arm always meets a cache, or a model's load, that the other warmed.
 */
export function armTurns(): (cell: string) => readonly [0 | 1, 0 | 1] {
  const pairs = new Map<string, number>();
  return (cell) => {
    const before = pairs.get(cell) ?? 0;
    pairs.set(cell, before + 1);
    return before % 2 === 0 ? [0, 1] : [1, 0];
  };
}

/** The cell of a run a pair is counted in: its model, on its set, in its language. */
export const cellOf = (row: Pick<PairedRow, "model" | "set" | "language">) =>
  `${row.model} · ${row.set} · ${row.language}`;

/** How many of `rows` each arm went first in, baseline then candidate. */
export const wentFirst = (rows: readonly Pick<PairedRow, "first">[]): [number, number] => [
  rows.filter((row) => row.first === 0).length,
  rows.filter((row) => row.first === 1).length,
];

/** The same, cell by cell, in the order the cells first ran. */
export function wentFirstByCell(
  rows: readonly Pick<PairedRow, "first" | "model" | "set" | "language">[],
): [string, [number, number]][] {
  const cells = [...new Set(rows.map(cellOf))];
  return cells.map((cell) => [cell, wentFirst(rows.filter((row) => cellOf(row) === cell))]);
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
 * better holds with up to `margin` fewer items in 30; one where more is worse, with none new, or,
 * `noMore`, with no more items than the baseline has.
 */
function guard(
  name: string,
  rows: readonly PairedRow[],
  good: Flag,
  counted: Flag,
  higherIsBetter: boolean,
  margin = 0,
  noMore = false,
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
    holds: higherIsBetter
      ? candidate >= baseline - allowed
      : noMore
        ? candidate <= baseline
        : lost === 0,
  };
}

/**
 * The plan's gate on the items both arms finished: no fewer items citing their expected
 * Passages, judged right, or with every Citation found than `margin` in 30 allows (none by
 * default); no new false Supported, duplicate Answer or change claimed that no Tool made; and no
 * more items failing to run.
 */
export function guards(
  rows: readonly PairedRow[],
  margin = 0,
  /** False Supported counted over the set: no more items with one than the baseline (`FALSE_SUPPORTED=counted`). */
  falseSupportedCounted = false,
): Guard[] {
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
    guard(
      "False Supported",
      rows,
      (run) => run.falseSupported > 0,
      all,
      false,
      0,
      falseSupportedCounted,
    ),
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
  const sign = difference < 0 ? "−" : difference > 0 ? "+" : "±";
  return `${sign}${seconds(Math.abs(difference))}, sooner in ${sooner} of ${pairs.length}`;
}

export function pairedSection(
  rows: readonly PairedRow[],
  names: [string, string],
  margin = 0,
  /** False: the rows are part of a set the guards hold on as a whole, so none is judged here. */
  judged = true,
  falseSupportedCounted = false,
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
  const counted = (run: (row: PairedRow) => ArmRun) =>
    rows.map(run).filter((each) => each.status === "done" && each.searches !== null);
  const searchedAgain = (run: (row: PairedRow) => ArmRun) => {
    const done = counted(run);
    return `${done.filter((each) => (each.searches ?? 0) > 1).length} of ${done.length}`;
  };
  const holds = (each: Guard) =>
    `${each.holds ? "yes" : "**no**"}${each.allowed > 0 ? ` (${each.allowed} fewer allowed)` : ""}`;
  const rule = (each: Guard) =>
    `| ${each.name} | ${each.baseline} | ${each.candidate} | ${each.lost} / ${each.gained} | ${judged ? holds(each) : "–"} |`;
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
    ...(counted((row) => row.candidate).length > 0
      ? [
          `| Searched more than once | ${searchedAgain((row) => row.baseline)} | ${searchedAgain((row) => row.candidate)} | |`,
        ]
      : []),
    "",
    `| Guard, items both finished | ${a} | ${b} | lost / gained | holds |`,
    "|---|---|---|---|---|",
    ...guards(rows, margin, falseSupportedCounted).map(rule),
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

/**
 * Where an item's time went, for items that read their requests (a help reply): each arm's
 * median, from the User's action, to its first request, to each of the Answer's own requests'
 * first byte, first text and end, and to its first whole option; the requests made for other
 * steps, the time spent reasoning, the steps on this computer, and the first request's tokens.
 */
export function timeTable(rows: readonly PairedRow[], names: [string, string]): string {
  const runs = (pick: (row: PairedRow) => ArmRun) =>
    rows.map(pick).filter((run) => run.status === "done" && run.requests);
  const arms = [runs((row) => row.baseline), runs((row) => row.candidate)] as const;
  const requests = (run: ArmRun) => run.requests ?? [];
  const own = (run: ArmRun) =>
    requests(run).filter((request) => request.kind === "model" && request.step === null);
  const time = (label: string, value: (run: ArmRun) => number | null) =>
    `| ${label} | ${arms.map((runs) => seconds(percentile(known(runs.map(value)), 0.5))).join(" | ")} |`;
  const counted = (label: string, value: (run: ArmRun) => number) =>
    `| ${label} | ${arms.map((runs) => mean(runs.map(value))).join(" | ")} |`;
  const tokens = (label: string, value: (run: ArmRun) => number | null) =>
    `| ${label} | ${arms.map((runs) => percentile(known(runs.map(value)), 0.5) ?? "–").join(" | ")} |`;
  const at = (index: number, mark: (request: RequestTiming) => number | null) => (run: ArmRun) => {
    const request = own(run)[index];
    const ms = request ? mark(request) : null;
    return request && ms !== null ? request.startMs + ms : null;
  };
  const most = Math.max(0, ...arms.flat().map((run) => own(run).length));
  const others = [
    ...new Set(
      arms
        .flat()
        .flatMap((run) =>
          requests(run).flatMap((request) =>
            request.kind === "model" && request.step === null
              ? []
              : [`${request.kind}:${request.step}`],
          ),
        ),
    ),
  ];
  const ofKey = (run: ArmRun, key: string) =>
    requests(run).filter((request) => `${request.kind}:${request.step}` === key);
  const reasoning = (run: ArmRun) =>
    requests(run).reduce((sum, request) => {
      if (request.firstReasoningMs === null) return sum;
      const until = request.firstTextMs ?? request.firstToolMs ?? request.endMs;
      return sum + Math.max(0, until - request.firstReasoningMs);
    }, 0);
  return [
    `| From the User's action (median; counts are means) | ${names[0]} | ${names[1]} |`,
    "|---|---|---|",
    time(
      "First request sent",
      (run) => requests(run).find((each) => each.kind === "model")?.startMs ?? null,
    ),
    ...Array.from({ length: most }, (_, index) => [
      time(
        `Request ${index + 1}: first byte`,
        at(index, (request) => request.firstByteMs),
      ),
      time(
        `Request ${index + 1}: first text`,
        at(index, (request) => request.firstTextMs),
      ),
      time(
        `Request ${index + 1}: end`,
        at(index, (request) => request.endMs),
      ),
    ]).flat(),
    time("First whole option", (run) => run.firstOptionMs ?? null),
    counted("The reply's own requests", (run) => own(run).length),
    counted("Written again by another model (share)", (run) =>
      new Set(own(run).map((request) => request.model)).size > 1 ? 1 : 0,
    ),
    ...others.flatMap((key) => {
      const [kind, step] = key.split(":");
      const name = kind === "local" ? `On this computer: ${step}` : `Requests for ${step}`;
      return [
        counted(`${name}, how many`, (run) => ofKey(run, key).length),
        time(`${name}, each`, (run) =>
          percentile(
            ofKey(run, key).map((each) => each.endMs),
            0.5,
          ),
        ),
      ];
    }),
    time("Reasoning, all requests", reasoning),
    tokens("Input tokens, first request", (run) => own(run)[0]?.inputTokens ?? null),
  ].join("\n");
}
