/**
 * The scripted model the set runs with when no chat model is given: it
 * answers every Question as its expected results say, searching for each
 * input's quote and handing them to the calculate Tool, so a run with no key
 * and no network checks that every expected input is found and read by the
 * app as the set says. Its scores are the set's own, never a model's.
 */
import type { MockLanguageModelV4 } from "ai/test";
import { type ShownPassage, shownPassages } from "../../tests/helpers/citations";
import { scriptedModel } from "../../tests/helpers/models";
import type { CalculationCase, ExpectedInput, ExpectedResult } from "./cases";
import { NORTHWIND_DECK } from "./documents";

const squeezed = (text: string) => text.replace(/\s+/g, " ").trim();

/** A Document is named after its file, without the extension. */
const withoutExtension = (name: string) => name.replace(/\.[^.]+$/, "");

const derivedWithInputs = (result: ExpectedResult) =>
  result.kind === "derived" && Object.keys(result.inputs).length > 0;

/** Each input's quote once: what the oracle searches for. */
const queriesOf = (test: CalculationCase): string[] => [
  ...new Set(
    test.results.flatMap((result) =>
      derivedWithInputs(result) ? Object.values(result.inputs).map((each) => each.quote) : [],
    ),
  ),
];

function passageOf(passages: readonly ShownPassage[], input: ExpectedInput): ShownPassage {
  const found = passages.find(
    (passage) =>
      passage.document === withoutExtension(input.document) &&
      squeezed(passage.text).includes(squeezed(input.quote)),
  );
  if (!found) throw new Error(`No Passage of ${input.document} shown holds "${input.quote}".`);
  return found;
}

const locationOf = (input: ExpectedInput, passage: ShownPassage): string | undefined =>
  input.unit === null
    ? (passage.location ?? undefined)
    : input.document === NORTHWIND_DECK
      ? `slide ${input.unit}`
      : `p. ${input.unit}`;

const AS = { percent: "percent", points: "points", USD: "currency", CNY: "currency" } as const;

/** A result written as the oracle writes one with no input to hand to calculate. */
function writtenValue(result: ExpectedResult, language: CalculationCase["language"]): string {
  switch (result.unit) {
    case "percent":
      return `${(result.value * 100).toFixed(2)}%`;
    case "points":
      return language === "zh"
        ? `${(result.value * 100).toFixed(2)}个百分点`
        : `${(result.value * 100).toFixed(2)} percentage points`;
    case "USD":
      return `$${result.value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    case "CNY":
      return `${(result.value / 1e4).toFixed(2)}万元`;
  }
}

const REFUSAL = {
  en: "The Documents give no exchange rate, so this can't be converted or compared.",
  zh: "文档没有给出汇率，无法折算或比较。",
};

export function calculationOracle(cases: readonly CalculationCase[]): MockLanguageModelV4 {
  return scriptedModel(
    (call) => {
      // The longest Question the prompt holds: "…同比增长多少？" is inside "按可比口径，…同比增长多少？".
      const test = cases
        .filter((each) => call.prompt.includes(each.question))
        .sort((a, b) => b.question.length - a.question.length)[0];
      if (!test) return { text: "This Question isn't in the set." };
      if (test.refuse) return { text: REFUSAL[test.language] };
      const queries = queriesOf(test);
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (searches.length < queries.length) {
        return {
          calls: [{ tool: "search_documents", input: { query: queries[searches.length] } }],
        };
      }
      const calculating = test.results.filter(derivedWithInputs);
      if (calculating.length > 0 && !call.results.some((result) => result.tool === "calculate")) {
        const passages = searches.flatMap((each) => shownPassages(each.text));
        const figures = calculating.map((result, index) => ({
          marker: index + 1,
          label: result.label,
          formula: result.formula,
          as: AS[result.unit],
          inputs: Object.entries(result.inputs).map(([name, input]) => {
            const passage = passageOf(passages, input);
            const location = locationOf(input, passage);
            return {
              name,
              label: name,
              passage: passage.id,
              ...(location && { location }),
              quote: input.quote,
              number: input.number,
              ...(input.unitQuote && { unitQuote: input.unitQuote }),
              ...(input.rate && { rate: input.rate }),
            };
          }),
        }));
        return { calls: [{ tool: "calculate", input: { figures } }] };
      }
      const lines = test.results.map((result) => {
        const marker = calculating.indexOf(result);
        return `${result.label}: ${marker >= 0 ? `[=${marker + 1}]` : writtenValue(result, test.language)}.`;
      });
      return { text: lines.join("\n") };
    },
    { judgesItsAnswers: true },
  );
}
