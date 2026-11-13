/**
 * What the everyday evaluation's record keeps of each cited sentence's check
 * (eval/everyday/checkRequests.ts, #3019): each quote the check's model gave the
 * cite Tool, the Citation check's answer to it, and the run's replies.
 */
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { describe, expect, test } from "vitest";
import {
  askedAnew,
  heardChecks,
  quotesTakenFromReplies,
  takenQuote,
} from "../../eval/everyday/checkRequests";
import { checkCitedSentences } from "../../eval/everyday/support";
import { type HeardRequest, watchTokens } from "../../eval/lib/tokens";
import { EVIDENCE_INSTRUCTIONS } from "../../src/core/answers/checks/prompt";
import { checkingModel, SAME_DETAIL } from "../helpers/checks";
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

const heard = (prompt: LanguageModelV4Prompt, text: string, inputTokens = 0): HeardRequest => ({
  prompt,
  text,
  usage: { inputTokens, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 },
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
      heard(first, ""),
      heard(second, ""),
      heard([asked("The paper suggests local lookups.")], "Verdict: unsupported"),
      heard(third, "Verdict: supported\nEvidence: [1]"),
      heard([{ role: "user", content: [{ type: "text", text: "Confirm the figure." }] }], "same"),
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
    const [run] = heardChecks([heard(prompt, "")]);
    expect(run?.quotes.map(({ marker, found }) => [marker, found])).toEqual([
      [1, true],
      [2, false],
    ]);
  });
});

const ROW = "Weighted keys O(n2 d) O(1) O(1)";
const ROW_ZH = "加权键只需要 O(1) 个顺序步骤。";
const written = (sentence: string, quote: string) =>
  heard(
    [asked(sentence)],
    `Verdict: supported\nEvidence: [1]\n[^1]: Weighted Keys Shorter Paths, p. 4 — "${quote}"`,
  );

describe("What the record counts of a check's requests (#3019)", () => {
  // protects=a request sent word for word as an earlier one counts as a look asked anew, and the steps of one look, which each add to the last, don't; fails_when=a look's later step is counted, or a repeat is missed; no_claim=which code path asked again.
  test("a request sent word for word again is a look asked anew, and a look's next step isn't", () => {
    const first = [asked(TABLE_ROW)];
    const next = [...first, cited("c1", 1, ROW), told("c1", "Recorded [^1].")];
    expect(askedAnew([heard(first, ""), heard(next, "Verdict: unsupported")])).toBe(0);
    expect(
      askedAnew([
        heard(first, ""),
        heard(next, "Verdict: unsupported"),
        heard([asked(ROW_ZH)], ""),
        heard(first, ""),
      ]),
    ).toBe(1);
  });

  // protects=a quote a check's reply wrote as a record line and no cite call of its run typed is taken from the reply, in English and Chinese sentences, matched loosely; one its run also typed through cite, one in running prose, and any in a run that asked for evidence are not; fails_when=a cite call's quote or an ask's structured reply reads as taken from the reply, or a written one is missed; no_claim=whether the core took it, which its Citation check decides.
  test("a record the reply wrote and no cite call typed is taken; one typed, in prose, or beside an ask for evidence isn't", () => {
    const taken = quotesTakenFromReplies([
      written(TABLE_ROW, ROW),
      written(ROW_ZH, "Recurrent O(n d2) O(n) O(n)"),
    ]);
    expect(takenQuote(taken, ROW)).toBe(true);
    expect(takenQuote(taken, "recurrent O(n d2)  O(n) O(n).")).toBe(true);
    expect(takenQuote(taken, "Weighted keys O(1)")).toBe(false);

    const typed = [asked(TABLE_ROW), cited("c1", 1, ROW), told("c1", "Recorded [^1].")];
    const inProse = heard(
      [asked(TABLE_ROW)],
      `Verdict: supported\nExplanation: the table gives "${ROW}".`,
    );
    const ask = heard(
      [{ role: "system", content: EVIDENCE_INSTRUCTIONS }, asked(TABLE_ROW)],
      `{"citations":[{"marker":1,"passage":"P1","quote":"${ROW}"}]}`,
    );
    expect(
      quotesTakenFromReplies([
        heard(typed, `Verdict: supported\n[^1]: Weighted Keys Shorter Paths, p. 4 — "${ROW}"`),
      ]).size,
    ).toBe(0);
    expect(quotesTakenFromReplies([inProse]).size).toBe(0);
    expect(quotesTakenFromReplies([written(TABLE_ROW, ROW), ask]).size).toBe(0);
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

  // protects=through the core's real check, a ✓ whose check took the record its reply wrote is marked with that record's quote, in English and Chinese, and one its check recorded through cite isn't; each sentence keeps a token count for every request its check made, and none was asked anew; fails_when=a cite call's ✓ is listed as taken from the reply, a taken one is missed, or the requests aren't kept; no_claim=how often a real model writes its record instead of calling cite.
  test("a ✓ resting on a record its reply wrote is marked, and one recorded through cite isn't", async () => {
    const tokens = watchTokens();
    const english = "Tides turn twice in a day here.";
    const chinese = "这里的潮水每天涨落两次。";
    const writing = {
      verdict: "supported" as const,
      judgement: "same" as const,
      reply: {
        text: [
          "Verdict: supported",
          "Absence: no",
          SAME_DETAIL,
          "Evidence: [1]",
          `[^1]: Tides, “${TURNS}”`,
        ].join("\n"),
      },
    };
    const model = checkingModel(
      {
        [english]: writing,
        [chinese]: writing,
        [CLOSES]: { verdict: "supported", quote: CLOSES, judgement: "same" },
      },
      [],
      '{"passage": null}',
    );
    const { core, documents } = await setUpWithDocuments(
      model,
      [{ name: "Tides.md", contents: `${TURNS}\n\n港口的潮水每天都会涨落。\n\n${CLOSES}\n` }],
      { createChatModel: tokens.chatModels(() => model) },
    );
    const [tides] = documents;
    if (!tides) throw new Error("Tides.md wasn't added.");
    const citation = (marker: number, quote: string) => ({
      marker,
      documentName: tides.name,
      documentId: tides.id,
      contentHash: tides.contentHash,
      quote,
    });

    const support = await checkCitedSentences(
      core,
      {
        text: `${english}[^1]\n\n${chinese}[^1]\n\n${CLOSES}[^2]`,
        citations: [citation(1, TURNS), citation(2, CLOSES)],
      },
      null,
      tokens.hear,
    );

    expect(support.map((each) => [each.sentence, each.verdict, each.fromReply])).toEqual([
      [english, "supported", [TURNS]],
      [chinese, "supported", [TURNS]],
      [CLOSES, "supported", undefined],
    ]);
    for (const each of support) {
      expect(each.asked?.requests.length).toBeGreaterThan(0);
      expect(each.asked?.anew).toBe(0);
    }
  });
});
