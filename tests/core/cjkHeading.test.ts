import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type Core, DATABASE_FILE } from "../../src/core";
import { documentBlocks } from "../../src/core/answers/checks/verifyTables";
import { extractText, pdfTablePages } from "../../src/core/documents/extract";
import { PROCESSING_VERSION } from "../../src/core/documents/processing";
import { openDatabase } from "../../src/core/storage";
import { citationState } from "../../src/shared/citations";
import { answerEnded, citingModel } from "../helpers/citations";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { scriptedModels } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

const HEADING = "北桥社区信托志愿者手册";
const SENTENCE = "志愿者每次值班前都要在前台签到。";
const WRAPPED_FIRST = "志愿者每次值班前都要在前台签到，并由";
const WRAPPED_SECOND = "值班组长复核当天的记录。";

const ENGLISH_HEADING = "Volunteer Handbook";
const ENGLISH_SENTENCE = "Volunteers sign in at the front desk before every shift.";

const storedPages = async (core: Core, documentId: string) =>
  (await core.readDocumentText(documentId)).pages.map((page) => page.text);

const storedPassages = (dataDir: string, documentId: string) =>
  queryDatabase<{ text: string }>(
    dataDir,
    `SELECT text FROM passages WHERE document_id = ? AND deleted_at IS NULL ORDER BY position`,
    [documentId],
  ).map((passage) => passage.text);

