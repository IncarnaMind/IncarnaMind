import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import * as Y from "yjs";
import {
  BLOCK_ID_ATTRIBUTE,
  type Core,
  DATABASE_FILE,
  type DocumentTextMatch,
  MIND_CONTENT_FIELD,
  type MindTextMatch,
} from "../../src/core";
import { createMindContent } from "../../src/core/mindContent";
import { createMindIndex } from "../../src/core/mindIndex";
import { createMinds } from "../../src/core/minds";
import { type Database, migrate, openDatabase, type SqlValue } from "../../src/core/storage";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  waitForDocuments,
  writeSourceFile,
} from "../helpers/documents";
import { connectToMind, type MindClient, typeInto } from "../helpers/mindClient";
import { editMind, heading, note, writeMind } from "../helpers/minds";

/** The words inside Minds and Documents, through the core's interface as ⌘K uses it (#116). */

async function mindWith(core: Core, blocks: JSONContent[]): Promise<[string, MindClient]> {
  const { id } = await core.createMind();
  const client = await connectToMind(core, id);
  writeMind(client, blocks);
  await client.settled();
  return [id, client];
}

/** The words a match marks, as the palette makes them bold. */
const marked = (match: Pick<MindTextMatch, "excerpt" | "highlights">) =>
  match.highlights.map((range) => match.excerpt.slice(range.start, range.end));

const bulletList = (...items: string[]): JSONContent => ({
  type: "bulletList",
  attrs: { id: randomUUID() },
  content: items.map((text) => ({
    type: "listItem",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  })),
});

