/**
 * What the repeats come to, per set and model: each sentence's outcomes, how
 * steady its verdict is, the checks that disagree with the one before, and
 * every result that isn't the verdict its Documents give, in the check's own
 * words.
 */
import type { Expected, RepeatSentence } from "./cases";
import type { Outcome, RepeatResult } from "./repeat";
import type { WatchedRequest } from "./requests";

export interface RepeatRow extends RepeatResult {
  set: string;
  model: string;
  key: string;
  kind: RepeatSentence["kind"];
  expected: Expected;
  knownMiss?: number;
  /** The model requests of this sentence's check; none in a report written before they were kept. */
  requests?: readonly WatchedRequest[];
}

const OUTCOMES: readonly Outcome[] = [
  "supported",
  "partly",
  "absent",
  "differs",
  "unsupported",
  "contradicted",
  "not-checked",
  "no-mark",
];

/** The verdict behind an outcome: the three cards of an unsupported sentence are one verdict. */
export const verdictOf = (outcome: Outcome) =>
  outcome === "partly" || outcome === "differs" || outcome === "absent" ? "unsupported" : outcome;

export function meetsExpected(row: Pick<RepeatRow, "outcome" | "expected">): boolean {
  const verdict = verdictOf(row.outcome);
  if (row.expected === "supported") return verdict === "supported";
  if (row.expected === "partly") return row.outcome === "partly";
  if (row.expected === "absent") return row.outcome === "absent";
  if (row.expected === "unsupported") return verdict === "unsupported";
  if (row.expected === "contradicted") return verdict === "contradicted";
  return verdict === "unsupported" || verdict === "contradicted";
}

/** What a Document states, all of it or for its own term. */
const STATED: ReadonlySet<Expected> = new Set(["supported", "partly"]);

export interface SentenceSummary {
  key: string;
  kind: RepeatSentence["kind"];
  expected: Expected;
  repeats: number;
  outcomes: Record<Outcome, number>;
  /** How many repeats gave its most frequent verdict. */
  steady: number;
}

export interface GroupSummary {
  set: string;
  model: string;
  repeats: number;
  sentences: SentenceSummary[];
  /** Supported, for a sentence its Documents don't state. */
  falseSupported: number;
  /** Not found or Unsupported, for a sentence its Documents state. */
  unsupportedOnStated: number;
  /** The partly-supported card, for a sentence whose topic no Document is about. */
  partlyOnAbsent: number;
  /** Repeats whose verdicts differ from the one before on any sentence, of those that follow one. */
  disagreeing: number;
  followed: number;
  /** The genuine conflicts Contradicted, of those checked, known misses left out; null without any. */
  conflicts: { contradicted: number; checked: number } | null;
  /** Every result that isn't the verdict its Documents give, known misses left out. */
  misses: RepeatRow[];
  /** The results of the sentences a known miss is filed for, apart. */
  known: RepeatRow[];
  cost: CheckCost;
}

/** What a sentence's check cost, on average over the checks of a group; the claims request isn't any sentence's. */
export interface CheckCost {
  requests: number;
  searches: number;
  /** Checks that searched more than once. */
  searchedAgain: number;
  /** Checks asked to search again before saying the sentence isn't found. */
  askedAgain: number;
  inputTokens: number;
  outputTokens: number;
  /** The requests' time, end to end, as one after another. */
  seconds: number;
}

export function costOf(rows: readonly RepeatRow[]): CheckCost {
  const mean = (of: (row: RepeatRow) => number) =>
    rows.length === 0 ? 0 : rows.reduce((total, row) => total + of(row), 0) / rows.length;
  const sum = (row: RepeatRow, of: (request: WatchedRequest) => number) =>
    (row.requests ?? []).reduce((total, request) => total + of(request), 0);
  const searches = (row: RepeatRow) => sum(row, (request) => request.asked.length);
  return {
    requests: mean((row) => row.requests?.length ?? 0),
    searches: mean(searches),
    searchedAgain: rows.filter((row) => searches(row) > 1).length,
    askedAgain: rows.filter((row) => row.requests?.some((request) => request.searchAgain)).length,
    inputTokens: mean((row) => sum(row, (request) => request.inputTokens)),
    outputTokens: mean((row) => sum(row, (request) => request.outputTokens)),
    seconds: mean((row) => sum(row, (request) => request.ms)) / 1000,
  };
}

