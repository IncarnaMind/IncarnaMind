/**
 * Why a small local model's Citations of the gating set's long PDFs weren't
 * found (#67), cause by cause, without a model, and what the fixes made of
 * them: records written by hand as a small model may write them, given to
 * the core's own citation session over the stored text of the evaluation's
 * PDFs (cut short), and sorted as the evaluation sorts them, as the Tool loop
 * gives them and, where it differs, as structured output does (which places
 * a record where its quote is in its Passage, `CiteOptions`). qwen3.5:4b in
 * structured output found 78% of its English quotes and 64% of its Chinese
 * ones on the gating set before them. A quote of Vantrell's report, whose
 * stored text lost its f-ligatures ("fnance"), is in ./scoring.test.ts
 * ("What became of a Citation").
 */
import { describe, expect, test } from "vitest";
import { type CitationOutcome, outcomeOf, quotePages } from "../../eval/lib/citations";
import type { CitationAttributes } from "../../src/core";
import { createCitationSession } from "../../src/core/answers/citations";
import type { CitationRecordInput, CiteOptions } from "../../src/core/answers/engine";
import { documentInstructions } from "../../src/core/answers/prompt";

/** A Document's stored pages, cut short, and its Passages, by the pages they cover. */
interface Excerpt {
  name: string;
  pages: Record<number, string>;
  passages: [number, number][];
}

interface Outcome {
  check: string;
  checkReason: string | null;
  pages: [number | null, number | null];
  outcome: CitationOutcome;
  quoteOn: [number, number] | null;
}

/**
 * The citation session of one Answer over an excerpt: the Passages as the
 * model reads them, and what becomes of its records.
 */
function sessionOver({ name, pages, passages }: Excerpt) {
  const units = Object.entries(pages).map(([page, text]) => ({
    page: Number(page),
    kind: "page" as const,
    text,
  }));
  const inRange = (from: number, to: number) =>
    units.filter((unit) => unit.page >= from && unit.page <= to);
  // A Passage runs across pages as processing lays them out: a blank line at each break.
  const stored = passages.map(([from, to], position) => ({
    passageId: `${name}#${position}`,
    pageFrom: from,
    pageTo: to,
    position,
    text: inRange(from, to)
      .map((unit) => unit.text.trim())
      .join("\n\n"),
  }));
  const source = { documentId: name, documentName: name, contentHash: "v1" };
  let shownOnce: Promise<string> | null = null;
  const session = createCitationSession(
    {
      searchableCount: () => 1,
      search: async () =>
        stored.map((passage) => ({
          ...passage,
          ...source,
          seq: passage.position,
          documentKind: "pdf" as const,
          windowFrom: passage.position,
          windowTo: passage.position,
        })),
      citationSource: (passageId) => {
        const passage = stored.find((each) => each.passageId === passageId);
        return passage
          ? { ...passage, ...source, documentKind: "pdf", documentDeleted: false, notCited: false }
          : null;
      },
      pageTexts: (_documentId, _contentHash, from, to) =>
        from === null || to === null ? units : inRange(from, to),
      documentDate: () => null,
    },
    { onRecord: () => undefined },
  );
  return {
    /** The Passages as the model reads them, each with its id: P1, P2… */
    shown: () => {
      shownOnce ??= session.tools.searchDocuments("a query").then((found) => found.text);
      return shownOnce;
    },
    /** What `cite` tells the model, and what became of each record: null when it was dropped. */
    cite(
      records: CitationRecordInput[],
      options?: CiteOptions,
    ): { feedback: string; outcomes: (Outcome | null)[] } {
      const feedback = session.tools.cite(records, options);
      session.check();
      const outcomes = records.map((record): Outcome | null => {
        const node = session.finalNode(record.marker);
        if (!node) return null;
        const attrs = node.attrs as Partial<CitationAttributes>;
        const cited = {
          check: attrs.check ?? "checking",
          checkReason: attrs.checkReason ?? null,
          quote: attrs.quote ?? "",
          pageFrom: attrs.pageFrom ?? null,
          pageTo: attrs.pageTo ?? null,
        };
        return {
          check: cited.check,
          checkReason: cited.checkReason,
          pages: [cited.pageFrom, cited.pageTo],
          outcome: outcomeOf(cited, units),
          quoteOn: quotePages(cited.quote, units),
        };
      });
      return { feedback, outcomes };
    },
  };
}