describe("searching inside Minds", () => {
  test("a word only inside a Mind is found, with an excerpt and the heading it sits under", async () => {
    const core = startCore(await createTempDataFolder());
    const [supplier] = await mindWith(core, [
      heading(1, "Supplier review"),
      note("Aldermoor Freight runs the cold chain."),
      heading(2, "Termination"),
      note("Either party may end the agreement on ninety days' written notice."),
    ]);
    await mindWith(core, [note("Notes from the stand-up about the Leeds account.")]);

    const [match, ...others] = await core.searchMinds("ninety");
    expect(others).toEqual([]);
    expect(match).toMatchObject({ mindId: supplier, heading: "Termination" });
    expect(match?.excerpt).toBe(
      "Either party may end the agreement on ninety days' written notice.",
    );
    expect(marked(match as MindTextMatch)).toEqual(["ninety"]);

    expect(await core.searchMinds("giraffe")).toEqual([]);
    expect(await core.searchMinds("  ")).toEqual([]);
  });

  test("a Chinese word is found, written in simplified or traditional characters", async () => {
    const core = startCore(await createTempDataFolder());
    const [finance] = await mindWith(core, [note("本季度的财务报表显示利润增长了百分之十二。")]);
    await mindWith(core, [note("会议纪要：下周讨论招聘计划。")]);

    for (const query of ["财务", "財務", "利润增长"]) {
      const found = await core.searchMinds(query);
      expect(
        found.map((match) => match.mindId),
        query,
      ).toEqual([finance]);
    }
    // The words as the index splits them: "财务报表" is one, which "财务" begins.
    const [match] = await core.searchMinds("财务");
    expect(marked(match as MindTextMatch)).toEqual(["财务报表"]);
  });

  test("every word must be somewhere in the Mind, the last one maybe still being typed", async () => {
    const core = startCore(await createTempDataFolder());
    const [parks] = await mindWith(core, [
      note("Irrigated parks cool the streets around them."),
      note("The effect is strongest on windless nights."),
    ]);

    const ids = async (query: string) =>
      (await core.searchMinds(query)).map((match) => match.mindId);
    expect(await ids("parks windless")).toEqual([parks]);
    expect(await ids("irrig")).toEqual([parks]);
    expect(await ids("parks wind")).toEqual([parks]);
    expect(await ids("parks giraffe")).toEqual([]);
    // The Block with both words is the one shown.
    const [match] = await core.searchMinds("windless nights");
    expect(match?.excerpt).toBe("The effect is strongest on windless nights.");

    // A Mind with both words in one Block comes before one with them in two.
    const [together] = await mindWith(core, [note("Parks feel cooler on windless evenings.")]);
    expect(await ids("parks windless")).toEqual([together, parks]);
  });

  test("words just typed are found at once, and words taken out are not", async () => {
    const core = startCore(await createTempDataFolder());
    const [id, client] = await mindWith(core, [note("Tides in Bergen")]);
    expect(await core.searchMinds("Bergen")).toHaveLength(1);

    typeInto(client, 0, "Tides in Bergen".length, " and the moon");
    await client.settled();
    expect((await core.searchMinds("moon")).map((match) => match.mindId)).toEqual([id]);

    editMind(client, () => [note("Tides in Oslo")]);
    await client.settled();
    expect(await core.searchMinds("Bergen")).toEqual([]);
    expect(await core.searchMinds("Oslo")).toHaveLength(1);
  });

  test("the index follows the User's typing by itself, once the Mind is quiet", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const [, client] = await mindWith(core, [note("Tides")]);
    typeInto(client, 0, "Tides".length, " in Bergen");
    await client.settled();

    await vi.waitFor(
      () =>
        expect(
          queryDatabase<{ text: string }>(
            dataDir,
            "SELECT text FROM mind_blocks WHERE deleted_at IS NULL",
          ),
        ).toEqual([{ text: "Tides in Bergen" }]),
      { timeout: 10_000, interval: 50 },
    );
  });

  test("lines of a list or a table never run together, and a footnote's words are found", async () => {
    const core = startCore(await createTempDataFolder());
    await mindWith(core, [
      bulletList("apple", "banana"),
      {
        type: "paragraph",
        attrs: { id: randomUUID() },
        content: [
          { type: "text", text: "Rainfall" },
          {
            type: "footnote",
            content: [{ type: "text", text: "Measured at Schiphol" }],
          },
        ],
      },
    ]);
    expect(await core.searchMinds("banana")).toHaveLength(1);
    expect(await core.searchMinds("applebanana")).toEqual([]);
    expect(await core.searchMinds("Schiphol")).toHaveLength(1);
  });

  test("a Mind in Recently deleted isn't found until it is restored, and deleted permanently its words go", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const [id] = await mindWith(core, [note("Quarterly forecast for the Leeds office")]);
    expect(await core.searchMinds("forecast")).toHaveLength(1);

    await core.deleteMind(id);
    expect(await core.searchMinds("forecast")).toEqual([]);
    await core.restore([{ kind: "mind", id }]);
    expect((await core.searchMinds("forecast")).map((match) => match.mindId)).toEqual([id]);

    await core.deleteMind(id);
    await core.deletePermanently([{ kind: "mind", id }]);
    expect(
      queryDatabase(dataDir, "SELECT text FROM mind_blocks WHERE text <> '' OR deleted_at IS NULL"),
    ).toEqual([]);
    expect(queryDatabase(dataDir, "SELECT rowid FROM mind_blocks_fts")).toEqual([]);
  });

  test("Minds written before the index, or stored to after it last read them, are read in the background after the next start", async () => {
    const dataDir = await createTempDataFolder();
    const first = startCore(dataDir);
    await mindWith(first, [note("Harbour pilots in Rotterdam")]);
    const [later] = await mindWith(first, [note("Ferry timetables")]);
    first.close();

    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      // The first as if written before the index existed; the second as if the app quit before reading it again.
      db.run("DELETE FROM mind_blocks WHERE mind_id <> ?", [later]);
      db.run("DELETE FROM mind_block_reads WHERE mind_id <> ?", [later]);
      db.run("UPDATE mind_blocks SET text = 'Ferry' WHERE mind_id = ?", [later]);
      db.run("UPDATE mind_block_reads SET updated_at = '2000-01-01T00:00:00.000Z'");
    } finally {
      db.close();
    }

    const core = startCore(dataDir);
    await vi.waitFor(
      async () => {
        expect(await core.searchMinds("Rotterdam")).toHaveLength(1);
        expect(await core.searchMinds("timetables")).toHaveLength(1);
      },
      { timeout: 10_000, interval: 50 },
    );
  });
});

