/**
 * Every bar of #3019 step 3's plan (`gates/research-step3.md`), read against main in the same run
 * from both arms' everyday reports: main's and the branch's, each run's `report.json`. A run with a
 * request the provider refused, failed or let time out is void: the bars aren't read while one is.
 * The second look's bars are struck, as the plan's changes say.
 */
import type { CaseResult } from "./asking";
import {
  type CheckRow,
  type CostOf,
  checkRows,
  dollars,
  fromReplyLines,
  median,
  totalCost,
  unstatedLines,
} from "./checkReport";
import { type NotFoundSentence, notFoundSentences } from "./notFound";
import { countedVerdict, type SentenceSupport } from "./support";

export interface ArmRun {
  /** Where its report was read from, to name it. */
  folder: string;
  results: readonly CaseResult[];
  /** Each try of a request the provider refused or failed, though a retry then answered it. */
  failedTries?: readonly string[];
}

export interface ArmsReading {
  lines: string[];
  /** Each request or check that voids its run; none read when there is one. */
  voided: string[];
  /** How the arms' Answers differ by request, model or language; none read when they do. */
  unmatched: string[];
  /** Each bar that failed. */
  failed: string[];
  /** Each bar the reports can't read, or that is read by hand. */
  unread: string[];
}

/** The plan's bars, fixed before the run. */
const SUPPORTED_MARGIN = 0.12;
const JOINED_SHARE = 0.1;
const DROPPED_ALLOWED = 2;

/** A check's or a request's failure that the provider refused, failed or let time out. */
const VOIDING = new Set<string>([
  "refused",
  "rate-limit",
  "out-of-credit",
  "plan-limit",
  "cost-cap",
  "failed",
  "timed-out",
  "answer-failed",
  "stopped",
]);

interface Answer {
  id: string;
  model: string;
  language: string;
  reply: string;
  support: SentenceSupport[];
  checkSeconds?: number;
  notFound: NotFoundSentence[];
  answering?: number[];
}

type Listed = SentenceSupport & { id: string; model: string; language: string };

/** A sentence as an older record kept it, its own Citations' quotes under `quotes`. */
type Recorded = SentenceSupport & { quotes?: SentenceSupport["cites"] };

function answersOf(runs: readonly ArmRun[]): Answer[] {
  return runs.flatMap(({ results }) =>
    results.flatMap((each) =>
      each.support
        ? [
            {
              id: each.id,
              model: each.model,
              language: each.language,
              reply: each.reply,
              support: each.support.map((sentence: Recorded) => ({
                ...sentence,
                cites: sentence.cites ?? sentence.quotes ?? [],
              })),
              checkSeconds: each.checkSeconds,
              notFound: each.notFound ?? notFoundSentences(each.reply),
              answering: each.answering,
            },
          ]
        : [],
    ),
  );
}

/** Each request or check of the runs that voids its run, named by its report and request. */
export function voidReasons(runs: readonly ArmRun[]): string[] {
  return runs.flatMap(({ folder, results, failedTries = [] }) => [
    ...failedTries.map(
      (each) => `${folder}: a request's try failed, though a retry answered: ${each}`,
    ),
    ...results.flatMap((each) => {
      const where = `${folder}: ${each.id}`;
      if (each.error) return [`${where}: didn't run: ${each.error}`];
      return (each.support ?? []).flatMap((sentence) =>
        [sentence, ...sentence.parts, ...sentence.parts.flatMap((part) => part.figures)]
          .filter((judged) => judged.reason !== null && VOIDING.has(judged.reason))
          .map((judged) => `${where}: a check ${judged.reason}: ${sentence.sentence}`),
      );
    }),
  ]);
}

/** How the arms' research Answers differ, each request, model and language with its two counts. */
export function unmatchedArms(main: readonly ArmRun[], branch: readonly ArmRun[]): string[] {
  const counts = (runs: readonly ArmRun[]) => {
    const by = new Map<string, number>();
    for (const { results } of runs)
      for (const each of results)
        if (each.support) {
          const key = `${each.id}, ${each.model}, ${each.language}`;
          by.set(key, (by.get(key) ?? 0) + 1);
        }
    return by;
  };
  const before = counts(main);
  const after = counts(branch);
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((key) => before.get(key) !== after.get(key))
    .sort()
    .map((key) => `${key}: main ${before.get(key) ?? 0}, branch ${after.get(key) ?? 0}`);
}

const listed = (answers: readonly Answer[]): Listed[] =>
  answers.flatMap((each) =>
    each.support.map((sentence) => ({
      ...sentence,
      id: each.id,
      model: each.model,
      language: each.language,
    })),
  );

const percent = (share: number) => `${(100 * share).toFixed(1)}%`;

function supportedShare(answers: readonly Answer[]) {
  const verdicts = answers.flatMap((each) => each.support.map(countedVerdict));
  const judged = verdicts.filter((verdict) => verdict !== "not-checked");
  const supported = judged.filter((verdict) => verdict === "supported").length;
  return {
    supported,
    judged: judged.length,
    share: judged.length > 0 ? supported / judged.length : 0,
  };
}

