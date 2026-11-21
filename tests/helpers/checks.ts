/**
 * A scripted model that checks claims (#96, #97) as its plans say, and names
 * a verified document's claims: those it has a plan for.
 */
import { SEARCH_AGAIN } from "../../src/core/answers/checks/claimCheck";
import type { SortWord } from "../../src/core/answers/checks/claims";
import { recordClaimFacts } from "../../src/core/answers/checks/recordCites";
import { sortReply } from "./claimSentences";

export { listedSentences } from "./claimSentences";

import { recordCiteTokens } from "../../src/core/recordCites/parser";
import { comparableSentence } from "../../src/shared/sentences";
import { shownPassages } from "./citations";
import {
  type GenerateCall,
  type GeneratedReply,
  type ModelCall,
  restatedAsQuoted,
  type ScriptedReply,
  scriptedModel,
  unscripted,
} from "./models";

/** How the scripted model checks a sentence: what it cites, and how it replies. */
export interface Plan {
  /** The verdict word it writes: one of the six a check asks for, or the older "unsupported". */
  verdict?:
    | "supported"
    | "unsupported"
    | "contradicted"
    | "overstated"
    | "partly supported"
    | "not found"
    | "own view";
  /** The line it cites, from the Passage that holds it. */
  quote?: string;
  says?: string;
  /** The line of working it gives for a verdict it worked out. */
  working?: string;
  /** For a contradiction: the sentence's words the Document gives another value for, and the Document's. */
  change?: { from: string; to: string };
  /** What it writes when asked for its explanation again in the interface's language (#2081). */
  restated?: string;
  /** Its reply instead, once it has searched; given the call, for one that reads it. */
  reply?: ScriptedReply | ((call: ModelCall) => ScriptedReply);
  /** What it says of a record cite's Passage. */
  judgement?: "conflict" | "same" | "neither";
  /** Its reply when asked for the parts of a sentence a record cite's Passage states in part. */
  part?: string;
  /** Asked to search again before it says the sentence isn't found: the query it writes, then how it checks. */
  again?: { query: string; plan: Plan };
  /** How the claim sorter classifies the sentence; "undecided" omits it from the sort reply. */
  sort?: SortWord | "undecided";
}

const SENTENCE = /<sentence>\n([\s\S]*?)\n<\/sentence>/;

/** An Unsupported verdict as a check writes it, with `said`, its Explanation. */
export const unsupportedReply = (_call: ModelCall, said?: string): string =>
  said
    ? `Verdict: unsupported\nExplanation: ${said}\nEvidence: []`
    : "Verdict: unsupported\nEvidence: []";

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
  const { quote } = plan;
  if (quote && !call.results.some((result) => result.tool === "cite")) {
    const passage = shown.find((each) => each.text.includes(quote)) ?? shown[0];
    return {
      calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage: passage?.id, quote }] } }],
    };
  }
  return {
    text: [
      `Verdict: ${plan.verdict ?? "unsupported"}`,
      ...(plan.says ? [`Explanation: ${plan.says}${quote ? " [^1]" : ""}`] : []),
      `Evidence: ${quote ? "[1]" : "[]"}`,
      ...(plan.working ? [`Working: ${plan.working}`] : []),
      ...(plan.change ? [`Change 1: ${plan.change.from}`, `To 1: ${plan.change.to} [^1]`] : []),
    ].join("\n"),
  };
}

/**
 * What the model gives when it isn't streamed, by the judge's question it asks: asked which of a
 * document's sentences make claims, those it has a plan for; asked about a record cite, the
 * plan's judgement. A question with no reply here fails the test (tests/setup/judges.ts).
 */
/** A plan's judgement as the record-cite judgement words it (src/core/answers/checks/prompt.ts). */
const RECORD_WORDS = { same: "supported", conflict: "partly", neither: "unsupported" } as const;

export const checkGenerate =
  (plans: Record<string, Plan>) =>
  (call: GenerateCall): GeneratedReply => {
    const sentence = SENTENCE.exec(call.prompt)?.[1] ?? "";
    // A record cite's judgement reads the sentence as the Note holds it: a Citation left out of a
    // plan's words leaves no space before the stop there.
    const tidy = (text: string) => text.replace(/\s+([.,;:!?。，；：！？])/gu, "$1");
    const plan =
      plans[sentence] ??
      Object.entries(plans).find(
        ([claim]) =>
          tidy(
            comparableSentence(
              recordClaimFacts(
                claim,
                recordCiteTokens(claim).filter((token) => token.kind === "cite"),
              ),
            ),
          ) === tidy(sentence),
      )?.[1];
    switch (call.question) {
      case "find-claims":
        return {
          text: sortReply(call.prompt, (text) => {
            const word = plans[text]?.sort;
            return word === "undecided" ? undefined : (word ?? (text in plans ? "claim" : "no"));
          }),
        };
      case "verify-brief":
        return { text: JSON.stringify({ conclusions: [], figures: [] }) };
      case "parts":
        return { text: plan?.part ?? "" };
      case "record-cite":
        return { text: `Judgement: ${RECORD_WORDS[plan?.judgement ?? "conflict"]}` };
      // What an Answer asks beside its checks: no claimed change, and no sentence of it judged.
      case "claimed-changes":
        return { text: JSON.stringify({ claims: [] }) };
      case "request-done":
        return { text: JSON.stringify({ asks_change: "no", request: "none" }) };
      case "sentence-batch":
        return { text: JSON.stringify({ sentences: [] }) };
      case "restate": {
        const asked = Object.values(plans).find(
          (each) =>
            each.restated !== undefined &&
            each.says !== undefined &&
            call.prompt.includes(each.says.split("\n")[0] ?? ""),
        );
        return { text: asked?.restated ?? restatedAsQuoted(call) };
      }
      // A request that is no judge's question, such as a search query's rewrite.
      case undefined:
        return { text: "" };
      default:
        return unscripted(call.question, call.system);
    }
  };

/** A model that checks as its plans say (`checkReply`, `checkGenerate`), keeping each call. */
export function checkingModel(plans: Record<string, Plan>, calls: ModelCall[] = []) {
  return scriptedModel(
    (call) => {
      calls.push(call);
      return checkReply(call, plans);
    },
    { generate: checkGenerate(plans) },
  );
}
