/**
 * The cases, items and records of the gate for the ask for a check's missing records
 * (`gates/records-ask.md`, #3019): its two arms, `main` and the branch, run in turn, item by item,
 * each in a process of its own from its own source.
 */
import type { AnswerUsage } from "../../src/core";
import type { CaseResult } from "./asking";
import type { SentenceSupport } from "./support";

export const ARMS = ["main", "branch"] as const;
export type Arm = (typeof ARMS)[number];

export type Language = "en" | "zh-CN";

/** The plan's models, fixed here and nowhere an environment variable can change them. */
export const GATE_MODEL = "claude-haiku-5-5";
export const GATE_JUDGE = "claude-sonnet-5-5";

/** The four research requests, as `cases.ts` names them: the record of #3019's runs. */
export const RESEARCH_IDS = [
  "research-attention-long",
  "research-gpt3-energy",
  "research-attention-long-zh",
  "research-gpt3-energy-zh",
] as const;
export const RESEARCH_RUNS = 6;
export const PAIR_RUNS = 3;

export type Twin = "right" | "wrong";

/** One of the plan's six pairs: a sentence as Claude Haiku 5.5 wrote it, its wrong twin, and what both cite. */
export interface FixedPair {
  pair: number;
  language: Language;
  /** The Document whose table it restates, by its name in the Library. */
  document: string;
  right: string;
  wrong: string;
  /** The table rows its Answer cited, quoted from the Document. */
  cites: readonly string[];
}

const WEIGHTED_KEYS = "Weighted Keys Shorter Paths";
const DEMONSTRATIONS = "Demonstrations Not Weights";
const TABLE_1 = ["Weighted keys O(n2 d) O(1) O(1)", "Recurrent O(n d2) O(n) O(n)"];
const TABLE_4 = ["220 B 210 B 2,740"];

/** The plan's table of pairs, fixed before any request and never changed after. */
export const PAIRS: readonly FixedPair[] = [
  {
    pair: 1,
    language: "en",
    document: WEIGHTED_KEYS,
    right:
      "Per-layer work: a weighted-key layer costs O(n²d) against O(nd²) for a recurrent layer, where n is sequence length and d is width.",
    wrong:
      "Per-layer work: a weighted-key layer costs O(nd²) against O(n²d) for a recurrent layer, where n is sequence length and d is width.",
    cites: TABLE_1,
  },
  {
    pair: 2,
    language: "en",
    document: WEIGHTED_KEYS,
    right:
      "Its Table 1 lists weighted-key layers at O(1) path length and recurrent layers at O(n).",
    wrong:
      "Its Table 1 lists weighted-key layers at O(n) path length and recurrent layers at O(1).",
    cites: TABLE_1,
  },
  {
    pair: 3,
    language: "en",
    document: DEMONSTRATIONS,
    right: "Compute: Table 4 lists the 220B model at 210B tokens and 2,740 accelerator days.",
    wrong: "Compute: Table 4 lists the 220B model at 210B tokens and 274 accelerator days.",
    cites: TABLE_4,
  },
  {
    pair: 4,
    language: "zh-CN",
    document: WEIGHTED_KEYS,
    right: "表 1 中，循环层的运算量是 O(n d²)，加权键层是 O(n² d)。",
    wrong: "表 1 中，循环层的运算量是 O(n² d)，加权键层是 O(n d²)。",
    cites: TABLE_1,
  },
  {
    pair: 5,
    language: "zh-CN",
    document: WEIGHTED_KEYS,
    right: "表 1 显示，循环层的顺序步数是 O(n)，而加权键层是 O(1)。",
    wrong: "表 1 显示，循环层的顺序步数是 O(1)，而加权键层是 O(n)。",
    cites: TABLE_1,
  },
  {
    pair: 6,
    language: "zh-CN",
    document: DEMONSTRATIONS,
    right:
      "文档《Demonstrations Not Weights》给出的是训练算力：220B 模型的训练用了 2,740 个加速器天（accelerator days），训练数据为 210B tokens。",
    wrong:
      "文档《Demonstrations Not Weights》给出的是训练算力：220B 模型的训练用了 274 个加速器天（accelerator days），训练数据为 210B tokens。",
    cites: TABLE_4,
  },
];

export type Item =
  | {
      kind: "research";
      key: string;
      id: (typeof RESEARCH_IDS)[number];
      language: Language;
      run: number;
    }
  | { kind: "pair"; key: string; pair: number; twin: Twin; language: Language; run: number };

