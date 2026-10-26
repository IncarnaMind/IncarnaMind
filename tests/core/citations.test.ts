import { Editor, type JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, onTestFinished, test } from "vitest";
import type { Citation, Core, CoreEvents } from "../../src/core";
import { ANSWER_TEMPERATURE, mergeSearches, searchLanguage } from "../../src/core/answers/engine";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import {
  answerEnded,
  askAndFinish,
  askNew,
  citationsIn,
  citeFeedback,
  citingModel,
  onlyCitation,
  type ShownPassage,
  setUpWithDocuments,
  shownPassages,
} from "../helpers/citations";
import { startCore } from "../helpers/core";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { answerIn, answerText, note, question, readMind, writeMind } from "../helpers/minds";
import { type GenerateCall, type GeneratedReply, promptOf, scriptedModel } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

/** Two pages about tides. */
const TIDES = buildPdf([
  {
    lines: [
      "Tides and the Moon",
      "The Moon's gravity raises two tidal bulges on the Earth.",
      "Most coasts therefore see two high tides every day.",
    ],
  },
  {
    lines: [
      "Spring and neap tides",
      "Spring tides happen at new moon and at full moon.",
      "Neap tides happen when the Moon is at its first or last quarter.",
    ],
  },
]);

const SPRING = "Spring tides happen at new moon and at full moon.";

/**
 * Five pages with a running header and a page number on each, and a sentence
 * that runs from the bottom of page 2 onto the top of page 3.
 */
const ALMANAC = buildPdf(
  [
    ["Tides are the rise and fall of the sea.", "They follow the Moon across the sky."],
    ["High water comes twice a day on most coasts.", "Neap tides occur when the Sun and the Moon"],
    ["pull at right angles to each other.", "Their range is the smallest of the month."],
    ["Spring tides have the largest range.", "Sailors plan around both."],
    ["Tide tables give the times of high water.", "They are published every year."],
  ].map((body, index) => ({ lines: ["Tide Almanac 2026", ...body, `${index + 1}`] })),
);

const CROSSING = "Neap tides occur when the Sun and the Moon pull at right angles to each other.";

/** Chinese text in a PDF, with a sentence running across the page break. */
const CHINESE_TIDES = buildPdf([
  { chineseLines: ["潮汐是海水的周期性涨落。", "月球的引力使地球两侧的海水隆起，"] },
  { chineseLines: ["形成两个潮汐隆起。", "因此大多数海岸每天有两次高潮。"] },
]);

/**
 * Markdown as a browser-made PDF's text layer often has it: with the Kangxi
 * radicals "⼤" and "⾔" in place of the ideographs "大" and "言".
 */
const RADICAL_NOTES = "# 笔记\n\n⼤型语⾔模型的参数规模很⼤，训练需要⼤量数据。\n";

/** Page 2 is a scan: an image, with no text. */
const WITH_SCAN = buildPdf([
  { lines: ["Survey of the harbour", "The harbour floor is mostly sand."] },
  { image: true },
  { lines: ["The survey ended in March.", "Divers mapped the old wreck."] },
]);

/** A Tiptap editor on the Mind's schema with no view: the renderer's editor minus the screen. */
function headlessEditor(content: JSONContent): Editor {
  const editor = new Editor({ element: null, extensions: noteExtensions(), content });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  onTestFinished(() => editor.destroy());
  return editor;
}

/** The first Passage the search showed, or a failure. */
const first = (passages: ShownPassage[]) => {
  const passage = passages[0];
  if (!passage) throw new Error("The search showed no Passages.");
  return passage;
};