const ticks = (answers: readonly Answer[]) =>
  listed(answers).filter((each) => each.verdict === "supported");

const joined = (answers: readonly Answer[]) =>
  answers.flatMap((each) =>
    each.notFound
      .filter((sentence) => sentence.marked && !sentence.otherDocuments)
      .map((sentence) => ({ ...sentence, id: each.id })),
  );

const otherMarked = (answers: readonly Answer[]) =>
  answers.flatMap((each) =>
    each.notFound
      .filter((sentence) => sentence.marked && sentence.otherDocuments)
      .map((sentence) => ({ ...sentence, id: each.id })),
  );

const sayingNotFound = (answers: readonly Answer[]) =>
  answers.filter((each) => each.notFound.length > 0).length;

/** The first answering request's input tokens of each Answer, by its request, in the order asked. */
function firstAnswering(answers: readonly Answer[]): Map<string, number[]> {
  const by = new Map<string, number[]>();
  for (const each of answers) {
    const first = each.answering?.[0];
    if (first !== undefined) by.set(each.id, [...(by.get(each.id) ?? []), first]);
  }
  return by;
}

/** How many answering requests the Answers made, and their mean input tokens. */
function everyAnswering(answers: readonly Answer[]): string {
  const tokens = answers.flatMap((each) => each.answering ?? []);
  const mean = tokens.reduce((sum, each) => sum + each, 0) / (tokens.length || 1);
  return `${tokens.length} requests of ${Math.round(mean)} input tokens on average`;
}

function costLine(arm: string, rows: readonly CheckRow[]): string {
  const sum = (pick: (row: CheckRow) => number) => rows.reduce((all, row) => all + pick(row), 0);
  const costs = rows.flatMap((row) => (row.cost === null ? [] : [row.cost]));
  return `| ${arm} | ${rows.length} | ${sum((row) => row.requests)} | ${median(rows.map((row) => row.requests))} | ${dollars(totalCost(rows))} | ${costs.length === rows.length ? dollars(median(costs)) : "unknown"} | ${median(rows.map((row) => row.seconds)).toFixed(1)} s |`;
}

