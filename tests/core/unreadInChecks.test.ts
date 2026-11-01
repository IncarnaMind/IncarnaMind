import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test, vi } from "vitest";
import {
  type Core,
  InvalidInputError,
  type Logger,
  MIND_CHECK_UNREAD_FIELD,
  type UnreadFile,
} from "../../src/core";
import { MAX_ROWS } from "../../src/core/documents/formats/grid";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { checkUnreadOf } from "../../src/shared/unreadFiles";
import { checkingModel, type Plan } from "../helpers/checks";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { parseCsv } from "../helpers/csv";
import {
  createSourceFolder,
  linkAndProcess,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { unzip } from "../helpers/docx";
import { lockedPdf } from "../helpers/lockedPdf";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { editMind, readMind, writeMind } from "../helpers/minds";
import { scriptedModels } from "../helpers/models";
import { xlsxOf } from "../helpers/office";
import { buildPdf } from "../helpers/pdf";
import { fakePrinter } from "../helpers/printer";

/*
 * Checks say which files in their scope couldn't be read, and why (#740):
 * Check against Documents, Check this note and Verify keep, with the request
 * that made their marks, the files their scope couldn't read as it started,
 * which the line beside them, the AI use statement and an export read back.
 */

const SUPPORTED = "Spring tides come at new and full moon.";
const UNSUPPORTED = "Penguins nest on the cliffs above the harbour.";

const PLANS: Record<string, Plan> = {
  [SUPPORTED]: {
    verdict: "supported",
    quote: "Spring tides happen at new moon and at full moon",
    says: "Tides says spring tides happen at new and full moon.",
  },
  [UNSUPPORTED]: { verdict: "unsupported" },
};

const TIDES = "# Tides\n\nSpring tides happen at new moon and at full moon.\n";

const UNREAD = [
  { name: "Contract.doc", reason: "format", extension: ".doc" },
  { name: "Locked.pdf", reason: "password", extension: null },
  { name: "Scan.pdf", reason: "scan", extension: null },
];

/**
 * A core with a Folder, Harbour, into which a Linked folder is filed that
 * holds Tides, which reads, and the files given; the Folder's id.
 */
async function linkedFolderWith(
  files: Record<string, string | Uint8Array>,
  options: Parameters<typeof startCore>[1] = {},
) {
  const library = await createSourceFolder();
  await writeSourceFile(library, "Tides.md", TIDES);
  for (const [name, contents] of Object.entries(files)) {
    await writeSourceFile(library, name, contents);
  }
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    ...options,
    createChatModel: scriptedModels(checkingModel(PLANS)).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const harbour = await core.createLibraryGroup({ name: "Harbour", description: "" });
  await linkAndProcess(core, library, { groupId: harbour.id });
  return { core, folderId: harbour.id, library, dataDir };
}

/** Adds a Citation of Tides to a Mind, which a source pack needs. */
async function citeTides(core: Core, mindId: string): Promise<void> {
  const tides = (await core.listDocuments()).find((document) => document.name === "Tides");
  if (!tides) throw new Error("No Tides.");
  const client = await connectToMind(core, mindId);
  editMind(client, (blocks) => [
    ...blocks,
    {
      type: "paragraph",
      attrs: { id: randomUUID() },
      content: [
        { type: "text", text: "The tides." },
        {
          type: "citation",
          attrs: {
            passageId: "passage-1",
            documentId: tides.id,
            documentName: tides.name,
            contentHash: tides.contentHash,
            pageFrom: 1,
            pageTo: 1,
            quote: "Spring tides happen at new moon and at full moon",
            check: "found",
            checkReason: null,
          },
        },
      ],
    },
  ]);
  await client.settled();
}

const withUnreadFiles = (options: Parameters<typeof startCore>[1] = {}) =>
  linkedFolderWith(
    {
      "Old/Contract.doc": "binary",
      "Locked.pdf": lockedPdf(["Harbour fees rise in May."], "harbour"),
      "Scan.pdf": buildPdf([{ image: true }]),
    },
    options,
  );

async function mindOf(core: Core, folderId: string | null, sentences: readonly string[]) {
  const mind = await core.createMind({ title: "Harbour", folderId });
  const client = await connectToMind(core, mind.id);
  const body = sentences.join(" ");
  const block: JSONContent = {
    type: "paragraph",
    attrs: { id: randomUUID() },
    content: [{ type: "text", text: body }],
  };
  writeMind(client, [block]);
  await client.settled();
  const blockId = String(block.attrs?.id);
  const check = (allDocuments = false) =>
    core.checkSentences({
      requestId: randomUUID(),
      mindId: mind.id,
      action: "check-against-documents",
      from: { blockId, offset: 0 },
      to: { blockId, offset: body.length },
      allDocuments,
    });
  return { mind, client, check };
}

async function unreadOfChecks(client: MindClient): Promise<UnreadFile[]> {
  await client.settled();
  const requests = claimSpans(readMind(client)).map((span) => span.check.request);
  return checkUnreadOf(client.doc, requests);
}

const named = (files: readonly UnreadFile[]) =>
  files
    .map(({ name, reason, extension }) => ({ name, reason, extension }))
    .sort((a, b) => a.name.localeCompare(b.name));

describe("What a check couldn't read", () => {
  test("Check against Documents in a Folder with a .doc, a locked PDF and a scan names the three, with their reasons", async () => {
    const { core, folderId } = await withUnreadFiles();
    const { client, check } = await mindOf(core, folderId, [SUPPORTED, UNSUPPORTED]);

    expect(await check()).toMatchObject({ kind: "checked", sentences: 2, checked: 2 });

    const unread = await unreadOfChecks(client);
    expect(named(unread)).toEqual(UNREAD);
    // An Answer asked in the Folder names the same: a Linked folder filed into it holds its files.
    expect(
      named(await core.listUnreadFiles({ folderIds: [folderId], tagIds: [], documentIds: [] })),
    ).toEqual(UNREAD);
    // A name that is a Document opens it; a file in a format not read isn't one.
    expect(unread.find((file) => file.name === "Scan.pdf")?.documentId).toEqual(expect.any(String));
    expect(unread.find((file) => file.name === "Contract.doc")?.documentId).toBeNull();
    // A file's path is this computer's, not the Mind's: it isn't kept with it.
    expect(JSON.stringify(client.doc.getMap(MIND_CHECK_UNREAD_FIELD).toJSON())).not.toContain(
      "Old",
    );
  });

  test("it is what was unread when the check started: a file added since is named once the sentence is checked again", async () => {
    const { core, folderId, library } = await withUnreadFiles();
    const { client, check } = await mindOf(core, folderId, [SUPPORTED]);
    await check();
    const kept = client.doc.getMap(MIND_CHECK_UNREAD_FIELD);
    await client.settled();
    const first = [...kept.keys()];
    expect(first).toHaveLength(1);

    await writeSourceFile(library, "Budget.xls", "binary");
    await core.reconcileDocuments();
    await vi.waitFor(async () =>
      expect((await core.listUnreadFiles(null)).map((file) => file.name)).toContain("Budget.xls"),
    );
    expect(named(await unreadOfChecks(client))).toEqual(UNREAD);

    await check();
    await client.settled();
    expect(named(await unreadOfChecks(client))).toEqual([
      { name: "Budget.xls", reason: "format", extension: ".xls" },
      ...UNREAD,
    ]);
    // The first request's marks are gone, and so is what it kept.
    expect([...kept.keys()]).toHaveLength(1);
    expect([...kept.keys()]).not.toEqual(first);
  });

  test("Verify over the Folder names the same three", async () => {
    const { core, folderId } = await withUnreadFiles();
    const outside = await createTempDataFolder();
    const report = await writeSourceFile(
      outside,
      "Harbour report.pdf",
      buildPdf([{ lines: ["Harbour report", SUPPORTED, UNSUPPORTED] }]),
    );
    const verified = await core.verifyDocument({ path: report, folderId });
    if (!verified.ok) throw new Error(`The report wasn't verified: ${verified.reason}`);
    const client = await connectToMind(core, verified.mind.id);
    await client.settled();
    expect(await core.findClaims({ requestId: randomUUID(), mindId: verified.mind.id })).toEqual({
      kind: "found",
      claims: 2,
    });

    expect(
      await core.verifyClaims({ requestId: randomUUID(), mindId: verified.mind.id }),
    ).toMatchObject({ kind: "checked", claims: 2, checked: 2 });

    expect(named(await unreadOfChecks(client))).toEqual(UNREAD);
  });

  test("Check this note names the same three", async () => {
    const { core, folderId } = await withUnreadFiles();
    const { mind, client } = await mindOf(core, folderId, [SUPPORTED, UNSUPPORTED]);

    expect(
      await core.checkMind({ requestId: randomUUID(), mindId: mind.id, mode: "all" }),
    ).toMatchObject({ kind: "checked", sentences: 2, checked: 2 });

    expect(named(await unreadOfChecks(client))).toEqual(UNREAD);
  });

  test("nothing is named when everything in the check's scope was read", async () => {
    const { core, folderId } = await linkedFolderWith({});
    const { client, check } = await mindOf(core, folderId, [SUPPORTED, UNSUPPORTED]);

    await check();

    expect(await unreadOfChecks(client)).toEqual([]);
    expect(client.doc.getMap(MIND_CHECK_UNREAD_FIELD).size).toBe(0);
  });

  test("a check in another Folder names only what that Folder couldn't read; Search all Documents names every one", async () => {
    const { core } = await withUnreadFiles();
    const elsewhere = await core.createLibraryGroup({ name: "Elsewhere", description: "" });
    // A Document of its own, which reads, so its checks search Elsewhere alone (#1359).
    const sources = await createSourceFolder();
    const added = await core.addDocuments(
      [await writeSourceFile(sources, "Moon.md", "# Moon\n\nThe moon pulls the sea.\n")],
      { groupId: elsewhere.id },
    );
    await waitForProcessing(
      core,
      added.documents.map((document) => document.id),
    );
    const { client, check } = await mindOf(core, elsewhere.id, [SUPPORTED]);

    expect(await check()).toMatchObject({ kind: "checked" });
    expect(named(await unreadOfChecks(client))).toEqual([]);
    expect(await check(true)).toMatchObject({ kind: "checked" });

    expect(named(await unreadOfChecks(client))).toEqual(UNREAD);
  });
});

describe("The AI use statement", () => {
  test.each(["en", "zh-CN"] as const)(
    "counts what the checks couldn't read, and names no file (%s)",
    async (language) => {
      const { core, folderId } = await withUnreadFiles();
      await core.updateSettings({ user: { language } });
      const { mind, check } = await mindOf(core, folderId, [SUPPORTED, UNSUPPORTED]);
      await check();

      const made = await core.createAiUseStatement(mind.id);
      const statement = readMind(await connectToMind(core, made.id));

      expect(statement.textContent).toContain(
        language === "en"
          ? "3 files they were checked against couldn’t be read, so the checks didn’t search them."
          : "有 3 个文件未能读取，因此没有检索这些文件。",
      );
      expect(statement.textContent).not.toMatch(
        language === "en" ? /didn’t search them:$/ : /没有检索这些文件：$/,
      );
      for (const name of ["Contract.doc", "Locked.pdf", "Scan.pdf"]) {
        expect(statement.textContent).not.toContain(name);
      }
      let lists = 0;
      statement.forEach((node) => {
        if (node.type.name === "bulletList") lists++;
      });
      expect(lists).toBe(0);
    },
  );

  test("says nothing of unread files when the checks read everything", async () => {
    const { core, folderId } = await linkedFolderWith({});
    const { mind, check } = await mindOf(core, folderId, [SUPPORTED]);
    await check();

    const made = await core.createAiUseStatement(mind.id);
    const statement = readMind(await connectToMind(core, made.id));
    expect(statement.textContent).not.toContain("couldn't be read");
    let lists = 0;
    statement.forEach((node) => {
      if (node.type.name === "bulletList") lists++;
    });
    expect(lists).toBe(0);
  });
});

const markdownOf = async (core: Core, mindId: string): Promise<string> =>
  new TextDecoder().decode((await core.exportMind(mindId, { format: "markdown" })).data);

describe("An export", () => {
  const UNREAD_WORDS = {
    en: [
      "What couldn’t be read",
      "files couldn’t be read",
      "Contract.doc",
      "Locked.pdf",
      "Scan.pdf",
      "Format not read yet",
      "Password-protected",
      "A scan with no text",
    ],
    "zh-CN": [
      "未能读取的文件",
      "个文件未能读取",
      "Contract.doc",
      "Locked.pdf",
      "Scan.pdf",
      "暂不支持此格式",
      "已设置密码",
      "扫描件",
    ],
  } as const;

  test.each(["en", "zh-CN"] as const)(
    "says nothing about the files the checks couldn't read, in any format (%s)",
    async (language) => {
      const { printed, printer } = fakePrinter();
      const { core, folderId } = await withUnreadFiles({ printer });
      await core.updateSettings({ user: { language } });
      const { mind, check } = await mindOf(core, folderId, [SUPPORTED]);
      await check();
      await citeTides(core, mind.id);

      const said: Record<string, string> = {
        markdown: await markdownOf(core, mind.id),
        html: new TextDecoder().decode((await core.exportMind(mind.id, { format: "html" })).data),
        docx:
          unzip((await core.exportMind(mind.id, { format: "docx" })).data)
            .get("word/document.xml")
            ?.toString("utf8") ?? "",
        sharePage: new TextDecoder().decode(
          (await core.exportMind(mind.id, { format: "share-page" })).data,
        ),
      };
      const before = printed.length;
      await core.exportMind(mind.id, { format: "pdf" });
      await core.exportMind(mind.id, { format: "source-pack" });
      said.pdf = printed[before]?.body ?? "";
      said.sourcePack = printed[before + 1]?.body ?? "";

      for (const [format, text] of Object.entries(said)) {
        for (const word of UNREAD_WORDS[language]) {
          expect(text, `${format} said ${word}`).not.toContain(word);
        }
      }
      for (const format of ["markdown", "html", "docx", "pdf", "sharePage"]) {
        expect(said[format]).toContain("The tides.");
      }
      expect(said.sourcePack).toContain("Tides");
    },
  );

  test.each(["en", "zh-CN"] as const)(
    "says nothing about reading when the checks read everything (%s)",
    async (language) => {
      const { core, folderId } = await linkedFolderWith({});
      await core.updateSettings({ user: { language } });
      const { mind, check } = await mindOf(core, folderId, [SUPPORTED]);
      await check();

      expect(await markdownOf(core, mind.id)).not.toContain(
        language === "en" ? "couldn’t be read" : "未能读取",
      );
    },
  );

  test("says nothing before a check runs, even with unread files in its Folder", async () => {
    const { core, folderId } = await withUnreadFiles();
    const { mind } = await mindOf(core, folderId, [SUPPORTED]);

    const markdown = await markdownOf(core, mind.id);

    expect(markdown).not.toContain("couldn’t be read");
    expect(markdown).not.toContain("Contract.doc");
  });
});

describe("The check record", () => {
  test("lists what the checks couldn't read, in its PDF and its CSV", async () => {
    const { printed, printer } = fakePrinter();
    const out = await createTempDataFolder();
    const { core, folderId } = await withUnreadFiles({ printer });
    await core.setOutputLocation(out);
    const { mind, check } = await mindOf(core, folderId, [SUPPORTED]);
    await check();

    const saved = await core.saveCheckRecord(mind.id);

    if (saved.status !== "saved") throw new Error(`Not saved: ${saved.status}`);
    const pdf = printed[0]?.body ?? "";
    expect(pdf).toContain("What couldn’t be read");
    expect(pdf).toContain("3 files couldn’t be read");
    expect(pdf).toContain("Contract.doc: Format not read yet (.doc)");
    expect(pdf).toContain("Locked.pdf: Password-protected");
    expect(pdf).toContain("Scan.pdf: A scan with no text");
    const csvName = readdirSync(out).find((name) => name.endsWith(".csv"));
    const rows = parseCsv(readFileSync(join(out, csvName ?? ""), "utf8"));
    expect(rows.find((each) => each[0] === "What couldn’t be read")?.[1]).toEqual(
      "3 files couldn’t be read; Contract.doc: Format not read yet (.doc). Convert it to PDF, Word, PowerPoint or Excel.; Locked.pdf: Password-protected. Remove the password and add it again.; Scan.pdf: A scan with no text that could be recognized (handwriting or a picture, say).",
    );

    // The same record in Chinese, with the whole explanations.
    const chinese = await createTempDataFolder();
    await core.updateSettings({ user: { language: "zh-CN" } });
    await core.setOutputLocation(chinese);
    const again = await core.saveCheckRecord(mind.id);
    if (again.status !== "saved") throw new Error(`Not saved: ${again.status}`);
    const zhName = readdirSync(chinese).find((name) => name.endsWith(".csv"));
    const zhRows = parseCsv(readFileSync(join(chinese, zhName ?? ""), "utf8"));
    expect(zhRows.find((each) => each[0] === "未能读取的文件")?.[1]).toEqual(
      "3 个文件未能读取; Contract.doc：暂不支持此格式（.doc）。请转换为 PDF、Word、PowerPoint 或 Excel。; Locked.pdf：已设置密码。请去掉密码后重新添加。; Scan.pdf：扫描件，未识别出文字（可能是手写内容或图片）。",
    );
  });

  test("names at most 20 files, then says how many more there were", async () => {
    const { printed, printer } = fakePrinter();
    const out = await createTempDataFolder();
    const files = Object.fromEntries(
      Array.from({ length: 22 }, (_, index) => [`Old/Contract ${index + 1}.doc`, "binary"]),
    );
    const { core, folderId } = await linkedFolderWith(files, { printer });
    await core.setOutputLocation(out);
    const { mind, check } = await mindOf(core, folderId, [SUPPORTED]);
    await check();

    const saved = await core.saveCheckRecord(mind.id);

    if (saved.status !== "saved") throw new Error(`Not saved: ${saved.status}`);
    const csvName = readdirSync(out).find((name) => name.endsWith(".csv"));
    const rows = parseCsv(readFileSync(join(out, csvName ?? ""), "utf8"));
    const summary = rows.find((each) => each[0] === "What couldn’t be read")?.[1] ?? "";
    expect(summary).toContain("22 files couldn’t be read");
    expect(summary).toContain("Contract 20.doc");
    expect(summary).not.toContain("Contract 21.doc");
    expect(summary).toContain("and 2 more");
    expect(printed[0]?.body ?? "").toContain("and 2 more");
  });

  test("says nothing when the checks read everything", async () => {
    const { printed, printer } = fakePrinter();
    const out = await createTempDataFolder();
    const { core, folderId } = await linkedFolderWith({}, { printer });
    await core.setOutputLocation(out);
    const { mind, check } = await mindOf(core, folderId, [SUPPORTED]);
    await check();

    const saved = await core.saveCheckRecord(mind.id);

    if (saved.status !== "saved") throw new Error(`Not saved: ${saved.status}`);
    expect(printed[0]?.body ?? "").not.toContain("What couldn’t be read");
    const csvName = readdirSync(out).find((name) => name.endsWith(".csv"));
    const rows = parseCsv(readFileSync(join(out, csvName ?? ""), "utf8"));
    expect(rows.some((each) => each[0] === "What couldn’t be read")).toBe(false);
  });
});

/**
 * A workbook is read in part without a word (#740): hidden and very hidden sheets are left
 * out, and the reading limit cuts its rows. Both are named in the same list, with what the
 * rest of the workbook says.
 */
describe("A workbook read in part", () => {
  const BUDGET = "Budget 2026.xlsx";
  const workbook = () =>
    xlsxOf([
      { name: "Visible", rows: [["Region"]] },
      { name: "Q3 raw", state: "hidden", rows: [["Secret"], ["1"]] },
      { name: "Q4 raw", state: "veryHidden", rows: [["Secret"], ["2"]] },
      {
        name: "Big",
        rows: Array.from({ length: MAX_ROWS + 5 }, (_, index) => [`R${index + 1}`, index]),
      },
      { name: "After", rows: [["never read"]] },
    ]);
  const withWorkbook = (options: Parameters<typeof startCore>[1] = {}) =>
    linkedFolderWith({ [BUDGET]: workbook() }, options);

  test("the list names the hidden sheets and the rows past the limit, with the workbook", async () => {
    const { core } = await withWorkbook();

    expect(await core.listUnreadFiles(null)).toMatchObject([
      {
        name: BUDGET,
        reason: "parts",
        parts: {
          hiddenSheets: ["Q3 raw", "Q4 raw"],
          rowsCut: [{ sheet: "Big", from: MAX_ROWS }],
          sheetsNotRead: ["After"],
        },
      },
    ]);
  });

  test("Read hidden sheets too reads the workbook again with them, and the list says only what is still unread", async () => {
    const { core, folderId } = await withWorkbook();
    const budget = (await core.listDocuments()).find((document) => document.name === "Budget 2026");
    if (!budget) throw new Error("No workbook.");
    expect(budget.readHiddenSheets).toBe(false);

    const before = await core.readDocumentText(budget.id);
    expect(before.pages.some((unit) => unit.label?.sheet === "Q3 raw")).toBe(false);

    const queued = await core.readHiddenSheets(budget.id);
    expect(queued).toMatchObject({ readHiddenSheets: true, status: "queued" });
    const [read] = await waitForProcessing(core, [budget.id]);
    expect(read?.status).toBe("ready");

    const after = await core.readDocumentText(budget.id);
    expect(after.pages.some((unit) => unit.label?.sheet === "Q3 raw")).toBe(true);
    expect(after.pages.some((unit) => unit.label?.sheet === "Q4 raw")).toBe(true);
    expect(after.pages.map((unit) => unit.text).join("\n")).toContain("Secret");
    // The visible sheets keep the Unit numbers a Citation already points at.
    const visible = (pages: typeof before.pages) =>
      pages
        .filter((unit) => unit.label?.sheet === "Visible" || unit.label?.sheet === "Big")
        .map((unit) => [unit.page, unit.text]);
    expect(visible(after.pages)).toEqual(visible(before.pages));
    // A Citation made before the re-read still finds its quote at its Unit numbers.
    const quoted = before.pages.find(
      (unit) => unit.label?.sheet === "Big" && unit.text.includes("R7777"),
    );
    if (!quoted) throw new Error("No Big sheet Unit.");
    expect(
      await core.readableQuote({
        documentId: budget.id,
        contentHash: budget.contentHash,
        pageFrom: quoted.page,
        pageTo: quoted.page,
        quote: "R7777",
      }),
    ).toBe("R7777");

    const found = (await core.listUnreadFiles(null)).find((file) => file.name === BUDGET);
    expect(found).toMatchObject({
      reason: "parts",
      parts: {
        hiddenSheets: [],
        rowsCut: [{ sheet: "Big", from: MAX_ROWS }],
        sheetsNotRead: ["After"],
      },
    });

    // A check made now says the same: the rows past the limit, not the hidden sheets.
    const { client, check } = await mindOf(core, folderId, [SUPPORTED]);
    await check();
    const checked = (await unreadOfChecks(client)).find((file) => file.name === BUDGET);
    expect(checked?.parts).toEqual({
      hiddenSheets: [],
      rowsCut: [{ sheet: "Big", from: MAX_ROWS }],
      sheetsNotRead: ["After"],
    });

    await expect(core.readHiddenSheets(budget.id)).rejects.toThrow(InvalidInputError);

    // Undo reads it again without them: the visible Units stay, the hidden sheets are left out.
    await core.readHiddenSheets(budget.id, false);
    const [undone] = await waitForProcessing(core, [budget.id]);
    expect(undone?.status).toBe("ready");
    const restored = await core.readDocumentText(budget.id);
    expect(restored.pages.some((unit) => unit.label?.sheet === "Q3 raw")).toBe(false);
    expect(visible(restored.pages)).toEqual(visible(before.pages));
    expect((await core.listUnreadFiles(null)).find((file) => file.name === BUDGET)).toMatchObject({
      reason: "parts",
      parts: {
        hiddenSheets: ["Q3 raw", "Q4 raw"],
        rowsCut: [{ sheet: "Big", from: MAX_ROWS }],
        sheetsNotRead: ["After"],
      },
    });

    // Undo, then Redo straight away while the re-read runs: Redo must not be refused by the
    // last finished read's parts (#740).
    await core.readHiddenSheets(budget.id);
    await waitForProcessing(core, [budget.id]);
    await core.readHiddenSheets(budget.id, false);
    const redone = await core.readHiddenSheets(budget.id, true);
    expect(redone.readHiddenSheets).toBe(true);
    const [completed] = await waitForProcessing(core, [budget.id]);
    expect(completed?.status).toBe("ready");
    expect(
      (await core.readDocumentText(budget.id)).pages.some((unit) => unit.label?.sheet === "Q3 raw"),
    ).toBe(true);
  });

  test("the workbook stays read with its hidden sheets when the file changes", async () => {
    const { core, library } = await withWorkbook();
    const budget = (await core.listDocuments()).find((document) => document.name === "Budget 2026");
    if (!budget) throw new Error("No workbook.");

    await core.readHiddenSheets(budget.id);
    const [read] = await waitForProcessing(core, [budget.id]);
    if (!read) throw new Error("No workbook read.");

    await writeSourceFile(
      library,
      BUDGET,
      xlsxOf([
        {
          name: "Visible",
          rows: [
            ["Region", "Sales"],
            ["North", "10"],
          ],
        },
        { name: "Q3 raw", state: "hidden", rows: [["Secret"], ["1"]] },
      ]),
    );
    await core.reconcileDocuments();
    const updated = await vi.waitFor(
      async () => {
        const document = (await core.listDocuments()).find((each) => each.id === budget.id);
        if (!document || document.contentHash === read.contentHash || document.status !== "ready") {
          throw new Error("The workbook is not re-read yet.");
        }
        return document;
      },
      { timeout: 15_000, interval: 50 },
    );
    expect(updated.readHiddenSheets).toBe(true);
    const text = await core.readDocumentText(budget.id);
    expect(text.pages.some((unit) => unit.label?.sheet === "Q3 raw")).toBe(true);
  });

  test("an export says nothing about a workbook's hidden sheets or cut rows", async () => {
    const { core, folderId } = await withWorkbook();
    const { mind, check } = await mindOf(core, folderId, [SUPPORTED]);
    await check();

    const markdown = await markdownOf(core, mind.id);

    for (const said of [BUDGET, "Q3 raw", "Q4 raw", "Big", "After", "hidden sheets"]) {
      expect(markdown).not.toContain(said);
    }
    expect(markdown).not.toContain("couldn’t be read");
  });

  test("an export names neither the workbook nor its sheets, in every format", async () => {
    const { printed, printer } = fakePrinter();
    const { core, folderId } = await withWorkbook({ printer });
    const { mind, check } = await mindOf(core, folderId, [SUPPORTED]);
    await check();
    await citeTides(core, mind.id);

    const markdown = await markdownOf(core, mind.id);
    const html = new TextDecoder().decode(
      (await core.exportMind(mind.id, { format: "html" })).data,
    );
    const docx =
      unzip((await core.exportMind(mind.id, { format: "docx" })).data)
        .get("word/document.xml")
        ?.toString("utf8") ?? "";
    const before = printed.length;
    await core.exportMind(mind.id, { format: "pdf" });
    await core.exportMind(mind.id, { format: "source-pack" });
    const pdf = printed[before]?.body ?? "";
    const pack = printed[before + 1]?.body ?? "";

    for (const said of [markdown, html, docx, pdf, pack]) {
      for (const secret of [BUDGET, "Q3 raw", "Q4 raw", "Big", "After"]) {
        expect(said).not.toContain(secret);
      }
      for (const word of ["couldn’t be read", "hidden sheets", "weren’t read"]) {
        expect(said).not.toContain(word);
      }
    }
  });

  test("the AI use statement counts what the workbook left unread, and names no sheet", async () => {
    const { core, folderId } = await withWorkbook();
    const { mind, check } = await mindOf(core, folderId, [SUPPORTED, UNSUPPORTED]);
    await check();

    const statement = readMind(
      await connectToMind(core, (await core.createAiUseStatement(mind.id)).id),
    );

    expect(statement.textContent).toContain("2 hidden sheets weren’t read");
    expect(statement.textContent).not.toContain(BUDGET);
    expect(statement.textContent).not.toContain("Q3 raw");
  });

  test("a stored value that can't be read says some of it wasn't read, never that all was", async () => {
    const warnings: string[] = [];
    const log: Logger = {
      info: () => {},
      warn: (event) => warnings.push(event),
      error: () => {},
    };
    const { printed, printer } = fakePrinter();
    const { core, folderId, dataDir } = await withWorkbook({ log, printer });
    const { mind, check } = await mindOf(core, folderId, [SUPPORTED]);
    const budget = (await core.listDocuments()).find((document) => document.name === "Budget 2026");
    if (!budget) throw new Error("No workbook.");
    queryDatabase(dataDir, "UPDATE documents SET unread_parts = ? WHERE id = ?", [
      '{"hiddenSheets":"Q3 raw"}',
      budget.id,
    ]);
    await check();

    const found = (await core.listUnreadFiles(null)).find((file) => file.name === BUDGET);
    expect(found).toMatchObject({ reason: "parts" });
    expect(found?.parts).toBeUndefined();
    expect(
      (await core.listDocuments()).find((document) => document.id === budget.id)
        ?.unreadPartsUnknown,
    ).toBe(true);
    expect(warnings).toContain("documents.unreadPartsUnreadable");

    const out = await createTempDataFolder();
    await core.setOutputLocation(out);
    const saved = await core.saveCheckRecord(mind.id);
    if (saved.status !== "saved") throw new Error(`Not saved: ${saved.status}`);
    expect(printed[0]?.body ?? "").toContain("Budget 2026.xlsx: Some of it hasn’t been read.");
  });

  test("the check record names the workbook and what it didn't read, in English and Chinese", async () => {
    const out = await createTempDataFolder();
    const { printed, printer } = fakePrinter();
    const { core, folderId } = await withWorkbook({ printer });
    await core.setOutputLocation(out);
    const { mind, check } = await mindOf(core, folderId, [SUPPORTED]);
    await check();

    const saved = await core.saveCheckRecord(mind.id);

    if (saved.status !== "saved") throw new Error(`Not saved: ${saved.status}`);
    expect(printed[0]?.body ?? "").toContain(
      "Budget 2026.xlsx: the hidden sheets “Q3 raw”, “Q4 raw”",
    );
    const csvName = readdirSync(out).find((name) => name.endsWith(".csv"));
    const rows = parseCsv(readFileSync(join(out, csvName ?? ""), "utf8"));
    expect(rows.find((each) => each[0] === "What couldn’t be read")?.[1]).toContain(
      "“Big”: rows 20,000+ weren’t read; “After”: the whole sheet wasn’t read",
    );

    const chinese = await createTempDataFolder();
    await core.updateSettings({ user: { language: "zh-CN" } });
    await core.setOutputLocation(chinese);
    const again = await core.saveCheckRecord(mind.id);
    if (again.status !== "saved") throw new Error(`Not saved: ${again.status}`);
    const zhName = readdirSync(chinese).find((name) => name.endsWith(".csv"));
    const zhRows = parseCsv(readFileSync(join(chinese, zhName ?? ""), "utf8"));
    expect(zhRows.find((each) => each[0] === "未能读取的文件")?.[1]).toContain(
      "Budget 2026.xlsx：隐藏工作表“Q3 raw”、“Q4 raw”未读取；“Big”：第 20,000 行及之后的内容未读取；“After”：整张工作表未读取",
    );
  });
});
