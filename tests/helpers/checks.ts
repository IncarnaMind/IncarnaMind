/**
 * A scripted model that checks claims (#96, #97) as its plans say, and names
 * a verified document's claims: those it has a plan for.
 */
import { recordClaimFacts } from "../../src/core/answers/checks/recordCites";
import { SEARCH_AGAIN } from "../../src/core/answers/checks/searchAgain";
import { scanRecordCites } from "../../src/core/recordCites/parser";
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
  says?: string;
  /** Its reply instead, once it has searched. */
  reply?: ScriptedReply;
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

/** The sentence a check Run is asked about. */
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
  if (plan.reply) return plan.reply;
  const shown = shownPassages(searches.at(-1)?.text ?? "");
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
  return {
    text: `Verdict: ${plan.verdict}${plan.says ? `\n${plan.says} [^1]` : ""}`,
  };
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
          recordClaimFacts(claim, scanRecordCites(claim, { hasPrevious: true })) === sentence,
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
