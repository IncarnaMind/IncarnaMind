import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import {
  type CheckRecordFormat,
  type CitationCheck,
  type ClaimCheckAttributes,
  type Document,
  GENERATED_MARK,
} from "../../src/core";
import { addSignOff, citationSignOffBasis } from "../../src/shared/signOffs";
import { setTextOrigin } from "../../src/shared/textOrigins";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { parseCsv } from "../helpers/csv";
import { addAndProcess, linkAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { writeMind } from "../helpers/minds";
import { fakePrinter } from "../helpers/printer";

/*
 * The check record (#738), as the User gets it: a PDF to file with the work and a CSV for their
 * own records, listing each checked sentence and each Citation with its result, the Document
 * version, the model and the time, and whose text it is. The fixture Mind holds one of each
 * result and each kind of text, so a row that goes missing or wrong fails.
 */

const NOW = "2026-10-16T09:00:00.000Z";
const CHECKED = "2026-10-15T14:20:00.000Z";
const QUOTE = "Spring tides happen at new moon.";

const text = (value: string, ...marks: { type: string; attrs?: object }[]): JSONContent => ({
  type: "text",
  text: value,
  ...(marks.length > 0 && { marks }),
});
const paragraph = (id: string, ...content: JSONContent[]): JSONContent => ({
  type: "paragraph",
  attrs: { id },
  content,
});

function citation(document: Document, check: CitationCheck): JSONContent {
  return {
    type: "citation",
    attrs: {
      passageId: "passage-1",
      documentId: document.id,
      documentName: "Tides",
      contentHash: document.contentHash,
      pageFrom: 1,
      pageTo: 1,
      quote: QUOTE,
      check,
      checkReason: check === "not-found" ? "quote-not-on-pages" : null,
    },
  };
}

type Model = { providerId: string; modelId: string };

function checked(
  document: Document,
  sentence: string,
  state: ClaimCheckAttributes["state"],
  model: Model,
  overrides: Partial<ClaimCheckAttributes> = {},
): ClaimCheckAttributes {
  const found = state === "supported" || state === "contradicted";
  return {
    id: randomUUID(),
    request: "request-1",
    action: "find-support",
    state,
    reason: state === "not-checked" ? "refused" : null,
    detail: null,
    ...model,
    text: sentence,
    evidence: found
      ? {
          passageId: "passage-1",
          documentId: document.id,
          documentName: "Tides",
          contentHash: document.contentHash,
          pageFrom: 1,
          pageTo: 1,
          location: null,
          quote: QUOTE,
          check: "found",
          checkReason: null,
        }
      : null,
    says: found ? "Tides says spring tides happen at new moon." : null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: true },
    versions: [{ documentId: document.id, contentHash: document.contentHash }],
    excluded: [],
    checkedAt: CHECKED,
    ...overrides,
  };
}

/** One parsed CSV row, by the header's names. */
type Row = Record<string, string>;

async function setUp(options: { printer?: ReturnType<typeof fakePrinter>["printer"] } = {}) {
  const dataDir = await createTempDataFolder();
  const sources = await createTempDataFolder();
  const out = await createTempDataFolder();
  const core = startCore(dataDir, { now: manualClock(NOW).now, ...options });
  const file = await writeSourceFile(sources, "Tides.txt", QUOTE);
  const [tides] = await addAndProcess(core, [file]);
  if (!tides) throw new Error("Tides was not added.");
  const local = await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const haiku = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: "claude-haiku-5-5",
  });
  const folder = await core.createLibraryGroup({ name: "Harbours", description: "" });
  await core.setOutputLocation(out);
  const mind = await core.createMind({ title: "Harbour notes", folderId: folder.id });
  const client = await connectToMind(core, mind.id);
  return {
    core,
    mind,
    client,
    tides,
    file,
    out,
    folderId: folder.id,
    localModel: { providerId: local.id, modelId: "local-model" },
    haikuModel: { providerId: haiku.id, modelId: "claude-haiku-5-5" },
  };
}

type Setup = Awaited<ReturnType<typeof setUp>>;