/** Weighted Keys, Shorter Paths, pp. 7–8, as stored: en-02's answer is on p. 8. */
const ATTENTION: Excerpt = {
  name: "Weighted Keys Shorter Paths",
  pages: {
    7: "3.1 Data, batching and hardware\nAll runs used a single machine holding twelve accelerator cards. The optimiser was Adam,",
    8: "Label smoothing of ε = 0.04 [27] was applied throughout. It costs perplexity,\nsince the model is less sure of itself, but it gains accuracy and BLEU.\n4 Results",
  },
  passages: [[7, 8]],
};

const PERPLEXITY =
  "It costs perplexity, since the model is less sure of itself, but it gains accuracy and BLEU.";

/** MPMA Code of Practice 2021, pp. 33–34, as stored: en-17's answer runs across the break. */
const MPMA: Excerpt = {
  name: "MPMA Code of Practice for the Pharmaceutical Industry 2021",
  pages: {
    33: "Clause 26: Delivery of items\nA representative who delivers items to a health professional and is not given an interview must leave the items with a reply card.\nWhen a representative offers to drop items off, the reply card must say that there is no obligation to grant an interview when items are",
    34: "delivered. It must also make clear that a refusal will not be held against the health professional, and that the items can be returned without explanation.",
  },
  // The search gives a window of overlapping Passages: one on p. 33 only, one across the break.
  passages: [
    [33, 33],
    [33, 34],
  ],
};

const OBLIGATION =
  "there is no obligation to grant an interview when items are delivered. It must also make clear that a refusal will not be held against the health professional";

/** 维基百科-可持续发展目标, pp. 3–4, as stored, radical look-alikes and all: zh-02's answer is on p. 4. */
const GOALS: Excerpt = {
  name: "维基百科-可持续发展目标",
  pages: {
    3: "3、確保健康及促進各年齡層的福祉\n3.1、在西元 2030 年前，減少全球的死產率，讓每 100,000 個活產的死胎數少於 70 個。",
    4: "3.5、強化物質濫⽤的預防與治療，包括⿇醉藥品濫⽤以及酗酒。\n3.6、在西元 2020 年前，讓全球因為交通事故⽽傷亡的⼈數減少⼀半。",
  },
  passages: [[3, 4]],
};

/**
 * 维基百科-梯度下降法, pp. 1–4, as stored, cut short: its formulas are
 * images, so pages 2 and 3 hold 309 and 78 characters, and one Passage
 * covers all four (zh-08's answer is on p. 2, zh-14's on p. 3).
 */
const GRADIENT: Excerpt = {
  name: "维基百科-梯度下降法",
  pages: {
    1: "梯度下降法梯度下降法（英語：Gradient descent）是⼀种求解⽆约束最优化问题的⼀阶迭代最优化算法",
    2: "梯度下降法处理⼀些复杂的⾮线性函数会出现问题，例如 Rosenbrock 函數其最⼩值在 处，数值为 。但是此函数具有狭窄弯曲的⼭⾕，最⼩值就在这些⼭⾕之中，并且⾕底很平。优化过程是之字形的向极⼩值点靠近，速度⾮常缓慢。",
    3: "梯度下降法的缺點包括：[8]\n靠近局部極⼩值时速度减慢。\n直線搜索可能會產⽣⼀些問題。",
    4: "共轭梯度法随机梯度下降法最优化线搜索反向傳播算法量⼦退⽕",
  },
  passages: [[1, 4]],
};

