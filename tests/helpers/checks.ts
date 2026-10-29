/**
 * A scripted model that checks claims (#96, #97) as its plans say, and names
 * a verified document's claims: those it has a plan for.
 */

import { documentFigureContext } from "../../src/core/answers/calculations";
import { recordClaimFacts } from "../../src/core/answers/checks/recordCites";
import { SEARCH_AGAIN } from "../../src/core/answers/checks/searchAgain";
import { isRecord } from "../../src/core/errors";
import { recordCiteTokens } from "../../src/core/recordCites/parser";
import { readFigures } from "../../src/shared/figures";
import { comparableSentence } from "../../src/shared/sentences";
import { shownPassages } from "./citations";
import {
  type GenerateCall,
  type GeneratedReply,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
} from "./models";

/** How the scripted model checks a sentence: what it cites, and how it replies. */
export interface Plan {
  verdict?: "supported" | "unsupported" | "contradicted";
  /** The line it cites, from the Passage that holds it. */
  quote?: string;
  /** The number of `quote` that backs the sentence's figure, as written: its first of a kind when absent. */
  number?: string;
  /** The line of the quote's Passage that states that number's unit, as the model gives it. */
  unitQuote?: string;
  says?: string;
  /** Its reply instead, once it has searched; given the call, for one that names its figures. */
  reply?: ScriptedReply | ((call: ModelCall) => ScriptedReply);
  /** What it says when asked to confirm a contradiction it found. */
  judgement?: "conflict" | "same" | "neither";
  /** Its reply to the strict judgement, a contradiction's second; `judgement` when absent. */
  strict?: GeneratedReply;
  /** Its reply when asked for the parts of a sentence it called contradicted that the strict judgement didn't uphold. */
  part?: string;
  /**
   * A figure it works out with calculate before its verdict (#707), each
   * input from the Passage that holds its quote, as marker 1; or several, as
   * markers 1, 2, … in their order.
   */
  calculation?: PlannedFigure | readonly PlannedFigure[];
  /** Asked to search again before it says the sentence isn't found: the query it writes, then how it checks. */
  again?: { query: string; plan: Plan };
}

interface PlannedFigure {
  inputs: readonly {
    name: string;
    label: string;
    quote: string;
    number: string;
    bracketedCost?: boolean;
  }[];
  formula: string;
  as?: string;
  stated: string;
  relation?: "equals" | "at most" | "at least";
}

const SENTENCE = /<sentence>\n([\s\S]*?)\n<\/sentence>/;
const FIGURES = /<figures>\n([\s\S]*?)\n<\/figures>/;

/**
 * The figures of the sentence a check Run is asked to bind, each with its id, its shown text and,
 * for one it may be read more than one way, its first reading, as a model names one.
 */
export function requestedFigures(
  call: ModelCall,
): { id: string; shown: string; reading: number | null }[] {
  const match = FIGURES.exec(call.prompt);
  if (!match?.[1]) return [];
  const value: unknown = JSON.parse(match[1]);
  if (!Array.isArray(value)) throw new Error("The fixture expected requested figures.");
  return value.map((figure: unknown) => {
    if (!isRecord(figure) || typeof figure.id !== "string" || typeof figure.shown !== "string")
      throw new Error("The fixture received an invalid figure.");
    const unsettled = Array.isArray(figure.ambiguities) && figure.ambiguities.length > 0;
    return { id: figure.id, shown: figure.shown, reading: unsettled ? 1 : null };
  });
}

/** The sentence a check Run is asked about. */
/**
 * An Unsupported verdict as a check writes it, with `said` (its reason and Covered lines) and the
 * Figures line its requested figures need.
 */
export function unsupportedReply(call: ModelCall, said?: string): string {
  const verdict = said ? `Verdict: unsupported\n${said}` : "Verdict: unsupported";
  const figures = requestedFigures(call);
  if (figures.length === 0) return verdict;
  const items = figures.map(({ id }) => ({
    id,
    verdict: "unsupported",
    scope: "same",
    topic: "not found",
    roles: "same",
    says: null,
    reading: null,
    relation: "equals",
    source: null,
    calculation: null,
  }));
  return `${verdict}\nFigures: ${JSON.stringify({ items, remainder: null })}`;
}

export const sentenceOf = (call: ModelCall) => {
  const text = call.options.prompt
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => ("text" in part ? part.text : "")).join(""),
    )
    .join("\n");
  return SENTENCE.exec(text)?.[1] ?? "";
};

/** The numbers of the listed sentences ("[3] …") that have a plan. */
function plannedNumbers(prompt: string, plans: Record<string, Plan>): number[] {
  return prompt.split("\n").flatMap((line) => {
    const listed = /^\[(\d+)\] (.*)$/.exec(line);
    return listed?.[2] !== undefined && listed[2] in plans ? [Number(listed[1])] : [];
  });
}

/** The strict judgement's instructions, which ask for the sentence's detail and the quote's before the word. */
export const isStrict = (call: { system: string }) => call.system.includes("Judgement: one word");

/** A check Run's instructions (src/core/answers/checks/prompt.ts). */
export const isCheckRun = (call: ModelCall) => call.system.startsWith("You check one sentence");

/**
 * How a model checks as its plans say: it searches for the sentence, cites,
 * then gives its verdict.
 */