/** A Mind with every result and every kind of text. */
async function writeNotes({ core, mind, client, tides, folderId, localModel, haikuModel }: Setup) {
  const [own, ai, theirs, mixed] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const sentences = [
    ["Spring tides come at new moon.", "supported"],
    ["Penguins nest on the harbour cliffs.", "unsupported"],
    ["Nobody would say.", "not-checked"],
  ] as const;
  writeMind(client, [
    paragraph(
      own,
      ...sentences.flatMap(([sentence, state]) => [
        text(sentence, {
          type: "claimCheck",
          attrs: checked(tides, sentence, state, localModel, {
            scope: { folderId, widened: false },
          }),
        }),
        text(" "),
      ]),
      text("Fog rolls in from the sea.", {
        type: "claimCheck",
        attrs: checked(tides, "Fog rolls in from the sea.", "unsupported", localModel, {
          scope: { folderId, widened: false },
          unsupported: {
            reason: "Tides says nothing about fog.",
            covered: null,
            uncovered: null,
            found: true,
          },
        }),
      }),
    ),
    paragraph(
      ai,
      text("The Moon pulls the sea", { type: GENERATED_MARK }),
      citation(tides, "found"),
      text("."),
    ),
    {
      type: "answer",
      attrs: { id: randomUUID(), status: "done", generatedMarks: true, ...haikuModel },
      content: [
        paragraph(randomUUID(), text("The tides follow the Moon."), citation(tides, "not-found")),
      ],
    },
    paragraph(
      theirs,
      text("Their report says tides follow the Moon.", {
        type: "claimCheck",
        attrs: checked(
          tides,
          "Their report says tides follow the Moon.",
          "contradicted",
          haikuModel,
        ),
      }),
    ),
    paragraph(mixed, text("I read it in the harbour office"), citation(tides, "found"), text(".")),
  ]);
  await client.settled();
  setTextOrigin(client.doc, [theirs], "imported");
  await client.settled();
  await core.recordAiUse([
    { mindId: mind.id, kind: "answer-added", characters: 24, blockIds: [ai], ...localModel },
  ]);
}

async function saveRecord(
  { core, mind, out }: Pick<Setup, "core" | "mind" | "out">,
  format: CheckRecordFormat,
) {
  const saved = await core.saveCheckRecord(mind.id);
  if (saved.status !== "saved") throw new Error(`Not saved: ${saved.status}`);
  const name = `${saved.file.name.replace(/\.(pdf|csv)$/, "")}.${format}`;
  return { name, path: join(out, name), files: readdirSync(out).sort(), saved };
}

const rowsOf = (csv: string): Row[] => {
  const table = parseCsv(csv);
  const at = table.findIndex((each) => each.length === 0 || (each.length === 1 && each[0] === ""));
  const [header = [], ...rows] = table.slice(at + 1);
  return rows.map((each) => Object.fromEntries(header.map((name, i) => [name, each[i] ?? ""])));
};

const summaryOf = (csv: string): Map<string, string> =>
  new Map(
    parseCsv(csv)
      .slice(1, 8)
      .map(([name = "", value = ""]) => [name, value]),
  );

