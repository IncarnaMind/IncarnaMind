/**
 * The report's lines on the research Answers' checks (#3019): what each Answer's checks cost, with
 * its second looks against their cap, the ✓ the judge finds their own Citations don't state, and
 * the ✓ that rest on a record the check's reply wrote, each listed to read by hand.
 */
import type { AnswerUsage } from "../../src/core";
import type { SentenceSupport } from "./support";

export interface CheckedAnswer {
  id: string;
  model: string;
  language: string;
  support: readonly SentenceSupport[];
  checkSeconds?: number;
}

type Listed = SentenceSupport & { id: string; model: string; language: string };

/** A request's cost in dollars, or null when the catalog has no price for its model. */
export type CostOf = (usage: AnswerUsage) => number | null;

const quoted = (text: string | null) =>
  text === null ? "(no quote)" : `“${text.replace(/\s+/g, " ").trim()}”`;

const citesLine = (each: SentenceSupport) =>
  `  - cites ${each.cites.map(({ documentName, quote }) => `${quoted(quote)} (${documentName})`).join(" · ")}`;

/** The second looks an Answer may take: one for each part its check judged, a whole sentence being one. */
export const secondLookCap = (support: readonly SentenceSupport[]): number =>
  support.reduce(
    (total, each) => total + Math.max(1, each.parts.filter((part) => part.kind === "fact").length),
    0,
  );

function costOfAnswer(support: readonly SentenceSupport[], costOf: CostOf): number | null {
  let dollars = 0;
  for (const usage of support.flatMap((each) => each.asked?.requests ?? [])) {
    const cost = costOf(usage);
    if (cost === null) return null;
    dollars += cost;
  }
  return dollars;
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

/** Each research Answer's checks: their second looks against the cap, requests, cost and time. */
export function checkCostLines(answers: readonly CheckedAnswer[], costOf: CostOf): string[] {
  if (answers.length === 0) return [];
  const dollars = (amount: number | null) =>
    amount === null ? "no price" : `$${amount.toFixed(4)}`;
  const rows = answers.map((each) => ({
    each,
    anew: each.support.reduce((total, sentence) => total + (sentence.asked?.anew ?? 0), 0),
    cap: secondLookCap(each.support),
    requests: each.support.reduce(
      (total, sentence) => total + (sentence.asked?.requests.length ?? 0),
      0,
    ),
    cost: costOfAnswer(each.support, costOf),
    seconds: each.checkSeconds ?? 0,
  }));
  const costs = rows.map((row) => row.cost);
  const total = costs.every((cost) => cost !== null)
    ? costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0)
    : null;
  const sum = (pick: (row: (typeof rows)[number]) => number) =>
    rows.reduce((all, row) => all + pick(row), 0);
  return [
    "What each Answer's checks of its cited sentences cost: the looks asked again word for word (a second look), against the cap of one for each part, the check's requests, their cost at the catalog's prices, and the time the checks took.",
    "",
    "| Request | Model | Language | Cited sentences | Second looks (cap) | Requests | Cost | Check time |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map(
      (row) =>
        `| ${row.each.id} | ${row.each.model} | ${row.each.language} | ${row.each.support.length} | ${row.anew} (${row.cap})${row.anew > row.cap ? " **over the cap**" : ""} | ${row.requests} | ${dollars(row.cost)} | ${row.seconds.toFixed(1)} s |`,
    ),
    "",
    `In all, over ${rows.length} Answers: ${sum((row) => row.anew)} second looks (cap ${sum((row) => row.cap)}), ${sum((row) => row.requests)} requests, ${dollars(total)}; a median of ${median(rows.map((row) => row.requests))} requests and ${median(rows.map((row) => row.seconds)).toFixed(1)} s of checks an Answer.`,
    "",
  ];
}

/** The ✓ the judge read against their own Citations' words, and each it finds they don't state. */
export function unstatedLines(sentences: readonly Listed[]): string[] {
  const judged = sentences.filter((each) => each.unstated !== undefined);
  if (judged.length === 0) return [];
  const groups = [...new Set(judged.map((each) => `${each.model}\n${each.language}`))];
  const unstated = judged.filter((each) => typeof each.unstated === "string");
  return [
    "The ✓ read by the judge against the words their own Citations quote:",
    "",
    "| Model | Language | ✓ judged | Judged unstated |",
    "|---|---|---|---|",
    ...groups.map((key) => {
      const [model = "", language = ""] = key.split("\n");
      const some = judged.filter((each) => each.model === model && each.language === language);
      return `| ${model} | ${language} | ${some.length} | ${some.filter((each) => typeof each.unstated === "string").length} |`;
    }),
    "",
    ...(unstated.length > 0
      ? [
          "Each ✓ the judge finds unstated, to read by hand:",
          "",
          ...unstated.flatMap((each) => [
            `- ${each.id} (${each.model}): ${each.sentence}`,
            citesLine(each),
            `  - unstated: ${each.unstated}`,
          ]),
          "",
        ]
      : []),
  ];
}

/** The ✓ that rest on a record their check's reply wrote and the check took (#3032), listed apart. */
export function fromReplyLines(sentences: readonly Listed[]): string[] {
  const taken = sentences.filter((each) => (each.fromReply?.length ?? 0) > 0);
  return [
    `The ✓ that rest on a record the check's reply wrote into its text, which the check took: ${taken.length}${taken.length > 0 ? ", to read by hand:" : "."}`,
    "",
    ...taken.flatMap((each) => [
      `- ${each.id} (${each.model}, ${each.language}): ${each.sentence}`,
      citesLine(each),
      ...(each.fromReply ?? []).map((quote) => `  - the record's quote ${quoted(quote)}`),
    ]),
    ...(taken.length > 0 ? [""] : []),
  ];
}