describe("searching the words in Documents", () => {
  test("finds Documents by words in their text, not by their name alone, one Passage each", async () => {
    const core = startCore(await createTempDataFolder());
    const folder = await createSourceFolder();
    const msa = await writeSourceFile(
      folder,
      "Aldermoor MSA.txt",
      "Either party may end this contract for convenience on ninety days' written notice.",
    );
    const handbook = await writeSourceFile(
      folder,
      "员工手册.txt",
      "试用期结束后，合同的通知期为三十天。",
    );
    const [msaDoc, handbookDoc] = await addAndProcess(core, [msa, handbook]);

    const [match, ...others] = await core.searchDocumentText("ninety notice");
    expect(others).toEqual([]);
    expect(match).toMatchObject({ documentId: msaDoc?.id, pageFrom: 1 });
    expect(marked(match as DocumentTextMatch)).toEqual(["ninety", "notice"]);

    expect(await core.searchDocumentText("Aldermoor")).toEqual([]);
    expect(await core.searchDocumentText("ninety giraffe")).toEqual([]);
    expect((await core.searchDocumentText("通知期")).map((each) => each.documentId)).toEqual([
      handbookDoc?.id,
    ]);
  });
  test("returns as many Documents as asked for, 20 unless asked, and refuses a limit outside 1 to 200", async () => {
    const core = startCore(await createTempDataFolder());
    const folder = await createSourceFolder();
    const files = await Promise.all(
      Array.from({ length: 22 }, (_, n) =>
        writeSourceFile(folder, `Tide table ${n}.txt`, `Spring tides at the harbour, week ${n}.`),
      ),
    );
    await addAndProcess(core, files);

    expect(await core.searchDocumentText("spring tides")).toHaveLength(20);
    expect(await core.searchDocumentText("spring tides", { limit: 200 })).toHaveLength(22);
    expect(await core.searchDocumentText("spring tides", { limit: 3 })).toHaveLength(3);
    for (const limit of [0, 201, 2.5]) {
      await expect(core.searchDocumentText("spring tides", { limit })).rejects.toThrow(
        "The limit must be a whole number from 1 to 200.",
      );
    }
  });

  test("leaves out a missing Document, and one long Document doesn't crowd out the others", async () => {
    const core = startCore(await createTempDataFolder());
    const folder = await createSourceFolder();
    const long = await writeSourceFile(
      folder,
      "Harbour log.txt",
      Array.from(
        { length: 6000 },
        (_, day) => `Day ${day}: the harbour pilot boarded the harbour pilot boat at dawn.`,
      ).join("\n\n"),
    );
    const filler = Array.from({ length: 300 }, (_, n) => `word${n}`).join(" ");
    const short = await writeSourceFile(
      folder,
      "Pilot rota.txt",
      `${filler} Each harbour pilot works four days. ${filler}`,
    );
    const gone = await writeSourceFile(folder, "Old rota.txt", "The harbour pilot rota for 2019.");
    const [logDoc, rotaDoc, goneDoc] = await addAndProcess(core, [long, short, gone]);

    const found = async () =>
      (await core.searchDocumentText("harbour pilot")).map((match) => match.documentId).sort();
    expect(await found()).toEqual([logDoc?.id, rotaDoc?.id, goneDoc?.id].sort());

    await rm(gone);
    await core.reconcileDocuments();
    await waitForDocuments(core, (listed) =>
      expect(listed.find((each) => each.id === goneDoc?.id)?.fileStatus).toBe("missing"),
    );
    expect(await found()).toEqual([logDoc?.id, rotaDoc?.id].sort());
  });
});