describe("The check record as CSV", () => {
  test("lists each checked sentence and each Citation with its result, the Document version, model, time and text", async () => {
    const setup = await setUp();
    await writeNotes(setup);

    const saved = await saveRecord(setup, "csv");

    expect(saved.name).toBe("Check record – Harbour notes.csv");
    const csv = readFileSync(saved.path, "utf8");
    expect(csv.startsWith("\uFEFF")).toBe(true);
    const rows = rowsOf(csv);
    const sha256 = createHash("sha256").update(readFileSync(setup.file)).digest("hex");
    const size = statSync(setup.file).size;
    const tidesVersion = {
      Document: "Tides",
      File: basename(setup.file),
      "Size (bytes)": String(size),
      "SHA-256": sha256,
      Location: "p. 1",
      Quote: QUOTE,
    };
    const local = { Model: "local-model", Service: "On this computer" };
    const haiku = { Model: "Claude Haiku 5.5", Service: "Anthropic" };
    const incarnaMind = { Model: "IncarnaMind", Service: "On this computer" };
    const none = {
      Document: "",
      File: "",
      "Size (bytes)": "",
      "SHA-256": "",
      Location: "",
      Quote: "",
    };

    expect(
      rows.map((row) => ({
        Kind: row.Kind,
        Sentence: row.Sentence,
        Result: row.Result,
        Text: row.Text,
        Document: row.Document,
        File: row.File,
        "Size (bytes)": row["Size (bytes)"],
        "SHA-256": row["SHA-256"],
        Location: row.Location,
        Quote: row.Quote,
        Model: row.Model,
        Service: row.Service,
        Checked: row["Checked (UTC)"],
      })),
    ).toEqual([
      {
        Kind: "Sentence",
        Sentence: "Spring tides come at new moon.",
        Result: "Supported",
        Text: "Your text",
        ...tidesVersion,
        ...local,
        Checked: CHECKED,
      },
      {
        Kind: "Sentence",
        Sentence: "Penguins nest on the harbour cliffs.",
        Result: "Not found",
        Text: "Your text",
        ...none,
        ...local,
        Checked: CHECKED,
      },
      {
        Kind: "Sentence",
        Sentence: "Nobody would say.",
        Result: "Not checked",
        Text: "Your text",
        ...none,
        Model: "",
        Service: "",
        Checked: "",
      },
      {
        Kind: "Sentence",
        Sentence: "Fog rolls in from the sea.",
        Result: "Unsupported",
        Text: "Your text",
        ...none,
        ...local,
        Checked: CHECKED,
      },
      {
        Kind: "Sentence",
        Sentence: "Their report says tides follow the Moon.",
        Result: "Contradicted",
        Text: "Someone else’s text",
        ...tidesVersion,
        ...haiku,
        Checked: CHECKED,
      },
      {
        Kind: "Citation",
        Sentence: "The Moon pulls the sea.",
        Result: "Quote found",
        Text: "AI text",
        ...tidesVersion,
        ...incarnaMind,
        Checked: "",
      },
      {
        Kind: "Citation",
        Sentence: "The tides follow the Moon.",
        Result: "Quote not found",
        Text: "AI text",
        ...tidesVersion,
        ...incarnaMind,
        Checked: "",
      },
      {
        Kind: "Citation",
        Sentence: "I read it in the harbour office.",
        Result: "Quote found",
        Text: "Your text",
        ...tidesVersion,
        ...incarnaMind,
        Checked: "",
      },
    ]);
    expect(rows[0]?.["What it says"]).toBe("Tides says spring tides happen at new moon.");
  });

  test("starts with the summary: the Mind, the date, the Folder, Local mode, the models and the counts", async () => {
    const setup = await setUp();
    await writeNotes(setup);

    const csv = readFileSync((await saveRecord(setup, "csv")).path, "utf8");

    const summary = summaryOf(csv);
    expect(parseCsv(csv)[0]).toEqual(["Check record: Harbour notes"]);
    expect(summary.get("Exported (UTC)")).toBe(NOW);
    expect(summary.get("Documents searched")).toBe("Harbours; All Documents");
    expect(summary.get("“Keep everything on this computer” when exported")).toBe("Off");
    expect(summary.get("Models")).toBe(
      "Claude Haiku 5.5 (Anthropic), 1 sentence check; local-model (On this computer), 3 sentence checks",
    );
    expect(summary.get("Sentences")).toBe(
      "Supported 1; Not found 1; Not checked 1; Unsupported 1; Contradicted 1",
    );
    expect(summary.get("Citations")).toBe("Quote found 2; Quote not found 1");

    await setup.core.setLocalOnly(true);
    const on = readFileSync((await saveRecord(setup, "csv")).path, "utf8");
    expect(summaryOf(on).get("“Keep everything on this computer” when exported")).toBe("On");
  });

  test("a Mind nothing was checked in says nothing was searched and no model was used, and still has its header", async () => {
    const { core, out } = await setUp();
    const mind = await core.createMind({ title: "Empty" });

    const saved = await core.saveCheckRecord(mind.id);

    expect(saved.status).toBe("saved");
    const csv = readFileSync(`${out}/Check record – Empty.csv`, "utf8");
    expect(summaryOf(csv).get("Documents searched")).toBe("None");
    expect(summaryOf(csv).get("Models")).toBe("None");
    expect(rowsOf(csv)).toEqual([]);
    expect(parseCsv(csv).some((row) => row[0] === "Kind" && row[1] === "Sentence")).toBe(true);
  });

  test("a quote that starts like a formula can't run in a spreadsheet, and commas, quotes and line breaks stay in their cell", async () => {
    const setup = await setUp();
    const { client, tides, localModel } = setup;
    const sentence = '=HYPERLINK("http://example.invalid"), said "them",\nand more.';
    writeMind(client, [
      paragraph(
        randomUUID(),
        text(sentence, {
          type: "claimCheck",
          attrs: checked(tides, sentence, "unsupported", localModel),
        }),
      ),
    ]);
    await client.settled();

    const csv = readFileSync((await saveRecord(setup, "csv")).path, "utf8");

    const [row] = rowsOf(csv);
    expect(row?.Sentence).toBe(
      `'${'=HYPERLINK("http://example.invalid"), said "them", and more.'}`,
    );
  });

  test("a quote a PDF's line end cut at a hyphen is listed as whole words", async () => {
    const setup = await setUp();
    const sources = await createTempDataFolder();
    const [harbour] = (await addAndProcess(setup.core, [
      await writeSourceFile(
        sources,
        "Harbour.txt",
        "The committee will review the case for the exist-\nence of tides near the pier.",
      ),
    ])) as [Document];
    writeMind(setup.client, [
      paragraph(
        randomUUID(),
        text("The committee will review the case"),
        {
          type: "citation",
          attrs: {
            passageId: "passage-2",
            documentId: harbour.id,
            documentName: "Harbour",
            contentHash: harbour.contentHash,
            pageFrom: 1,
            pageTo: 1,
            quote: "The committee will review the case for the exist-",
            check: "found",
            checkReason: null,
          },
        },
        text("."),
      ),
    ]);
    await setup.client.settled();

    const csv = readFileSync((await saveRecord(setup, "csv")).path, "utf8");

    expect(rowsOf(csv).map((row) => row.Quote)).toEqual([
      "The committee will review the case for the existence",
    ]);
  });

  test("in Chinese, the summary, headings, results and file name are Chinese", async () => {
    const setup = await setUp();
    await writeNotes(setup);
    await setup.core.updateSettings({ user: { language: "zh-CN" } });

    const saved = await saveRecord(setup, "csv");

    expect(saved.name).toBe("核对记录 – Harbour notes.csv");
    const csv = readFileSync(saved.path, "utf8");
    expect(parseCsv(csv)[0]).toEqual(["核对记录：Harbour notes"]);
    const summary = summaryOf(csv);
    expect(summary.get("导出时间（UTC）")).toBe(NOW);
    expect(summary.get("搜索范围")).toBe("Harbours; 全部文档");
    expect(summary.get("AI 模型")).toBe(
      "Claude Haiku 5.5（Anthropic），1 次句子核对; local-model（在这台电脑上），3 次句子核对",
    );
    expect(summary.get("导出时“所有内容都留在这台电脑上”")).toBe("未开启");
    const [first] = rowsOf(csv);
    const citationRow = rowsOf(csv).find((row) => row.类型 === "引用");
    // Not found is its own result, apart from Unsupported, in Chinese too.
    expect(
      rowsOf(csv)
        .filter((row) => row.类型 === "句子")
        .map((row) => row.核对结果),
    ).toEqual(["有依据", "未找到", "未核对", "无依据", "与文档矛盾"]);
    expect(first).toMatchObject({
      类型: "句子",
      核对结果: "有依据",
      文字来源: "你写的文字",
      文档: "Tides",
      位置: "第 1 页",
      服务: "在这台电脑上",
    });
    expect(citationRow).toMatchObject({
      类型: "引用",
      核对结果: "找到引文",
      文字来源: "AI 生成的文字",
      模型: "IncarnaMind",
      服务: "在这台电脑上",
    });
  });
});

