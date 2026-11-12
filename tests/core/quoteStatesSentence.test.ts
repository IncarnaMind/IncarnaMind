import { describe, expect, test } from "vitest";
import type { Core, CoreAdapters, MarkedCitation } from "../../src/core";
import { answerEnded, answerJudged, setUpWithDocuments, shownPassages } from "../helpers/citations";
import { type GenerateCall, type GeneratedReply, scriptedModel } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";
import {
  answering,
  type Case,
  CHINESE,
  DECOY_CHINESE,
  DECOY_ENGLISH,
  documentOf,
  ENGLISH,
  holds,
  STATED_CHINESE,
  STATED_ENGLISH,
} from "../helpers/quoteStatesSentenceCases";

/**
 * A Citation's quote states its sentence (#2739), over the issue's ten sentences in English and
 * Chinese (../helpers/quoteStatesSentenceCases): a found quote shows its whole sentence, and a
 * sentence whose shown quote doesn't state it ends with no green check. The judge here reads as a
 * careful person would: the sentence's quoted words state it only when they hold its claim's words.
 */

/** The sentences of a batch, each with the words it cites, as the batch's prompt shows them. */
function batchSentences(prompt: string): { number: number; quoted: string }[] {
  return [
    ...prompt.matchAll(
      /<sentence number="(\d+)">\n[\s\S]*?\n<\/sentence>\n((?:It cites [^\n]*\n?)*)/g,
    ),
  ].map(([, number, cites = ""]) => ({ number: Number(number), quoted: cites }));
}

/** The judge as a careful reader: supported as `each` says, copying the claim's words its quoted words don't hold. */
function judge(each: Case) {
  return (call: GenerateCall): GeneratedReply => ({
    text: JSON.stringify({
      sentences: batchSentences(call.prompt).map(({ number, quoted }) => ({
        number,
        kind: "fact",
        unstated: null,
        uncited: each.states.filter((words) => !holds(quoted, words)).join(" ") || null,
        verdict: each.verdict ?? "supported",
        roles: "same",
        time: "same",
        says: "The Document says so.",
      })),
    }),
  });
}

/** The Answer as `answering` scripts it, its sentences judged as `judge`. */
const answeringModel = (each: Case) =>
  scriptedModel(answering(each), {
    generate: (call) =>
      call.question === "sentence-batch" ? judge(each)(call) : { text: '{"claims":[]}' },
  });

async function judgedCitation(core: Core, question: string): Promise<MarkedCitation | undefined> {
  const asked = await core.askInConversation({ text: question });
  if (!asked.asked) throw new Error("Not asked.");
  const ended = await answerEnded(core, asked.answerId);
  if (ended.event !== "finished") throw new Error("The Answer failed.");
  const answer = await answerJudged(core, asked.conversation.id, asked.answerId);
  return answer.citations.find((each) => each.marker === 1);
}

async function asked(each: Case, chinese: boolean, overrides: Partial<CoreAdapters> = {}) {
  const { core } = await setUpWithDocuments(
    answeringModel(each),
    [documentOf(each, chinese)],
    overrides,
  );
  return judgedCitation(core, chinese ? "这份报告怎么说？" : "What does the report say?");
}

describe("a Citation's shown quote states its sentence, or the sentence has no green check", () => {
  for (const [language, cases, chinese] of [
    ["English", ENGLISH, false],
    ["Chinese", CHINESE, true],
    ["English, already stated", STATED_ENGLISH, false],
    ["Chinese, already stated", STATED_CHINESE, true],
    ["English, a figure given to the wrong thing", DECOY_ENGLISH, false],
    ["Chinese, a figure given to the wrong thing", DECOY_CHINESE, true],
  ] as const) {
    test.each(cases)(`in ${language}, a quote that $name ends $ends`, async (each) => {
      const citation = await asked(each, chinese);

      expect(citation?.check).toBe(each.ends);
      // A stated sentence shows words that state it; a decoy's number is in the words shown, and
      // only the model's own words keep it from the green check.
      if (each.ends === "found" || cases === DECOY_ENGLISH || cases === DECOY_CHINESE) {
        for (const words of each.states) expect(holds(citation?.quote ?? "", words)).toBe(true);
        expect(holds(citation?.quote ?? "", each.quote)).toBe(true);
      }
    });
  }

  test.each([
    ["English", ENGLISH[1] as Case, false],
    ["Chinese", CHINESE[1] as Case, true],
  ] as const)(
    "in %s, a quote kept as the model gave it, by the evaluation's switch, leaves its date out and its sentence unchecked",
    async (_, each, chinese) => {
      const citation = await asked(each, chinese, { quotesAsGiven: () => true });

      expect(citation).toMatchObject({ quote: each.quote, check: "not-checked" });
    },
  );
});

