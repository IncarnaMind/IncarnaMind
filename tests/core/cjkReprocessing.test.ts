import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import { keywordText } from "../../src/core/documents/keywords";
import { PROCESSING_VERSION } from "../../src/core/documents/processing";
import { openDatabase } from "../../src/core/storage";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  unfoldedKeywords,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { createControlledEmbedder, turnOnEmbeddings } from "../helpers/embedding";
import { buildPdf } from "../helpers/pdf";

const CHINESE_LINES = [
  "线上销售增长 0.8%，增速低于上半年。线上毛利率由上年同期的 37.5% 降至 32.1%：配送成本上升，7",
  "月起免运费门槛又下调至 40 英镑。利兹新配送中心将于 2027 年第一季度投入使用。",
];
const ENGLISH_LINES = [
  "Online gross margin fell to 32.1% from 37.5% a year",
  "earlier: delivery costs rose, and the free-delivery threshold was cut to £40 in July.",
];
const KOREAN_LINES = [
  "배송비는 증가했습니다. 7",
  "월부터 물류비가 감소했습니다.",
  "가나다",
  "라마바.",
];

interface Seed {
  id: string;
  name: string;
}

function asEarlierPipeline(
  dataDir: string,
  chinese: Seed,
  english: Seed,
  ordinary: Seed,
  korean: Seed,
): void {
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    db.transaction(() => {
      for (const { id, name } of [chinese, english, ordinary, korean]) {
        db.run("UPDATE documents SET processing_version = 14 WHERE id = ?", [id]);
        if (name !== ordinary.name) continue;
        db.run("UPDATE passages SET text = 'Superseded wording' WHERE document_id = ?", [id]);
      }
      const passages = db.all<{ seq: number; text: string }>(
        "SELECT seq, text FROM passages WHERE document_id = ? AND deleted_at IS NULL",
        [chinese.id],
      );
      for (const { seq, text } of passages) {
        const earlier = text.replace("7月起", "7\n月起");
        db.run("UPDATE passages SET text = ? WHERE seq = ?", [earlier, BigInt(seq)]);
        db.run("DELETE FROM passages_fts WHERE rowid = ?", [BigInt(seq)]);
        db.run("INSERT INTO passages_fts (rowid, text) VALUES (?, ?)", [
          BigInt(seq),
          `${unfoldedKeywords(chinese.name)} ${unfoldedKeywords(earlier)}`,
        ]);
      }
      db.run(
        "UPDATE passages SET text = replace(text, '7 월부터', '7\n월부터') WHERE document_id = ?",
        [korean.id],
      );
      db.run(
        "UPDATE passages SET text = replace(text, '가나다 라마바', '가나다라마바') WHERE document_id = ?",
        [korean.id],
      );
      db.run(
        "UPDATE passages_fts SET text = 'stale-index' WHERE rowid IN (SELECT seq FROM passages WHERE document_id = ?)",
        [chinese.id],
      );
    });
  } finally {
    db.close();
  }
}