describe("A person's own check in the check record", () => {
  // protects=a Citation the User marked Checked by me is listed with their name and when, apart from IncarnaMind's result, and as changed once its sentence changes (#1933); fails_when=the column is empty, says "you", or still says checked after the edit; no_claim=the PDF's layout.
  test("lists who checked a Citation and when, beside IncarnaMind's result, and that it changed since", async () => {
    const setup = await setUp();
    const { client, tides } = setup;
    const cited = { ...citation(tides, "found") };
    cited.attrs = { ...cited.attrs, id: "citation-1" };
    const write = (words: string) =>
      writeMind(client, [paragraph("own", text(words), cited, text("."))]);
    write("The Moon pulls the sea");
    await client.settled();
    addSignOff(client.doc, {
      id: randomUUID(),
      target: { kind: "citation", id: "citation-1" },
      at: "2026-10-16T08:30:00.000Z",
      contentHash: citationSignOffBasis("The Moon pulls the sea\uFFFC.", {
        documentId: tides.id,
        contentHash: tides.contentHash,
        quote: QUOTE,
      }),
      deletedAt: null,
      name: "Ada Lovelace",
      personId: "person-1",
    });
    await client.settled();

    const personOf = async () => {
      const csv = readFileSync((await saveRecord(setup, "csv")).path, "utf8");
      return rowsOf(csv).find((row) => row.Kind === "Citation")?.["Checked by a person"];
    };
    expect(await personOf()).toBe("Ada Lovelace · 2026-10-16T08:30:00.000Z");

    write("The Moon pulls every sea");
    await client.settled();
    expect(await personOf()).toBe("Ada Lovelace · 2026-10-16T08:30:00.000Z · changed since");
  });
});

