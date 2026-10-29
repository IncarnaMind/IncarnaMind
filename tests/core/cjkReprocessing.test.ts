import { rename } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { DATABASE_FILE, type Document } from "../../src/core";
import { keywordText } from "../../src/core/documents/keywords";
import { joinCjkLineWraps } from "../../src/core/documents/lineWrap";
import { buildPassages } from "../../src/core/documents/passages";
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
  "가나다라마",
  "바사아자차",
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
        "UPDATE document_pages SET text = replace(text, ?, ?) WHERE document_id = ? AND deleted_at IS NULL",
        ["7月起", "7\n月起", chinese.id],
      );
      db.run(
        "UPDATE passages SET text = replace(text, '7 월부터', '7\n월부터') WHERE document_id = ?",
        [korean.id],
      );
      db.run(
        "UPDATE document_pages SET text = replace(text, ?, ?) WHERE document_id = ? AND deleted_at IS NULL",
        ["7 월부터", "7\n월부터", korean.id],
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
    // The old pipeline joined a Hangul-Hangul line and the new one does too: a quote across it stays.
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

  test("a v14 PDF whose cuts move gets each kept Passage its own words", async () => {
    const dataDir = await createTempDataFolder();
    const sources = await createSourceFolder();
    const lines = Array.from(
      { length: 360 },
      (_, index) => `月编码X${String(index + 1).padStart(3, "0")}值7`,
    );
    const pages = Array.from({ length: 8 }, (_, page) => lines.slice(page * 45, (page + 1) * 45));
    const first = startCore(dataDir);
    const [document] = await addAndProcess(first, [
      await writeSourceFile(
        sources,
        "codes.pdf",
        buildPdf(pages.map((chineseLines) => ({ chineseLines }))),
      ),
    ]);
    if (!document) throw new Error("The Document wasn't added.");
    await first.close();

    let earlierTexts: string[] = [];
    let earlierIds: string[] = [];
    let exposed: string | null = null;
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      const stored = db.all<{ page: number; text: string }>(
        `SELECT page, text FROM document_pages
         WHERE document_id = ? AND deleted_at IS NULL ORDER BY page`,
        [document.id],
      );
      if (stored.length === 0) throw new Error("The pages weren't stored.");
      // Every line ends in a digit and the next starts with a Han character, so the wider
      // join removes each of these breaks and the rebuilt Passages cut where the old ones did not.
      const earlierPages = stored.map((page) => ({
        page: page.page,
        text: page.text.replaceAll("值7月", "值7\n月"),
      }));
      const earlier = buildPassages(earlierPages);
      const rebuilt = buildPassages(stored);
      if (earlier.length < 3) throw new Error("The fixture has too few Passages.");
      // A code the rebuilt Passage at one position holds and the kept Passage at that position
      // doesn't: the map would put it on the kept one's row, whose text never holds it.
      exposed =
        rebuilt
          .flatMap((passage, index) => {
            const kept = earlier[index]?.text ?? "";
            if (kept === passage.text) return [];
            const code = (passage.text.match(/X\d{3}/g) ?? []).find((each) => !kept.includes(each));
            return code ? [code] : [];
          })
          .at(0) ?? null;
      if (!exposed) throw new Error("No code tells the two cuts apart.");
      const seededAt = "2026-01-01T00:00:00.000Z";
      earlierTexts = earlier.map((passage) => passage.text);
      earlierIds = earlier.map((_, index) => `old-passage-${index}`);
      db.transaction(() => {
        db.run("UPDATE documents SET processing_version = 14 WHERE id = ?", [document.id]);
        for (const page of earlierPages) {
          db.run(
            "UPDATE document_pages SET text = ? WHERE document_id = ? AND page = ? AND deleted_at IS NULL",
            [page.text, document.id, BigInt(page.page)],
          );
        }
        db.run("UPDATE passages SET deleted_at = ? WHERE document_id = ? AND deleted_at IS NULL", [
          seededAt,
          document.id,
        ]);
        earlier.forEach((passage, index) => {
          const row = db.get<{ seq: number }>(
            `INSERT INTO passages (id, document_id, position, page_from, page_to, window_from,
               window_to, text, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
            [
              earlierIds[index] as string,
              document.id,
              BigInt(passage.position),
              passage.pageFrom === null ? null : BigInt(passage.pageFrom),
              passage.pageTo === null ? null : BigInt(passage.pageTo),
              BigInt(passage.windowFrom),
              BigInt(passage.windowTo),
              passage.text,
              seededAt,
              seededAt,
            ],
          );
          if (!row) throw new Error("An old Passage wasn't stored.");
          db.run("INSERT INTO passages_fts (rowid, text) VALUES (?, ?)", [
            BigInt(row.seq),
            keywordText(passage.text),
          ]);
        });
      });
    } finally {
      db.close();
    }
    if (!exposed) throw new Error("The old state wasn't seeded.");

    const core = startCore(dataDir);
    await waitForProcessing(core, [document.id]);
    const rows = queryDatabase<{ id: string; text: string }>(
      dataDir,
      "SELECT id, text FROM passages WHERE document_id = ? AND deleted_at IS NULL ORDER BY position",
      [document.id],
    );
    expect(rows.map((row) => row.id)).toEqual(earlierIds);
    rows.forEach((row, index) => {
      expect(row.text).toBe(joinCjkLineWraps(earlierTexts[index] as string));
    });
    expect(
      queryDatabase(dataDir, "SELECT processing_version FROM documents WHERE id = ?", [
        document.id,
      ]),
    ).toEqual([{ processing_version: PROCESSING_VERSION }]);
    const found = await core.searchPassages(exposed, { mode: "keyword" });
    expect(found.length).toBeGreaterThan(0);
    for (const row of found) expect(row.text).toContain(exposed);
    await core.close();
  });

  test("a PDF last read before version 15 and missing at start is read and joined when it comes back", async () => {
    const dataDir = await createTempDataFolder();
    const sources = await createSourceFolder();
    const path = await writeSourceFile(
      sources,
      "Away.pdf",
      buildPdf([{ chineseLines: ["配送成本上升，7", "月起免运费门槛下调。"] }]),
    );
    const first = startCore(dataDir);
    const [document] = (await addAndProcess(first, [path])) as [Document];
    first.close();
    // Back to what a pipeline before the keyword index left: version 14, its rows to rewrite,
    // and the break kept.
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.transaction(() => {
        db.run("UPDATE documents SET processing_version = 14, keywords_version = 0 WHERE id = ?", [
          document.id,
        ]);
        db.run(
          "UPDATE document_pages SET text = replace(text, ?, ?) WHERE document_id = ? AND deleted_at IS NULL",
          ["7月起", "7\n月起", document.id],
        );
        for (const { seq, text } of db.all<{ seq: number; text: string }>(
          "SELECT seq, text FROM passages WHERE document_id = ? AND deleted_at IS NULL",
          [document.id],
        )) {
          db.run("UPDATE passages SET text = ? WHERE seq = ?", [
            text.replace("7月起", "7\n月起"),
            BigInt(seq),
          ]);
        }
      });
    } finally {
      db.close();
    }
    // The file is away when the app starts, so this start can't read it again.
    await rename(path, `${path}.away`);
    const second = startCore(dataDir);
    await waitForProcessing(second, [document.id]);
    // The read that failed rebuilt the rows it kept: the Passages are still 14's, the rows
    // this version's. Hand the rewrite rows an older version wrote, to see what it does.
    const older = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      older.run("UPDATE documents SET keywords_version = 0 WHERE id = ?", [document.id]);
    } finally {
      older.close();
    }
    second.upgradeKeywordIndex();
    // The keyword job must not call the text current: the wider pipeline hasn't read it yet.
    await vi.waitFor(
      () =>
        expect(
          queryDatabase<{ keywords_version: number }>(
            dataDir,
            "SELECT keywords_version FROM documents WHERE id = ?",
            [document.id],
          ),
        ).toEqual([{ keywords_version: PROCESSING_VERSION }]),
      { timeout: 30_000 },
    );
    expect(
      queryDatabase<{ processing_version: number }>(
        dataDir,
        "SELECT processing_version FROM documents WHERE id = ?",
        [document.id],
      ),
    ).toEqual([{ processing_version: 14 }]);
    second.close();

    await rename(`${path}.away`, path);
    const third = startCore(dataDir);
    await waitForProcessing(third, [document.id]);
    const rows = queryDatabase<{ text: string }>(
      dataDir,
      "SELECT text FROM passages WHERE document_id = ? AND deleted_at IS NULL",
      [document.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toContain("配送成本上升，7月起免运费门槛下调。");
    expect(rows[0]?.text).not.toContain("7\n月");
    expect(
      queryDatabase<{ processing_version: number }>(
        dataDir,
        "SELECT processing_version FROM documents WHERE id = ?",
        [document.id],
      ),
    ).toEqual([{ processing_version: PROCESSING_VERSION }]);
    third.close();
  });

  test("a two-page re-read reindexes each kept Passage by position, not by the rebuilt cuts", async () => {
    const dataDir = await createTempDataFolder();
    const sources = await createSourceFolder();
    const lines = Array.from(
      { length: 8 },
      (_, index) =>
        `${index === 0 ? "甲页专有词 A001" : ""}第${index + 1}段${CHINESE_LINES.join("")}`,
    );
    const pdf = buildPdf([
      { printed: lines.map((text) => ({ text, size: 4 })) },
      { chineseLines: ["乙页独有词 B001，保持原文。"] },
    ]);
    const first = startCore(dataDir);
    const [document] = (await addAndProcess(first, [
      await writeSourceFile(sources, "two pages.pdf", pdf),
    ])) as [Document];
    first.close();
    const before = queryDatabase<{ seq: number; id: string }>(
      dataDir,
      "SELECT seq, id FROM passages WHERE document_id = ? AND deleted_at IS NULL ORDER BY position",
      [document.id],
    );
    expect(before.length).toBeGreaterThan(1);

    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.transaction(() => {
        db.run("UPDATE documents SET processing_version = 14 WHERE id = ?", [document.id]);
        db.run(
          "UPDATE document_pages SET text = replace(text, '7月起', '7\n月起') WHERE document_id = ?",
          [document.id],
        );
        db.run(
          "UPDATE passages SET text = replace(text, '7月起', '7\n月起') WHERE document_id = ?",
          [document.id],
        );
      });
    } finally {
      db.close();
    }

    const core = startCore(dataDir);
    await waitForProcessing(core, [document.id]);
    const after = queryDatabase<{ seq: number; id: string }>(
      dataDir,
      "SELECT seq, id FROM passages WHERE document_id = ? AND deleted_at IS NULL ORDER BY position",
      [document.id],
    );
    expect(after.map((row) => row.seq)).toEqual(before.map((row) => row.seq));
    // The index rows follow the kept Passages: a word of the first page only in the first,
    // a word of the last page only in the last.
    expect(
      (await core.searchPassages("A001", { mode: "keyword" })).map((row) => row.passageId),
    ).toEqual([before[0]?.id]);
    expect(
      (await core.searchPassages("B001", { mode: "keyword" })).map((row) => row.passageId),
    ).toEqual([before.at(-1)?.id]);
    const phrase = (text: string) => `"${keywordText(text)}"`;
    expect(
      queryDatabase(dataDir, "SELECT rowid FROM passages_fts WHERE passages_fts MATCH ?", [
        phrase("甲页专有词"),
      ]),
    ).toEqual([{ rowid: before[0]?.seq }]);
    expect(
      queryDatabase(dataDir, "SELECT rowid FROM passages_fts WHERE passages_fts MATCH ?", [
        phrase("乙页独有词"),
      ]),
    ).toEqual([{ rowid: before.at(-1)?.seq }]);
    await core.close();
  });
});