/** Each bar of the plan, the branch's arm read against main's. */
export function readArms(
  main: readonly ArmRun[],
  branch: readonly ArmRun[],
  priced: CostOf,
): ArmsReading {
  const voided = voidReasons([...main, ...branch]);
  const named = (runs: readonly ArmRun[]) => runs.map((run) => run.folder).join(", ");
  const head = [
    "# #3019 step 3: the bars, the branch against main",
    "",
    `main: ${named(main)}`,
    "",
    `branch: ${named(branch)}`,
    "",
  ];
  if (voided.length > 0)
    return {
      lines: [
        ...head,
        "## Void",
        "",
        "A request was refused, failed or timed out, so these runs are void and no bar is read. Keep them, strike them with the reason, and run them again once.",
        "",
        ...voided.map((reason) => `- ${reason}`),
        "",
      ],
      voided,
      unmatched: [],
      failed: [],
      unread: [],
    };
  const unmatched = unmatchedArms(main, branch);
  if (unmatched.length > 0)
    return {
      lines: [
        ...head,
        "## Not comparable",
        "",
        "The arms don't hold the same research Answers by request, model and language, so no bar is read:",
        "",
        ...unmatched.map((each) => `- ${each}`),
        "",
      ],
      voided,
      unmatched,
      failed: [],
      unread: [],
    };
  const before = answersOf(main);
  const after = answersOf(branch);
  const failed: string[] = [];
  const unread: string[] = [];
  const bar = (name: string, holds: boolean | null) => {
    if (holds === false) failed.push(name);
    if (holds === null) unread.push(name);
    return holds === null ? "not read" : holds ? "holds" : "**fails**";
  };
  const models = [...new Set([...before, ...after].map((each) => each.model))].join(", ");

  const share = { main: supportedShare(before), branch: supportedShare(after) };
  const shareHolds = share.branch.share >= share.main.share - SUPPORTED_MARGIN - 1e-9;

  const judged = (answers: readonly Answer[]) =>
    ticks(answers).every((each) => each.unstated !== undefined);
  const unstatedOf = (answers: readonly Answer[]) =>
    ticks(answers).filter((each) => typeof each.unstated === "string").length;
  const unstatedHolds =
    judged(before) && judged(after) ? unstatedOf(after) <= unstatedOf(before) : null;

  const gaps = { main: joined(before).length, branch: joined(after).length };
  const joinedHolds = gaps.main > 0 ? gaps.branch < JOINED_SHARE * gaps.main : null;
  const said = { main: sayingNotFound(before), branch: sayingNotFound(after) };
  const droppedHolds = said.branch >= said.main - DROPPED_ALLOWED;
  const othersMarked = otherMarked(after);

  const rows = { main: checkRows(before, priced), branch: checkRows(after, priced) };

  const tokens = { main: firstAnswering(before), branch: firstAnswering(after) };
  const differences = [...tokens.branch].flatMap(([id, branchTokens]) => {
    const mainTokens = tokens.main.get(id);
    return mainTokens ? [{ id, main: median(mainTokens), branch: median(branchTokens) }] : [];
  });

  const lines = [
    ...head,
    `${before.length} research Answers on main, ${after.length} on the branch; ${models}. No request refused, failed or timed out.`,
    "",
    "## 1. Supported share of judged",
    "",
    "| Arm | Supported | Judged | Share |",
    "|---|---|---|---|",
    `| main | ${share.main.supported} | ${share.main.judged} | ${percent(share.main.share)} |`,
    `| branch | ${share.branch.supported} | ${share.branch.judged} | ${percent(share.branch.share)} |`,
    "",
    `The branch's ${percent(share.branch.share)} against main's ${percent(share.main.share)} less 12 points, ${percent(share.main.share - SUPPORTED_MARGIN)}: ${bar("1. Supported share", shareHolds)}.`,
    "",
    "## 2. Wrong ✓",
    "",
    `Unstated ✓: the branch has ${unstatedOf(after)}, main ${unstatedOf(before)}: ${bar("2. Unstated ✓", unstatedHolds)}.`,
    "",
    "On the branch:",
    "",
    ...unstatedLines(listed(after)),
    "On main:",
    "",
    ...unstatedLines(listed(before)),
    "Second-look ✓ and the negative beside them: struck, as the second look is out (the plan's changes).",
    "",
    "## 3. H's seven stay Unsupported",
    "",
    `Read by hand from the record: every ✓ on the branch the judge finds unstated, listed under 2, is a sentence that adds a word or a conclusion its Passages don't state. ${bar("3. H's seven, read by hand", null)}.`,
    "",
    "## 4. C: what wasn't found",
    "",
    "| Arm | Answers | Answers that say what wasn't found | Sentences that join a quote to it |",
    "|---|---|---|---|",
    `| main | ${before.length} | ${said.main} | ${gaps.main} |`,
    `| branch | ${after.length} | ${said.branch} | ${gaps.branch} |`,
    "",
    `Joined absence, under 10% of main's ${gaps.main}: ${bar("4. Joined absence", joinedHolds)}${joinedHolds === null ? " (main has none to measure against)" : ""}.`,
    "",
    `Nothing dropped, at least main's ${said.main} less ${DROPPED_ALLOWED}: ${bar("4. Nothing dropped", droppedHolds)}.`,
    "",
    ...joined(after).map((each) => `- ${each.id}, joined: ${each.sentence}`),
    ...(gaps.branch > 0 ? [""] : []),
    "## 5. Only this Document",
    "",
    `Sentences about the other Documents that carry a marker on the branch: ${othersMarked.length}: ${bar("5. Only this Document", othersMarked.length === 0)}.`,
    "",
    ...othersMarked.map((each) => `- ${each.id}: ${each.sentence}`),
    ...(othersMarked.length > 0 ? [""] : []),
    "## 6. What the second look costs",
    "",
    "Struck, as the second look is out. What the checks cost on each arm, for the record:",
    "",
    "| Arm | Answers | Check requests | Median an Answer | Cost | Median an Answer | Median check time |",
    "|---|---|---|---|---|---|---|",
    costLine("main", rows.main),
    costLine("branch", rows.branch),
    "",
    "## 7. The ✓ resting on a record taken from the reply",
    "",
    "On the branch:",
    "",
    ...fromReplyLines(listed(after)),
    "On main:",
    "",
    ...fromReplyLines(listed(before)),
    "## The answering requests' input tokens",
    "",
    ...(differences.length > 0
      ? [
          "Each request's first answering request, its input tokens (median over its Answers):",
          "",
          "| Request | main | branch | Added |",
          "|---|---|---|---|",
          ...differences.map(
            (each) => `| ${each.id} | ${each.main} | ${each.branch} | ${each.branch - each.main} |`,
          ),
          "",
          `A median of ${median(differences.map((each) => each.branch - each.main))} input tokens added to each answering request.`,
          "",
          `Every answering request: ${everyAnswering(before)} on main, ${everyAnswering(after)} on the branch. Only each Answer's first is paired: its later ones carry Tool results that differ between the arms.`,
          "",
        ]
      : ["Not recorded: the reports keep no answering request's tokens.", ""]),
    "## Verdict",
    "",
    failed.length > 0
      ? `A bar failed, so nothing ships from this run: ${failed.join("; ")}.`
      : "No bar the reports read failed.",
    "",
    ...(unread.length > 0 ? [`Read by hand or not read: ${unread.join("; ")}.`, ""] : []),
  ];
  return { lines, voided, unmatched, failed, unread };
}
