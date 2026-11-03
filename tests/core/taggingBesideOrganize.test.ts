/**
 * Tagging beside Organize: with Folders in place and a model on this computer, one switch
 * decides whether new Documents are tagged and filed by themselves (#1617). Off, nothing is
 * sent for them, and Organize and a re-tag the User asks for still go. Through the core's
 * public interface, with a scripted model: no network.
 */
import { join } from "node:path";
import { APICallError } from "ai";
import { describe, expect, test, vi } from "vitest";
import { type Core, DATABASE_FILE, type Document } from "../../src/core";
import { openDatabase } from "../../src/core/storage";
import { createTempDataFolder, startCore } from "../helpers/core";
import { createSourceFolder, writeSourceFile } from "../helpers/documents";
import { scriptedModels } from "../helpers/models";
import { docxOf, xlsxOf } from "../helpers/office";
import { buildPdf } from "../helpers/pdf";
import { type ScriptedChat, scriptedChat } from "../helpers/scriptedChat";
import { tagNamed, tagNamesOf, waitForTagging } from "../helpers/tags";

const LOCAL = { kind: "ollama", modelId: "local-model" } as const;
const startOn = (dataDir: string, chat: ScriptedChat) =>
  startCore(dataDir, { createChatModel: scriptedModels(chat.model).createChatModel });

/** A core with a Folder and Organize allowed, filing new Documents by itself or not. */
async function start(automatic: boolean, dataDir?: string) {
  const directory = dataDir ?? (await createTempDataFolder());
  const chat = scriptedChat();
  const core = startOn(directory, chat);
  const provider = await core.saveChatProvider(LOCAL);
  const reports = await core.createLibraryGroup({ name: "Reports", description: "Reports" });
  const save = (filesByItself: boolean) =>
    core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: LOCAL.modelId } },
      automatic: filesByItself,
    });
  await save(automatic);
  return { core, chat, reports, dataDir: directory, save };
}

async function add(core: Core, files: Record<string, string | Uint8Array>): Promise<Document[]> {
  const folder = await createSourceFolder();
  const paths: string[] = [];
  for (const [name, contents] of Object.entries(files)) {
    paths.push(await writeSourceFile(folder, name, contents));
  }
  const { documents } = await core.addDocuments(paths);
  return waitForTagging(
    core,
    documents.map((each) => each.id),
    (each) => each.status === "ready",
  );
}

const assignmentsOf = async (core: Core) => (await core.getLibrary()).assignments;

/** Waits until Organize has filed each Document in `folderId`. */
const filed = (core: Core, ids: readonly string[], folderId: string) =>
  vi.waitFor(async () => {
    const assignments = await assignmentsOf(core);
    for (const id of ids) {
      expect(assignments.find((each) => each.documentId === id)).toMatchObject({
        groupId: folderId,
        status: "classified",
      });
    }
  });

describe("with tagging and sorting by themselves off", () => {
  test("a PDF, a Word file and a sheet get nothing by themselves: no request, no Tags, no Folder", async () => {
    const { core, chat } = await start(false);

    const added = await add(core, {
      "Annual report.pdf": buildPdf([
        { lines: ["Annual report", "Revenue grew in every region."] },
      ]),
      "Board minutes.docx": docxOf([{ text: "Minutes of the board meeting in March." }]),
      "Sales.xlsx": xlsxOf([
        {
          name: "Sales",
          rows: [
            ["Region", "Total"],
            ["North", 12],
          ],
        },
      ]),
    });

    for (const document of await core.listDocuments()) {
      expect(document.tags).toEqual([]);
      expect(document.tagging).toBe("off");
    }
    expect(added).toHaveLength(3);
    expect(chat.calls).toEqual([]);
    expect(await assignmentsOf(core)).toEqual([]);
  });

  test("Organize, run by hand, tags and files them, and keeps a Tag the User added", async () => {
    const { core, chat, reports } = await start(false);
    const [first, second] = await add(core, {
      "One.txt": "The first report, about revenue.",
      "Two.txt": "The second report, about costs.",
    });
    if (!first || !second) throw new Error("Nothing was added.");
    const book = await tagNamed(core, "Book");
    const report = await tagNamed(core, "Report");
    await core.addDocumentTag(first.id, book.id);
    chat.organizeTags([report.id]);

    await core.classifyDocuments();
    await filed(core, [first.id, second.id], reports.id);

    expect((await tagNamesOf(core, first.id)).sort()).toEqual(["Book", "Report"]);
    expect(await tagNamesOf(core, second.id)).toEqual(["Report"]);
    expect(chat.calls.map((call) => call.purpose)).toEqual(["organize", "organize"]);
  });

  test("Undo of that Organize run leaves the Tags", async () => {
    const { core, chat, reports } = await start(false);
    const [document] = await add(core, { "One.txt": "The first report, about revenue." });
    if (!document) throw new Error("Nothing was added.");
    chat.organizeTags([(await tagNamed(core, "Contract")).id]);
    await core.classifyDocuments([document.id]);
    await filed(core, [document.id], reports.id);
    expect(await tagNamesOf(core, document.id)).toEqual(["Contract"]);

    const held = (await core.getLibrary()).assignments.find(
      (each) => each.documentId === document.id,
    );
    if (!held) throw new Error("No assignment.");
    const { documentId: _id, tagging, ...assignment } = held;
    await core.restoreAssignment(
      document.id,
      { assignment: null, tagging: null },
      { assignment, tagging: tagging ?? null },
    );

    expect(await assignmentsOf(core)).toEqual([]);
    expect(await tagNamesOf(core, document.id)).toEqual(["Contract"]);
  });

  test("Re-tag, asked for by hand, works the Tags out and doesn't move the Document", async () => {
    const { core, chat } = await start(false);
    const [document] = await add(core, { "One.txt": "The first report, about revenue." });
    if (!document) throw new Error("Nothing was added.");
    expect(chat.calls).toEqual([]);

    await core.retagDocuments([document.id]);
    await waitForTagging(core, [document.id]);

    expect(chat.calls.map((call) => call.purpose)).toEqual(["tags"]);
    expect(await tagNamesOf(core, document.id)).toEqual(["Report"]);
    expect(await assignmentsOf(core)).toEqual([]);
  });

  test("Documents left pending, as an older version did, wait for nothing at the next start", async () => {
    const first = await start(false);
    const [document] = await add(first.core, { "One.txt": "The first report, about revenue." });
    if (!document) throw new Error("Nothing was added.");
    first.core.close();
    const db = openDatabase(join(first.dataDir, DATABASE_FILE));
    try {
      db.run("UPDATE documents SET tagging_status = 'pending'");
    } finally {
      db.close();
    }

    const chat = scriptedChat();
    const second = startOn(first.dataDir, chat);

    await vi.waitFor(async () =>
      expect((await second.listDocuments()).map((each) => each.tagging)).toEqual(["off"]),
    );
    expect(chat.calls).toEqual([]);
    expect(await assignmentsOf(second)).toEqual([]);
  });

  test("a failed re-tag shows why, and Retry tags it without filing it", async () => {
    const { core, chat } = await start(false);
    const [held] = await add(core, { "One.txt": "The first report, about revenue." });
    if (!held) throw new Error("Nothing was added.");
    chat.fail(
      new APICallError({
        message: "The model does not exist",
        url: "https://api.example.com/v1/messages",
        requestBodyValues: {},
        statusCode: 404,
        isRetryable: false,
      }),
    );
    await core.retagDocuments([held.id]);
    const [failed] = await waitForTagging(core, [held.id], (each) => each.tagging === "failed");
    expect(failed?.taggingError).toMatchObject({ kind: "model" });

    chat.fail(null);
    await core.retagDocuments([held.id]);
    await waitForTagging(core, [held.id]);
    expect(chat.calls.at(-1)?.purpose).toBe("tags");
    expect(await assignmentsOf(core)).toEqual([]);
  });
});

