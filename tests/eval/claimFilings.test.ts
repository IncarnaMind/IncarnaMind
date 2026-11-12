import { wrapLanguageModel } from "ai";
import { describe, expect, test } from "vitest";
import {
  claimFilingsOf,
  filingRows,
  filingsByProbe,
  keepClaimFilings,
} from "../../eval/everyday/claimFilings";
import { unbackedClaims } from "../../src/core/answers/claimedChanges";
import { scriptedModel } from "../helpers/models";

// Verdicts as the quick models gave them in #2970's diagnosis runs.
const AS_A_NOTE =
  '{"claims":[{"sentence":"我整理了手册的要点。","kind":"made","about":"mind","backed":false}]}';
const AS_SOMEONE_ELSE =
  '{"claims":[{"sentence":"你昨天加了两本历史书","kind":"added","about":"someone_else","backed":false},{"sentence":"并把《三体》挪到了下个月。","kind":"changed","about":"someone_else","backed":false}]}';
const AS_THE_REPLY_AND_A_NOTE =
  '{"claims":[{"sentence":"The summary in “Q3 review” grew to about 422 words.","kind":"changed","about":"mind","backed":true},{"sentence":"A couple of lines carry a warning from the app\'s checks.","kind":"made","about":"reply","backed":false}]}';
const NONE = '{"claims":[]}';

const text = (reply: string) => [{ type: "text", text: reply }];

describe("Where the claims check filed each sentence (#2970)", () => {
  test("keeps each claim's fields as the model gave them", () => {
    expect(claimFilingsOf(text(AS_A_NOTE))).toEqual({
      filed: [{ sentence: "我整理了手册的要点。", kind: "made", about: "mind", backed: false }],
    });
    expect(claimFilingsOf(text(NONE))).toEqual({ filed: [] });
  });

  test("keeps a field that is missing or of another type as null", () => {
    expect(
      claimFilingsOf(text('{"claims":[{"sentence":"Done.","kind":"added","backed":"false"}]}')),
    ).toEqual({ filed: [{ sentence: "Done.", kind: "added", about: null, backed: null }] });
  });

  test("keeps a reply with no list of claims as its text", () => {
    expect(claimFilingsOf(text("I can't tell."))).toEqual({ filed: [], text: "I can't tell." });
  });

  test("reads a fenced reply and a tool call's input, as providers return them", () => {
    expect(claimFilingsOf(text(`\`\`\`json\n${NONE}\n\`\`\``))).toEqual({ filed: [] });
    const call = { type: "tool-call", toolCallId: "json-1", toolName: "json", input: AS_A_NOTE };
    expect(claimFilingsOf([call])).toEqual(claimFilingsOf(text(AS_A_NOTE)));
  });

  test("counts, by probe, the runs each about value was given in, once a run", () => {
    const rows = [
      { id: "own-zh", flagged: false, filings: claimFilingsOf(text(AS_SOMEONE_ELSE)) },
      { id: "own-zh", flagged: false, filings: claimFilingsOf(text(NONE)) },
      { id: "marks-en", flagged: false, filings: claimFilingsOf(text(AS_THE_REPLY_AND_A_NOTE)) },
      { id: "marks-en", flagged: true, filings: claimFilingsOf(text(AS_A_NOTE)) },
      { id: "marks-en", flagged: false, filings: claimFilingsOf(text("no JSON")) },
      { id: "marks-en", flagged: false },
    ];
    expect(filingsByProbe(rows)).toEqual({
      "own-zh": {
        runs: 2,
        flagged: 0,
        none: 1,
        unreadable: 0,
        about: { someone_else: { runs: 1, unbacked: 1 } },
      },
      "marks-en": {
        runs: 4,
        flagged: 1,
        none: 0,
        unreadable: 2,
        about: { mind: { runs: 2, unbacked: 1 }, reply: { runs: 1, unbacked: 1 } },
      },
    });
  });

  test("writes one table row a probe", () => {
    const rows = filingRows(
      filingsByProbe([
        { id: "own-zh", flagged: false, filings: claimFilingsOf(text(AS_SOMEONE_ELSE)) },
        { id: "fact-en", flagged: false, filings: claimFilingsOf(text(NONE)) },
      ]),
    );
    expect(rows.slice(2)).toEqual([
      "| own-zh | 0 of 1 | 0 | 0 | someone_else 1 (1) |",
      "| fact-en | 0 of 1 | 1 | 0 | — |",
    ]);
  });

  test("keeps the claims check's reply from the app's own check, and only that question's", async () => {
    const filings = keepClaimFilings();
    const model = wrapLanguageModel({
      model: scriptedModel(() => ({ text: "" }), {
        generate: (call) => ({ text: call.question === "claimed-changes" ? AS_A_NOTE : NONE }),
      }),
      middleware: filings.middleware,
    });
    const result = await unbackedClaims("我整理了手册的要点。", [], [], null, {
      model,
      request: "手册里有哪些要点？",
      names: () => null,
      signal: new AbortController().signal,
    });
    expect(result.claims).toEqual(["made"]);
    expect(filings.take()).toEqual(claimFilingsOf(text(AS_A_NOTE)));
    expect(filings.take()).toBeUndefined();
  });
});