describe("Answers cite Passages", { timeout: 30_000 }, () => {
  test("a quote that is on its cited page becomes a Citation in the text whose quote is found", async () => {
    const model = citingModel({
      query: "spring tides",
      records: (passages) => [
        { marker: 1, passage: first(passages).id, pageFrom: 2, pageTo: 2, quote: SPRING },
      ],
      answer: "Spring tides come at new and full moon [^1].",
    });
    const { core, client, mind, documents } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);
    const added: CoreEvents["answer.citationAdded"][] = [];
    core.on("answer.citationAdded", (event) => added.push(event));

    const { answerId, finished } = await askAndFinish(
      core,
      client,
      mind.id,
      "When are spring tides?",
    );

    // The marker became an inline node in the sentence; the text around it stays.
    expect(answerText(client, answerId)).toBe("Spring tides come at new and full moon .");
    const paragraph = answerIn(client, answerId).child(0);
    expect(paragraph.child(1).type.name).toBe("citation");
    const expected: Citation = {
      passageId: expect.any(String),
      documentId: documents[0]?.id as string,
      documentName: "Tides",
      contentHash: documents[0]?.contentHash as string,
      pageFrom: 2,
      pageTo: 2,
      location: { kind: "page", from: 2, to: 2 },
      quote: SPRING,
      check: "found",
      checkReason: null,
    };
    expect(onlyCitation(client, answerId)).toEqual(expected);
    expect(finished).toMatchObject({
      status: "done",
      citations: [expected],
      droppedMarkers: 0,
      droppedRecords: 0,
      citationSupport: "tools",
    });
    // The record was announced as it arrived, still being checked.
    expect(added).toEqual([
      { mindId: mind.id, answerId, marker: 1, citation: { ...expected, check: "checking" } },
    ]);
    // The model was told the record was fine.
    expect(citeFeedback(model)).toMatch(/^Recorded \[\^1\]\./);
  });

  test("records given after the Answer's text, in the same reply, work too", async () => {
    const model = scriptedModel((call) => {
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (searches.length === 0) {
        return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
      }
      if (call.results.some((result) => result.tool === "cite")) return { text: "" };
      const passage = first(shownPassages(searches[0]?.text ?? ""));
      return {
        text: "Spring tides come at new and full moon [^1].",
        calls: [
          {
            tool: "cite",
            input: {
              citations: [
                { marker: 1, passage: passage.id, pageFrom: 2, pageTo: 2, quote: SPRING },
              ],
            },
          },
        ],
      };
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);

    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");

    expect(answerText(client, answerId)).toBe("Spring tides come at new and full moon .");
    expect(onlyCitation(client, answerId)).toMatchObject({ pageFrom: 2, check: "found" });
  });

  test("the Answer shows that it searched the Documents, and what for", async () => {
    const model = citingModel({
      query: "neap tides",
      records: () => [],
      answer: "Neap tides are the small ones.",
      preamble: "Let me look that up in your Documents.",
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);
    const started: CoreEvents["answer.toolCallStarted"][] = [];
    const ended: CoreEvents["answer.toolCallFinished"][] = [];
    core.on("answer.toolCallStarted", (event) => started.push(event));
    core.on("answer.toolCallFinished", (event) => ended.push(event));

    const { answerId } = await askAndFinish(core, client, mind.id, "What are neap tides?");

    const call = {
      id: expect.any(String),
      tool: "search_documents",
      source: "documents",
      input: { query: "neap tides" },
    };
    expect(started.map((event) => event.call)).toEqual([
      { ...call, status: "running", resultCount: null },
    ]);
    const done = { ...call, status: "done", resultCount: 1, passages: [expect.any(String)] };
    expect(ended.map((event) => event.call)).toEqual([done]);
    expect(JSON.parse(answerIn(client, answerId).attrs.toolCalls as string)).toEqual([done]);
    // What the model wrote before searching was only a preamble: it isn't in the Answer.
    expect(answerText(client, answerId)).toBe("Neap tides are the small ones.");
  });

  test("the answering prompt asks for a Citation for every claim from the Documents, and to say when they don't cover the Question", async () => {
    const model = citingModel({ query: "tides", records: () => [], answer: "Twice a day." });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);

    await askAndFinish(core, client, mind.id, "How often are there high tides?");

    const system = promptOf(model)[0]?.text ?? "";
    expect(system).toMatch(/Cite every claim you draw from a Passage/);
    expect(system).toMatch(/If the Documents don't cover the Question, say so/);
    expect(system).toMatch(/\[\^1\]/);
    expect(system).toMatch(
      /one unbroken stretch of the Passage: don't leave words out with an ellipsis/,
    );
    expect(system).toMatch(/The User has added 1 Document /);
    // Short: it is sent with every Question.
    expect(system.length).toBeLessThan(5000);
  });

  // protects=what the model is sent tells it a cited sentence says only what its quote supports, with an inference in a sentence of its own; fails_when=the rule is left out of the answering prompt or loses its examples in either language; no_claim=whether a model follows it (eval/everyday).
  test("the answering prompt says a cited sentence says only what its quote supports, and an inference goes in a sentence of its own", async () => {
    const model = citingModel({ query: "tides", records: () => [], answer: "Twice a day." });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);

    await askAndFinish(core, client, mind.id, "How often are there high tides?");

    const system = promptOf(model)[0]?.text ?? "";
    expect(system).toContain("A sentence with a Citation says only what its quote supports.");
    expect(system).toContain(
      'in a sentence of its own with no marker, worded as a reading: "This suggests…" / "这意味着…"',
    );
  });

  test("a marker with no record is removed, and a record naming no Passage is dropped: both are counted", async () => {
    const model = citingModel({
      query: "tides",
      records: (passages) => [
        { marker: 1, passage: first(passages).id, pageFrom: 2, pageTo: 2, quote: SPRING },
        // No marker [^2] in the text: the engine places it (see answerMarkers.test.ts).
        {
          marker: 2,
          passage: first(passages).id,
          pageFrom: 1,
          pageTo: 1,
          quote: "Most coasts therefore see two high tides every day.",
        },
        // A Passage the model was never shown.
        { marker: 4, passage: "P99", pageFrom: 1, pageTo: 1, quote: "Anything." },
      ],
      answer:
        "Spring tides come at full moon [^1]. Neap tides are smaller [^3]. The Moon matters [^4].\n\n[^1]: Tides, page 2.",
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);

    const { answerId, finished } = await askAndFinish(
      core,
      client,
      mind.id,
      "Tell me about tides.",
    );

    // [^3] and [^4] had no (valid) record: gone, with the space before them. The footnote line went too.
    expect(answerText(client, answerId)).toBe(
      "Spring tides come at full moon . Neap tides are smaller. The Moon matters.",
    );
    // [^2] matches no sentence: it went to the end of the paragraph that shares a word ("tides") with it.
    expect(citationsIn(client, answerId).map((citation) => citation.quote)).toEqual([
      SPRING,
      "Most coasts therefore see two high tides every day.",
    ]);
    expect(finished).toMatchObject({ droppedMarkers: 2, droppedRecords: 1, placedMarkers: 1 });
    expect(finished.citations).toHaveLength(2);
    // The model heard about the record it couldn't make.
    expect(citeFeedback(model)).toMatch(/\[\^4\]: there is no Passage "P99"/);
  });

  test("while the Answer streams, its Citations show 'checking'", async () => {
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const answer = "Spring tides come at full moon [^1].";
    const model = citingModel({
      query: "spring tides",
      records: (passages) => [
        { marker: 1, passage: first(passages).id, pageFrom: 2, pageTo: 2, quote: SPRING },
      ],
      answer,
      pause: { after: answer.length, until: released },
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);

    const answerId = await askNew(core, client, mind.id, "When are spring tides?");
    await expect
      .poll(() => citationsIn(client, answerId).map((citation) => citation.check))
      .toEqual(["checking"]);
    expect(answerIn(client, answerId).attrs.status).toBe("streaming");
    expect(onlyCitation(client, answerId)).toMatchObject({ documentName: "Tides", pageFrom: 2 });

    const ended = answerEnded(core, answerId);
    release();
    expect((await ended).event).toBe("finished");
    expect(onlyCitation(client, answerId).check).toBe("found");
  });
});

describe("The page-range rule", { timeout: 30_000 }, () => {
  test.each([
    {
      name: "pages outside the Passage's pages",
      pages: { pageFrom: 3, pageTo: 3 },
      reason: "pages-outside-passage",
    },
    {
      name: "more than two pages",
      pages: { pageFrom: 1, pageTo: 3 },
      reason: "too-many-pages",
    },
  ])("a Citation of $name is 'not found', with the reason", async ({ pages, reason }) => {
    // Three short pages: one Passage covers them all.
    const threePages = buildPdf([
      { lines: ["Tides rise and fall twice a day."] },
      { lines: ["Spring tides happen at new moon and at full moon."] },
      { lines: ["Neap tides are the smallest."] },
    ]);
    const model = citingModel({
      query: "spring tides",
      records: (passages) => [{ marker: 1, passage: first(passages).id, ...pages, quote: SPRING }],
      answer: "At new and full moon [^1].",
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Three.pdf", contents: reason === "too-many-pages" ? threePages : TIDES },
    ]);

    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");

    expect(onlyCitation(client, answerId)).toMatchObject({
      ...pages,
      check: "not-found",
      checkReason: reason,
    });
    expect(citeFeedback(model)).toMatch(/cite one page, or two consecutive pages/);
  });

  test("a record that names no page, for a Passage over three pages, cites the page its quote is on", async () => {
    // Three short pages: one Passage covers them all. A small model often names no page (#67).
    const threePages = buildPdf([
      { lines: ["Tides rise and fall twice a day."] },
      { lines: ["Spring tides happen at new moon and at full moon."] },
      { lines: ["Neap tides are the smallest."] },
    ]);
    let shown: ShownPassage[] = [];
    const model = citingModel({
      query: "spring tides",
      records: (passages) => {
        shown = passages;
        return [{ marker: 1, passage: first(passages).id, quote: SPRING }];
      },
      answer: "At new and full moon [^1].",
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Three.pdf", contents: threePages },
    ]);

    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");

    expect(first(shown).pages).toBe("1-3");
    expect(onlyCitation(client, answerId)).toMatchObject({
      pageFrom: 2,
      pageTo: 2,
      location: { kind: "page", from: 2, to: 2 },
      check: "found",
    });
  });

  test("a quote from another page than the one cited is 'not found'", async () => {
    const model = citingModel({
      query: "spring tides",
      records: (passages) => [
        { marker: 1, passage: first(passages).id, pageFrom: 1, pageTo: 1, quote: SPRING },
      ],
      answer: "At new and full moon [^1].",
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);

    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");

    expect(onlyCitation(client, answerId)).toMatchObject({
      pageFrom: 1,
      pageTo: 1,
      check: "not-found",
      checkReason: "quote-not-on-pages",
    });
    expect(citeFeedback(model)).toMatch(/\[\^1\]: the quote isn't word for word on p\. 1/);
  });
});

describe("The Citation check", { timeout: 30_000 }, () => {
  test("a quote across a page break is found once running headers, footers and page numbers are left out", async () => {
    let shown: ShownPassage[] = [];
    const model = citingModel({
      query: "neap tides",
      records: (passages) => {
        shown = passages;
        return [
          { marker: 1, passage: first(passages).id, pageFrom: 2, pageTo: 3, quote: CROSSING },
        ];
      },
      answer: "Neap tides come when the Sun and Moon pull at right angles [^1].",
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Almanac.pdf", contents: ALMANAC },
    ]);

    const { answerId } = await askAndFinish(core, client, mind.id, "When are neap tides?");

    expect(onlyCitation(client, answerId)).toMatchObject({
      pageFrom: 2,
      pageTo: 3,
      check: "found",
    });
    // The model saw the Passage without the header and page numbers, with each page's start marked.
    const passage = first(shown);
    expect(passage.text).not.toContain("Tide Almanac 2026");
    expect(passage.text).toContain("Neap tides occur when the Sun and the Moon\n\n[p. 3] pull at");
  });

  test("a paraphrased quote is 'not found': the match is exact", async () => {
    const model = citingModel({
      query: "neap tides",
      records: (passages) => [
        {
          marker: 1,
          passage: first(passages).id,
          pageFrom: 2,
          pageTo: 3,
          quote: "Neap tides happen when the Sun and Moon are at right angles.",
        },
      ],
      answer: "At right angles [^1].",
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Almanac.pdf", contents: ALMANAC },
    ]);

    const { answerId } = await askAndFinish(core, client, mind.id, "When are neap tides?");

    expect(onlyCitation(client, answerId)).toMatchObject({
      check: "not-found",
      checkReason: "quote-not-on-pages",
    });
  });

  test("a quote that writes the page's reference [36] as [^36] is found, and the Answer's own markers still become Citations", async () => {
    const quote =
      "during training, we employed label smoothing of value 0.1 [^36]. This hurts perplexity";
    const model = citingModel({
      query: "label smoothing",
      records: (passages) => [
        { marker: 1, passage: first(passages).id, pageFrom: 1, pageTo: 1, quote },
      ],
      answer: "Label smoothing hurt perplexity but helped BLEU [^1].",
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      {
        name: "Attention.pdf",
        contents: buildPdf([
          {
            lines: [
              "Label Smoothing",
              "During training, we employed label smoothing of value 0.1 [36]. This",
              "hurts perplexity, but improves accuracy and BLEU score.",
            ],
          },
        ]),
      },
    ]);

    const { answerId } = await askAndFinish(core, client, mind.id, "What did label smoothing do?");

    expect(answerText(client, answerId)).toBe("Label smoothing hurt perplexity but helped BLEU .");
    expect(citationsIn(client, answerId)).toEqual([
      expect.objectContaining({ quote, check: "found", checkReason: null }),
    ]);
    expect(citeFeedback(model)).toMatch(/^Recorded \[\^1\]\. Write the Answer now/);
  });

  test("a quote with an ellipsis is found when each part is on the cited page, and 'not found' when a part is too short", async () => {
    const parts = "Spring tides happen at new moon … the Moon is at its first or last quarter.";
    const short = "Spring tides happen at new moon ... last quarter.";
    const model = citingModel({
      query: "spring tides",
      records: (passages) => [
        { marker: 1, passage: first(passages).id, pageFrom: 2, pageTo: 2, quote: parts },
        { marker: 2, passage: first(passages).id, pageFrom: 2, pageTo: 2, quote: short },
      ],
      answer: "Spring tides come at new moon [^1], neap tides at the quarters [^2].",
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);

    const { answerId } = await askAndFinish(core, client, mind.id, "When are the tides?");

    expect(citationsIn(client, answerId)).toEqual([
      expect.objectContaining({ quote: parts, check: "found", checkReason: null }),
      expect.objectContaining({
        quote: short,
        check: "not-found",
        checkReason: "quote-not-on-pages",
      }),
    ]);
  });

  test("a Chinese quote across a page break is found, with full-width punctuation and spacing normalised", async () => {
    const model = citingModel({
      query: "潮汐 隆起",
      records: (passages) => [
        {
          marker: 1,
          passage: first(passages).id,
          pageFrom: 1,
          pageTo: 2,
          quote: "月球的引力使地球两侧的海水隆起, 形成两个潮汐隆起。",
        },
      ],
      answer: "月球引力形成两个潮汐隆起[^1]。",
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "潮汐.pdf", contents: CHINESE_TIDES },
    ]);

    const { answerId } = await askAndFinish(core, client, mind.id, "潮汐是怎么形成的？");

    expect(onlyCitation(client, answerId)).toMatchObject({
      documentName: "潮汐",
      pageFrom: 1,
      pageTo: 2,
      check: "found",
    });
    expect(answerText(client, answerId)).toBe("月球引力形成两个潮汐隆起。");
  });

  test("a Chinese quote is found in text that has radical look-alikes; in Markdown, the section it is under is cited", async () => {
    const model = citingModel({
      query: "大型语言模型",
      records: (passages) => [
        { marker: 1, passage: first(passages).id, quote: "大型语言模型的参数规模很大" },
      ],
      answer: "大型语言模型的参数规模很大[^1]。",
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "笔记.md", contents: RADICAL_NOTES },
    ]);

    const { answerId } = await askAndFinish(core, client, mind.id, "大型语言模型有多大？");

    expect(onlyCitation(client, answerId)).toMatchObject({
      documentName: "笔记",
      pageFrom: 1,
      pageTo: 1,
      location: { kind: "section" },
      check: "found",
    });
  });

  test("the Passages the model reads have the ideographs, not their radical look-alikes", async () => {
    let shown: ShownPassage[] = [];
    const model = citingModel({
      query: "大型语言模型",
      records: (passages) => {
        shown = passages;
        return [{ marker: 1, passage: first(passages).id, quote: "大型语言模型的参数规模很大" }];
      },
      answer: "大型语言模型的参数规模很大[^1]。",
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "笔记.md", contents: RADICAL_NOTES },
    ]);

    await askAndFinish(core, client, mind.id, "大型语言模型有多大？");

    expect(first(shown).text).toContain("大型语言模型的参数规模很大，训练需要大量数据。");
    expect(first(shown).text).not.toMatch(/[⼤⾔]/);
  });

  test("in a Document whose text lost its f-ligatures, a quote of it as it shows is found; elsewhere a lone f stays an f", async () => {
    const lost = `# Report\n\nThe goal is to fnance and facilitate growth. ${"The frm's fnancial eforts beneft its ofce. ".repeat(50)}\n`;
    const kept = `# Log\n\nThe fight was delayed by fog. ${"The first financial effort of the office was flawed. ".repeat(50)}\n`;
    const model = citingModel({
      // Words of both Documents, so keyword search alone, the default, finds both.
      query: "goal delayed",
      records: (passages) => {
        const of = (document: string) =>
          passages.find((passage) => passage.document === document)?.id ?? "none";
        return [
          {
            marker: 1,
            passage: of("Report"),
            quote: "The goal is to finance and facilitate growth.",
          },
          { marker: 2, passage: of("Log"), quote: "The flight was delayed by fog." },
        ];
      },
      answer: "Growth [^1]. A delay [^2].",
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Report.md", contents: lost },
      { name: "Log.md", contents: kept },
    ]);

    const { answerId } = await askAndFinish(
      core,
      client,
      mind.id,
      "What is the goal, and what was delayed?",
    );

    expect(
      citationsIn(client, answerId).map(({ documentName, check }) => [documentName, check]),
    ).toEqual([
      ["Report", "found"],
      ["Log", "not-found"],
    ]);
  });

  test("a Citation of a page with no text, such as a scan, 'can't be checked'", async () => {
    const model = citingModel({
      query: "harbour survey",
      records: (passages) => [
        {
          marker: 1,
          passage: first(passages).id,
          pageFrom: 2,
          pageTo: 2,
          quote: "The harbour floor is mostly sand.",
        },
      ],
      answer: "The floor is sand [^1].",
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Survey.pdf", contents: WITH_SCAN },
    ]);

    const { answerId } = await askAndFinish(core, client, mind.id, "What is the harbour floor?");

    expect(onlyCitation(client, answerId)).toMatchObject({
      pageFrom: 2,
      check: "cant-check",
      checkReason: "no-text",
    });
  });

  test("a Citation of a Document deleted before the Answer finished 'can't be checked', and still names it", async () => {
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const answer = "Spring tides come at full moon [^1].";
    const model = citingModel({
      query: "spring tides",
      records: (passages) => [
        { marker: 1, passage: first(passages).id, pageFrom: 2, pageTo: 2, quote: SPRING },
      ],
      answer,
      pause: { after: answer.length, until: released },
    });
    const { core, client, mind, documents } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);

    const answerId = await askNew(core, client, mind.id, "When are spring tides?");
    await expect.poll(() => citationsIn(client, answerId).length).toBe(1);
    await core.deleteDocument(documents[0]?.id as string);
    const ended = answerEnded(core, answerId);
    release();
    expect((await ended).event).toBe("finished");

    expect(onlyCitation(client, answerId)).toMatchObject({
      documentName: "Tides",
      quote: SPRING,
      check: "cant-check",
      checkReason: "document-removed",
    });
  });
});

describe("Models that can't call Tools", { timeout: 30_000 }, () => {
  /** A local model whose server refuses Tools, as Ollama does for models without them. */
  const refusesTools = {
    status: 400,
    message: "registry.ollama.ai/library/tiny:latest does not support tools",
  };

  test("fall back to one search with the Question's text, and return their Citations as structured output", async () => {
    const model = scriptedModel((call) => {
      if (call.tools.length > 0) return { error: refusesTools };
      if (!call.json) return { text: "Expected a request for JSON." };
      const passage = first(shownPassages(call.system));
      return {
        text: JSON.stringify({
          answer: "Spring tides come at new and full moon [^1].",
          citations: [{ marker: 1, passage: passage.id, pageFrom: 2, pageTo: 2, quote: SPRING }],
        }),
      };
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);

    const { answerId, finished } = await askAndFinish(
      core,
      client,
      mind.id,
      "When are spring tides?",
    );

    expect(answerText(client, answerId)).toBe("Spring tides come at new and full moon .");
    expect(onlyCitation(client, answerId)).toMatchObject({ pageFrom: 2, check: "found" });
    expect(finished.citationSupport).toBe("structured-output");
    expect(answerIn(client, answerId).attrs.citationSupport).toBe("structured-output");
    // The one search used the Question's text, and shows on the Answer.
    expect(JSON.parse(answerIn(client, answerId).attrs.toolCalls as string)).toEqual([
      expect.objectContaining({
        tool: "search_documents",
        input: { query: "When are spring tides?" },
        status: "done",
      }),
    ]);
    expect(model.doStreamCalls).toHaveLength(2);

    // The next Answer from this model goes straight to structured output.
    await askAndFinish(core, client, mind.id, "When are spring tides again?");
    expect(model.doStreamCalls).toHaveLength(3);
    expect(model.doStreamCalls[2]?.tools ?? []).toEqual([]);
  });

  test("structured output inside a Markdown code fence is read too", async () => {
    const model = scriptedModel((call) => {
      if (call.tools.length > 0) return { error: refusesTools };
      const passage = first(shownPassages(call.system));
      const reply = {
        answer: "At new and full moon [^1].",
        citations: [{ marker: "1", passage: passage.id, pageFrom: 2, pageTo: 2, quote: SPRING }],
      };
      return { text: `\`\`\`json\n${JSON.stringify(reply, null, 2)}\n\`\`\`` };
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);

    const { answerId, finished } = await askAndFinish(
      core,
      client,
      mind.id,
      "When are spring tides?",
    );

    expect(answerText(client, answerId)).toBe("At new and full moon .");
    expect(onlyCitation(client, answerId).check).toBe("found");
    expect(finished.citationSupport).toBe("structured-output");
  });

  test("a model with neither Tools nor structured output still answers, without Citations, and says why", async () => {
    const model = scriptedModel((call) => {
      if (call.tools.length > 0) return { error: refusesTools };
      if (call.json) return { error: { status: 400, message: "response_format is not supported" } };
      return { text: "Spring tides come at new and full moon [^1]." };
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);

    const { answerId, finished } = await askAndFinish(
      core,
      client,
      mind.id,
      "When are spring tides?",
    );

    expect(answerText(client, answerId)).toBe("Spring tides come at new and full moon.");
    expect(citationsIn(client, answerId)).toEqual([]);
    expect(finished).toMatchObject({ citationSupport: "none", citations: [], droppedMarkers: 1 });
    // The Answer carries the limitation, for the notice.
    expect(answerIn(client, answerId).attrs.citationSupport).toBe("none");
    // It still drew on the Documents: the search's Passages were in its instructions.
    expect(promptOf(model, 2)[0]?.text).toContain(SPRING);
    expect(promptOf(model, 2)[0]?.text).toMatch(/Don't write citation markers/);
  });

  test("other provider errors are failures, not a reason to give up Tools", async () => {
    const model = scriptedModel(() => ({
      error: { status: 401, message: "Invalid API key for tools" },
    }));
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);

    const answerId = await askNew(core, client, mind.id, "When are spring tides?");
    const ended = await answerEnded(core, answerId);

    expect(ended).toMatchObject({ event: "failed", payload: { error: { kind: "auth" } } });
    expect(model.doStreamCalls).toHaveLength(1);
  });
});

describe("Searching for a follow-up Question", { timeout: 30_000 }, () => {
  const refusesTools = { status: 400, message: "tiny:latest does not support tools" };
  /** The instructions of a request to rewrite a Question for search. */
  const REWRITING = /one query for searching the User's Documents/;

  /**
   * A local model that can't call Tools: it answers in JSON, without
   * Citations, and rewrites Questions for search with `rewrite`. (It can't
   * tag Documents, which asks for a reply that isn't streamed too.)
   */
  const withoutTools = (rewrite: (call: GenerateCall) => GeneratedReply) =>
    scriptedModel(
      (call) =>
        call.tools.length > 0
          ? { error: refusesTools }
          : { text: JSON.stringify({ answer: "At new and full moon.", citations: [] }) },
      {
        generate: (call) =>
          REWRITING.test(call.system)
            ? rewrite(call)
            : { error: { status: 400, message: "This model doesn't tag Documents." } },
      },
    );

  /** The requests a model had to rewrite a Question for search: their instructions, text and temperature. */
  const rewritesOf = (model: MockLanguageModelV4) =>
    model.doGenerateCalls
      .map((options) => {
        const [system = "", prompt = ""] = options.prompt.map((message) =>
          typeof message.content === "string"
            ? message.content
            : message.content.map((part) => ("text" in part ? part.text : "")).join(""),
        );
        return { system, prompt, temperature: options.temperature };
      })
      .filter((request) => REWRITING.test(request.system));

  /** Writes `above`, then a Question, into the Mind; asks it and waits for its Answer. */
  async function askBelow(
    core: Core,
    client: MindClient,
    mindId: string,
    above: JSONContent[],
    text: string,
  ): Promise<string> {
    const asked = question(text);
    writeMind(client, [...above, asked]);
    await client.settled();
    const result = await core.askQuestion({ mindId, questionId: asked.attrs.id });
    if (!result.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(result)}`);
    const ended = await answerEnded(core, result.answerId);
    expect(ended.event).toBe("finished");
    return result.answerId;
  }

  /** What the Answer's search looked for, as its Tool-call card shows it. */
  const searchedFor = (client: MindClient, answerId: string): unknown =>
    JSON.parse(answerIn(client, answerId).attrs.toolCalls as string)[0]?.input.query;

  test("a model without Tools rewrites the Question into a query that stands on its own, from the Blocks above, and searches for that", async () => {
    const model = withoutTools(({ prompt }) => ({
      text: prompt.includes("Spring tides have the largest range")
        ? '"When do spring tides happen?"'
        : "The rewrite didn't see the Notes above the Question.",
    }));
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);

    const answerId = await askBelow(
      core,
      client,
      mind.id,
      [question("Tell me about spring tides."), note("Spring tides have the largest range.")],
      "When do they happen?",
    );

    // One short request, with the Blocks above, the Question, and the Answer temperature.
    const rewrites = rewritesOf(model);
    expect(rewrites).toHaveLength(1);
    expect(rewrites[0]?.temperature).toBe(ANSWER_TEMPERATURE);
    expect(rewrites[0]?.prompt).toContain("User: Tell me about spring tides.");
    expect(rewrites[0]?.prompt).toMatch(/The Question: When do they happen\?$/);
    // The search used the rewrite, without its quotes, and found the Passages it needs.
    expect(searchedFor(client, answerId)).toBe("When do spring tides happen?");
    expect(promptOf(model, 1)[0]?.text).toContain(SPRING);
  });

  test("a Question with nothing above it in its context is searched as it is, with no rewrite", async () => {
    const model = withoutTools(() => ({ text: "A rewrite that shouldn't be used" }));
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);

    // A Note switched out of the Question context isn't context to rewrite from.
    const answerId = await askBelow(
      core,
      client,
      mind.id,
      [note("Spring tides have the largest range.", { off: true })],
      "When are spring tides?",
    );

    expect(rewritesOf(model)).toHaveLength(0);
    expect(searchedFor(client, answerId)).toBe("When are spring tides?");
  });

  test("when the rewrite fails or comes back empty, the Question is searched as it is", async () => {
    const replies: GeneratedReply[] = [
      { error: { status: 500, message: "The server had an error." } },
      { text: "<think>The Question is about spring tides, so" },
    ];
    const model = withoutTools(() => replies.shift() ?? { text: "" });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);
    const above = [note("Spring tides have the largest range.")];

    const failed = await askBelow(core, client, mind.id, above, "When do they happen?");
    expect(searchedFor(client, failed)).toBe("When do they happen?");

    const cutOff = await askBelow(core, client, mind.id, above, "And how high are they?");
    expect(searchedFor(client, cutOff)).toBe("And how high are they?");
    expect(rewritesOf(model)).toHaveLength(2);
  });

  test("a model that calls Tools isn't asked to rewrite: the search Tool tells it to write queries that stand on their own", async () => {
    const model = citingModel({ query: "spring tides", records: () => [], answer: "Twice." });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);

    await askBelow(
      core,
      client,
      mind.id,
      [note("Spring tides have the largest range.")],
      "When do they happen?",
    );

    expect(rewritesOf(model)).toHaveLength(0);
    const search = model.doStreamCalls[0]?.tools?.find((each) => each.name === "search_documents");
    expect(search?.type === "function" && search.description).toMatch(/stand on its own/);
    expect(JSON.stringify(search?.type === "function" && search.inputSchema)).toMatch(
      /instead of pronouns or words that point back/,
    );
  });
});

describe("Citations in the Mind", { timeout: 30_000 }, () => {
  test("survive a restart, with their check results", async () => {
    const model = citingModel({
      query: "spring tides",
      records: (passages) => [
        { marker: 1, passage: first(passages).id, pageFrom: 2, pageTo: 2, quote: SPRING },
      ],
      answer: "Spring tides come at new and full moon [^1].",
    });
    const { core, client, mind, dataDir } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);
    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");
    const before = onlyCitation(client, answerId);
    core.close();

    const restarted = startCore(dataDir);
    const reader = await connectToMind(restarted, mind.id);

    expect(onlyCitation(reader, answerId)).toEqual(before);
    expect(before.check).toBe("found");
  });

  test("copying text that holds a Citation into a Note keeps the Citation; deleting the text deletes it", async () => {
    const model = citingModel({
      query: "spring tides",
      records: (passages) => [
        { marker: 1, passage: first(passages).id, pageFrom: 2, pageTo: 2, quote: SPRING },
      ],
      answer: "Spring tides come at new and full moon [^1].",
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);
    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");
    const cited = onlyCitation(client, answerId);

    // The User selects the Answer's sentence with its Citation, copies it, and pastes it into a new Note.
    const editor = headlessEditor(readMind(client).toJSON());
    let at = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "citation") at = pos;
    });
    const sentence = editor.state.doc.resolve(at);
    const copied = TextSelection.create(
      editor.state.doc,
      sentence.start(),
      sentence.end(),
    ).content();
    // What the clipboard carries: the sentence, inside the Answer it came from.
    expect(copied.content.firstChild?.type.name).toBe("answer");
    // Pasting runs the editor's paste transforms, as ProseMirror does.
    let pastedSlice = copied;
    for (const plugin of editor.state.plugins) {
      const transform = plugin.props.transformPasted;
      if (transform) pastedSlice = transform.call(plugin, pastedSlice, editor.view, false);
    }
    editor.commands.insertContentAt(editor.state.doc.content.size, { type: "paragraph" });
    const inNote = editor.state.doc.content.size - 1;
    editor.view.dispatch(
      editor.state.tr
        .setSelection(TextSelection.create(editor.state.doc, inNote))
        .replaceSelection(pastedSlice),
    );
    writeMind(client, editor.getJSON().content ?? []);
    await client.settled();

    // Another window sees a Note (not another Answer) with the same Citation, check result and all.
    const reader = await connectToMind(core, mind.id);
    const pasted = readMind(reader).lastChild;
    expect(pasted?.type.name).toBe("paragraph");
    expect(pasted?.textContent).toBe("Spring tides come at new and full moon .");
    expect(pasted?.child(1).attrs).toEqual({ ...cited, proposal: null });
    // The Answer keeps its own.
    expect(onlyCitation(reader, answerId)).toEqual(cited);

    // Deleting the pasted text deletes its Citation.
    const end = editor.state.doc.content.size - 1;
    const start = end - (editor.state.doc.lastChild?.content.size ?? 0);
    editor.commands.deleteRange({ from: start, to: end });
    writeMind(client, editor.getJSON().content ?? []);
    await client.settled();
    await expect.poll(() => readMind(reader).lastChild?.childCount).toBe(0);
    expect(onlyCitation(reader, answerId)).toEqual(cited);
  });

  test("a Note holding a Citation shows it to later Questions as a reference to its source", async () => {
    const model = citingModel({ query: "tides", records: () => [], answer: "Yes." });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);
    const cited = note("Spring tides come at full moon");
    cited.content?.push(
      {
        type: "citation",
        attrs: {
          passageId: "p",
          documentId: "d",
          documentName: "Tides",
          contentHash: "h",
          pageFrom: 2,
          pageTo: 2,
          quote: SPRING,
          check: "found",
        },
      },
      { type: "text", text: "." },
    );
    const asked = question("Is that right?");
    writeMind(client, [cited, asked]);
    await client.settled();

    const result = await core.askQuestion({ mindId: mind.id, questionId: asked.attrs.id });
    if (!result.asked) throw new Error("The Question wasn't asked.");
    await answerEnded(core, result.answerId);

    expect(promptOf(model, 0)[1]?.text).toBe(
      "Spring tides come at full moon[Tides, p. 2 · C1].\n\nIs that right?",
    );
  });
});

describe("Searching across languages without Tools", { timeout: 30_000 }, () => {
  const refusesTools = { status: 400, message: "tiny:latest does not support tools" };
  /** The instructions of a request to translate a search query. */
  const TRANSLATING = /You translate a query for searching the User's Documents/;

  /** A model that can't call Tools: it answers in JSON, and translates queries with `translate`. */
  const withoutTools = (translate: (call: GenerateCall) => GeneratedReply) =>
    scriptedModel(
      (call) =>
        call.tools.length > 0
          ? { error: refusesTools }
          : { text: JSON.stringify({ answer: "At new and full moon.", citations: [] }) },
      {
        generate: (call) =>
          TRANSLATING.test(call.system)
            ? translate(call)
            : { error: { status: 400, message: "This model doesn't tag Documents." } },
      },
    );

  /** What the Answer's searches looked for, as their Tool-call cards show them. */
  const searchesOf = (client: MindClient, answerId: string): unknown[] =>
    (
      JSON.parse(answerIn(client, answerId).attrs.toolCalls as string) as {
        input: { query: unknown };
      }[]
    ).map((call) => call.input.query);

  test("a Question in another language than the Documents is searched again, translated into theirs, by one short request", async () => {
    const translations: string[] = [];
    const model = withoutTools(({ prompt }) => {
      translations.push(prompt);
      return { text: "When do spring tides happen?" };
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);

    const { answerId } = await askAndFinish(core, client, mind.id, "大潮在什么时候发生？");

    expect(translations).toEqual(["Translate this query into English:\n大潮在什么时候发生？"]);
    expect(searchesOf(client, answerId)).toEqual([
      "大潮在什么时候发生？",
      "When do spring tides happen?",
    ]);
    expect(promptOf(model, 1)[0]?.text).toContain(SPRING);
  });

  test("a Question in the Documents' language is searched once, with no translation", async () => {
    const model = withoutTools(() => ({ text: "A translation that shouldn't be asked for" }));
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);

    const { answerId } = await askAndFinish(core, client, mind.id, "When are the spring tides?");

    expect(
      model.doGenerateCalls.filter((call) => TRANSLATING.test(JSON.stringify(call.prompt))),
    ).toHaveLength(0);
    expect(searchesOf(client, answerId)).toEqual(["When are the spring tides?"]);
  });

  test("the language searched again is the Documents' most common one the Question isn't in", () => {
    const english = { language: "English", documents: 7 };
    const chinese = { language: "Chinese", documents: 5 };
    expect(searchLanguage("大潮在什么时候发生？", [english])).toBe("English");
    expect(searchLanguage("大潮在什么时候发生？", [chinese, english])).toBe("English");
    expect(searchLanguage("What is the size of the data that is used?", [english])).toBeNull();
    expect(searchLanguage("What is the size of the data that is used?", [english, chinese])).toBe(
      "Chinese",
    );
    // Too short to tell it is English, but it can't be Chinese: it has no Chinese characters.
    expect(searchLanguage("When are spring tides?", [english, chinese])).toBe("Chinese");
    expect(
      searchLanguage("When are spring tides?", [english, { language: "French", documents: 1 }]),
    ).toBeNull();
    expect(searchLanguage("When are spring tides?", [])).toBeNull();
  });

  test("two searches' Passages are given once each, ranked alternately so a small window keeps the best of each", () => {
    const shown = (id: string) =>
      `<passage id="${id}" document="Tides" pages="1">\nText ${id}\n</passage>`;
    const merged = mergeSearches([
      { text: [shown("P1"), shown("P2")].join("\n\n"), passageCount: 2, ranks: [1, 0] },
      { text: [shown("P2"), shown("P3")].join("\n\n"), passageCount: 2, ranks: [0, 1] },
    ]);
    expect(merged).toEqual({
      text: [shown("P1"), shown("P2"), shown("P3")].join("\n\n"),
      passageCount: 3,
      ranks: [2, 0, 3],
    });
    const none = {
      text: "No Passages in the User's Documents match this search.",
      passageCount: 0,
    };
    expect(mergeSearches([none, none])).toBe(none);
  });
});
