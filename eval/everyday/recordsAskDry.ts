/**
 * The gate's free dry run (`gates/records-ask.md`): the scripted chat model plays the research
 * Answers, the checks, their asks for evidence and the judge, so the whole run is played with no
 * request to any provider. Its numbers are fake. What it replies depends only on what it is told,
 * never on the arm: an ask that names its markers alone is answered with a Document's own
 * references, as Claude Haiku 5.5 answered it, and one that says what each marker was for with the
 * table's rows.
 */
import { findQuote } from "../../src/shared/quoteMatch";
import { isCheckRun, requestedFigures, SAME_DETAIL, sentenceOf } from "../../tests/helpers/checks";
import { shownPassages } from "../../tests/helpers/citations";
import {
  type GenerateCall,
  type GeneratedReply,
  judgesNothing,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
} from "../../tests/helpers/models";
import { CASES } from "./cases";
import { STATED_INSTRUCTIONS } from "./judge";
import { type FixedPair, PAIRS, RESEARCH_IDS } from "./recordsAsk";

/** A placeholder the provider is saved with in the dry run: the scripted model never sends it. */
export const DRY_RUN_PLACEHOLDER = "dry-run-placeholder-not-a-key";

const pairNumbered = (pair: number): FixedPair => {
  const found = PAIRS.find((each) => each.pair === pair);
  if (!found) throw new Error(`The plan has no pair ${pair}.`);
  return found;
};

/** Each research request's Answer, scripted: the right sentences of its Document's pairs in its language. */
const ANSWERS: Record<(typeof RESEARCH_IDS)[number], readonly FixedPair[]> = {
  "research-attention-long": [pairNumbered(1), pairNumbered(2)],
  "research-gpt3-energy": [pairNumbered(3)],
  "research-attention-long-zh": [pairNumbered(4), pairNumbered(5)],
  "research-gpt3-energy-zh": [pairNumbered(6)],
};

/** The pair a sentence belongs to, and which twin it is. */
function twinOf(sentence: string): { pair: FixedPair; right: boolean } | null {
  for (const pair of PAIRS) {
    if (pair.right === sentence) return { pair, right: true };
    if (pair.wrong === sentence) return { pair, right: false };
  }
  return null;
}

/** The wrong twin the dry run's check calls Supported, one with no figure for the figure check to catch. */
const TICKED_WRONG = pairNumbered(2).wrong;
/** The sentence whose first check is refused once in each arm, so a void try is struck and run again. */
const REFUSED_ONCE = pairNumbered(5).wrong;

const PASSAGE = /<passage id="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/passage>/gu;

const passagesIn = (text: string) =>
  [...text.matchAll(PASSAGE)].map((match) => ({ id: match[1] ?? "", text: match[2] ?? "" }));

const holding = (passages: readonly { id: string; text: string }[], quote: string) =>
  passages.find((each) => findQuote(each.text, quote, { numbers: "if-needed" }) !== null);

const marked = (sentence: string, markers: readonly number[]) => {
  const tags = markers.map((marker) => `[^${marker}]`).join("");
  return /[.。]$/u.test(sentence)
    ? `${sentence.slice(0, -1)}${tags}${sentence.slice(-1)}`
    : `${sentence}${tags}`;
};

/** An Answer's turns: it searches for each row it cites, records them, then writes its sentences. */
function answerTurn(call: ModelCall, pairs: readonly FixedPair[]): ScriptedReply {
  const searches = call.results.filter((result) => result.tool === "search_documents");
  const quotes = [...new Set(pairs.flatMap((pair) => pair.cites))];
  if (searches.length === 0)
    return {
      calls: quotes.map((quote) => ({ tool: "search_documents", input: { query: quote } })),
    };
  const shown = searches.flatMap((search) => shownPassages(search.text));
  const markerOf = new Map(quotes.map((quote, index) => [quote, index + 1]));
  if (!call.results.some((result) => result.tool === "cite")) {
    const citations = quotes.flatMap((quote) => {
      const passage = holding(shown, quote);
      return passage ? [{ marker: markerOf.get(quote), passage: passage.id, quote }] : [];
    });
    return { calls: [{ tool: "cite", input: { citations } }] };
  }
  return {
    text: pairs
      .map((pair) =>
        marked(
          pair.right,
          pair.cites.flatMap((quote) => markerOf.get(quote) ?? []),
        ),
      )
      .join(" "),
  };
}

/** A query that shows the check a Passage of the same Document with a bracketed number in it. */
const BRACKETED_QUERY: Record<string, string> = {
  "Weighted Keys Shorter Paths": "residual connection sub-layer layer normalisation",
  "Demonstrations Not Weights": "References",
};

/**
 * The check's verdict, as Claude Haiku 5.5 wrote such replies in the saved records: Supported
 * with its Evidence line, and its records where the reader can't take them, two quotes under one
 * marker for two rows, or the quote in running prose for one. A wrong twin is Contradicted,
 * all but one, which the dry run's check ticks.
 */
function verdictOf(call: ModelCall, sentence: string): string {
  const twin = twinOf(sentence);
  const supported = !twin || twin.right || sentence === TICKED_WRONG;
  const cites = twin?.pair.cites ?? [];
  const markers = cites.map((_, index) => index + 1);
  const records =
    cites.length > 1
      ? `[^1]: ${twin?.pair.document}, p. 4 — ${cites.map((quote) => `“${quote}”`).join(" and ")}`
      : `The table gives ${cites.map((quote) => `“${quote}”`).join(" ")} for it.`;
  const lines = [
    `Verdict: ${supported ? "supported" : "contradicted"}`,
    "Absence: no",
    SAME_DETAIL,
    `Explanation: The table states it.${markers.map((marker) => ` [^${marker}]`).join("")}`,
    `Evidence: ${JSON.stringify(markers)}`,
    records,
  ];
  const figures = requestedFigures(call);
  if (figures.length === 0) return lines.join("\n");
  const items = figures.map(({ id, reading }) => ({
    id,
    verdict: supported ? "supported" : "contradicted",
    scope: "same",
    topic: "found",
    roles: "same",
    says: null,
    reading,
    relation: "equals",
    source: null,
    calculation: null,
  }));
  return [...lines, `Figures: ${JSON.stringify({ items, remainder: null })}`].join("\n");
}