describe("Why a small model's Citations of long PDFs aren't found", () => {
  test("a page in traditional characters, quoted in simplified ones, is found character by character (zh-02; ADR-0009)", async () => {
    const goals = sessionOver(GOALS);
    // The model reads the page's own characters, radical look-alikes folded: 讓, 為, 傷, 數, 減.
    expect(await goals.shown()).toContain(
      "3.6、在西元 2020 年前，讓全球因為交通事故而傷亡的人數減少一半。",
    );

    const { outcomes } = goals.cite([
      {
        marker: 1,
        passage: "P1",
        location: "p. 4",
        quote: "讓全球因為交通事故而傷亡的人數減少一半",
      },
      // The Question is in simplified Chinese, and so is the Answer: its quote follows.
      {
        marker: 2,
        passage: "P1",
        location: "p. 4",
        quote: "让全球因为交通事故而伤亡的人数减少一半",
      },
      // Reworded, it is in neither.
      { marker: 3, passage: "P1", location: "p. 4", quote: "让全球交通事故伤亡人数减半" },
    ]);

    expect(outcomes).toMatchObject([
      { check: "found", quoteOn: [4, 4] },
      { check: "found", quoteOn: [4, 4] },
      { check: "not-found", outcome: "not-in-document", quoteOn: null },
    ]);
    // Structured output places a quote only where it is: the simplified one on p. 4, the reworded one nowhere.
    const placed = sessionOver(GOALS);
    await placed.shown();
    expect(
      placed.cite(
        [
          {
            marker: 1,
            passage: "P1",
            location: "p. 3",
            quote: "让全球因为交通事故而伤亡的人数减少一半",
          },
          { marker: 2, passage: "P1", location: "p. 3", quote: "让全球交通事故伤亡人数减半" },
        ],
        { structured: true },
      ).outcomes,
    ).toMatchObject([
      { check: "found", pages: [4, 4] },
      { check: "not-found", pages: [3, 3], outcome: "not-in-document" },
    ]);
  });

  test("the Passage's first page, for a quote on its second, is a wrong page that cite's feedback lets the Tool loop fix; structured output's is placed (en-02)", async () => {
    const attention = sessionOver(ATTENTION);
    // The Passage covers pp. 7–8, and marks where p. 8 starts.
    expect(await attention.shown()).toContain('pages="7-8">');
    expect(await attention.shown()).toContain("\n\n[p. 8] Label smoothing");

    const { feedback, outcomes } = attention.cite([
      { marker: 1, passage: "P1", location: "p. 7", quote: PERPLEXITY },
      { marker: 2, passage: "P1", location: "p. 8", quote: PERPLEXITY },
      { marker: 3, passage: "P1", pageFrom: 7, pageTo: 8, quote: PERPLEXITY },
    ]);

    expect(outcomes).toMatchObject([
      { check: "not-found", outcome: "wrong-page", pages: [7, 7], quoteOn: [8, 8] },
      { check: "found", pages: [8, 8] },
      { check: "found", pages: [8, 8] },
    ]);
    // In the Tool loop, `cite` tells the model, which may fix the record with another call.
    expect(feedback).toMatch(/\[\^1\]: the quote isn't word for word on p\. 7 in P1/);
    // Structured output sends one request, so nothing can tell the model: its record is placed.
    const placed = sessionOver(ATTENTION);
    await placed.shown();
    expect(
      placed.cite([{ marker: 1, passage: "P1", location: "p. 7", quote: PERPLEXITY }], {
        structured: true,
      }).outcomes,
    ).toMatchObject([{ check: "found", pages: [8, 8] }]);
  });

  test("the structured-output example names no page; its placeholder, copied, cites the page the quote is on (en-02)", async () => {
    const instructions = documentInstructions("structured-output", {
      total: 1,
      names: ["Weighted Keys Shorter Paths"],
    });
    // It named "p. 3", which a record that copied it put outside its Passage.
    expect(instructions).toContain('"location": "…"');
    expect(instructions).not.toContain("p. 3");
    const attention = sessionOver(ATTENTION);
    await attention.shown();

    const { outcomes } = attention.cite([
      { marker: 1, passage: "P1", location: "…", quote: PERPLEXITY },
      { marker: 2, passage: "P1", location: "p. 3", quote: PERPLEXITY },
    ]);

    expect(outcomes).toMatchObject([
      { check: "found", pages: [8, 8] },
      { check: "not-found", checkReason: "pages-outside-passage", outcome: "page-range" },
    ]);
    // In structured output, a page outside the Passage is placed inside it, where the quote is.
    const placed = sessionOver(ATTENTION);
    await placed.shown();
    expect(
      placed.cite([{ marker: 1, passage: "P1", location: "p. 3", quote: PERPLEXITY }], {
        structured: true,
      }).outcomes,
    ).toMatchObject([{ check: "found", pages: [8, 8] }]);
  });

  test("a quote across a page break needs both pages, in a Passage that has both (en-17)", async () => {
    const audience = sessionOver(MPMA);
    const shown = await audience.shown();
    expect(shown).toContain(
      '<passage id="P1" document="MPMA Code of Practice for the Pharmaceutical Industry 2021" pages="33">',
    );
    expect(shown).toContain("\n\n[p. 34] delivered. It must also make clear");

    const { outcomes } = audience.cite([
      // The page where the quote starts.
      { marker: 1, passage: "P2", location: "p. 33", quote: OBLIGATION },
      // Both pages, of the Passage that holds them.
      { marker: 2, passage: "P2", location: "pp. 33-34", quote: OBLIGATION },
      // Both pages, but of the overlapping Passage that holds only the first.
      { marker: 3, passage: "P1", location: "pp. 33-34", quote: OBLIGATION },
    ]);

    expect(outcomes).toMatchObject([
      { check: "not-found", outcome: "wrong-page", quoteOn: [33, 34] },
      { check: "found", pages: [33, 34] },
      { check: "not-found", checkReason: "pages-outside-passage", outcome: "page-range" },
    ]);
    // Structured output places the first across both pages of its Passage, but never moves
    // the third out of P1, which holds only the first page.
    const placed = sessionOver(MPMA);
    await placed.shown();
    expect(
      placed.cite(
        [
          { marker: 1, passage: "P2", location: "p. 33", quote: OBLIGATION },
          { marker: 3, passage: "P1", location: "pp. 33-34", quote: OBLIGATION },
        ],
        { structured: true },
      ).outcomes,
    ).toMatchObject([
      { check: "found", pages: [33, 34] },
      { check: "not-found", checkReason: "pages-outside-passage", outcome: "page-range" },
    ]);
  });

  test("a record that names no page, for a Passage over four pages, cites the quote's own page (zh-08, zh-14)", async () => {
    const gradient = sessionOver(GRADIENT);
    expect(await gradient.shown()).toContain('pages="1-4">');

    const { outcomes } = gradient.cite([
      { marker: 1, passage: "P1", quote: "优化过程是之字形的向极小值点靠近，速度非常缓慢" },
      { marker: 2, passage: "P1", quote: "直線搜索可能會產生一些問題" },
      // The Passage's own pages, copied from its tag: more than two.
      { marker: 3, passage: "P1", location: "pp. 1-4", quote: "直線搜索可能會產生一些問題" },
    ]);

    expect(outcomes).toMatchObject([
      { check: "found", pages: [2, 2] },
      { check: "found", pages: [3, 3] },
      { check: "not-found", checkReason: "too-many-pages", outcome: "page-range" },
    ]);
  });

  test("a record that names its Passage other than by its id is dropped, and its marker with it; structured output finds the Passage it meant", async () => {
    const attention = sessionOver(ATTENTION);
    await attention.shown();

    const { feedback, outcomes } = attention.cite([
      { marker: 1, passage: "1", location: "p. 8", quote: PERPLEXITY },
      {
        marker: 2,
        passage: "Weighted Keys Shorter Paths",
        location: "p. 8",
        quote: PERPLEXITY,
      },
      { marker: 3, passage: "[P1]", location: "p. 8", quote: PERPLEXITY },
    ]);

    expect(outcomes.map((outcome) => outcome?.check ?? null)).toEqual([null, null, "found"]);
    expect(feedback).toContain('there is no Passage "1" in your search results');

    // Structured output reads "1" and "P1 (p. 8)" as P1; a record naming no Passage it was given
    // (its Document, or a Passage it wasn't given) cites the one that holds its quote, if one does.
    const numbered = sessionOver(ATTENTION);
    await numbered.shown();
    const structured = numbered.cite(
      [
        { marker: 1, passage: "1", location: "p. 8", quote: PERPLEXITY },
        { marker: 2, passage: "P1 (p. 8)", location: "p. 8", quote: PERPLEXITY },
        {
          marker: 3,
          passage: "Weighted Keys Shorter Paths",
          location: "p. 8",
          quote: PERPLEXITY,
        },
        { marker: 4, passage: "7", location: "p. 8", quote: PERPLEXITY },
        {
          marker: 5,
          passage: "Weighted Keys Shorter Paths",
          quote: "Label smoothing helps a lot.",
        },
      ],
      { structured: true },
    );
    expect(structured.outcomes.map((outcome) => outcome?.check ?? null)).toEqual([
      "found",
      "found",
      "found",
      "found",
      null,
    ]);
  });
});
