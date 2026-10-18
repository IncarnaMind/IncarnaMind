/**
 * The guards every everyday request in the assistant is held to
 * (eval/everyday/checks.ts), on the failures that were found, and the judge
 * of claims they read (eval/everyday/judge.ts), which is apart from the app's
 * own net.
 */
import { describe, expect, test } from "vitest";
import { type RequestOutcome, requestFailures } from "../../eval/everyday/checks";
import { judgeClaims, verdictIn } from "../../eval/everyday/judge";
import { languageRates, rowRates } from "../../eval/everyday/rates";
import type { AnswerToolCall } from "../../src/core";
import { scriptedModel } from "../helpers/models";

const PAPERS = [
  { id: "tutorial", name: "A Tutorial about Random Neural Networks in Supervised Learning" },
  { id: "graphst", name: "2306.10683v1" },
];

const citation = (documentId: string) => ({ documentId });

const created: AnswerToolCall = {
  id: "c1",
  tool: "create_mind",
  source: "minds",
  input: { title: "Summary" },
  status: "done",
  resultCount: null,
  mindChange: { mindId: "m1", created: true, request: "r1", proposals: 7 },
};

const outcome = (fields: Partial<RequestOutcome>): RequestOutcome => ({
  expected: { write: true, cite: true, coverAll: true },
  answer: { text: "", citations: [], toolCalls: [], steps: null },
  verdict: { unbacked: [] },
  citedInMinds: ["tutorial", "graphst"],
  changedBlocks: [],
  scoped: PAPERS,
  ...fields,
});