describe("#1933's acceptance: ten Citations, six marked, one edited, then sent", () => {
  // protects=#1933's acceptance criterion, with the edited mark kept as changed: of six Citations the User marked, the one whose sentence was edited shows as changed since, the record lists IncarnaMind's result for all ten and five checked by the person, and History keeps the Note as it was sent; fails_when=a count or the sent version is wrong; no_claim=the Word file's contents.
  test("the record lists five checked by the person, one changed since, every result, and History the export", async () => {
    const setup = await setUp();
    const { core, client, tides, mind, out } = setup;
    const lines = Array.from({ length: 10 }, (_, index) => `Line ${index + 1} cites the tides`);
    const write = (edited: number | null) =>
      writeMind(
        client,
        lines.map((line, index) =>
          paragraph(
            `p${index}`,
            text(index === edited ? `${line} again` : line),
            {
              ...citation(tides, "found"),
              attrs: { ...citation(tides, "found").attrs, id: `c${index}` },
            },
            text("."),
          ),
        ),
      );
    write(null);
    await client.settled();
    for (const index of [0, 1, 2, 3, 4, 5]) {
      addSignOff(client.doc, {
        id: randomUUID(),
        target: { kind: "citation", id: `c${index}` },
        at: "2026-10-16T08:30:00.000Z",
        contentHash: citationSignOffBasis(`${lines[index]}\uFFFC.`, {
          documentId: tides.id,
          contentHash: tides.contentHash,
          quote: QUOTE,
        }),
        deletedAt: null,
        name: "Ada Lovelace",
        personId: "person-1",
      });
    }
    await client.settled();
    write(2);
    await client.settled();
    const sent = await core.saveMindExport(mind.id, { format: "docx" });
    if (sent.status !== "saved") throw new Error(`Not saved: ${sent.status}`);

    const rows = rowsOf(
      readFileSync((await saveRecord({ core, mind, out }, "csv")).path, "utf8"),
    ).filter((row) => row.Kind === "Citation");
    expect(rows).toHaveLength(10);
    expect(rows.every((row) => row.Result === "Quote found")).toBe(true);
    const people = rows.map((row) => row["Checked by a person"]);
    expect(
      people.filter((each) => each === "Ada Lovelace · 2026-10-16T08:30:00.000Z"),
    ).toHaveLength(5);
    expect(people.filter((each) => each?.endsWith("changed since"))).toHaveLength(1);
    expect(people.filter((each) => each === "")).toHaveLength(4);
    const { checkpoints } = await core.listCheckpoints(mind.id);
    expect(checkpoints.find((each) => each.reason === "export")?.file).toBe(sent.file.name);
  });
});