function checkTurn(call: ModelCall, refused: Set<string>): ScriptedReply {
  const sentence = sentenceOf(call);
  if (sentence === REFUSED_ONCE && !refused.has(sentence)) {
    refused.add(sentence);
    return { error: { status: 529, message: "Overloaded" } };
  }
  const searches = call.results.filter((result) => result.tool === "search_documents").length;
  const document = twinOf(sentence)?.pair.document;
  if (searches === 0) return { calls: [{ tool: "search_documents", input: { query: sentence } }] };
  const bracketed = document ? BRACKETED_QUERY[document] : undefined;
  if (searches === 1 && bracketed)
    return { calls: [{ tool: "search_documents", input: { query: bracketed } }] };
  return { text: verdictOf(call, sentence) };
}

const ASKED_MARKERS = /Missing Citation markers: (\[[^\]]*\])/u;
const TOLD_WHAT_FOR = "They are the markers of your verdict's own lines.";

/**
 * The reply to an ask for the records: told what each marker was for, the table's rows; asked for
 * the markers alone, a Passage's own bracketed reference, as in the saved records.
 */
function evidenceReply(call: GenerateCall): string {
  const sentence = /<sentence>\n([\s\S]*?)\n<\/sentence>/u.exec(call.prompt)?.[1]?.trim() ?? "";
  const passages = passagesIn(call.prompt);
  const markers: number[] = JSON.parse(ASKED_MARKERS.exec(call.prompt)?.[1] ?? "[1]");
  const rows = twinOf(sentence)?.pair.cites ?? [];
  const references = passages.flatMap((passage) =>
    passage.text
      .split("\n")
      .filter((line) => /\[\d{1,3}\]/u.test(line))
      .map((line) => ({ passage: passage.id, quote: line.trim() })),
  );
  const told = call.prompt.includes(TOLD_WHAT_FOR) || references.length === 0;
  const records = markers.flatMap((marker, index) => {
    if (!told) {
      const reference = references[index % references.length];
      return reference ? [{ marker, ...reference }] : [];
    }
    const quote = rows[index] ?? rows[0];
    const passage = quote ? holding(passages, quote) : undefined;
    return quote && passage ? [{ marker, passage: passage.id, quote }] : [];
  });
  if (!ASKED_MARKERS.test(call.prompt)) {
    const [first] = records;
    return JSON.stringify(
      first ? { passage: first.passage, location: "p. 4", quote: first.quote } : { passage: null },
    );
  }
  return JSON.stringify({ citations: records.map((record) => ({ ...record, location: "p. 4" })) });
}

function generated(call: GenerateCall): GeneratedReply {
  const sentence = /<sentence>\n([\s\S]*?)\n<\/sentence>/u.exec(call.prompt)?.[1]?.trim() ?? "";
  const wrong = twinOf(sentence)?.right === false;
  switch (call.question) {
    case "evidence":
    case "covered-evidence":
      return { text: evidenceReply(call) };
    case "confirm":
    case "strict":
    case "strict-figure":
    case "nearest":
      return { text: wrong ? "conflict" : "same" };
    case "record-cite":
      return { text: `Judgement: ${wrong ? "partly" : "supported"}` };
    case "parts":
      return { text: "" };
    default:
      return judgesNothing(call);
  }
}

/**
 * The chat model of the dry run, for the Answers and the checks. `refused` keeps the sentence whose
 * first check was refused, so it is refused once in each arm.
 */
export function dryChatModel() {
  const refused = new Set<string>();
  return scriptedModel(
    (call) => {
      if (call.question === "unmarked-quotes") return { text: '{"citations":[]}' };
      if (isCheckRun(call)) return checkTurn(call, refused);
      const id = RESEARCH_IDS.find((each) => call.prompt.includes(requestOf(each)));
      if (!id)
        throw new Error(`The dry run has no Answer scripted for: ${call.prompt.slice(-200)}`);
      return answerTurn(call, ANSWERS[id]);
    },
    { generate: generated, judgesItsAnswers: true },
  );
}

/** A research request's words, which tell the scripted model which Answer to write. */
function requestOf(id: (typeof RESEARCH_IDS)[number]): string {
  const found = CASES.find((each) => each.id === id);
  if (!found) throw new Error(`No everyday request "${id}".`);
  return found.request;
}

/**
 * The judge of the dry run: the claims' judge finds no claimed change, and the judge of the ✓
 * sentences finds one unstated, the per-layer sentence, so bar 3's list has something to read.
 */
export function dryJudgeModel() {
  return scriptedModel(() => ({ text: "This judge doesn't stream." }), {
    generate: (call) => {
      if (call.system !== STATED_INSTRUCTIONS) return { text: '{"unbacked": []}' };
      const sentences = [
        ...call.prompt.matchAll(/<sentence number="(\d+)">\n([\s\S]*?)\n<\/sentence>/gu),
      ];
      return {
        text: sentences
          .map(([, number, text]) =>
            text?.startsWith("Per-layer work")
              ? `${number}: unstated: “Per-layer work”`
              : `${number}: stated`,
          )
          .join("\n"),
      };
    },
  });
}
