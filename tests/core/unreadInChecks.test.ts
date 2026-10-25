import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test, vi } from "vitest";
import { type Core, MIND_CHECK_UNREAD_FIELD, type UnreadFile } from "../../src/core";
import { MAX_ROWS } from "../../src/core/documents/formats/grid";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { checkUnreadOf } from "../../src/shared/unreadFiles";
import { checkingModel, type Plan } from "../helpers/checks";
import { createTempDataFolder, startCore } from "../helpers/core";
import { parseCsv } from "../helpers/csv";
import {
  createSourceFolder,
  linkAndProcess,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { paragraphsOf, unzip } from "../helpers/docx";
import { lockedPdf } from "../helpers/lockedPdf";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { scriptedModels } from "../helpers/models";
import { xlsxOf } from "../helpers/office";
import { buildPdf } from "../helpers/pdf";
import { fakePrinter } from "../helpers/printer";

/*
 * Checks say which files in their scope couldn't be read, and why (#740):
 * Find support, Check against Documents, Check this Mind and Verify keep, with the request
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
  const core = startCore(await createTempDataFolder(), {
    ...options,
    createChatModel: scriptedModels(checkingModel(PLANS)).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const harbour = await core.createLibraryGroup({ name: "Harbour", description: "" });
  await linkAndProcess(core, library, { groupId: harbour.id });
  return { core, folderId: harbour.id, library };
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
      action: "find-support",
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
  test("Find support in a Folder with a .doc, a locked PDF and a scan names the three, with their reasons", async () => {
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

  test("Check this Mind names the same three", async () => {
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
  test.each([
    ["en", "When these sentences were checked, 3 files they were checked against couldn’t be read"],
    ["zh-CN", "核对这些说法时，有 3 个文件未能读取"],
  ] as const)("lists what the checks couldn't read, with why (%s)", async (language, intro) => {
    const { core, folderId } = await withUnreadFiles();
    await core.updateSettings({ user: { language } });
    const { mind, check } = await mindOf(core, folderId, [SUPPORTED, UNSUPPORTED]);
    await check();

    const made = await core.createAiUseStatement(mind.id);
    const statement = readMind(await connectToMind(core, made.id));

    const texts: string[] = [];
    statement.forEach((node) => void texts.push(node.textContent));
    const at = texts.findIndex((each) => each.startsWith(intro));
    expect(at).toBeGreaterThan(-1);
    const list = statement.child(at + 1);
    expect(list.type.name).toBe("bulletList");
    const items: string[] = [];
    list.forEach((item) => void items.push(item.textContent));
    expect(items.sort()).toEqual(
      language === "en"
        ? [
            "Contract.doc: Format not read yet (.doc). Convert it to PDF, Word, PowerPoint or Excel.",
            "Locked.pdf: Password-protected. Remove the password and add it again.",
            "Scan.pdf: A scan with no text that could be recognized (handwriting or a picture, say).",
          ]
        : [
            "Contract.doc：暂不支持此格式（.doc）。请转换为 PDF、Word、PowerPoint 或 Excel。",
            "Locked.pdf：已设置密码。请去掉密码后重新添加。",
            "Scan.pdf：扫描件，未识别出文字（可能是手写内容或图片）。",
          ],
    );
  });

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
  test.each([
    [
      "en",
      {
        heading: "## What couldn’t be read",
        count: "3 files couldn’t be read",
        names: ["Contract.doc", "Locked.pdf", "Scan.pdf"],
        reasons: ["Format not read yet", "Password-protected", "A scan with no text"],
      },
    ],
    [
      "zh-CN",
      {
        heading: "## 未能读取的文件",
        count: "3 个文件未能读取",
        names: ["Contract.doc", "Locked.pdf", "Scan.pdf"],
        reasons: ["暂不支持此格式", "已设置密码", "扫描件"],
      },
    ],
  ] as const)(
    "counts what couldn't be read in the Mind's Search scope, without naming the files (%s)",
    async (language, words) => {
      const { core, folderId } = await withUnreadFiles();
      await core.updateSettings({ user: { language } });
      const { mind } = await mindOf(core, folderId, [SUPPORTED]);

      const markdown = await markdownOf(core, mind.id);

      expect(markdown).toContain(words.heading);
      expect(markdown).toContain(words.count);
      for (const name of words.names) expect(markdown).not.toContain(name);
      for (const reason of words.reasons) expect(markdown).not.toContain(reason);

      const heading = words.heading.replace("## ", "");
      const html = new TextDecoder().decode(
        (await core.exportMind(mind.id, { format: "html" })).data,
      );
      expect(html).toContain(`<h3>${heading}</h3>`);
      expect(html).toContain(words.count);
      for (const name of words.names) expect(html).not.toContain(name);

      const docx = await core.exportMind(mind.id, { format: "docx" });
      const document = unzip(docx.data).get("word/document.xml")?.toString("utf8") ?? "";
      const paragraphs = paragraphsOf(document).map((each) => each.text);
      expect(paragraphs).toContain(heading);
      expect(paragraphs).toContain(words.count);
      for (const name of words.names) expect(document).not.toContain(name);
    },
  );

  test("names the files when the Mind says so, and keeps that choice for that Mind alone", async () => {
    const { core, folderId } = await withUnreadFiles();
    const { mind } = await mindOf(core, folderId, [SUPPORTED]);

    const before = await core.previewMindExport(mind.id, { format: "markdown" });
    expect(before.unreadFiles).toBe(3);
    expect(before.unreadFileNames).toBe(false);

    await core.setMindUnreadFileNames(mind.id, true);
    const named = await markdownOf(core, mind.id);
    expect(named).toContain("- Contract.doc: Format not read yet (.doc)");
    expect(named).toContain("- Locked.pdf: Password-protected");
    expect(named).toContain("- Scan.pdf: A scan with no text");
    expect((await core.previewMindExport(mind.id, { format: "markdown" })).unreadFileNames).toBe(
      true,
    );

    const { mind: other } = await mindOf(core, folderId, [SUPPORTED]);
    const elsewhere = await markdownOf(core, other.id);
    expect(elsewhere).toContain("3 files couldn’t be read");
    expect(elsewhere).not.toContain("Contract.doc");

    await core.setMindUnreadFileNames(mind.id, false);
    expect(await markdownOf(core, mind.id)).not.toContain("Contract.doc");
  });

  test("a PDF export prints the count only", async () => {
    const { printed, printer } = fakePrinter();
    const { core, folderId } = await withUnreadFiles({ printer });
    const { mind } = await mindOf(core, folderId, [SUPPORTED]);

    await core.exportMind(mind.id, { format: "pdf" });

    const body = printed[0]?.body ?? "";
    expect(body).toContain("What couldn’t be read");
    expect(body).toContain("3 files couldn’t be read");
    expect(body).not.toContain("Contract.doc");
    expect(body).not.toContain("Locked.pdf");
    expect(body).not.toContain("Scan.pdf");
  });

  test.each([
    ["en", "1 file couldn’t be read"],
    ["zh-CN", "1 个文件未能读取"],
  ] as const)(
    "says it in the singular for one file, without naming it (%s)",
    async (language, count) => {
      const { core, folderId } = await linkedFolderWith({ "Old/Contract.doc": "binary" });
      await core.updateSettings({ user: { language } });
      const { mind } = await mindOf(core, folderId, [SUPPORTED]);

      const markdown = await markdownOf(core, mind.id);

      expect(markdown).toContain(count);
      expect(markdown).not.toContain("Contract.doc");
    },
  );

  test("says nothing when everything in the Mind's Search scope was read", async () => {
    const { core, folderId } = await linkedFolderWith({});
    const { mind } = await mindOf(core, folderId, [SUPPORTED]);

    const markdown = await markdownOf(core, mind.id);

    expect(markdown).not.toContain("couldn’t be read");
    expect(markdown).not.toContain("未能读取");
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

  test("an export counts them, and names them only when the Mind names the files", async () => {
    const { core, folderId } = await withWorkbook();
    const { mind } = await mindOf(core, folderId, [SUPPORTED]);

    const counted = await markdownOf(core, mind.id);
    expect(counted).toContain("1 file couldn’t be read");
    expect(counted).toContain("2 hidden sheets weren’t read");
    expect(counted).toContain("2 sheets have rows that weren’t read");
    expect(counted).not.toContain(BUDGET);
    expect(counted).not.toContain("Q3 raw");

    await core.setMindUnreadFileNames(mind.id, true);
    const named = await markdownOf(core, mind.id);
    expect(named).toContain(
      "Budget 2026.xlsx: the hidden sheets “Q3 raw”, “Q4 raw” weren’t read; “Big”: rows 20,000+ weren’t read; “After”: the whole sheet wasn’t read",
    );
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
