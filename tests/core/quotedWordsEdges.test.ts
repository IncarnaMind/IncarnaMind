/**
 * Words an Answer puts in quotation marks (#483), at the edges: each kind of
 * quotation mark, two quotes in a sentence, a Document that wraps its lines,
 * a page that can't be checked, and two Citations in one sentence.
 */
import { describe, expect, test } from "vitest";
import { type RecheckDocuments, recheckKept } from "../../src/core/answers/citations";
import { parseQuotedWords } from "../../src/shared/citations";
import {
  askAndFinish,
  citationsIn,
  citingModel,
  onlyCitation,
  type ShownPassage,
  setUpWithDocuments,
} from "../helpers/citations";
import { scriptedModel } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

const REPORT =
  "# Site safety report\n\nSafety training: coverage reached 98% of site staff, up 6 points on 2024.\n";
const CHINESE_REPORT = "# 安全生产报告\n\n安全培训，覆盖率达到98%，较上年提高 6 个百分点。\n";
const CHANGED = "training coverage reached 98% of site staff";

/** Asks one Question about a Document, citing its `quote`; gives the Answer's Citations. */
async function ask(
  document: { name: string; contents: string },
  query: string,
  quote: string,
  answer: string,
) {
  const model = citingModel({
    query,
    records: (passages: ShownPassage[]) => [{ marker: 1, passage: passages[0]?.id, quote }],
    answer,
  });
  const { core, client, mind } = await setUpWithDocuments(model, [document]);
  const { answerId } = await askAndFinish(core, client, mind.id, "How many were trained?");
  return citationsIn(client, answerId);
}

const report = { name: "Site safety report.md", contents: REPORT };
const askReport = (answer: string) =>
  ask(report, "training coverage", "coverage reached 98% of site staff", answer);