export function summarise(rows: readonly RepeatRow[]): GroupSummary[] {
  const groups = new Map<string, RepeatRow[]>();
  for (const row of rows) {
    const key = `${row.set}\n${row.model}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0] as RepeatRow;
    const repeats = [...new Set(group.map((row) => row.repeat))].sort((a, b) => a - b);
    const keys = [...new Set(group.map((row) => row.key))];
    const sentences = keys.map((key): SentenceSummary => {
      const own = group.filter((row) => row.key === key);
      const outcomes = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) as Record<
        Outcome,
        number
      >;
      const verdicts = new Map<string, number>();
      for (const row of own) {
        outcomes[row.outcome]++;
        const verdict = verdictOf(row.outcome);
        verdicts.set(verdict, (verdicts.get(verdict) ?? 0) + 1);
      }
      const sample = own[0] as RepeatRow;
      return {
        key,
        kind: sample.kind,
        expected: sample.expected,
        repeats: own.length,
        outcomes,
        steady: Math.max(...verdicts.values()),
      };
    });
    const verdictsIn = (repeat: number) =>
      keys
        .map((key) => {
          const row = group.find((each) => each.repeat === repeat && each.key === key);
          return row ? verdictOf(row.outcome) : "missing";
        })
        .join(" ");
    const pairs = repeats
      .slice(1)
      .map((repeat, index): [number, number] => [repeats[index] as number, repeat]);
    const counted = group.filter((row) => row.knownMiss === undefined);
    const conflicts = counted.filter((row) => row.expected === "contradicted");
    return {
      set: first.set,
      model: first.model,
      repeats: repeats.length,
      sentences,
      falseSupported: counted.filter(
        (row) => !STATED.has(row.expected) && row.outcome === "supported",
      ).length,
      partlyOnAbsent: group.filter((row) => row.kind === "absent" && row.outcome === "partly")
        .length,
      unsupportedOnStated: group.filter(
        (row) =>
          STATED.has(row.expected) && (row.outcome === "absent" || row.outcome === "unsupported"),
      ).length,
      disagreeing: pairs.filter(([before, after]) => verdictsIn(before) !== verdictsIn(after))
        .length,
      followed: pairs.length,
      conflicts:
        conflicts.length === 0
          ? null
          : {
              contradicted: conflicts.filter((row) => row.outcome === "contradicted").length,
              checked: conflicts.length,
            },
      misses: counted.filter((row) => !meetsExpected(row)),
      known: group.filter((row) => row.knownMiss !== undefined),
      cost: costOf(group),
    };
  });
}

const cell = (text: string | null) => (text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

function knownLines(known: readonly RepeatRow[]): string[] {
  const issues = [...new Set(known.map((row) => row.knownMiss))];
  return issues.flatMap((issue) => {
    const ofIssue = known.filter((row) => row.knownMiss === issue);
    const keys = [...new Set(ofIssue.map((row) => row.key))];
    return [
      "",
      `### Known misses (#${issue}), outside the counts above`,
      "",
      ...keys.map((key) => {
        const own = ofIssue.filter((row) => row.key === key);
        const count = (outcomes: readonly Outcome[]) =>
          own.filter((row) => outcomes.includes(row.outcome)).length;
        return `- ${key}: ${count(["contradicted"])} of ${own.length} Contradicted, ${count(["supported"])} Supported, ${count(["partly", "absent", "differs", "unsupported"])} unsupported, ${count(["not-checked", "no-mark"])} not checked or not named`;
      }),
    ];
  });
}

export function report(
  summaries: readonly GroupSummary[],
  run: { commit: string; spent: number; repeats: number },
): string {
  return [
    "# Repeated checks of an unchanged Mind",
    "",
    `Commit ${run.commit}, ${run.repeats} repeats a Mind, $${run.spent.toFixed(2)} at the app's own count.`,
    "",
    ...summaries.flatMap((group) => [
      `## ${group.set} · ${group.model} · ${group.repeats} checks`,
      "",
      "| Sentence | Kind | Expected | Supported | Partly | Absent | Differs | Unsupported | Contradicted | Not checked | Same verdict |",
      "|---|---|---|---|---|---|---|---|---|---|---|",
      ...group.sentences.map(
        (each) =>
          `| ${each.key} | ${each.kind} | ${each.expected} | ${each.outcomes.supported} | ${each.outcomes.partly} | ${each.outcomes.absent} | ${each.outcomes.differs} | ${each.outcomes.unsupported} | ${each.outcomes.contradicted} | ${each.outcomes["not-checked"] + each.outcomes["no-mark"]} | ${each.steady} of ${each.repeats} |`,
      ),
      "",
      `- False Supported: ${group.falseSupported}`,
      `- Not found or Unsupported, for a sentence they state: ${group.unsupportedOnStated}`,
      `- The partly-supported card, for a sentence whose topic they don't hold: ${group.partlyOnAbsent}`,
      `- Checks whose verdicts differ from the one before: ${group.disagreeing} of ${group.followed}`,
      ...(group.conflicts
        ? [
            `- Genuine conflicts Contradicted: ${group.conflicts.contradicted} of ${group.conflicts.checked}`,
          ]
        : []),
      `- A sentence's check, on average: ${group.cost.requests.toFixed(2)} requests, ${group.cost.searches.toFixed(2)} searches (more than one in ${group.cost.searchedAgain} of ${group.sentences.reduce((total, each) => total + each.repeats, 0)}, asked to search again in ${group.cost.askedAgain}), ${Math.round(group.cost.inputTokens)} tokens in, ${Math.round(group.cost.outputTokens)} out, ${group.cost.seconds.toFixed(1)} s of requests`,
      ...knownLines(group.known),
      "",
      ...(group.misses.length > 0
        ? [
            "| Check | Sentence | Card | What the check said | Covered | Not covered | Quote |",
            "|---|---|---|---|---|---|---|",
            ...group.misses.map(
              (row) =>
                `| ${row.repeat} | ${cell(row.sentence)} | ${row.outcome} | ${cell(row.failure ?? row.says)} | ${cell(row.covered)} | ${cell(row.uncovered)} | ${cell(row.quote)} |`,
            ),
            "",
          ]
        : []),
    ]),
  ].join("\n");
}