const researchItem = (id: (typeof RESEARCH_IDS)[number], run: number): Item => ({
  kind: "research",
  key: `${id}#${run}`,
  id,
  language: id.endsWith("-zh") ? "zh-CN" : "en",
  run,
});

const pairItem = (pair: FixedPair, twin: Twin, run: number): Item => ({
  kind: "pair",
  key: `pair-${pair.pair}-${twin}#${run}`,
  pair: pair.pair,
  twin,
  language: pair.language,
  run,
});

/**
 * Every item of the run in the order both arms ask it: round by round, the four research requests,
 * then, in the first three rounds, the twelve sentences of the pairs.
 */
export function runItems(): Item[] {
  return Array.from({ length: RESEARCH_RUNS }, (_, index) => index + 1).flatMap((run) => [
    ...RESEARCH_IDS.map((id) => researchItem(id, run)),
    ...(run <= PAIR_RUNS
      ? PAIRS.flatMap((pair) => [pairItem(pair, "right", run), pairItem(pair, "wrong", run)])
      : []),
  ]);
}

/** The plan's priced pilot: `research-attention-long` on each arm, then the first pair on each. */
export function pilotItems(): Item[] {
  const [first] = PAIRS;
  if (!first) throw new Error("The plan's pairs are missing.");
  return [
    researchItem("research-attention-long", 1),
    pairItem(first, "right", 1),
    pairItem(first, "wrong", 1),
  ];
}

export const sentenceOf = (pair: FixedPair, twin: Twin) =>
  twin === "right" ? pair.right : pair.wrong;

/** What an item's requests came to: those answered, each try that failed, their tokens and cost. */
export interface Requests {
  answered: number;
  /** Each try the provider refused or failed, a retry's earlier tries included, by its error's name and status. */
  failed: string[];
  usage: AnswerUsage;
  /** At the catalog's price for the model; null when it has none. */
  dollars: number | null;
}

/** One try of an item on one arm, as its record file keeps it. */
export interface ItemRecord {
  arm: Arm;
  key: string;
  kind: Item["kind"];
  language: Language;
  /** The research request's id, or "pair 2, wrong". */
  name: string;
  pair: number | null;
  twin: Twin | null;
  run: number;
  /** 1, or 2 for the one run again after a void try. */
  attempt: number;
  /** Each cited sentence as the check judged it, with what its model was asked and told. */
  sentences: SentenceSupport[];
  /** A research request's Answer as the everyday record keeps it; null for a pair. */
  answer: CaseResult | null;
  /** Why the check or the Answer didn't run; null when it ran. */
  error: string | null;
  requests: Requests;
  seconds: number;
  /** Why this try is void; empty when it isn't. */
  void: string[];
}

/** A check's or an Answer's failure that the provider refused, failed or let time out. */
const VOIDING: ReadonlySet<string> = new Set([
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

/** Why a try is void under the plan's rule: any request refused, failed or timed out, a retried one included. */
export function voidReasons(
  record: Pick<ItemRecord, "error" | "requests" | "sentences" | "answer">,
): string[] {
  return [
    ...(record.error ? [`didn't run: ${record.error}`] : []),
    ...(record.answer?.error ? [`the Answer failed: ${record.answer.error}`] : []),
    ...record.requests.failed.map((each) => `a try failed: ${each}`),
    ...record.sentences.flatMap((sentence) =>
      [sentence, ...sentence.parts, ...sentence.parts.flatMap((part) => part.figures)]
        .filter((judged) => judged.reason !== null && VOIDING.has(judged.reason))
        .map((judged) => `a check ${judged.reason}: ${sentence.sentence}`),
    ),
  ];
}

/** The plan's stop in US dollars, the pilot and one rerun of a void try included. */
export const STOP_DOLLARS = 2.5;

/**
 * Whether the next try may run under the plan's stop: what the gate spent before this run, with
 * every try of this run on both arms and its judge, leaves room for the most one has cost so far.
 * Null when a cost isn't known, so the stop can't be kept.
 */
export function underTheStop(
  before: number,
  costs: readonly (number | null)[],
): { spent: number; most: number; within: boolean } | null {
  const known = costs.filter((cost): cost is number => cost !== null);
  if (known.length < costs.length) return null;
  const spent = before + known.reduce((total, cost) => total + cost, 0);
  const most = Math.max(0, ...known);
  return { spent, most, within: spent + most <= STOP_DOLLARS };
}

/** The file an arm writes an item's try to, so the other arm can see its turn has come. */
export const recordFile = (key: string, attempt: number) =>
  `${key.replace(/[^a-z0-9-]+/giu, "_")}.${attempt}.json`;