describe("The everyday request guards", () => {
  // protects=a page claimed and never made fails on every guard it breaks; fails_when=it passes; no_claim=none beyond protects.
  test("a page claimed and never made fails", () => {
    const text = "I've created a summary page for the two papers.";
    const failures = requestFailures(
      outcome({
        answer: { text, citations: [], toolCalls: [], steps: null },
        verdict: { unbacked: [text] },
        citedInMinds: [],
      }),
    );
    expect(failures.map((failure) => failure.kind)).toEqual([
      "no-change",
      "unbacked",
      "no-citations",
      "uncovered",
    ]);
  });

  // protects=a good summary written only in the panel fails a write request; fails_when=its Citations in the panel hide that nothing was written; no_claim=none beyond protects.
  test("a summary written only in the panel fails a write request", () => {
    const failures = requestFailures(
      outcome({
        answer: {
          text: "The tutorial is a practical guide [^1]. GraphST models urban regions [^2].",
          citations: [citation("tutorial"), citation("graphst")],
          toolCalls: [],
          steps: null,
        },
        citedInMinds: [],
      }),
    );
    expect(failures.map((failure) => failure.kind)).toEqual(["no-change", "no-citations"]);
  });

  // protects=asked to make the summary in the Mind longer, a second version added beside it fails, and one changed in place passes; fails_when=either is judged the other way; no_claim=none beyond protects.
  test("a longer version added beside the summary fails, and one changed in place passes", () => {
    const call = (tool: string): AnswerToolCall => ({
      ...created,
      tool,
      input: {},
      mindChange: { mindId: "m1", created: false, request: "r2", proposals: 2 },
    });
    const asked = (tool: string) =>
      requestFailures(
        outcome({
          expected: { write: true, cite: false, coverAll: false, inPlace: true },
          answer: { text: "", citations: [], toolCalls: [call(tool)], steps: null },
        }),
      ).map((failure) => failure.kind);
    expect(asked("add_to_mind")).toEqual(["beside"]);
    expect(asked("edit_mind")).toEqual([]);
  });

  // protects=asked to make the summary added with Add to note longer, changing other text and leaving the summary as it was fails; fails_when=any change in the Mind passes; no_claim=none beyond protects.
  test("a change that leaves the added summary as it was fails", () => {
    const edited: AnswerToolCall = {
      ...created,
      tool: "edit_mind",
      input: {},
      mindChange: { mindId: "m1", created: false, request: "r2", proposals: 1 },
    };
    const failures = (changedBlocks: number[]) =>
      requestFailures(
        outcome({
          expected: { write: true, cite: false, coverAll: false, inPlace: true },
          answer: { text: "", citations: [], toolCalls: [edited], steps: null },
          changedBlocks,
          addedBlocks: [3],
        }),
      ).map((failure) => failure.kind);
    expect(failures([1])).toEqual(["untouched"]);
    expect(failures([3])).toEqual([]);
  });

  // protects=a Mind written with a source as text fails, naming it, and one with none passes (#1075); fails_when=bracketed sources in a Mind go unnoticed; no_claim=how the sources are found (tests/shared/namedSources.test.ts).
  test("a Mind holding a source written as text fails", () => {
    const kinds = (sourcesAsText: string[]) =>
      requestFailures(
        outcome({
          answer: { text: "", citations: [], toolCalls: [created], steps: null },
          sourcesAsText,
        }),
      ).map((failure) => failure.kind);
    expect(kinds(["[5_Rue_Berryer_Paris, slide 3]"])).toEqual(["as-text"]);
    expect(kinds([])).toEqual([]);
  });

  // protects=a page made with no Citations in it fails, whatever the reply cites; fails_when=the reply's Citations count for the page's; no_claim=none beyond protects.
  test("a page whose Citations were lost fails, whatever the reply cites", () => {
    const failures = requestFailures(
      outcome({
        answer: {
          text: "Made “Summary”.",
          citations: [citation("tutorial"), citation("graphst")],
          toolCalls: [created],
          steps: null,
        },
        citedInMinds: [],
      }),
    );
    expect(failures).toEqual([{ kind: "no-citations" }]);
  });

  // protects=a Question answered by cited text written into a Mind has its Citations; fails_when=it fails for none in the reply; no_claim=whether it should have written.
  test("a Question answered in a Mind, cited there, has its Citations", () => {
    const failures = requestFailures(
      outcome({
        expected: { write: false, cite: true, coverAll: false },
        answer: {
          text: "The summaries are ready.",
          citations: [],
          toolCalls: [created],
          steps: null,
        },
      }),
    );
    expect(failures).toEqual([]);
  });

  // protects=a Document in scope counts as covered only when cited or named as left out, not merely named; fails_when=a name alone passes; no_claim=none beyond protects.
  test("every Document in scope is cited, or named as left out", () => {
    const one = (text: string) =>
      outcome({
        answer: { text, citations: [], toolCalls: [created], steps: null },
        citedInMinds: ["tutorial"],
      });
    expect(requestFailures(one("Made “Summary”. 2306.10683v1 is the GraphST paper."))).toEqual([
      { kind: "uncovered", documents: ["2306.10683v1"] },
    ]);
    expect(
      requestFailures(
        one("Made “Summary”. I couldn't read 2306.10683v1, so it covers the tutorial."),
      ),
    ).toEqual([]);
  });

  // protects=a claim the judge finds fails, marked when the app flagged it too; fails_when=it passes; no_claim=none beyond protects.
  test("a claim the judge finds fails, flagged or not", () => {
    const flagged = outcome({
      expected: { write: false, cite: false, coverAll: false },
      answer: {
        text: "I added it.",
        citations: [],
        toolCalls: [],
        steps: {
          sentAt: null,
          finishedAt: null,
          phases: [],
          reasoning: null,
          unbackedClaims: ["added"],
        },
      },
      verdict: { unbacked: ["I added it."] },
    });
    expect(requestFailures(flagged)).toEqual([
      { kind: "unbacked", sentences: ["I added it."], flagged: true },
    ]);
  });
});

describe("Only what was asked changes", () => {
  // protects=asked to change one paragraph, a change to another fails and names it; fails_when=it passes, or the one asked about fails; no_claim=none beyond protects.
  test("a change outside the paragraph asked about fails", () => {
    const edit = (changedBlocks: number[]) =>
      requestFailures(
        outcome({
          expected: { write: true, cite: false, coverAll: false, only: 1 },
          answer: { text: "", citations: [], toolCalls: [created], steps: null },
          changedBlocks,
        }),
      );
    expect(edit([1])).toEqual([]);
    expect(edit([0, 1])).toEqual([{ kind: "outside", blocks: [0] }]);
  });
});

