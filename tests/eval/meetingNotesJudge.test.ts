import type { LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { CallTurn } from "../../eval/speed/callHelpCases";
import {
  citedForJudge,
  citedSentences,
  judgeNotes,
  lineQuoted,
  readGrade,
  readVerdicts,
  savedLines,
  savedNotes,
  sentencesPrompt,
} from "../../eval/speed/meetingNotesJudge";

const TURNS: CallTurn[] = [
  { who: "me", text: "We can set up a separate session just for those two." },
  { who: "them", text: "Let's do that. I'll have to check with IT, they are slow this month." },
  { who: "me", text: "Okay. Let's do that on Thursday then." },
];
const found = (quote: string) => ({ documentName: "Transcript", quote, check: "found" });

describe("the line of the call a meeting-notes Citation is judged against", () => {
  it("is the one line that holds the quoted words, with who said it", () => {
    expect(lineQuoted(TURNS, "I'll have to check with IT")).toBe(TURNS[1]);
    expect(citedForJudge(TURNS, found("I'll have to check with IT"))).toBe(
      "the other side said: “Let's do that. I'll have to check with IT, they are slow this month.”",
    );
  });

  it("finds the line when the quote differs only in case, spaces or punctuation", () => {
    expect(lineQuoted(TURNS, "a separate session,  just for those two")).toBe(TURNS[0]);
  });

  it("finds the line of a quote of a word or two, as a short Chinese quote is", () => {
    expect(lineQuoted(TURNS, "Okay")).toBe(TURNS[2]);
    expect(
      lineQuoted([{ who: "them", text: "这个思路好，就这么办。" }], "就这么办"),
    ).not.toBeNull();
  });

  it("falls back to the quoted words alone when no line, or more than one, holds them", () => {
    expect(lineQuoted(TURNS, "Let's do that")).toBeNull();
    expect(lineQuoted(TURNS, "the price is forty euros")).toBeNull();
    expect(lineQuoted(TURNS, " … ")).toBeNull();
    expect(citedForJudge(TURNS, found("Let's do that"))).toBe(
      "Transcript, quoted words only: “Let's do that”",
    );
  });
});

const NOTES = [
  "## Summary[1]",
  "They offered a session.[1] The other side agreed and will check with IT.[2][3] No date was set.",
  "## Action items",
  "The other side checks with IT.[4]",
  "A line with no Citation.",
].join("\n");
const CITATIONS = [
  found("a separate session just for those two"),
  found("Let's do that."),
  { documentName: "Transcript", quote: "we will ask IT tomorrow", check: "not-found" },
  found("I'll have to check with IT"),
];

describe("the sentences the meeting-notes judge reads", () => {
  it("are each stretch of the notes that ends in Citations, with its section and what came before", () => {
    expect(citedSentences(NOTES)).toEqual([
      { cites: [1], heading: "Summary", earlier: "", text: "They offered a session." },
      {
        cites: [2, 3],
        heading: "Summary",
        earlier: "They offered a session.",
        text: "The other side agreed and will check with IT.",
      },
      { cites: [4], heading: "Action items", earlier: "", text: "The other side checks with IT." },
    ]);
  });

  it("go to the judge with the lines of their found Citations only", () => {
    expect(sentencesPrompt(TURNS, CITATIONS, citedSentences(NOTES).slice(1, 2))).toBe(
      [
        '<item n="1">',
        "Section: Summary",
        "Earlier in its paragraph: They offered a session.",
        "Sentence: The other side agreed and will check with IT.",
        "- the other side said: “Let's do that. I'll have to check with IT, they are slow this month.”",
        "</item>",
      ].join("\n"),
    );
  });
});

describe("the meeting-notes judge's replies", () => {
  it("give a verdict for every sentence, with the reason for each one marked", () => {
    expect(
      readVerdicts(
        'Here: {"items": [{"n": 2, "said": false, "why": "the lines give\\n no date"}, {"n": 1, "said": true}]}',
        2,
      ),
    ).toEqual([
      { said: true, why: "" },
      { said: false, why: "the lines give no date" },
    ]);
  });

  it("are not read when a sentence has no verdict, two, or one that isn't yes or no", () => {
    expect(readVerdicts('{"items": [{"n": 1, "said": true}]}', 2)).toBeNull();
    expect(
      readVerdicts('{"items": [{"n": 1, "said": true}, {"n": 1, "said": false}]}', 2),
    ).toBeNull();
    expect(readVerdicts('{"items": [{"n": 1, "said": "mostly"}]}', 1)).toBeNull();
    expect(readVerdicts('{"items": [{"n": 3, "said": true}]}', 1)).toBeNull();
    expect(readVerdicts("I can't check these.", 1)).toBeNull();
  });

  it("give the grade, unread when it is none the judge was offered", () => {
    expect(readGrade('{"grade": "partly"}')).toBe("partly");
    expect(readGrade('{"grade": "fine"}')).toBe("unread");
    expect(readGrade("no JSON")).toBeNull();
  });
});

/** A judge that answers each request in turn from `replies`, and keeps what it was sent. */
function scripted(replies: readonly string[]) {
  const sent: string[] = [];
  let next = 0;
  const model: LanguageModel = new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      sent.push(JSON.stringify(prompt));
      const text = replies[next++] ?? "";
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  return { model, sent };
}

describe("the meeting-notes judge", () => {
  const input = { expected: "A session.", notes: NOTES, citations: CITATIONS, turns: TURNS };

  it("marks a sentence by its first found Citation, and counts the sentences it read", async () => {
    const judge = scripted([
      '{"grade": "right"}',
      '{"items": [{"n": 1, "said": true}, {"n": 2, "said": false, "why": "no line says IT"}, {"n": 3, "said": true}]}',
    ]);
    expect(await judgeNotes(judge.model, input)).toEqual({
      grade: "right",
      sentences: 3,
      unstated: [{ n: 2, why: "no line says IT" }],
    });
    expect(judge.sent).toHaveLength(2);
    expect(judge.sent[1]).toContain("the other side said");
    expect(judge.sent[1]).not.toContain("we will ask IT tomorrow");
  });

  it("asks once more for a reply it can't read, and is unread when that fails too", async () => {
    const judge = scripted(['{"grade": "right"}', "Sure.", '{"items": []}']);
    expect(await judgeNotes(judge.model, input)).toMatchObject({ grade: "unread", unstated: [] });
    expect(judge.sent).toHaveLength(3);
  });

  it("reads many sentences ten at a time", async () => {
    const notes = Array.from({ length: 12 }, (_, index) => `Point ${index + 1}.[1]`).join("\n");
    const said = (count: number) =>
      JSON.stringify({
        items: Array.from({ length: count }, (_, index) => ({ n: index + 1, said: index !== 1 })),
      });
    const judge = scripted(['{"grade": "right"}', said(10), said(2)]);
    const judged = await judgeNotes(judge.model, { ...input, notes });
    expect(judged).toMatchObject({ sentences: 12, unstated: [{ n: 1 }, { n: 1 }] });
    expect(judge.sent).toHaveLength(3);
  });
});

describe("a run's saved notes", () => {
  const citations = [
    { documentName: "Transcript · Meeting, 15 November", quote: "Let's do that.", check: "found" },
    { documentName: "转写稿 · 会议，11月15日", quote: "就这么办", check: "not-found" },
  ];
  const notes = "## Decisions\nWe agreed on a session.[1]\n就这么办。[2]";

  it("are read back as they were saved, with the reasons", () => {
    const text = [
      notes,
      ...savedLines(citations, [{ n: 1, why: "the line doesn't say what was agreed: a session" }]),
    ].join("\n");
    expect(text.split("\n").at(-1)).toBe(
      "[unstated] 1: the line doesn't say what was agreed: a session",
    );
    expect(savedNotes(text)).toEqual({ notes, citations, unstated: [1] });
  });

  it("are read back from a run saved before the reasons were kept", () => {
    const text = [notes, ...savedLines(citations, []), "[unstated] 1, 2"].join("\n");
    expect(savedNotes(text)).toEqual({ notes, citations, unstated: [1, 2] });
  });

  it("refuse a line after the Citations that is neither a Citation nor a mark", () => {
    expect(() =>
      savedNotes([notes, ...savedLines(citations, []), "more notes"].join("\n")),
    ).toThrow("isn't one");
  });
});