describe("CJK line-wrap re-reading", { timeout: 30_000 }, () => {
  test("wrap-only updates keep Passage ids, embeddings and old Citations, with their index refreshed", async () => {
    const dataDir = await createTempDataFolder();
    const sources = await createSourceFolder();
    const embedder = createControlledEmbedder();
    const first = startCore(dataDir, { embedder });
    await turnOnEmbeddings(first);
    const paths = [
      await writeSourceFile(
        sources,
        "Chinese announcement.pdf",
        buildPdf([{ printed: CHINESE_LINES.map((text) => ({ text, size: 4 })) }]),
      ),
      await writeSourceFile(
        sources,
        "English announcement.pdf",
        buildPdf([{ lines: ENGLISH_LINES }]),
      ),
      await writeSourceFile(
        sources,
        "Ordinary announcement.pdf",
        buildPdf([{ lines: ENGLISH_LINES }]),
      ),
      await writeSourceFile(
        sources,
        "Korean announcement.pdf",
        buildPdf([{ chineseLines: KOREAN_LINES }]),
      ),
    ];
    const [chinese, english, ordinary, korean] = await addAndProcess(first, paths);
    if (!chinese || !english || !ordinary || !korean)
      throw new Error("The mixed Library was not added.");
    const initialCalls = embedder.texts.length;
    const chineseSeq = queryDatabase<{ seq: number }>(
      dataDir,
      "SELECT seq FROM passages WHERE document_id = ? AND deleted_at IS NULL",
      [chinese.id],
    )[0]?.seq;
    asEarlierPipeline(dataDir, chinese, english, ordinary, korean);
    await first.close();

    const core = startCore(dataDir, { embedder });
    await waitForProcessing(core, [chinese.id, english.id, ordinary.id, korean.id]);

    const chineseRows = queryDatabase<{ seq: number; text: string; embedding: Uint8Array | null }>(
      dataDir,
      "SELECT seq, text, embedding FROM passages WHERE document_id = ? AND deleted_at IS NULL",
      [chinese.id],
    );
    expect(chineseRows).toHaveLength(1);
    expect(chineseRows[0]?.seq).toBe(chineseSeq);
    expect(chineseRows[0]?.text).toContain("7月起免运费");
    expect(chineseRows[0]?.embedding).not.toBeNull();
    const englishRows = queryDatabase<{ seq: number; text: string; embedding: Uint8Array | null }>(
      dataDir,
      "SELECT seq, text, embedding FROM passages WHERE document_id = ? AND deleted_at IS NULL",
      [english.id],
    );
    expect(englishRows).toHaveLength(1);
    expect(englishRows[0]?.text).toContain("a year\nearlier");
    expect(englishRows[0]?.embedding).not.toBeNull();
    const ordinaryRows = queryDatabase<{ seq: number; text: string }>(
      dataDir,
      "SELECT seq, text FROM passages WHERE document_id = ? AND deleted_at IS NULL",
      [ordinary.id],
    );
    expect(ordinaryRows).toHaveLength(1);
    expect(ordinaryRows[0]?.text).not.toBe("Superseded wording");
    expect(ordinaryRows[0]?.seq).not.toBe(chineseRows[0]?.seq);
    const koreanRows = queryDatabase<{ text: string; embedding: Uint8Array | null }>(
      dataDir,
      "SELECT text, embedding FROM passages WHERE document_id = ? AND deleted_at IS NULL",
      [korean.id],
    );
    expect(koreanRows).toHaveLength(1);
    expect(koreanRows[0]?.text).toContain("7 월부터");
    expect(koreanRows[0]?.text).toContain("가나다라마바");
    expect(koreanRows[0]?.embedding).not.toBeNull();
    expect(embedder.texts.length).toBeGreaterThan(initialCalls);
    expect(embedder.texts.length - initialCalls).toBe(1);

    const found = await core.searchPassages("7 月起免运费", { mode: "keyword" });
    expect(found.map((result) => result.documentId)).toContain(chinese.id);
    expect(
      await core.recheckCitation({
        documentId: chinese.id,
        pageFrom: 1,
        pageTo: 1,
        quote: "配送成本上升，7",
      }),
    ).toMatchObject({ check: "found" });
    expect(
      await core.recheckCitation({
        documentId: korean.id,
        pageFrom: 1,
        pageTo: 1,
        quote: "배송비는 증가했습니다. 7\n월부터",
      }),
    ).toMatchObject({ check: "found" });
    expect(
      await core.recheckCitation({
        documentId: korean.id,
        pageFrom: 1,
        pageTo: 1,
        quote: "가나다라마바",
      }),
    ).toMatchObject({ check: "found" });
    expect(
      queryDatabase<{ processing_version: number }>(
        dataDir,
        "SELECT DISTINCT processing_version FROM documents",
      ).map((row) => row.processing_version),
    ).toEqual([PROCESSING_VERSION]);
    console.info(
      JSON.stringify({
        wrapOnlyUpdated: chineseRows.length + koreanRows.length,
        unchanged: englishRows.length,
        ordinarilyReplaced: ordinaryRows.length,
        additionalEmbeddings: embedder.texts.length - initialCalls,
      }),
    );
    await core.close();
  });

  test("reindexes each Passage by position after a wrap-only update", async () => {
    const dataDir = await createTempDataFolder();
    const sources = await createSourceFolder();
    const first = startCore(dataDir);
    const path = await writeSourceFile(
      sources,
      "Two pages.pdf",
      buildPdf([
        {
          printed: Array.from({ length: 8 }, (_, index) => ({
            text: `${index === 0 ? "甲页专有词" : ""}第${index + 1}段${CHINESE_LINES.join("")}`,
            size: 4,
          })),
        },
        { printed: [{ text: "乙页独有词，保持原文。", size: 4 }] },
      ]),
    );
    const [document] = await addAndProcess(first, [path]);
    if (!document) throw new Error("The two-page Document was not added.");
    const seeded = queryDatabase<{ seq: number; position: number }>(
      dataDir,
      "SELECT seq, position FROM passages WHERE document_id = ? AND deleted_at IS NULL ORDER BY position",
      [document.id],
    );
    expect(seeded.length).toBeGreaterThan(1);
    const firstPassage = seeded[0];
    if (!firstPassage) throw new Error("The first Passage is missing.");
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.transaction(() => {
        db.run("UPDATE documents SET processing_version = 15 WHERE id = ?", [document.id]);
        db.run("UPDATE passages SET text = replace(text, '7月起', '7\n月起') WHERE seq = ?", [
          BigInt(firstPassage.seq),
        ]);
      });
    } finally {
      db.close();
    }
    await first.close();

    const core = startCore(dataDir);
    await waitForProcessing(core, [document.id]);

    const passages = queryDatabase<{ seq: number; position: number }>(
      dataDir,
      "SELECT seq, position FROM passages WHERE document_id = ? AND deleted_at IS NULL ORDER BY position",
      [document.id],
    );
    expect(passages.map(({ seq }) => seq)).toEqual(seeded.map(({ seq }) => seq));
    const matches = (text: string) =>
      queryDatabase<{ rowid: number }>(
        dataDir,
        "SELECT rowid FROM passages_fts WHERE passages_fts MATCH ? ORDER BY rowid",
        [keywordText(text)],
      ).map(({ rowid }) => rowid);
    const lastPassage = seeded.at(-1);
    if (!lastPassage) throw new Error("The last Passage is missing.");
    expect(matches("甲页专有词")).toEqual([firstPassage.seq]);
    expect(matches("乙页独有词")).toEqual([lastPassage.seq]);
    await core.close();
  });
});