describe("Asked after the example's Answer", () => {
  const reply = (text: string) =>
    requestFailures(
      outcome({
        expected: { write: false, cite: false, coverAll: false, noEarlier: true },
        answer: { text, citations: [], toolCalls: [], steps: null },
      }),
    ).map((failure) => failure.kind);

  // protects=a reply that goes back to an earlier Answer or the example fails, in English and in Chinese, and one about the Question doesn't; fails_when=it passes, or an ordinary reply that says "leverages" or "忽略" fails; no_claim=none beyond protects.
  test("a reply about an earlier Answer or the example fails", () => {
    expect(reply("GraphST leverages spatial information to ignore the noise. [^1]")).toEqual([]);
    expect(reply("GraphST 利用空间信息，忽略了噪声。")).toEqual([]);
    expect(reply("It claims this. My first answer cited a facilities agreement.")).toEqual([
      "earlier",
    ]);
    expect(reply("It claims this. Please disregard the 3.5x leverage limit.")).toEqual(["earlier"]);
    expect(reply("它的主张是这样。另外，上一个回答讲的是租赁合同。")).toEqual(["earlier"]);
    expect(reply("它的主张是这样。请忽略之前的杠杆率数字。")).toEqual(["earlier"]);
  });
});

describe("Pass rates", () => {
  // protects=a request is held to its floor over its runs, per model, and runs are counted per language; fails_when=one failed run marks a request that meets its floor, or a request under it passes; no_claim=none beyond protects.
  test("per request against its floor, and per language", () => {
    const run = (id: string, language: "en" | "zh-CN", passed: boolean) => ({
      id,
      language,
      model: "haiku",
      passed,
    });
    const runs = [
      run("a", "en", true),
      run("a", "en", false),
      run("a", "en", true),
      run("b", "zh-CN", false),
      run("b", "zh-CN", true),
      run("b", "zh-CN", false),
    ];
    const rows = rowRates(
      runs,
      new Map([
        ["a", 2 / 3],
        ["b", 2 / 3],
      ]),
    );
    expect(rows.map((row) => [row.id, row.passed, row.runs, row.under])).toEqual([
      ["a", 2, 3, false],
      ["b", 1, 3, true],
    ]);
    expect(languageRates(runs)).toEqual([
      { model: "haiku", language: "en", passed: 2, runs: 3 },
      { model: "haiku", language: "zh-CN", passed: 1, runs: 3 },
    ]);
  });
});

describe("The judge of claims", () => {
  // protects=the judge reads the record and the reply, and its verdict is read back; fails_when=either is left out of what it reads, or a verdict it can't read passes; no_claim=how well a real model judges.
  test("reads the record and the reply, and its verdict", async () => {
    let asked = "";
    const model = scriptedModel(() => ({ text: "" }), {
      generate: ({ prompt }) => {
        asked = prompt;
        return {
          text: '```json\n{"unbacked": ["The new page replaces the earlier version."]}\n```',
        };
      },
    });
    const verdict = await judgeClaims(
      model,
      "Made it. The new page replaces the earlier version.",
      ["- add_to_mind “Summary”: proposed 2 new Blocks, waiting for the User"],
    );
    expect(asked).toContain("add_to_mind “Summary”");
    expect(asked).toContain("The new page replaces the earlier version.");
    expect(verdict).toEqual({ unbacked: ["The new page replaces the earlier version."] });
    expect(verdictIn("no idea").unbacked).toHaveLength(1);
    expect(
      verdictIn(
        '{"unbacked": ["Here is a shorter version:"]}\n\nWait, that is no claim.\n\n{"unbacked": []}',
      ),
    ).toEqual({ unbacked: [] });
  });
});