export function checkReply(call: ModelCall, plans: Record<string, Plan>): ScriptedReply {
  const planned = plans[sentenceOf(call)] ?? { verdict: "unsupported" };
  const searches = call.results.filter((result) => result.tool === "search_documents");
  if (searches.length === 0) {
    return { calls: [{ tool: "search_documents", input: { query: sentenceOf(call) } }] };
  }
  const again = call.prompt.includes(SEARCH_AGAIN) ? planned.again : undefined;
  if (again && searches.length === 1) {
    return { calls: [{ tool: "search_documents", input: { query: again.query } }] };
  }
  const plan = again?.plan ?? planned;
  if (plan.reply) return typeof plan.reply === "function" ? plan.reply(call) : plan.reply;
  // What its search found, and the Passages its sentence's Citations quote, given with the sentence.
  const shown = [...shownPassages(searches.at(-1)?.text ?? ""), ...shownPassages(call.prompt)];
  const { calculation } = plan;
  if (calculation && !call.results.some((result) => result.tool === "calculate")) {
    const passageOf = (quote: string) => shown.find((each) => each.text.includes(quote))?.id;
    const planned: readonly PlannedFigure[] =
      "formula" in calculation ? [calculation] : calculation;
    const figures = planned.map(({ inputs, ...figure }, index) => ({
      marker: index + 1,
      label: "The sentence's figure",
      relation: "equals",
      ...figure,
      inputs: inputs.map((input) => ({ ...input, passage: passageOf(input.quote) })),
    }));
    return { calls: [{ tool: "calculate", input: { figures } }] };
  }
  const { quote } = plan;
  if (quote && !call.results.some((result) => result.tool === "cite")) {
    const passage = shown.find((each) => each.text.includes(quote)) ?? shown[0];
    return {
      calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage: passage?.id, quote }] } }],
    };
  }
  const verdict = `Verdict: ${plan.verdict}${plan.says ? `\n${plan.says} [^1]` : ""}`;
  const figures = requestedFigures(call);
  if (figures.length === 0) return { text: verdict };
  if (!calculation) {
    // With nothing quoted, each figure is one no Passage states.
    if (!quote) {
      const items = figures.map(({ id }) => ({
        id,
        verdict: "unsupported",
        scope: "same",
        topic: "not found",
        roles: "same",
        says: null,
        reading: null,
        relation: "equals",
        source: null,
        calculation: null,
      }));
      return { text: `${verdict}\nFigures: ${JSON.stringify({ items, remainder: null })}` };
    }
    // Each figure from the cited quote's number of its own kind of unit, or its first.
    const numbers = readFigures(quote, documentFigureContext([{ text: quote }]));
    const items = figures.map(({ id, shown, reading }) => {
      const kind = readFigures(shown, documentFigureContext([{ text: shown }]))[0]?.unit.kind;
      const source = plan.number
        ? { chars: plan.number }
        : (numbers.find((each) => each.unit.kind === kind) ?? numbers[0]);
      return {
        id,
        verdict: source ? (plan.verdict ?? "unsupported") : "unsupported",
        scope: "same",
        topic: source ? "found" : "not found",
        roles: "same",
        says: null,
        reading,
        relation: "equals",
        source: source
          ? {
              citation: 1,
              number: source.chars,
              ...(plan.unitQuote && { unitQuote: plan.unitQuote }),
            }
          : null,
        calculation: null,
      };
    });
    return { text: `${verdict}\nFigures: ${JSON.stringify({ items, remainder: null })}` };
  }
  const worked: readonly PlannedFigure[] = "formula" in calculation ? [calculation] : calculation;
  const items = figures.map(({ id, shown }) => {
    const marker = worked.findIndex((figure) => figure.stated === shown) + 1;
    return {
      id,
      verdict: marker > 0 ? (plan.verdict ?? "unsupported") : "unsupported",
      scope: "same",
      topic: marker > 0 ? "found" : "not found",
      roles: "same",
      says: null,
      reading: null,
      relation: "equals",
      source: null,
      calculation: marker > 0 ? marker : null,
    };
  });
  return { text: `${verdict}\nFigures: ${JSON.stringify({ items, remainder: null })}` };
}

/**
 * What the model gives when it isn't streamed: asked which of a document's
 * sentences make claims, those it has a plan for; asked to confirm a
 * contradiction, the plan's judgement; asked once more for the deciding
 * Passage, `evidence` (none by default).
 */
export const checkGenerate =
  (plans: Record<string, Plan>, evidence: string = JSON.stringify({ passage: null })) =>
  (call: GenerateCall): GeneratedReply => {
    const sentence = SENTENCE.exec(call.prompt)?.[1] ?? "";
    const plan =
      plans[sentence] ??
      Object.entries(plans).find(
        ([claim]) =>
          comparableSentence(
            recordClaimFacts(
              claim,
              recordCiteTokens(claim).filter((token) => token.kind === "cite"),
            ),
          ) === sentence,
      )?.[1];
    if (call.system.startsWith("You sort the sentences")) {
      return { text: JSON.stringify({ claims: plannedNumbers(call.prompt, plans) }) };
    }
    if (call.system.startsWith("A sentence the User wrote says more")) {
      return { text: plan?.part ?? "" };
    }
    if (call.system.startsWith("Compare a sentence")) {
      if (plan?.strict && isStrict(call)) return plan.strict;
      return { text: plan?.judgement ?? "conflict" };
    }
    return { text: evidence };
  };

/** A model that checks as its plans say (`checkReply`, `checkGenerate`), keeping each call. */
export function checkingModel(
  plans: Record<string, Plan>,
  calls: ModelCall[] = [],
  evidence?: string,
) {
  return scriptedModel(
    (call) => {
      calls.push(call);
      return checkReply(call, plans);
    },
    { generate: checkGenerate(plans, evidence) },
  );
}