describe("with Organize moving new Documents by itself", () => {
  test("Organize tags and files them, and automatic tagging sends nothing", async () => {
    const { core, chat, reports } = await start(true);

    const [document] = await add(core, { "One.txt": "The first report, about revenue." });
    if (!document) throw new Error("Nothing was added.");
    await filed(core, [document.id], reports.id);
    await waitForTagging(core, [document.id]);

    expect(chat.calls.map((call) => call.purpose)).toEqual(["organize"]);
  });

  test("back online, a Document Organize couldn't reach the model for is organized again, once however many windows say so", async () => {
    const { core, chat, reports } = await start(true);
    chat.fail(
      new APICallError({
        message: "fetch failed",
        url: "http://127.0.0.1:11434/v1/chat/completions",
        requestBodyValues: {},
        isRetryable: false,
      }),
    );
    const [document] = await add(core, { "One.txt": "The first report, about revenue." });
    if (!document) throw new Error("Nothing was added.");
    const [failed] = await waitForTagging(core, [document.id], (each) => each.tagging === "failed");
    expect(failed?.taggingError).toMatchObject({ kind: "network" });
    const before = chat.calls.length;

    chat.fail(null);
    await Promise.all([core.backOnline(), core.backOnline()]);

    await filed(core, [document.id], reports.id);
    expect(chat.calls.slice(before).map((call) => call.purpose)).toEqual(["organize"]);
  });
});

describe("with the switch on, the work a quit or a hand interrupts", () => {
  test("quitting halfway picks up at the next start", async () => {
    const first = await start(true);
    first.chat.hold();
    const [document] = await add(first.core, { "One.txt": "The first report, about revenue." });
    if (!document) throw new Error("Nothing was added.");
    await vi.waitFor(() => expect(first.chat.calls).toHaveLength(1));
    first.core.close();
    first.chat.release();

    const chat = scriptedChat();
    const second = startOn(first.dataDir, chat);

    await filed(second, [document.id], first.reports.id);
    expect(chat.purposesFor("first report")).toEqual(["organize"]);
  });

  test("a Document Organize was asked to organize isn't worked on a second time by itself", async () => {
    const { core, chat, reports } = await start(true);
    chat.hold();
    const [first, second] = await add(core, {
      "One.txt": "The first report, about revenue.",
      "Two.txt": "The second report, about costs.",
    });
    if (!first || !second) throw new Error("Nothing was added.");
    await vi.waitFor(() => expect(chat.purposesFor("first report")).toEqual(["organize"]));

    await core.classifyDocuments([second.id]);
    chat.release();
    await filed(core, [first.id, second.id], reports.id);

    expect(chat.purposesFor("second report")).toEqual(["organize"]);
  });
});

describe("with Organize filing new Documents by itself, a Document it holds", () => {
  test("a Document Organize holds is re-tagged and filed by Organize", async () => {
    const { core, chat, reports } = await start(true);
    const [document] = await add(core, { "One.txt": "The first report, about revenue." });
    if (!document) throw new Error("Nothing was added.");
    await filed(core, [document.id], reports.id);
    const before = chat.calls.length;

    await core.retagDocuments([document.id]);

    await vi.waitFor(() => expect(chat.calls.length).toBe(before + 1));
    expect(chat.calls.at(-1)?.purpose).toBe("organize");
  });
});
