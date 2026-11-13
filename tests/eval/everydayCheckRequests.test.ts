/**
 * What the everyday evaluation's record keeps of each cited sentence's check
 * (eval/everyday/checkRequests.ts, #3019): each quote the check's model gave the
 * cite Tool, the Citation check's answer to it, and the run's replies.
 */
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { describe, expect, test } from "vitest";
import { heardChecks } from "../../eval/everyday/checkRequests";
import { checkCitedSentences } from "../../eval/everyday/support";
import { watchTokens } from "../../eval/lib/tokens";
import { checkingModel } from "../helpers/checks";
import { type SourceFile, setUpWithDocuments } from "../helpers/citations";

const asked = (sentence: string): LanguageModelV4Prompt[number] => ({
  role: "user",
  content: [{ type: "text", text: `The sentence to check:\n<sentence>\n${sentence}\n</sentence>` }],
});

const cited = (id: string, marker: number, quote: string): LanguageModelV4Prompt[number] => ({
  role: "assistant",
  content: [
    {
      type: "tool-call",
      toolCallId: id,
      toolName: "cite",
      input: { citations: [{ marker, passage: "P1", quote }] },
    },
  ],
});

const told = (id: string, answer: string): LanguageModelV4Prompt[number] => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: id,
      toolName: "cite",
      output: { type: "text", value: answer },
    },
  ],
});

const TABLE_ROW = "Weighted keys need O(1) sequential steps.";
const MISSED = "Fix these with another cite call:\n- [^1]: the quote isn't in P1's text.";

describe("The record of what a check asked its model and was told", () => {
  // protects=each run of a check is read from its requests by the sentence it was asked about, with every quote its model gave the cite Tool, whether the Citation check recorded it, what it told the model, and the run's replies with text; fails_when=a quote is lost, a refused quote reads as found, a quote is counted twice across the requests that repeat it, or a part's run is merged with another's; no_claim=why the Citation check refused a quote.
  test("each run keeps its typed quotes, the Citation check's answer and its replies", () => {
    const first = [asked(TABLE_ROW)];
    const second = [
      ...first,
      cited("c1", 1, "Weighted keys O(n2d) O(1)"),
      told("c1", `Nothing was recorded. ${MISSED}`),
    ];
    const third = [
      ...second,
      cited("c2", 1, "Weighted keys O(n2 d) O(1) O(1)"),
      told("c2", "Recorded [^1]. Write the Answer now."),
    ];
    const runs = heardChecks([
      { prompt: first, text: "" },
      { prompt: second, text: "" },
      { prompt: [asked("The paper suggests local lookups.")], text: "Verdict: unsupported" },
      { prompt: third, text: "Verdict: supported\nEvidence: [1]" },
      {
        prompt: [{ role: "user", content: [{ type: "text", text: "Confirm the figure." }] }],
        text: "same",
      },
    ]);
    expect(runs).toEqual([
      {
        claim: TABLE_ROW,
        quotes: [
          {
            marker: 1,
            passage: "P1",
            quote: "Weighted keys O(n2d) O(1)",
            found: false,
            answer: `Nothing was recorded. ${MISSED}`,
          },
          {
            marker: 1,
            passage: "P1",
            quote: "Weighted keys O(n2 d) O(1) O(1)",
            found: true,
            answer: "Recorded [^1]. Write the Answer now.",
          },
        ],
        replies: ["Verdict: supported\nEvidence: [1]"],
      },
      { claim: "The paper suggests local lookups.", quotes: [], replies: ["Verdict: unsupported"] },
      { claim: null, quotes: [], replies: ["same"] },
    ]);
  });

  // protects=a quote recorded beside a problem named for its own marker is not found, and one recorded beside another marker's problem is; fails_when=any problem in the answer marks every quote of the call as not found, or none; no_claim=none beyond protects.
  test("a quote is found only when its own marker is recorded with no problem named for it", () => {
    const prompt = [
      asked(TABLE_ROW),
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "c1",
            toolName: "cite",
            input: JSON.stringify({
              citations: [
                { marker: 1, passage: "P1", quote: "O(1)" },
                { marker: 2, passage: "P2", quote: "O(n)" },
              ],
            }),
          },
        ],
      },
      told(
        "c1",
        "Recorded [^1], [^2]. Fix these with another cite call:\n- [^2]: the quote is in P3.",
      ),
    ];
    const [run] = heardChecks([{ prompt, text: "" }]);
    expect(run?.quotes.map(({ marker, found }) => [marker, found])).toEqual([
      [1, true],
      [2, false],
    ]);
  });
});

const TIDES: SourceFile = {
  name: "Tides.md",
  contents: "The tide turns twice a day.\n\nThe harbour closes at dusk.\n",
};
const TURNS = "The tide turns twice a day.";
const CLOSES = "The harbour closes at dusk.";

describe("Hearing a cited sentence's check through the Library's chat model", () => {
  // protects=checking an Answer's cited sentences with the token watcher's hear keeps, for each, what its check's model typed for the cite Tool and the Citation check's answer, through the core's real check, and its replies only for a sentence that isn't Supported; a check started outside the hearing isn't heard; fails_when=the hearing loses the check's requests inside the core, takes in another flow's, or keeps a Supported sentence's replies; no_claim=how a real model quotes.
  test("each sentence keeps its check's typed quotes and answers, and only its own", async () => {
    const tokens = watchTokens();
    const model = checkingModel({
      [TURNS]: { verdict: "supported", quote: TURNS },
      [CLOSES]: { verdict: "supported", quote: "The harbour shuts at dusk." },
    });
    const { core, documents } = await setUpWithDocuments(model, [TIDES], {
      createChatModel: tokens.chatModels(() => model),
    });
    const [tides] = documents;
    if (!tides) throw new Error("Tides.md wasn't added.");
    const citation = (marker: number, quote: string) => ({
      marker,
      documentName: tides.name,
      documentId: tides.id,
      contentHash: tides.contentHash,
      quote,
    });
    const outside = core.checkClaim({ claim: TURNS });
    const [turns, closes] = await checkCitedSentences(
      core,
      { text: `${TURNS}[^1] ${CLOSES}[^2]`, citations: [citation(1, TURNS), citation(2, CLOSES)] },
      null,
      tokens.hear,
    );
    await outside;

    expect(turns?.verdict).toBe("supported");
    expect(
      turns?.checks?.flatMap((run) => run.quotes.map(({ quote, found }) => [quote, found])),
    ).toEqual([[TURNS, true]]);
    expect(turns?.checks?.every((run) => run.replies.length === 0)).toBe(true);
    expect(closes?.verdict).toBe("not-checked");
    const [typed] = closes?.checks?.flatMap((run) => run.quotes) ?? [];
    expect(typed).toMatchObject({ quote: "The harbour shuts at dusk.", found: false });
    expect(typed?.answer).toContain("[^1]: ");
    expect(
      closes?.checks?.[0]?.replies.some((reply) => reply.startsWith("Verdict: supported")),
    ).toBe(true);
  });
});
