/**
 * The guards every everyday request in the assistant is held to
 * (eval/everyday/checks.ts), on the failures that were found, and the judge
 * of claims they read (eval/everyday/judge.ts), which is apart from the app's
 * own net.
 */
import { describe, expect, test } from "vitest";
import {
  chineseShare,
  givenToMindsOf,
  guardLosses,
  guardTook,
  pointersIn,
  type RequestOutcome,
  requestFailures,
  rewrittenLater,
  takenOut,
} from "../../eval/everyday/checks";
import { judgeClaims, verdictIn } from "../../eval/everyday/judge";
import { languageRates, rowRates } from "../../eval/everyday/rates";
import { ASKED_AGAIN } from "../../eval/everyday/reasks";
import type { AnswerToolCall } from "../../src/core";
import { askAgainNote } from "../../src/core/answers/claimedChanges";
import { scriptedModel } from "../helpers/models";

const PAPERS = [
  { id: "tutorial", name: "A Tutorial about Random Neural Networks in Supervised Learning" },
  { id: "graphst", name: "2306.10683v1" },
];

const citation = (documentId: string, marker: number) => ({ documentId, marker });

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
          citations: [citation("tutorial", 1), citation("graphst", 2)],
          toolCalls: [],
          steps: null,
        },
        citedInMinds: [],
      }),
    );
    expect(failures.map((failure) => failure.kind)).toEqual(["no-change", "no-citations"]);
  });

  // protects=a marker in the Answer's text that no Citation backs fails, in Chinese as in English, and a marker in code or one with its Citation doesn't; fails_when=a dead marker passes or a backed one fails; no_claim=none beyond protects.
  test("a Citation marker no Citation backs fails", () => {
    const asked = (text: string, markers: number[]) =>
      requestFailures(
        outcome({
          expected: { write: false, cite: true, coverAll: false },
          answer: {
            text,
            citations: markers.map((marker) => citation("tutorial", marker)),
            toolCalls: [],
            steps: null,
          },
          citedInMinds: [],
        }),
      );
    expect(asked("Self-attention is faster [^1]. It costs more [^2][^2].", [1])).toEqual([
      { kind: "dead-markers", markers: [2] },
    ]);
    expect(asked("自注意力更快[^1]。它的成本更高[^2]。", [])).toEqual([
      { kind: "no-citations" },
      { kind: "dead-markers", markers: [1, 2] },
    ]);
    expect(asked("Self-attention is faster [^1]. Write `[^2]` for a marker.", [1])).toEqual([]);
  });

  // protects=a Tool's call written as text in the Answer fails, in English and Chinese, and the same tag around words or in code doesn't; fails_when=a <cite> block passes or an HTML explanation fails; no_claim=none beyond protects.
  test("a Tool's call written as text fails", () => {
    const asked = (text: string) =>
      requestFailures(
        outcome({
          expected: { write: false, cite: false, coverAll: false },
          answer: { text, citations: [], toolCalls: [], steps: null },
          citedInMinds: [],
        }),
      ).map((failure) => failure.kind);
    const block = '<cite>\n[{"marker":1,"passage":"P1","quote":"A quote."}]\n</cite>';
    expect(asked(`Self-attention is faster.\n\n${block}`)).toEqual(["tool-text"]);
    expect(
      asked(
        `自注意力更快。\n\n${block.replace(/<|>/g, (found) => (found === "<" ? "&lt;" : "&gt;"))}`,
      ),
    ).toEqual(["tool-text"]);
    expect(asked("The <cite> element marks a title, as in `<cite>[{}]</cite>`.")).toEqual([]);
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

  // protects=a translation written into a Mind must use the field's term for a thing, here 大潮 for "spring tides", and fails on the near one, 春潮 (#1635); fails_when=either passes unnoticed; no_claim=other terms.
  test("a translation that doesn't use the term asked for fails, naming the one it used", () => {
    const failures = (writtenInMinds: string[]) =>
      requestFailures(
        outcome({
          expected: {
            write: true,
            cite: false,
            coverAll: false,
            terms: [{ want: "大潮", not: ["春潮"] }],
          },
          answer: { text: "", citations: [], toolCalls: [created], steps: null },
          writtenInMinds,
        }),
      );
    expect(failures(["导游说每月有两次大潮。"])).toEqual([]);
    expect(failures(["导游说每月有两次春潮。"])).toEqual([
      { kind: "term", want: "大潮", found: ["春潮"] },
    ]);
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
          citations: [citation("tutorial", 1), citation("graphst", 2)],
          toolCalls: [created],
          steps: null,
        },
        citedInMinds: [],
      }),
    );
    expect(failures).toEqual([{ kind: "no-citations" }]);
  });

  // protects=a request that may go either way, answered by cited text written into a Mind, has its Citations; fails_when=it fails for none in the reply; no_claim=whether it should have written.
  test("a request either way, answered in a Mind and cited there, has its Citations", () => {
    const failures = requestFailures(
      outcome({
        expected: { write: false, cite: true, coverAll: false, either: true },
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

  // protects=a Question that changes a Mind fails, and a piece that lands elsewhere than its case says fails (#1559); fails_when=either passes; no_claim=none beyond protects.
  test("a Question that changes a Mind, and a piece in the wrong place, fail", () => {
    const answer = { text: "Done.", citations: [], toolCalls: [created], steps: null };
    expect(
      requestFailures(
        outcome({ expected: { write: false, cite: false, coverAll: false }, answer }),
      ),
    ).toEqual([{ kind: "changed-unasked" }]);
    expect(
      requestFailures(
        outcome({
          expected: { write: true, cite: false, coverAll: false, into: "asked-from" },
          answer,
          askedFrom: "page",
        }),
      ),
    ).toEqual([{ kind: "wrong-place", wanted: "asked-from" }]);
    expect(
      requestFailures(
        outcome({ expected: { write: true, cite: false, coverAll: false, into: "new" }, answer }),
      ),
    ).toEqual([]);
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

describe("Standing on its own, and the example unasked", () => {
  const failed = (text: string) =>
    requestFailures(
      outcome({
        expected: {
          write: false,
          cite: false,
          coverAll: false,
          noEarlier: true,
          standsAlone: true,
          noExample: true,
        },
        answer: { text, citations: [], toolCalls: [], steps: null },
      }),
    ).map((failure) => failure.kind);
  const lost = (
    text: string,
    addedToPage?: string,
    givenToMinds?: string[],
    writtenInMinds?: string[],
  ) =>
    requestFailures(
      outcome({
        expected: { write: false, cite: false, coverAll: false },
        answer: { text, citations: [], toolCalls: [], steps: null },
        addedToPage,
        givenToMinds: givenToMinds?.map((content) => ({ content, landed: true })),
        writtenInMinds,
      }),
    ).map((failure) => failure.kind);

  // protects=asked after the example's Answer, a reply that talks about an earlier Answer fails, in English and in Chinese, and one that says it all again doesn't; fails_when=it passes, or an ordinary reply that says "earlier" or "忽略" fails; no_claim=none beyond protects.
  test("a reply that talks about an earlier Answer fails", () => {
    expect(failed("GraphST leverages spatial information to ignore the noise.")).toEqual([]);
    expect(failed("GraphST 利用空间信息，忽略了噪声。")).toEqual([]);
    expect(failed("An earlier study found the same effect.")).toEqual([]);
    expect(failed("Its results are covered in my earlier answer.")).toEqual(["earlier"]);
    expect(failed("Its datasets are listed above.")).toEqual(["earlier"]);
    expect(failed("它的主张是这样。另外，上一个回答讲的是租赁合同。")).toEqual(["earlier"]);
    expect(failed("居家办公的规定见上一条回答。")).toEqual(["earlier"]);
    expect(failed("数据集见上文。")).toEqual(["earlier"]);
  });

  // protects=the pointers counted in what goes into a page are its sentences that point back, in English and in Chinese; fails_when=one is missed, or an ordinary sentence is counted; no_claim=none beyond protects.
  test("pointers left in a page are counted by sentence", () => {
    expect(
      pointersIn(
        "## Summary\n\nIts results are strong. They are covered in my earlier answer.\n\n- 数据集见上文。\n- An earlier study found the same effect.",
      ),
    ).toEqual(["They are covered in my earlier answer.", "数据集见上文。"]);
    expect(
      pointersIn("Its MAE is 1.1285 in Chicago, as covered in my earlier answer."),
    ).toHaveLength(1);
  });

  // protects=the reply is held to the gate as Add to note puts it: a pointer paragraph taken out passes, and a correction or a pointer cut from inside a paragraph fails as content lost; fails_when=lost content passes, or a pointer taken out fails; no_claim=none beyond protects.
  test("content left out of the reply as Add to note puts it fails", () => {
    const correction = "I made an error in my previous answer and the total excludes VAT.";
    expect(lost(`Pay is 5k. ${correction}`, "Pay is 5k.")).toEqual(["content-lost"]);
    expect(lost("Pay is 5k.\n\nSee my earlier answer.", "Pay is 5k.")).toEqual([]);
    expect(lost("Pay is 5k. See my earlier answer.", "Pay is 5k.")).toEqual(["content-lost"]);
  });

  // protects=the gate holds the guard to its own input and output: a Block it took that says more than a pointer, or a Block it changed, is content lost; a pointer paragraph it took is not; fails_when=either loss is missed, or a kept Block is taken for changed; no_claim=none beyond protects.
  test("the guard may take out only a pointer paragraph, and change nothing", () => {
    expect(guardTook("Pay is 5k.\n\nSee my earlier answer.", "Pay is 5k.")).toEqual({
      removed: ["See my earlier answer."],
      changed: [],
    });
    expect(guardTook("**Total: £45,000**\n\nSee above.\n\nVAT is extra.", "VAT is extra.")).toEqual(
      { removed: ["**Total: £45,000**", "See above."], changed: [] },
    );
    expect(
      guardTook("Pay is 5k. See above.\n\nBonus is 1k.", "Pay is 5k.\n\nBonus is 1k."),
    ).toEqual({ removed: ["Pay is 5k. See above."], changed: ["Pay is 5k."] });
  });

  // protects=the gate lets the guard take out only a paragraph of one line and one sentence that is only a pointer: a list item, a heading or quote with its pointer, two lines, a table row, code, or a claim before the pointer, taken out, each fails, in English and Chinese; fails_when=a wrong removal passes, or a true one fails; no_claim=none beyond protects.
  test("the gate refuses any removal but a pointer paragraph", () => {
    const own = "Pay is 5k a month.";
    for (const wrong of [
      "- See above.",
      "- Holiday: see my earlier answer.",
      "## Pay\nSee my earlier answer.",
      "> As mentioned above.",
      "Covered above.\nSee my earlier answer.",
      "Holiday is unpaid. See my earlier answer.",
      "| Notice | See my earlier answer. |",
      "```\nSee above.\n```",
      "1. See my earlier answer.",
      "年假不带薪。见上一条回答。",
      "- 见上一条回答。",
      "## 薪酬\n见上一条回答。",
      "> 如上所述。",
      "如上所述。\n详见上文。",
    ]) {
      expect(guardLosses(`${own}\n\n${wrong}`, own)).toEqual([wrong]);
    }
    for (const pointer of [
      "See my earlier answer.",
      "Notice, holiday and home working are covered in my earlier answer.",
      "居家办公的规定见上一条回答。",
      "同上。",
      "具体内容请参考上文。",
    ]) {
      expect(guardLosses(`${own}\n\n${pointer}`, own)).toEqual([]);
    }
  });

  // protects=a copy of the last Answer into a Mind (answer: true) is held to the gate, read as Add to note reads it, and its `content` set aside as the app sets it aside; edit_mind's own content is held too; fails_when=a copy goes ungated or the wrong text is gated; no_claim=none beyond protects.
  test("a copy of the last Answer is gated as Add to note reads it", () => {
    const earlier = { text: "Pay is 5k.\n\nSee my earlier answer.", question: "Summarise this" };
    const call = (tool: string, input: Record<string, unknown>): AnswerToolCall => ({
      ...created,
      tool,
      input,
    });
    const given = givenToMindsOf(
      [
        call("add_to_mind", { answer: true, content: "set aside" }),
        call("create_mind", { answer: true }),
        call("edit_mind", { content: "Pay is 6k." }),
        call("search_documents", { query: "pay" }),
      ],
      earlier,
    );
    expect(given).toEqual([
      { content: earlier.text, question: "Summarise this", landed: true },
      { content: earlier.text, question: "Summarise this", landed: true },
      { content: "Pay is 6k.", landed: true },
    ]);
    const copied = outcome({
      expected: { write: true, cite: false, coverAll: false },
      givenToMinds: [given[0] ?? { content: "", landed: false }],
    });
    expect(takenOut(copied)).toEqual({ removed: ["See my earlier answer."], lost: [] });
    const askedAbout = outcome({
      expected: { write: true, cite: false, coverAll: false },
      givenToMinds: [
        { content: earlier.text, question: "Did your earlier answer cover it?", landed: true },
      ],
    });
    expect(takenOut(askedAbout)).toEqual({ removed: [], lost: [] });
    expect(givenToMindsOf([call("add_to_mind", { answer: true })], null)).toEqual([]);
  });

  // protects=through the real guard, what each Mind tool's content loses is only pointer paragraphs, as the evaluation reads them in English and Chinese (同上, 参考上文 included), and a sentence the model or the app changed after the guard is counted apart, not as lost, with words only taken out told from reworded (#1397); fails_when=a correct removal reads as lost, or a later rewrite fails the guard; no_claim=none beyond protects.
  test("what a call gave to write into a Mind, through the guard", () => {
    for (const pointer of [
      "See my earlier answer.",
      "年假见上文。",
      "同上。",
      "具体内容请参考上文。",
    ]) {
      expect(lost("Done.", undefined, [`Pay is 5k.\n\n${pointer}`], ["Pay is 5k."])).toEqual([]);
    }
    const rewritten = outcome({
      expected: { write: true, cite: false, coverAll: false },
      givenToMinds: [{ content: "Key results. Highlights are below[^8]:", landed: true }],
      writtenInMinds: ["Key results. All of them."],
    });
    expect(requestFailures(rewritten).map((failure) => failure.kind)).not.toContain("content-lost");
    expect(rewrittenLater(rewritten)).toEqual([
      { given: "Highlights are below[^8]:", now: null, cut: false },
    ]);
    const cut = outcome({
      expected: { write: true, cite: false, coverAll: false },
      givenToMinds: [
        { content: "It fuses mobility and POIs, which geography can miss [^2].", landed: true },
        { content: "A call the app refused, which wrote nothing.", landed: false },
      ],
      writtenInMinds: ["Pay is 5k.", "It fuses mobility and POIs."],
    });
    expect(rewrittenLater(cut)).toEqual([
      {
        given: "It fuses mobility and POIs, which geography can miss [^2].",
        now: "It fuses mobility and POIs.",
        cut: true,
      },
    ]);
    const reworded = outcome({
      expected: { write: true, cite: false, coverAll: false },
      givenToMinds: [
        {
          content: "Crime forecasting: best results across all crime categories[^8].",
          landed: true,
        },
        { content: "大潮出现在新月和满月时，并且每年都会淹没港口[^1]。", landed: true },
        {
          content: "It wins across every category (e.g., Theft, Assault) and every metric[^7].",
          landed: true,
        },
        { content: "It wins in each city (e.g. Chicago) and on every task[^3].", landed: true },
        { content: "The data clearly supports this, but not every claim[^4].", landed: true },
      ],
      writtenInMinds: [
        "Crime forecasting: best results in all cases.",
        "大潮出现在新月和满月时。",
        "It wins across every category.",
        "It wins in each city.",
        "The data clearly supports this?",
      ],
    });
    expect(rewrittenLater(reworded)).toEqual([
      {
        given: "Crime forecasting: best results across all crime categories[^8].",
        now: "Crime forecasting: best results in all cases.",
        cut: false,
      },
      {
        given: "大潮出现在新月和满月时，并且每年都会淹没港口[^1]。",
        now: "大潮出现在新月和满月时。",
        cut: true,
      },
      {
        given: "It wins across every category (e.g., Theft, Assault) and every metric[^7].",
        now: "It wins across every category.",
        cut: true,
      },
      {
        given: "It wins in each city (e.g. Chicago) and on every task[^3].",
        now: "It wins in each city.",
        cut: true,
      },
      {
        given: "The data clearly supports this, but not every claim[^4].",
        now: "The data clearly supports this?",
        cut: false,
      },
    ]);
  });

  // protects=a reply about the User's own Documents that mentions the example fails, in English and in Chinese; fails_when=it passes; no_claim=none beyond protects.
  test("a reply that mentions the example fails", () => {
    expect(failed("It claims this, and has nothing to do with Northwind.")).toEqual(["example"]);
    expect(failed("It claims this. Please disregard the 3.5x leverage limit.")).toEqual([
      "example",
    ]);
    expect(failed("It claims this. My first answer cited a facilities agreement.")).toEqual([
      "earlier",
      "example",
    ]);
    expect(failed("它的主张是这样。请忽略之前的杠杆率数字。")).toEqual(["earlier", "example"]);
  });
});

describe("An earlier try the User never saw", () => {
  const says = (text: string, askedAgain = true) =>
    requestFailures(
      outcome({
        expected: { write: false, cite: false, coverAll: false },
        answer: { text, citations: [], toolCalls: [], steps: null },
        askedAgain,
      }),
    ).map((failure) => failure.kind);

  // protects=a reply that apologises for, or refers to, an earlier try of the model's fails, in English and in Chinese, and an ordinary apology or an earlier version of a Document doesn't; fails_when=it passes, or one of the ordinary replies fails; no_claim=none beyond protects.
  test("a reply about its own earlier try fails", () => {
    expect(says("Sorry, my previous reply didn't write the note. The page is made now.")).toEqual([
      "unseen-attempt",
    ]);
    expect(says("Apologies for the earlier response. The page is made now.")).toEqual([
      "unseen-attempt",
    ]);
    expect(says("As I said before, the page is made.")).toEqual(["unseen-attempt"]);
    expect(says("抱歉，上一条回复没有实际写入笔记。")).toEqual(["unseen-attempt"]);
    expect(says("对不起，我之前的回复漏了这一点。页面已经写好。")).toEqual(["unseen-attempt"]);
    expect(says("如我刚才所说，页面已经写好。")).toEqual(["unseen-attempt"]);
    expect(says("Sorry, I couldn't find the figure in the Documents.")).toEqual([]);
    expect(says("The previous version of the paper reported 5%.")).toEqual([]);
    expect(says("抱歉，文档里没有实际数据。")).toEqual([]);
    expect(says("2017 年的前一版报告给出的是 5%。")).toEqual([]);
  });

  // protects=a reply the app did not ask for again may speak of a message the User read, as a follow-up does; fails_when=it fails; no_claim=none beyond protects.
  test("a reply that was not asked again may speak of the User's earlier message", () => {
    expect(
      says("My earlier message said the citations were replaced, which was wrong.", false),
    ).toEqual([]);
    expect(says("我上一条回复说引文已经换了，这是错的。", false)).toEqual([]);
  });

  // protects=the mark the evaluation counts the app's asks by is in the note the app asks with; fails_when=the note is reworded and the evaluation stops counting its asks; no_claim=none beyond protects.
  test("the note the app asks again with carries the mark the evaluation watches for", () => {
    expect(askAgainNote(["added"], [], () => null)).toContain(ASKED_AGAIN);
  });
});

describe("The Question's language (#892, #1273)", () => {
  const summary = (text: string, language: "en" | "zh-CN") =>
    requestFailures(
      outcome({
        expected: { write: false, cite: false, coverAll: false, language },
        answer: { text, citations: [], toolCalls: [], steps: null },
        scoped: [],
      }),
    ).filter((failure) => failure.kind === "wrong-language");

  // protects=an English summary of a contract that also has a Chinese version passes in English and fails in Chinese, and the other way round; quoted words and Citation markers don't count; fails_when=a Chinese summary of an English Question passes, or an English one that quotes the Chinese contract fails; no_claim=how well a real model keeps to the language, which the eval's summary cases ask.
  test("a reply in the other language fails, quoted words and markers aside", () => {
    const english =
      "## Employment contract\nThe term is three years from the start date.[^1] Notice is one month.[^2]";
    const chinese =
      "## 劳动合同\n合同期限为三年，自起始日期算起。[^1] 解除合同须提前一个月通知。[^2]";
    expect(summary(english, "en")).toEqual([]);
    expect(summary(chinese, "zh-CN")).toEqual([]);
    expect(summary(chinese, "en")).toMatchObject([{ kind: "wrong-language", wanted: "en" }]);
    expect(summary(english, "zh-CN")).toMatchObject([{ kind: "wrong-language", wanted: "zh-CN" }]);
    const quoting =
      "The contract says “合同期限为三年，自起始日期算起。” which is three years from the start date.";
    expect(chineseShare(quoting)).toBe(0);
    expect(summary(quoting, "en")).toEqual([]);
  });
});

describe("A figure the numbers give is calculated (#1444)", () => {
  const asked = (text: string, shown: string[]) =>
    requestFailures(
      outcome({
        expected: { write: false, cite: true, coverAll: false, figure: /11\.73亿美元/ },
        answer: {
          text,
          citations: [citation("reserves", 1)],
          toolCalls: [],
          steps: null,
          figures: shown.map((each) => ({ shown: each })),
        },
        scoped: [{ id: "reserves", name: "官方储备资产（2026年）" }],
        citedInMinds: [],
      }),
    );

  // protects=an Answer that gives both cited figures and says it couldn't work out their difference fails twice, for the missing figure and for giving up; fails_when=it passes; no_claim=the figure's value.
  test("an Answer with no figure that gives up on the difference fails", () => {
    const failures = asked(
      "9月末为34002.51亿美元[^1]。我没能算出两者的差额，所以这里不给具体数字。",
      [],
    );
    expect(failures).toEqual([
      { kind: "no-figure", wanted: "11\\.73亿美元", shown: [] },
      { kind: "gave-up", said: "我没能算出两者的差额，所以这里不给具体数字。" },
    ]);
  });

  test("an English Answer that says it couldn't calculate it fails; one with the figure passes", () => {
    expect(
      asked("I couldn't calculate the change, so I haven't worked out the difference.", [])
        .map((each) => each.kind)
        .sort(),
    ).toEqual(["gave-up", "no-figure"]);
    expect(asked("增加了11.73亿美元。", ["11.73亿美元"])).toEqual([]);
  });
});

describe('What "this" means and adding the last Answer (#1334, #1734)', () => {
  const DATED = [
    { id: "contract", name: "Employment contract" },
    { id: "nda", name: "Mutual NDA" },
  ];
  const added = (input: Record<string, unknown>): AnswerToolCall => ({
    ...created,
    tool: "add_to_mind",
    input,
    mindChange: { mindId: "m0", created: false, request: "r2", proposals: 2 },
  });
  const kinds = (fields: Partial<RequestOutcome>, expected: RequestOutcome["expected"]) =>
    requestFailures(outcome({ scoped: DATED, citedInMinds: [], ...fields, expected })).map(
      (failure) => failure.kind,
    );
  const earlier = { text: "One month's written notice [^1].", question: "How much notice?" };

  // protects=a short piece about the one Document on screen passes, and one that cites or names the other, or runs past five lines, fails; fails_when=either slips through; no_claim=none beyond protects.
  test("only the Document meant, and short", () => {
    const call = added({ content: "# NDA\n\nFive years of confidentiality [^1]." });
    const expected = {
      write: true,
      cite: true,
      coverAll: false,
      documents: ["Mutual NDA"],
      atMostLines: 5,
    };
    const given = givenToMindsOf([call], null);
    expect(
      kinds(
        {
          answer: { text: "Done.", citations: [], toolCalls: [call], steps: null },
          citedInMinds: ["nda"],
          givenToMinds: given,
        },
        expected,
      ),
    ).toEqual([]);
    const long = added({ content: ["# NDA", "a", "b", "c", "d", "e"].join("\n\n") });
    expect(
      kinds(
        {
          answer: { text: "Done.", citations: [], toolCalls: [long], steps: null },
          citedInMinds: ["nda", "contract"],
          writtenInMinds: ["The Employment contract is separate."],
          givenToMinds: givenToMindsOf([long], null),
        },
        expected,
      ),
    ).toEqual(["other-documents", "too-long"]);
  });

  // protects=with two on screen, an Answer that asked which and stopped there passes, one that didn't ask fails, and asking unasked fails; fails_when=any of them is read the other way; no_claim=none beyond protects.
  test("asks which, or doesn't", () => {
    const asking: AnswerToolCall = {
      ...created,
      tool: "ask_user",
      input: {},
      mindChange: undefined,
    };
    const must = { write: false, cite: false, coverAll: false, asks: "must" } as const;
    const answer = (toolCalls: AnswerToolCall[]) => ({
      text: "",
      citations: [],
      toolCalls,
      steps: null,
    });
    expect(kinds({ answer: answer([asking]), stoppedAtAsk: true }, must)).toEqual([]);
    expect(kinds({ answer: answer([]) }, must)).toEqual(["no-ask"]);
    expect(
      kinds(
        { answer: answer([asking]), stoppedAtAsk: true },
        { write: true, cite: true, coverAll: false },
      ),
    ).toEqual(["asked"]);
  });

  // protects="add this to my notes" passes only as a copy of the last Answer, and "write notes on these" fails as only a copy; fails_when=new notes pass as the Answer, or a copy as new notes; no_claim=none beyond protects.
  test("adds the last Answer, or writes new notes", () => {
    const copy = added({ answer: true });
    const fresh = added({ content: "## Notes\n\nThe NDA lasts five years [^1]." });
    const adds = { write: true, cite: false, coverAll: false, addsAnswer: true } as const;
    const writes = { write: true, cite: false, coverAll: false, addsAnswer: false } as const;
    const run = (calls: AnswerToolCall[], expected: RequestOutcome["expected"]) =>
      kinds(
        {
          answer: { text: "Added it.", citations: [], toolCalls: calls, steps: null },
          givenToMinds: givenToMindsOf(calls, earlier),
        },
        expected,
      );
    expect(run([copy], adds)).toEqual([]);
    expect(run([fresh], adds)).toEqual(["not-the-answer"]);
    expect(run([copy], writes)).toEqual(["only-a-copy"]);
    expect(run([fresh], writes)).toEqual([]);
  });
});

describe("Asking about selected words (#101)", () => {
  const quoted = {
    documentId: "tutorial",
    documentName: PAPERS[0]?.name ?? "",
    quote: "Random neural networks learn in one pass.",
    pageFrom: 3,
    pageTo: 3,
    location: { kind: "page", from: 3, to: 3 } as const,
  };
  const cited = (pageFrom: number, check: "found" | "not-found" = "found") => ({
    documentId: "tutorial",
    documentName: quoted.documentName,
    marker: 1,
    pageFrom,
    pageTo: pageFrom,
    check,
  });
  const failuresOf = (citations: ReturnType<typeof cited>[]) =>
    requestFailures(
      outcome({
        expected: { write: false, cite: true, coverAll: false },
        answer: {
          text: citations.length > 0 ? "It means this.[^1]" : "It means this.",
          citations,
          toolCalls: [],
          steps: null,
        },
        citedInMinds: [],
        quoted,
      }),
    ).map((failure) => failure.kind);

  // protects=the first Citation must be the selected words where they were selected, found; fails_when=another page, a Citation not found, or none passes; no_claim=how often a real model cites them, which the run measures.
  test("its first Citation is the words selected, found where they were selected", () => {
    expect(failuresOf([cited(3), cited(7)])).toEqual([]);
    expect(failuresOf([cited(7), cited(3)])).toEqual(["not-quoted"]);
    expect(failuresOf([cited(3, "not-found")])).toEqual(["not-quoted"]);
    expect(failuresOf([])).toEqual(["no-citations", "not-quoted"]);
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

describe("The filing guards", () => {
  const filingOutcome = (
    text: string,
    citations = [
      {
        ...citation("tutorial", 1),
        documentName: "Harbour Hotels 2026 annual release",
        quote: "Operating profitability reached 38.2%",
      },
    ],
  ) =>
    requestFailures(
      outcome({
        expected: {
          write: false,
          cite: true,
          coverAll: false,
          answerWith: /38\.2%/,
          answerEvidence: {
            document: /Harbour Hotels 2026 annual release/,
            quote: /Operating profitability reached 38\.2%/,
          },
          noDocumentAbsence: /margin|利润率/,
        },
        answer: { text, citations, toolCalls: [], steps: null },
        citedInMinds: [],
      }),
    );

  test("requires the expected figure and rejects a whole-Document absence claim in English and Chinese", () => {
    expect(
      filingOutcome("Operating margin was 38.2% [^1].").map((failure) => failure.kind),
    ).toEqual([]);
    expect(
      filingOutcome("The release doesn't state the operating margin.").map(
        (failure) => failure.kind,
      ),
    ).toEqual(["missing-answer-text", "document-absence"]);
    expect(filingOutcome("报告未披露 38.2% 的营业利润率。").map((failure) => failure.kind)).toEqual(
      ["document-absence"],
    );
  });

  test("rejects absence after the verb and a Citation to another Document", () => {
    expect(
      filingOutcome(
        "The release contains no operating margin. Operating margin was 38.2% [^1].",
      ).map((failure) => failure.kind),
    ).toEqual(["document-absence"]);
    expect(
      filingOutcome("报告不包含经营利润率。经营利润率为 38.2% [^1]。").map(
        (failure) => failure.kind,
      ),
    ).toEqual(["document-absence"]);
    expect(
      filingOutcome("Operating margin was 38.2% [^1].", [
        { ...citation("other", 1), documentName: "Another filing", quote: "Operating margin" },
      ]).map((failure) => failure.kind),
    ).toEqual(["wrong-answer-citation"]);
  });

  test("allows a search-miss statement without treating it as a whole-Document absence", () => {
    expect(
      filingOutcome("I didn't find the operating margin in the release.").map(
        (failure) => failure.kind,
      ),
    ).toEqual(["missing-answer-text"]);
  });

  test("allows an unrelated caveat beside the cited answer", () => {
    expect(
      filingOutcome("Operating margin was 38.2% [^1]. 文档本身没有说明换算关系。").map(
        (failure) => failure.kind,
      ),
    ).toEqual([]);
    expect(
      filingOutcome(
        "Operating margin was 38.2% [^1]。这是按同店口径的变化幅度，文件未说明与哪一期比较。",
      ).map((failure) => failure.kind),
    ).toEqual([]);
  });

  test("a true absence accepts a search miss but not an invented figure or a Document-level claim", () => {
    const missing = (text: string, citations: ReturnType<typeof citation>[] = []) =>
      requestFailures(
        outcome({
          expected: {
            write: false,
            cite: false,
            coverAll: false,
            searchMiss: true,
            noDocumentAbsence: /cash conversion|现金转换周期/,
          },
          answer: { text, citations, toolCalls: [], steps: null },
          citedInMinds: [],
        }),
      ).map((failure) => failure.kind);
    expect(missing("I didn't find the cash conversion cycle in the 10-Q.")).toEqual([]);
    expect(missing("The 10-Q doesn't state the cash conversion cycle.")).toEqual([
      "no-search-miss",
      "document-absence",
    ]);
    expect(missing("The cash conversion cycle was 42 days.")).toEqual([
      "no-search-miss",
      "invented-answer",
    ]);
    expect(missing("I didn't find the cash conversion cycle in the 10-Q. It was 42 days.")).toEqual(
      ["invented-answer"],
    );
    expect(
      missing("I didn't find the cash conversion cycle. The closest is a 6.2% sales decline[^1].", [
        citation("northmart", 1),
      ]),
    ).toEqual([]);
    expect(
      missing(
        "I didn't find the cash conversion cycle. I searched the Q2 2026 10-Q and nothing matched.",
      ),
    ).toEqual([]);
  });
});
