/**
 * An area of a page the User picked (#118): its picture goes with the Question to a model that
 * reads images, its region stays its Citation's, and a model that reads text alone is sent none.
 */
import { describe, expect, test } from "vitest";
import type { AskedQuote, Core } from "../../src/core";
import { answerEnded, setUpWithDocuments } from "../helpers/citations";
import { PNG } from "../helpers/citedPages";
import { promptOf, scriptedModel } from "../helpers/models";
import { xlsxOf } from "../helpers/office";
import { buildPdf } from "../helpers/pdf";

const PAPER = buildPdf([
  { lines: ["Grocers studied across the eleven chains."] },
  { lines: ["Pooling the cuts, the recovery peaks in the second quarter."] },
]);
const REVENUE = xlsxOf([
  {
    name: "Revenue",
    rows: [
      ["Revenue by segment"],
      ["£m, unaudited"],
      [],
      ["", "Q1", "Q2", "Q3", "9 months"],
      ["2025"],
      [],
      ["Stores", 1412, 1438, 1446, 4296],
      ["Online", 318, 326, 341, 985],
      ["Wholesale", 96, 98, 101, 295],
      [],
      ["2026"],
      ["Stores", 1431, 1452, 1470, 4353],
      ["Online", 352, 361, 329, 1042],
      ["Wholesale", 99, 97, 92, 288],
    ],
  },
]);

const PICTURE = {
  src: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`,
  width: 1,
  height: 1,
};

async function areaQuote(core: Core, documentId: string, name: string): Promise<AskedQuote> {
  const area = { x: 0.4, y: 0.4, width: 0.2, height: 0.2 };
  const cited = await core.citeSelection({ documentId, parts: [], area, unit: 1 });
  expect(cited.checkReason).toBe("picture");
  return {
    documentId,
    documentName: name,
    quote: cited.quote,
    pageFrom: cited.pageFrom,
    pageTo: cited.pageTo,
    location: cited.location,
    pick: "area",
    picture: PICTURE,
    check: cited.check,
    checkReason: cited.checkReason,
  };
}

/** The files a request sends, from its last user message. */
function filesSent(model: ReturnType<typeof scriptedModel>, call = 0) {
  const message = model.doStreamCalls[call]?.prompt.filter((each) => each.role === "user").at(-1);
  if (!message || typeof message.content === "string") return [];
  return message.content.flatMap((part) => (part.type === "file" ? [part] : []));
}

async function askArea(setUp: Awaited<ReturnType<typeof setUpWithDocuments>>, quote: AskedQuote) {
  const { core, mind } = setUp;
  const result = await core.askInConversation({
    text: "What does this figure show?",
    mindId: mind.id,
    quotes: [quote],
  });
  if (!result.asked) throw new Error("The Question wasn't asked.");
  await answerEnded(core, result.answerId);
  return result;
}

describe("An area asked about in a Document's viewer", { timeout: 30_000 }, () => {
  test("sends its picture to a model that reads images, and says the picture is attached", async () => {
    const setUp = await setUpWithDocuments(
      scriptedModel(() => ({ text: "A figure." })),
      [{ name: "Rate cuts.pdf", contents: PAPER }],
    );
    const paper = setUp.documents[0];
    if (!paper) throw new Error("The paper wasn't added.");
    await setUp.core.saveChatProvider({
      kind: "openai",
      apiKey: "sk-proj-a-made-up-key",
      modelId: "gpt-4.1",
    });
    const quote = await areaQuote(setUp.core, paper.id, paper.name);
    const asked = await askArea(setUp, quote);

    const files = filesSent(setUp.models.model);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ mediaType: "image/png" });
    const prompt = promptOf(setUp.models.model)
      .map((message) => message.text)
      .join("\n");
    expect(prompt).toContain("The picture at this place is attached to this message.");
    expect(prompt).toContain('location="p. 1"');

    const { messages } = await setUp.core.getConversation(asked.conversation.id);
    const question = messages.find(
      (message) => message.kind === "question" && message.id === asked.questionId,
    );
    expect(question).toMatchObject({
      quotes: [
        {
          pick: "area",
          quote: "",
          picture: { width: 1, height: 1 },
          check: "cant-check",
          checkReason: "picture",
        },
      ],
    });
  });

  test("sends no picture to a model that reads text alone", async () => {
    const setUp = await setUpWithDocuments(
      scriptedModel(() => ({ text: "A figure." })),
      [{ name: "Rate cuts.pdf", contents: PAPER }],
    );
    const paper = setUp.documents[0];
    if (!paper) throw new Error("The paper wasn't added.");
    await setUp.core.saveChatProvider({
      kind: "openai",
      apiKey: "sk-proj-a-made-up-key",
      modelId: "gpt-4",
    });
    const quote = await areaQuote(setUp.core, paper.id, paper.name);
    await askArea(setUp, quote);
    expect(filesSent(setUp.models.model)).toEqual([]);
  });

  test("cites a sheet range to its rows and keeps its cells with the Question", async () => {
    const setUp = await setUpWithDocuments(
      scriptedModel(() => ({ text: "Stores grew." })),
      [{ name: "Revenue.xlsx", contents: REVENUE }],
    );
    const book = setUp.documents[0];
    if (!book) throw new Error("The workbook wasn't added.");
    const parts = [
      {
        unit: 1,
        text: "Stores\t1431\t1452\t1470\t4353\nOnline\t352\t361\t329\t1042\nWholesale\t99\t97\t92\t288",
      },
    ];
    const cited = await setUp.core.citeSelection({ documentId: book.id, parts });
    expect(cited.check).toBe("found");
    const quote: AskedQuote = {
      documentId: book.id,
      documentName: book.name,
      quote: cited.quote,
      pageFrom: cited.pageFrom,
      pageTo: cited.pageTo,
      location: cited.location,
      pick: "rows",
      table: { header: ["Q1", "Q2", "Q3", "9 months"], rows: [["1431", "1452", "1470", "4353"]] },
      check: cited.check,
      checkReason: cited.checkReason,
    };
    const asked = await askArea(setUp, quote);
    const prompt = promptOf(setUp.models.model)
      .map((message) => message.text)
      .join("\n");
    expect(prompt).toContain("Q1\tQ2\tQ3\t9 months");
    const { messages } = await setUp.core.getConversation(asked.conversation.id);
    const question = messages.find(
      (message) => message.kind === "question" && message.id === asked.questionId,
    );
    expect(question).toMatchObject({
      quotes: [
        {
          pick: "rows",
          table: {
            header: ["Q1", "Q2", "Q3", "9 months"],
            rows: [["1431", "1452", "1470", "4353"]],
          },
        },
      ],
    });
  });
});