describe("What the check record can't know", () => {
  const sentence = "Spring tides come at new moon.";
  async function checkedBy(setup: Setup, model: Model) {
    writeMind(setup.client, [
      paragraph(
        randomUUID(),
        text(sentence, {
          type: "claimCheck",
          attrs: checked(setup.tides, sentence, "supported", model, {
            scope: { folderId: setup.folderId, widened: false },
          }),
        }),
      ),
    ]);
    await setup.client.settled();
  }

  test("a model whose provider was removed since says its service isn't recorded, not that it ran on this computer", async () => {
    const setup = await setUp();
    await checkedBy(setup, setup.haikuModel);
    await setup.core.deleteChatProvider(setup.haikuModel.providerId);

    const csv = readFileSync((await saveRecord(setup, "csv")).path, "utf8");

    expect(rowsOf(csv).map((row) => [row.Model, row.Service])).toEqual([
      ["Claude Haiku 5.5", "Not recorded"],
    ]);
    expect(summaryOf(csv).get("Models")).toBe("Claude Haiku 5.5 (Not recorded), 1 sentence check");

    await setup.core.updateSettings({ user: { language: "zh-CN" } });
    const zh = readFileSync((await saveRecord(setup, "csv")).path, "utf8");
    expect(rowsOf(zh).map((row) => [row.模型, row.服务])).toEqual([["Claude Haiku 5.5", "未记录"]]);
  });

  test("a check whose mark names no model says so", async () => {
    const setup = await setUp();
    await checkedBy(setup, { providerId: "", modelId: "" });

    const csv = readFileSync((await saveRecord(setup, "csv")).path, "utf8");

    expect(rowsOf(csv).map((row) => [row.Model, row.Service, row["Checked (UTC)"]])).toEqual([
      ["Not recorded", "", CHECKED],
    ]);
    expect(summaryOf(csv).get("Models")).toBe("Not recorded, 1 sentence check");
  });

  test("a Document deleted since says so where its file and size would be, and its hash stays", async () => {
    const { printed, printer } = fakePrinter();
    const setup = await setUp({ printer });
    await checkedBy(setup, setup.localModel);
    await setup.core.deleteDocument(setup.tides.id);

    const csv = readFileSync((await saveRecord(setup, "csv")).path, "utf8");
    await saveRecord(setup, "pdf");

    const [row] = rowsOf(csv);
    expect(row).toMatchObject({
      Document: "Tides",
      File: "Document deleted",
      "Size (bytes)": "",
      "SHA-256": setup.tides.contentHash,
    });
    expect(printed[0]?.body).toContain("File</span> Document deleted ·");

    await setup.core.updateSettings({ user: { language: "zh-CN" } });
    const zh = readFileSync((await saveRecord(setup, "csv")).path, "utf8");
    expect(rowsOf(zh)[0]?.文件).toBe("文档已删除");
  });

  test("the Documents searched are the ones the checks searched: a Folder, everything, a Folder since deleted, or the Mind's chosen scope, a Linked folder's included", async () => {
    const setup = await setUp();
    const own = { folderId: setup.folderId, widened: false };
    const gone = await setup.core.createLibraryGroup({ name: "Old harbours", description: "" });
    const notes = join(await createTempDataFolder(), "Notes");
    await writeSourceFile(notes, "Holiday.md", "# Holiday\n\nLeave is 25 days.\n");
    await linkAndProcess(setup.core, notes);
    const linked = (await setup.core.listFolders()).find((folder) => folder.name === "Notes");
    if (!linked) throw new Error("The Linked folder has no Folder.");
    const chosen = (scope: Partial<{ folderIds: string[]; documentIds: string[] }>) => ({
      folderId: setup.folderId,
      widened: false,
      chosen: { folderIds: [], tagIds: [], documentIds: [], ...scope },
    });
    const checks = [
      ["Spring tides come at new moon.", own],
      ["Neap tides are weaker.", { folderId: null, widened: true }],
      ["Tidal ranges differ between harbours.", { folderId: gone.id, widened: false }],
      ["High water comes later each day.", chosen({ documentIds: [setup.tides.id] })],
      ["Leave is 25 days.", chosen({ folderIds: [linked.id] })],
    ] as const;
    writeMind(setup.client, [
      paragraph(
        randomUUID(),
        ...checks.flatMap(([sentence, scope]) => [
          text(sentence, {
            type: "claimCheck",
            attrs: checked(setup.tides, sentence, "supported", setup.localModel, { scope }),
          }),
          text(" "),
        ]),
      ),
    ]);
    await setup.client.settled();
    await setup.core.deleteLibraryGroup(gone.id);

    const csv = readFileSync((await saveRecord(setup, "csv")).path, "utf8");

    expect(summaryOf(csv).get("Documents searched")).toBe(
      "Harbours; All Documents; A deleted Folder; Tides; Notes",
    );
  });

  test("times are in UTC in both formats, with the year", async () => {
    const { printed, printer } = fakePrinter();
    const setup = await setUp({ printer });
    await checkedBy(setup, setup.localModel);

    const csv = readFileSync((await saveRecord(setup, "csv")).path, "utf8");
    await saveRecord(setup, "pdf");

    expect(rowsOf(csv)[0]?.["Checked (UTC)"]).toBe(CHECKED);
    expect(printed[0]?.body).toContain("15 Oct 2026, 14:20 UTC");
  });
});