describe("each Mind's line under its name, for Home's Recent", () => {
  test("is the first line that isn't its name, as typed a moment ago; a Mind with none is left out", async () => {
    const core = startCore(await createTempDataFolder());
    const [titled] = await mindWith(core, [
      heading(1, "Supplier review"),
      note("Aldermoor Freight runs the cold chain."),
      note("Termination needs ninety days' notice."),
    ]);
    const [untitled, client] = await mindWith(core, [
      note("Notes from the stand-up about the Leeds account."),
      note("Hiring plan next week."),
    ]);
    const [empty] = await mindWith(core, []);

    const snippets = await core.listMindSnippets();
    expect(snippets).toEqual(
      expect.arrayContaining([
        { mindId: titled, text: "Aldermoor Freight runs the cold chain." },
        { mindId: untitled, text: "Hiring plan next week." },
      ]),
    );
    expect(snippets.map((each) => each.mindId)).not.toContain(empty);

    writeMind(client, [
      note("Notes from the stand-up about the Leeds account."),
      note("下周讨论招聘计划。"),
    ]);
    await client.settled();
    expect(await core.listMindSnippets()).toEqual(
      expect.arrayContaining([{ mindId: untitled, text: "下周讨论招聘计划。" }]),
    );
  });

  test("keeps a line that starts with the Mind's name, and skips only the title heading or the line the name comes from", async () => {
    const core = startCore(await createTempDataFolder());
    const short = await core.createMind({ title: "Q3" });
    const shortClient = await connectToMind(core, short.id);
    writeMind(shortClient, [note("Q3 revenue grew 4%."), note("Margins held.")]);
    await shortClient.settled();
    const [headed] = await mindWith(core, [heading(1, "Q3"), note("Q3 revenue grew 4%.")]);
    const long =
      "The harbour board met on Tuesday to agree the berth fees for next year and the dredging plan";
    const [cut] = await mindWith(core, [note(long), note("Fees rise by 3%.")]);

    const snippets = await core.listMindSnippets();
    expect(snippets).toEqual(
      expect.arrayContaining([
        { mindId: short.id, text: "Q3 revenue grew 4%." },
        { mindId: headed, text: "Q3 revenue grew 4%." },
        { mindId: cut, text: "Fees rise by 3%." },
      ]),
    );
  });

  test("follows a rename: the old title heading isn't shown as the line", async () => {
    const core = startCore(await createTempDataFolder());
    const [moorings] = await mindWith(core, [
      heading(1, "Moorings"),
      note("Berths are let by the year."),
    ]);
    await core.renameMind(moorings, "Mooring fees");

    expect(await core.listMindSnippets()).toEqual(
      expect.arrayContaining([{ mindId: moorings, text: "Berths are let by the year." }]),
    );
  });

  test("a Mind restored from Recently deleted has its line again, in the same session and after a restart", async () => {
    const dataDir = await createTempDataFolder();
    const first = startCore(dataDir);
    const [same] = await mindWith(first, [
      heading(1, "Tides"),
      note("Spring tides come twice a month."),
    ]);
    const [later] = await mindWith(first, [
      heading(1, "Ferries"),
      note("The last ferry leaves at ten."),
    ]);
    expect(await first.listMindSnippets()).toHaveLength(2);
    await first.deleteMind(same);
    await first.deleteMind(later);
    await first.restore([{ kind: "mind", id: same }]);
    expect(await first.listMindSnippets()).toEqual([
      { mindId: same, text: "Spring tides come twice a month." },
    ]);
    first.close();

    const core = startCore(dataDir);
    expect(await core.listMindSnippets()).toHaveLength(1);
    await core.restore([{ kind: "mind", id: later }]);
    expect(await core.listMindSnippets()).toEqual(
      expect.arrayContaining([{ mindId: later, text: "The last ferry leaves at ten." }]),
    );
  });

  test("a long line is kept only to its start", async () => {
    const core = startCore(await createTempDataFolder());
    const sentence = "The harbour master publishes the tide tables every Monday morning. ";
    const [log] = await mindWith(core, [heading(1, "Log"), note(sentence.repeat(30))]);

    const [snippet] = await core.listMindSnippets();
    expect(snippet?.mindId).toBe(log);
    expect(snippet?.text.startsWith(sentence.trim())).toBe(true);
    expect(Array.from(snippet?.text ?? "").length).toBeLessThanOrEqual(300);
  });

  test("saving one Mind reads only that Mind again: the same work for a Library of 3 Minds or of 30", async () => {
    const small = await workOfOneSave(3);
    const large = await workOfOneSave(30);
    expect(small.unchanged).toEqual({ minds: 0, blockRows: 0 });
    expect(large.unchanged).toEqual({ minds: 0, blockRows: 0 });
    expect(small.saved.minds).toBe(1);
    expect(large.saved).toEqual(small.saved);
  });
});