describe("A Chinese page's heading", { timeout: 30_000 }, () => {
  test("stays apart from the sentence under it, and a wrapped sentence still joins", async () => {
    const dataDir = await createTempDataFolder();
    const sources = await createSourceFolder();
    const core = startCore(dataDir);
    const [document] = await addAndProcess(core, [
      await writeSourceFile(
        sources,
        "志愿者手册.pdf",
        buildPdf([
          { chineseLines: [HEADING, SENTENCE] },
          { chineseLines: [WRAPPED_FIRST, WRAPPED_SECOND] },
        ]),
      ),
    ]);
    if (!document) throw new Error("The Document wasn't added.");

    expect(await storedPages(core, document.id)).toEqual([
      `${HEADING}\n${SENTENCE}`,
      `${WRAPPED_FIRST}${WRAPPED_SECOND}`,
    ]);
    expect((await storedPages(core, document.id)).join("\n")).not.toContain(
      `${HEADING}${SENTENCE}`,
    );
    expect(storedPassages(dataDir, document.id).join("\n")).toContain(`${HEADING}\n${SENTENCE}`);

    expect(
      await core.recheckCitation({
        mindId: null,
        documentId: document.id,
        pageFrom: 1,
        pageTo: 1,
        quote: SENTENCE,
      }),
    ).toMatchObject({ check: "found" });
    expect(
      await core.recheckCitation({
        mindId: null,
        documentId: document.id,
        pageFrom: 2,
        pageTo: 2,
        quote: `${WRAPPED_FIRST}${WRAPPED_SECOND}`,
      }),
    ).toMatchObject({ check: "found" });
    await core.close();
  });

  test("English lines are read as they were, a heading above its sentence", async () => {
    const dataDir = await createTempDataFolder();
    const sources = await createSourceFolder();
    const core = startCore(dataDir);
    const [document] = await addAndProcess(core, [
      await writeSourceFile(
        sources,
        "Volunteer Handbook.pdf",
        buildPdf([{ lines: [ENGLISH_HEADING, ENGLISH_SENTENCE] }]),
      ),
    ]);
    if (!document) throw new Error("The Document wasn't added.");

    expect(await storedPages(core, document.id)).toEqual([
      `${ENGLISH_HEADING}\n${ENGLISH_SENTENCE}`,
    ]);
    expect(
      await core.recheckCitation({
        mindId: null,
        documentId: document.id,
        pageFrom: 1,
        pageTo: 1,
        quote: ENGLISH_SENTENCE,
      }),
    ).toMatchObject({ check: "found" });
    await core.close();
  });

  test("a Document read before this version is read again, its heading kept apart", async () => {
    const dataDir = await createTempDataFolder();
    const sources = await createSourceFolder();
    const path = await writeSourceFile(
      sources,
      "志愿者手册.pdf",
      buildPdf([{ chineseLines: [HEADING, SENTENCE] }]),
    );
    const first = startCore(dataDir);
    const [document] = await addAndProcess(first, [path]);
    if (!document) throw new Error("The Document wasn't added.");
    await first.close();

    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.transaction(() => {
        db.run("UPDATE documents SET processing_version = ? WHERE id = ?", [
          // Version 16 joined a heading's line onto the text under it (#2219).
          16n,
          document.id,
        ]);
        db.run(
          `UPDATE document_pages SET text = ?
           WHERE document_id = ? AND deleted_at IS NULL`,
          [`${HEADING}${SENTENCE}`, document.id],
        );
        db.run("UPDATE passages SET text = ? WHERE document_id = ?", [
          `${HEADING}${SENTENCE}`,
          document.id,
        ]);
      });
    } finally {
      db.close();
    }

    const second = startCore(dataDir);
    await waitForProcessing(second, [document.id]);
    expect(await storedPages(second, document.id)).toEqual([`${HEADING}\n${SENTENCE}`]);
    expect(storedPassages(dataDir, document.id).join("\n")).toContain(`${HEADING}\n${SENTENCE}`);
    expect(
      queryDatabase<{ processing_version: number }>(
        dataDir,
        "SELECT processing_version FROM documents WHERE id = ?",
        [document.id],
      ),
    ).toEqual([{ processing_version: PROCESSING_VERSION }]);
    await second.close();
  });

  test("a tilted heading keeps its break by its size alone", async () => {
    const dataDir = await createTempDataFolder();
    const sources = await createSourceFolder();
    const core = startCore(dataDir);
    const [document] = await addAndProcess(core, [
      await writeSourceFile(
        sources,
        "志愿者手册.pdf",
        buildPdf([
          {
            tilt: 10,
            printed: [
              { text: "志愿者手册", size: 20 },
              { text: "志愿者每次值班前都要在前台签到。", size: 11 },
            ],
          },
        ]),
      ),
    ]);
    if (!document) throw new Error("The Document wasn't added.");
    expect(await storedPages(core, document.id)).toEqual([
      `志愿者手册\n志愿者每次值班前都要在前台签到。`,
    ]);
    await core.close();
  });

  test("a line printed twice keeps a break only where the page ended it", async () => {
    const dataDir = await createTempDataFolder();
    const sources = await createSourceFolder();
    const core = startCore(dataDir);
    const [document] = await addAndProcess(core, [
      await writeSourceFile(
        sources,
        "单位说明.pdf",
        buildPdf([
          {
            printed: [
              { text: "7", size: 20 },
              { text: "月是单位。", size: 11 },
              { text: "本季度收入较上年增长，自7", size: 11 },
              { text: "月起收入增长。", size: 11 },
            ],
          },
        ]),
      ),
    ]);
    if (!document) throw new Error("The Document wasn't added.");
    expect(await storedPages(core, document.id)).toEqual([
      "7\n月是单位。\n本季度收入较上年增长，自7月起收入增长。",
    ]);
    await core.close();
  });

  test("the old corpus's titles, bylines and headings are blocks of their own (#3288)", async () => {
    const dir = join(__dirname, "../fixtures/organize/files");
    const files = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith(".pdf")).sort();
    const paths: string[] = [];
    const names: string[] = [];
    for (const name of files) {
      const path = join(dir, name);
      const { units } = await extractText("pdf", new Uint8Array(await readFile(path)));
      if (!units.some((unit) => /\p{Script=Han}/u.test(unit.text))) continue;
      paths.push(path);
      names.push(name);
    }
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const documents = await addAndProcess(core, paths);
    const kinds: Record<string, string[]> = {};
    const texts: Record<string, string[]> = {};
    for (const [index, document] of documents.entries()) {
      const name = names[index] as string;
      const { pages } = await core.readDocumentText(document.id);
      const tables = await pdfTablePages(
        new Uint8Array(await readFile(paths[index] as string)),
      ).catch(() => new Map());
      const scanned = await core.readScannedText(document.id);
      const blocks = documentBlocks(pages, tables, scanned.pages);
      kinds[name] = blocks.map((block) => block.node.type);
      texts[name] = blocks.map((block) => String(block.node.content?.[0]?.text ?? ""));
    }
    // Each title, byline and heading with no full stop is a block of its own, where the blocks
    // before #3288 ran it into the text under it: 9, 8, 13, 6, 14, 11 and 20 blocks then.
    const P = "paragraph";
    const H = "heading";
    const T = "table";
    expect(kinds).toEqual({
      "2025年度财务报表.pdf": [P, P, P, T, P, T, P, T, H, P],
      "2026年第一季度销售报告.pdf": [P, P, H, P, H, T, H, P, H, P, P, H, P],
      "TR2026-03.pdf": [P, P, P, P, P, P, P, P, P, P, P, P, P, T, P, P, P, P],
      "dzfp_044031900111_20260312.pdf": [P, P, P, P, T, P, P],
      "租赁合同-2026.pdf": Array.from({ length: 23 }, () => P),
      "第三章.pdf": [P, P, P, P, P, P, P, P, P, P, P, P, P, P, T, P, P, P],
      "说明书.pdf": [P, P, H, P, P, P, P, P, H, T, H, P, P, P, P, P, H, P, H, P, H, T, H, P],
    });
    expect(texts["租赁合同-2026.pdf"]?.slice(0, 6)).toEqual([
      "房屋租赁合同",
      "出租方（甲方）：周敏 身份证号：示例（略）",
      "承租方（乙方）：刘思远 联系电话：555-0142",
      "根据《中华人民共和国民法典》及有关规定，甲乙双方在平等、自愿的基础上，就房屋租赁事宜达成如下协议：",
      "第一条 房屋基本情况",
      "甲方将位于示例市示例区示例路 88 号 3 栋 502 室的房屋出租给乙方居住使用，建筑面积 76 平方米，附带家具家电清单见附件一。",
    ]);
    expect(texts["2026年第一季度销售报告.pdf"]?.slice(0, 3)).toEqual([
      "青禾家居 2026 年第一季度销售报告",
      "编制部门：经营分析部 报送：公司管理层 日期：2026 年 4 月 10 日",
      "一、总体情况",
    ]);
    expect(texts["第三章.pdf"]).toContain("3.1 引言");
    expect(texts["说明书.pdf"]).toContain("四、滤网更换");
  });

  // protects=a Citation quoting a heading run into its sentence, as text from before the heading rules stored it, is still found after the version step reads the Document again (#2219, #3288); fails_when=re-reading a Document whose page gains a heading's break orphans or fails a Citation made from the old text
  test.each([
    // Version 16 joined a heading's line onto the text under it (#2219).
    16n,
    // Version 31 joined a heading the size of the line above it, and shorter, onto it (#3288).
    31n,
  ])(
    "a Citation of the old fused block still stands after a Document read at version %i is read again",
    async (version) => {
      const dataDir = await createTempDataFolder();
      const sources = await createSourceFolder();
      const path = await writeSourceFile(
        sources,
        "志愿者手册.pdf",
        buildPdf([{ chineseLines: [HEADING, SENTENCE] }]),
      );
      const first = startCore(dataDir);
      const [document] = await addAndProcess(first, [path]);
      if (!document) throw new Error("The Document wasn't added.");
      await first.close();
      // The text main's pipeline stored for the page: the heading run into its sentence, which
      // the Citation quotes.
      const FUSED = `${HEADING}${SENTENCE}`;
      const db = openDatabase(join(dataDir, DATABASE_FILE));
      try {
        db.run("UPDATE document_pages SET text = ? WHERE document_id = ? AND deleted_at IS NULL", [
          FUSED,
          document.id,
        ]);
        db.run("UPDATE passages SET text = ? WHERE document_id = ? AND deleted_at IS NULL", [
          FUSED,
          document.id,
        ]);
      } finally {
        db.close();
      }
      const model = citingModel({
        query: "志愿者签到",
        records: (passages) => [{ marker: 1, passage: passages[0]?.id, quote: FUSED }],
        answer: "志愿者每次值班前都要在前台签到 [^1]。",
      });
      const models = scriptedModels(model);
      const asking = startCore(dataDir, { createChatModel: models.createChatModel });
      await asking.saveChatProvider({ kind: "ollama", modelId: "local-model" });
      const asked = await asking.askInConversation({ text: "志愿者值班前要做什么？" });
      if (!asked.asked) throw new Error("Question not asked");
      const ended = await answerEnded(asking, asked.answerId);
      if (ended.event !== "finished") throw new Error("The Answer failed");
      const [citation] = ended.payload.citations;
      if (!citation) throw new Error("The Answer made no Citation.");
      expect(citation).toMatchObject({ check: "found", quote: FUSED, pageFrom: 1, pageTo: 1 });
      await asking.close();

      // The version step re-reads it: the stored text gains the heading's break, so the block
      // the Citation quotes is no longer stored as it was.
      const seeded = openDatabase(join(dataDir, DATABASE_FILE));
      try {
        seeded.run("UPDATE documents SET processing_version = ? WHERE id = ?", [
          version,
          document.id,
        ]);
      } finally {
        seeded.close();
      }
      const second = startCore(dataDir);
      await waitForProcessing(second, [document.id]);
      expect(await storedPages(second, document.id)).toEqual([`${HEADING}\n${SENTENCE}`]);

      // Of the two outcomes there may be, it is the first: found where it was, the Document and
      // its verdict kept. Not a third — nothing orphaned, or pointing at text that is gone.
      expect(
        await second.recheckCitation({
          mindId: null,
          documentId: document.id,
          pageFrom: 1,
          pageTo: 1,
          quote: FUSED,
        }),
      ).toMatchObject({ check: "found" });
      expect(citationState(citation, await second.listDocuments())).toMatchObject({
        check: "found",
        documentId: document.id,
        changedAfterCited: false,
      });
      await second.close();
    },
  );
});