describe("The check record as PDF", () => {
  test("is printed with the summary, each item and a footer saying what it is", async () => {
    const { printed, printer } = fakePrinter();
    const setup = await setUp({ printer });
    await writeNotes(setup);
    await setup.core.setLocalOnly(true);

    const saved = await saveRecord(setup, "pdf");

    expect(saved.name).toBe("Check record – Harbour notes.pdf");
    expect(readFileSync(saved.path, "utf8")).toBe("%PDF-stand-in");
    const [document] = printed;
    expect(document).toMatchObject({
      language: "en",
      title: "Check record – Harbour notes",
      notes: [],
      footer:
        "This record lists what IncarnaMind checked and how. “Quote found” means the quoted words are on that page; it doesn’t mean they support the sentence.",
    });
    const body = document?.body ?? "";
    const sha256 = createHash("sha256").update(readFileSync(setup.file)).digest("hex");
    expect(body).toContain("Check record: Harbour notes");
    expect(body).toContain("16 Oct 2026, 09:00 UTC");
    expect(body).toContain("<div>Harbours</div><div>All Documents</div>");
    expect(body).toContain(
      '<th scope="row">“Keep everything on this computer” when exported</th><td><div>On</div></td>',
    );
    expect(body).toContain(
      "<div>Claude Haiku 5.5 (Anthropic), 1 sentence check</div><div>local-model (On this computer), 3 sentence checks</div>",
    );
    expect(body).toContain("Sentences checked against the Documents (5)");
    expect(body).toContain("Citations (3)");
    for (const sentence of [
      "Spring tides come at new moon.",
      "Penguins nest on the harbour cliffs.",
      "Their report says tides follow the Moon.",
    ]) {
      expect(body).toContain(sentence);
    }
    expect(body).toContain(
      "Checked by</span> Claude Haiku 5.5 (Anthropic) · 15 Oct 2026, 14:20 UTC",
    );
    expect(body).toContain("Checked by</span> IncarnaMind (On this computer)</p>");
    expect(body).toContain(
      `<code class="record-hash">${sha256.slice(0, 4)}…${sha256.slice(-4)}</code>`,
    );
    expect(body).not.toContain(sha256);
    expect(body).toContain("Contradicted</b> · Sentence · Someone else’s text");
    expect(body).toContain("Quote not found</b> · Citation · AI text");
    expect(body.match(/class="record-shape"/g)).toHaveLength(8);
  });

  test("shows the Mind's words as text: markup in a sentence or a quote is escaped", async () => {
    const { printed, printer } = fakePrinter();
    const setup = await setUp({ printer });
    const sentence = "<img src=x onerror=alert(1)> is not a picture.";
    writeMind(setup.client, [
      paragraph(
        randomUUID(),
        text(sentence, {
          type: "claimCheck",
          attrs: checked(setup.tides, sentence, "supported", setup.localModel),
        }),
      ),
    ]);
    await setup.client.settled();

    await saveRecord(setup, "pdf");

    const body = printed[0]?.body ?? "";
    expect(body).not.toContain("<img");
    expect(body).toContain("&lt;img src=x onerror=alert(1)&gt; is not a picture.");
  });

  test("in Chinese, the PDF's words and footer are Chinese", async () => {
    const { printed, printer } = fakePrinter();
    const setup = await setUp({ printer });
    await writeNotes(setup);
    await setup.core.updateSettings({ user: { language: "zh-CN" } });

    await saveRecord(setup, "pdf");

    expect(printed[0]).toMatchObject({
      language: "zh-CN",
      title: "核对记录 – Harbour notes",
      footer:
        "本记录列出 IncarnaMind 核对了什么、怎样核对。“找到引文”只说明引文的文字在那一页上，不说明它支持这句话。",
    });
    expect(printed[0]?.body).toContain("核对记录：Harbour notes");
    expect(printed[0]?.body).toContain("对照文档核对的句子（5）");
    expect(printed[0]?.body).toContain("核对方式</span> IncarnaMind（在这台电脑上）</p>");
    expect(printed[0]?.body).toContain("2026年10月15日 14:20 UTC");
  });

  test("a sentence no check ran for lists no model and no time", async () => {
    const { printed, printer } = fakePrinter();
    const setup = await setUp({ printer });
    await writeNotes(setup);

    await saveRecord(setup, "pdf");

    const body = printed[0]?.body ?? "";
    const refused = body.slice(body.indexOf("Nobody would say."));
    expect(refused.slice(0, refused.indexOf("</div>"))).not.toContain("Checked by");
  });
});