/**
 * Asks a Library of `size` Minds for their lines, then again with nothing changed, then once more
 * after one Mind was saved, counting the Minds read and the index rows read each time.
 */
async function workOfOneSave(size: number) {
  const dataDir = await createTempDataFolder();
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  onTestFinished(() => db.close());
  migrate(db);
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 9, 19) + tick++).toISOString();
  const work = { minds: 0, blockRows: 0 };
  const counted = (sql: string, rows: number) => {
    if (sql.includes("mind_blocks")) work.blockRows += rows;
  };
  const watched: Database = {
    exec: (sql) => db.exec(sql),
    run: (sql, params) => db.run(sql, params),
    get<Row>(sql: string, params?: readonly SqlValue[]) {
      const row = db.get<Row>(sql, params);
      counted(sql, row === undefined ? 0 : 1);
      return row;
    },
    all<Row>(sql: string, params?: readonly SqlValue[]) {
      const rows = db.all<Row>(sql, params);
      counted(sql, rows.length);
      return rows;
    },
    transaction: (fn) => db.transaction(fn),
    close: () => db.close(),
  };
  const content = createMindContent(db, now, (mindId) => index.contentStored(mindId));
  const index = createMindIndex({
    db: watched,
    now,
    content: {
      peek(mindId, look) {
        work.minds += 1;
        return content.peek(mindId, look);
      },
    },
    reportError: (error) => {
      throw error;
    },
  });
  onTestFinished(() => index.close());
  const minds = createMinds(db, now);
  const docs = new Map<string, Y.Doc>();
  const write = (mindId: string, text: string) => {
    const doc = docs.get(mindId) ?? new Y.Doc();
    docs.set(mindId, doc);
    const before = Y.encodeStateVector(doc);
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.setAttribute(BLOCK_ID_ATTRIBUTE, randomUUID());
    paragraph.insert(0, [new Y.XmlText(text)]);
    doc.getXmlFragment(MIND_CONTENT_FIELD).insert(0, [paragraph]);
    content.apply(mindId, Y.encodeStateAsUpdate(doc, before));
  };
  const ids = Array.from({ length: size }, (_, at) => {
    const { id } = minds.create({ title: "", kind: "mind", folderId: null });
    write(id, `Notes ${at + 1}.`);
    return id;
  });

  index.leadingLines();
  const taken = () => {
    const done = { ...work };
    work.minds = 0;
    work.blockRows = 0;
    return done;
  };
  taken();
  index.leadingLines();
  const unchanged = taken();
  const [first] = ids;
  if (!first) throw new Error("No Mind was made.");
  write(first, "Moorings are let by the year.");
  expect(index.leadingLines().get(first)?.[0]?.text).toBe("Moorings are let by the year.");
  return { unchanged, saved: taken() };
}