describe("a figure among others of its unit ends as the model's own words leave it, read in their page's unit", () => {
  const IN_THOUSANDS = [
    "Results for the year (£'000)",
    "Turnover was 1,250 and fees were £800 in the year.",
  ];
  const SENTENCE = "Turnover was 1,250 and fees were £800 in the year.";
  const of = (quote: string, ends: Case["ends"]): Case => ({
    name: quote,
    lines: IN_THOUSANDS,
    sentence: "Fees were £800.",
    quote,
    states: ["£800"],
    ends,
  });

  test.each([
    [
      "quoted whole, so shown as given, holds the turnover in £'000 too",
      of(SENTENCE, "not-checked"),
    ],
    [
      "quoted up to its figure, holds the turnover in £'000 too",
      of("Turnover was 1,250 and fees were £800", "not-checked"),
    ],
    ["quoted as the fees alone, holds the one figure", of("fees were £800 in the year", "found")],
  ])("the sentence %s", async (_, each) => {
    const citation = await asked(each, false);

    expect(citation).toMatchObject({ quote: SENTENCE, check: each.ends });
  });
});

describe("cite says when two records give one quote", () => {
  const LINES = [
    "The method is usually credited to Ilsa Marrow, who first proposed it in 1847.",
    "Teodor Venn independently proposed a similar method in 1907.",
  ];
  const MARROW = "The method is usually credited to Ilsa Marrow, who first proposed it in 1847";

  /** A model that gives both markers Marrow's quote, then the same records again, and answers; `told` keeps what each `cite` said. */
  function repeatingModel(told: string[]) {
    return scriptedModel(
      (call) => {
        const searches = call.results.filter((result) => result.tool === "search_documents");
        if (searches.length === 0) {
          return { calls: [{ tool: "search_documents", input: { query: "Marrow Venn method" } }] };
        }
        const cites = call.results.filter((result) => result.tool === "cite");
        if (cites.length < 2) {
          const passage = shownPassages(searches.at(-1)?.text ?? "")[0]?.id;
          const record = (marker: number) => ({ marker, passage, quote: MARROW });
          return { calls: [{ tool: "cite", input: { citations: [record(1), record(2)] } }] };
        }
        told.push(...cites.map((cite) => cite.text));
        return {
          text: "Ilsa Marrow first proposed the method in 1847[^1]. Teodor Venn proposed a similar one in 1907[^2].",
        };
      },
      { judgesItsAnswers: true },
    );
  }

  test("once, for the later marker, as advice that leaves the Answer to be written, and the record is kept", async () => {
    const told: string[] = [];
    const { core } = await setUpWithDocuments(repeatingModel(told), [
      { name: "Methods.pdf", contents: buildPdf([{ lines: LINES }]) },
    ]);

    const citation = await judgedCitation(core, "Who proposed the method?");

    expect(told[0]).toMatch(
      /^Recorded \[\^1\], \[\^2\]\. \[\^2\] gives the quote of \[\^1\]\. .* Write the Answer now/,
    );
    expect(told[0]).not.toContain("[^1] gives the quote");
    expect(told[0]).not.toContain("Fix these");
    expect(told[1]).toMatch(/^Recorded \[\^1\], \[\^2\]\. Write the Answer now/);
    expect(citation?.quote).toBe(MARROW);
  });

  test("never, with the evaluation's switch for quotes as given", async () => {
    const told: string[] = [];
    const { core } = await setUpWithDocuments(
      repeatingModel(told),
      [{ name: "Methods.pdf", contents: buildPdf([{ lines: LINES }]) }],
      { quotesAsGiven: () => true },
    );

    await judgedCitation(core, "Who proposed the method?");

    expect(told[0]).toMatch(/^Recorded \[\^1\], \[\^2\]\. Write the Answer now/);
  });
});