describe("Quoted words, at the edges", { timeout: 30_000 }, () => {
  test.each([
    ["straight", `The report says "${CHANGED}" [^1].`],
    ["curly", `The report says “${CHANGED}” [^1].`],
    ["single curly", `The report says ‘${CHANGED}’ [^1].`],
    ["corner", `The report says 「${CHANGED}」 [^1].`],
    ["double corner", `The report says 『${CHANGED}』 [^1].`],
    ["angle", `The report says «${CHANGED}» [^1].`],
  ])("a changed word in %s quotation marks is not found", async (_kind, answer) => {
    const [citation] = await askReport(answer);

    expect(citation).toMatchObject({
      check: "not-found",
      checkReason: "quoted-words-not-on-pages",
    });
  });

  test.each(["报告称「培训覆盖率达到98%」[^1]。", "报告称『培训覆盖率达到98%』[^1]。"])(
    "in Chinese, %s is checked too",
    async (answer) => {
      const [citation] = await ask(
        { name: "安全生产报告.md", contents: CHINESE_REPORT },
        "覆盖率",
        "覆盖率达到98%",
        answer,
      );

      expect(citation).toMatchObject({ check: "not-found" });
    },
  );

  test("of two quotes in a sentence, one the Document has and one it hasn't, the Citation is not found", async () => {
    const [citation] = await askReport(
      "It says “coverage reached 98% of site staff” and “training reached every site” [^1].",
    );

    expect(citation).toMatchObject({
      check: "not-found",
      checkReason: "quoted-words-not-on-pages",
    });
    expect(
      parseQuotedWords(citation?.quotedWords)
        ?.answer.map((piece) => piece.text)
        .join(""),
    ).toBe("training reached every site");
  });

  test("a comma inside the closing mark is not part of the words", async () => {
    const [citation] = await askReport(
      "“Coverage reached 98% of site staff,” the report says [^1].",
    );

    expect(citation).toMatchObject({ check: "found", checkReason: null });
  });

  test("a Document's name in quotation marks, as a title, is a name and not a quote", async () => {
    const [citation] = await ask(
      { name: "Harbour safety report 2025.md", contents: REPORT },
      "training coverage",
      "coverage reached 98% of site staff",
      "The “Harbour Safety Report 2025,” says coverage reached 98% of site staff [^1].",
    );

    expect(citation).toMatchObject({ check: "found", checkReason: null });
  });

  test("two quotes the Document has leave the Citation found", async () => {
    const [citation] = await askReport(
      "It says “coverage reached 98% of site staff” and “up 6 points on 2024” [^1].",
    );

    expect(citation).toMatchObject({ check: "found", checkReason: null });
  });

  test("a quote the Document breaks across lines is found, and shown on one line when it is not", async () => {
    const wrapped = {
      name: "Wrapped report.txt",
      contents: "Safety training: coverage reached 98%\nof site staff, up 6 points on 2024.\n",
    };
    const quote = "coverage reached 98% of site staff";

    const [found] = await ask(wrapped, "training coverage", quote, `It says “${quote}” [^1].`);
    const [changed] = await ask(
      wrapped,
      "training coverage",
      quote,
      `It says “training ${quote}” [^1].`,
    );

    expect(found).toMatchObject({ check: "found" });
    expect(changed).toMatchObject({ check: "not-found" });
    expect(
      parseQuotedWords(changed?.quotedWords)
        ?.closest?.map((piece) => piece.text)
        .join(""),
    ).toBe("Safety training: coverage reached 98% of site staff, up 6 points on 2024.");
  });

  test("words in a page that can't be checked are left alone", async () => {
    const model = citingModel({
      query: "harbour floor",
      records: (passages: ShownPassage[]) => [
        {
          marker: 1,
          passage: passages[0]?.id,
          pageFrom: 2,
          pageTo: 2,
          quote: "The harbour floor is mostly sand.",
        },
      ],
      answer: "The survey says “the harbour floor is mostly gravel and weed” [^1].",
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      {
        name: "Survey.pdf",
        contents: buildPdf([
          { lines: ["Survey of the harbour", "The harbour floor is mostly sand."] },
          { image: true },
          { lines: ["The survey ended in March.", "Divers mapped the old wreck."] },
        ]),
      },
    ]);

    const { answerId } = await askAndFinish(core, client, mind.id, "What is the harbour floor?");

    expect(onlyCitation(client, answerId)).toMatchObject({
      check: "cant-check",
      checkReason: "no-text",
    });
  });

  test("with a Citation of the sentence on a page that can't be checked, the words are not called not found", async () => {
    const model = citingModel({
      query: "harbour floor survey training coverage",
      records: (passages: ShownPassage[]) => [
        {
          marker: 1,
          passage: passages.find((each) => each.document === "Site safety report")?.id,
          quote: "coverage reached 98% of site staff",
        },
        {
          marker: 2,
          passage: passages.find((each) => each.document === "Survey")?.id,
          pageFrom: 2,
          pageTo: 2,
          quote: "The harbour floor is mostly sand.",
        },
      ],
      answer: "It says “the harbour floor is mostly gravel and weed” [^1][^2].",
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      report,
      {
        name: "Survey.pdf",
        contents: buildPdf([
          { lines: ["Survey of the harbour", "The harbour floor is mostly sand."] },
          { image: true },
          { lines: ["The survey ended in March.", "Divers mapped the old wreck."] },
        ]),
      },
    ]);

    const { answerId } = await askAndFinish(core, client, mind.id, "What is the harbour floor?");

    expect(citationsIn(client, answerId).map((each) => each.check)).toEqual([
      "found",
      "cant-check",
    ]);
  });

  describe("a Citation added for a quotation written without a marker (#760)", () => {
    const writes = async (answer: string) => {
      const model = scriptedModel((call) =>
        call.results.some((result) => result.tool === "search_documents")
          ? { text: answer }
          : { calls: [{ tool: "search_documents", input: { query: "training coverage" } }] },
      );
      const { core, client, mind } = await setUpWithDocuments(model, [report]);
      const { answerId } = await askAndFinish(core, client, mind.id, "How many were trained?");
      return citationsIn(client, answerId);
    };
    const line = "Safety training: coverage reached 98% of site staff, up 6 points on 2024.";

    test("is found when the quotation is the Passage's own", async () => {
      expect((await writes(`It says "${line}" So it rose.`)).map((each) => each.check)).toEqual([
        "found",
      ]);
    });

    test("is not found when the quotation's words differ from the sentence it was matched to", async () => {
      const [citation] = await writes(
        `It says "${line.replace("Safety", "Workplace")}" So it rose.`,
      );

      expect(citation).toMatchObject({
        check: "not-found",
        checkReason: "quoted-words-not-on-pages",
      });
    });
  });

  describe("a Citation kept through Edit with AI", () => {
    const documentsWith = (text: string): RecheckDocuments => ({
      currentVersion: () => "v2",
      pageTexts: () => [{ page: 1, text, kind: "page" }],
      passagesCovering: () => [{ id: "passage", text }],
    });
    const kept = {
      documentId: "document",
      contentHash: "v1",
      pageFrom: 1,
      pageTo: 1,
      quote: "coverage reached 98% of site staff",
      check: "not-found",
      checkReason: "quoted-words-not-on-pages",
      quotedWords: {
        answer: [{ text: "training coverage reached 98% of site staff", found: false }],
        closest: null,
      },
    };

    test("stays not found while the Document's current version lacks the words, though it has the quote", () => {
      expect(
        recheckKept(documentsWith("Safety training: coverage reached 98% of site staff."), kept),
      ).toBeNull();
    });

    test("is found, with no quoted words kept, once the current version has them", () => {
      const now = recheckKept(
        documentsWith("Our training coverage reached 98% of site staff."),
        kept,
      );

      expect(now).toMatchObject({ check: "found", checkReason: null });
      expect(now).not.toHaveProperty("quotedWords");
    });

    test("once checked again in the current version, says nothing of the page its quoted words ran on to", () => {
      const now = recheckKept(
        documentsWith("Safety training: coverage reached 98% of site staff."),
        {
          ...kept,
          check: "found",
          checkReason: null,
          quotedWords: { runsOnTo: { kind: "page", from: 2, to: 2 } },
        },
      );

      expect(now).toMatchObject({ check: "found", contentHash: "v2" });
      expect(now).not.toHaveProperty("quotedWords");
    });
  });

  describe("two Citations in a sentence", () => {
    const files = [
      {
        name: "Safety report.md",
        contents: "# Safety\n\nSafety training coverage reached 98% of site staff in 2025.\n",
      },
      {
        name: "Audit report.md",
        contents: "# Audit\n\nEvery site passed its annual audit in the first quarter.\n",
      },
    ];
    const askBoth = async (words: string) => {
      const model = citingModel({
        query: "site safety training coverage audit",
        records: (passages: ShownPassage[]) => [
          {
            marker: 1,
            passage: passages.find((each) => each.document === "Safety report")?.id,
            quote: "Safety training coverage reached 98% of site staff",
          },
          {
            marker: 2,
            passage: passages.find((each) => each.document === "Audit report")?.id,
            quote: "Every site passed its annual audit",
          },
        ],
        answer: `It says “${words}” [^1][^2].`,
      });
      const { core, client, mind } = await setUpWithDocuments(model, files);
      const { answerId } = await askAndFinish(core, client, mind.id, "How were the sites?");
      return citationsIn(client, answerId);
    };

    test("words in the second's Unit leave both found, though the first has none of them", async () => {
      const citations = await askBoth("every site passed its annual audit");

      expect(citations.map((each) => each.check)).toEqual(["found", "found"]);
    });

    test("words in neither make the Citation whose Unit holds the nearest words not found", async () => {
      const [safety, audit] = await askBoth("every site passed its quarterly audit in 2025");

      expect(safety).toMatchObject({ documentName: "Safety report", check: "found" });
      expect(audit).toMatchObject({
        documentName: "Audit report",
        check: "not-found",
        checkReason: "quoted-words-not-on-pages",
      });
    });
  });
});