describe("Saving a check record", () => {
  test("writes the PDF and the CSV side by side under one name, and says so in one result", async () => {
    const { printer } = fakePrinter();
    const setup = await setUp({ printer });
    await writeNotes(setup);

    const saved = await setup.core.saveCheckRecord(setup.mind.id);

    expect(saved).toMatchObject({
      status: "saved",
      file: { name: "Check record – Harbour notes.pdf", defaulted: false },
      withCsv: true,
      failures: [],
    });
    expect(readdirSync(setup.out).sort()).toEqual([
      "Check record – Harbour notes.csv",
      "Check record – Harbour notes.pdf",
    ]);

    const second = await setup.core.saveCheckRecord(setup.mind.id);
    expect(second).toMatchObject({ file: { name: "Check record – Harbour notes 2.pdf" } });
    expect(readdirSync(setup.out).sort()).toEqual([
      "Check record – Harbour notes 2.csv",
      "Check record – Harbour notes 2.pdf",
      "Check record – Harbour notes.csv",
      "Check record – Harbour notes.pdf",
    ]);
  });

  test("a copy with no printer, or a printer that fails, keeps the CSV and says the PDF wasn't saved and why", async () => {
    const bare = await setUp();

    const without = await bare.core.saveCheckRecord(bare.mind.id);

    expect(without).toMatchObject({
      status: "saved",
      file: { name: "Check record – Harbour notes.csv" },
      withCsv: false,
      failures: [
        {
          format: "pdf",
          message: "This copy of IncarnaMind can’t make PDFs.",
          wording: { key: "error.checkRecord.noPdf" },
        },
      ],
    });
    expect(readdirSync(bare.out)).toEqual(["Check record – Harbour notes.csv"]);

    const broken = await setUp({
      printer: {
        print: async () => {
          throw new Error("The PDF took too long to lay out.");
        },
      },
    });
    const failed = await broken.core.saveCheckRecord(broken.mind.id);
    expect(failed).toMatchObject({
      withCsv: false,
      failures: [
        {
          format: "pdf",
          message: "Couldn’t lay out the PDF.",
          wording: { key: "error.pdf.notLaidOut" },
        },
      ],
    });
    expect(readdirSync(broken.out)).toEqual(["Check record – Harbour notes.csv"]);
  });

  test("a Mind that isn't there is refused, and the Mind it is of is left as it was", async () => {
    const setup = await setUp({ printer: fakePrinter().printer });
    await writeNotes(setup);
    const before = (await setup.core.openMind(setup.mind.id)).state;

    await setup.core.saveCheckRecord(setup.mind.id);
    await expect(setup.core.saveCheckRecord(randomUUID())).rejects.toThrow();

    expect((await setup.core.openMind(setup.mind.id)).state).toEqual(before);
  });
});
