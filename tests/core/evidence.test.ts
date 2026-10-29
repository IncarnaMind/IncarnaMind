import { appendFile, copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type CoreAdapters, type EvidenceSearchResult, InvalidInputError } from "../../src/core";
import { askAndFinish } from "../helpers/citations";
import { createTempDataFolder, nextEvent, queryDatabase, startCore } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  linkAndProcess,
  sha256,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { exportMind, indexed, linkWithExports } from "../helpers/evidence";
import { connectToMind } from "../helpers/mindClient";
import { note, writeMind } from "../helpers/minds";
import { scriptedModel, scriptedModels } from "../helpers/models";

const MOON =
  "Spring tides happen at new moon and at full moon, when the Sun and the Moon pull together.";
const NOTE = "Spring tides come twice a month, at new moon and at full moon.";

/** The Documents a search's evidence came from, by name. */
const evidenceFrom = (found: EvidenceSearchResult) => [
  ...new Set(found.passages.map((passage) => passage.documentName)),
];

/**
 * A core with a Linked folder "Papers" holding the User's own note on the
 * Moon, the Output location inside it ("Papers/Exports"), and new files there allowed.
 */
async function setUp(overrides: Partial<CoreAdapters> = {}) {
  const data = await createTempDataFolder();
  const core = startCore(data, overrides);
  const { papers, documents } = await linkWithExports(core, [{ name: "Moon.txt", contents: MOON }]);
  const [moon] = documents;
  if (!moon) throw new Error("The Moon note wasn't indexed.");
  return { core, data, papers, moon };
}

describe("Files IncarnaMind wrote aren't evidence", () => {
  test("a Word export saved into a Linked folder is indexed as IncarnaMind's, and a check's search leaves it out, naming where it matched; ordinary search still finds it", async () => {
    const { core, moon } = await setUp();
    const exported = await exportMind(core, "Tides", NOTE);
    expect(exported).toMatchObject({
      name: "Tides",
      kind: "docx",
      status: "ready",
      ownFile: { kind: "export", counted: false },
    });
    expect(moon.ownFile).toBeNull();

    // Ordinary Answers search it as before.
    const ordinary = await core.searchPassages("spring tides full moon");
    expect(new Set(ordinary.map((passage) => passage.documentId))).toEqual(
      new Set([moon.id, exported.id]),
    );

    // A check's evidence is the User's note only; the export is named, with where it matched.
    const found = await core.searchEvidence("spring tides full moon");
    expect(evidenceFrom(found)).toEqual(["Moon"]);
    expect(found.excluded).toEqual([
      {
        documentId: exported.id,
        documentName: "Tides",
        reason: "own-file",
        passages: [
          expect.objectContaining({
            documentId: exported.id,
            text: expect.stringContaining(NOTE),
          }),
        ],
      },
    ]);
  });

  test("with the switch off in Settings, or in its Folder, IncarnaMind's files may be evidence", async () => {
    const { core } = await setUp();
    const exported = await exportMind(core, "Tides", NOTE);

    await core.updateSettings({ user: { leaveOutOwnFiles: false } });
    const everywhere = await core.searchEvidence("spring tides");
    expect(evidenceFrom(everywhere).sort()).toEqual(["Moon", "Tides"]);
    expect(everywhere.excluded).toEqual([]);
    await core.updateSettings({ user: { leaveOutOwnFiles: true } });
    expect(evidenceFrom(await core.searchEvidence("spring tides"))).toEqual(["Moon"]);

    // A Folder that counts IncarnaMind's files: its own, and only its own.
    const drafts = await core.createLibraryGroup({
      name: "Drafts",
      description: "Earlier drafts",
      countsOwnFiles: true,
    });
    expect(drafts.countsOwnFiles).toBe(true);
    await core.moveToFolder({ documentIds: [exported.id], folderId: drafts.id });
    expect(evidenceFrom(await core.searchEvidence("spring tides")).sort()).toEqual([
      "Moon",
      "Tides",
    ]);
    // Renamed without saying, the switch stays; switched off, the export is left out again.
    const renamed = await core.updateLibraryGroup(drafts.id, {
      name: "Old drafts",
      description: "Earlier drafts",
    });
    expect(renamed.countsOwnFiles).toBe(true);
    await core.updateLibraryGroup(drafts.id, {
      name: "Old drafts",
      description: "Earlier drafts",
      countsOwnFiles: false,
    });
    expect(evidenceFrom(await core.searchEvidence("spring tides"))).toEqual(["Moon"]);
    await expect(
      core.updateLibraryGroup(drafts.id, {
        name: "Old drafts",
        description: "",
        countsOwnFiles: "yes" as unknown as boolean,
      }),
    ).rejects.toThrow(InvalidInputError);
  });

  test("Count it makes one Document count from then on, and taking it back leaves it out again; only IncarnaMind's files can be counted", async () => {
    const { core, moon } = await setUp();
    const exported = await exportMind(core, "Tides", NOTE);

    const announced = nextEvent(core, "document.status");
    const counted = await core.setCountedAsEvidence(exported.id, true);
    expect(counted.ownFile).toEqual({ kind: "export", counted: true });
    expect((await announced).ownFile).toEqual({ kind: "export", counted: true });
    const found = await core.searchEvidence("spring tides");
    expect(evidenceFrom(found).sort()).toEqual(["Moon", "Tides"]);
    expect(found.excluded).toEqual([]);

    // Its Undo, or its menu, takes it back.
    expect((await core.setCountedAsEvidence(exported.id, false)).ownFile?.counted).toBe(false);
    expect(evidenceFrom(await core.searchEvidence("spring tides"))).toEqual(["Moon"]);

    await expect(core.setCountedAsEvidence(moon.id, true)).rejects.toThrow(InvalidInputError);
    await expect(
      core.setCountedAsEvidence(exported.id, "yes" as unknown as boolean),
    ).rejects.toThrow(InvalidInputError);
  });

  test("a Search scope limits what is searched and named: IncarnaMind's files outside it aren't mentioned", async () => {
    const { core, moon } = await setUp();
    await exportMind(core, "Tides", NOTE);
    const found = await core.searchEvidence("spring tides", {
      scope: { folderIds: [], tagIds: [], documentIds: [moon.id] },
    });
    expect(evidenceFrom(found)).toEqual(["Moon"]);
    expect(found.excluded).toEqual([]);
  });

  test("a Mind with a Chinese name exports as IncarnaMind's file, named in Chinese where it matched", async () => {
    const { core } = await setUp();
    const exported = await exportMind(
      core,
      "潮汐笔记",
      "大潮每月两次，出现在新月和满月。",
      "markdown",
    );
    expect(exported).toMatchObject({ name: "潮汐笔记", ownFile: { kind: "export" } });
    const found = await core.searchEvidence("大潮 满月");
    expect(found.passages).toEqual([]);
    expect(found.excluded).toMatchObject([{ documentName: "潮汐笔记", reason: "own-file" }]);
  });

  test("the fingerprints survive a restart: an export saved outside any Linked folder, copied into one later, is still IncarnaMind's", async () => {
    const dataDir = await createTempDataFolder();
    const first = startCore(dataDir);
    const outside = await createSourceFolder();
    await first.setOutputLocation(outside);
    const mind = await first.createMind({ title: "Tides" });
    writeMind(await connectToMind(first, mind.id), [note(NOTE)]);
    const saved = await first.saveMindExport(mind.id, { format: "markdown" });
    if (saved.status !== "saved") throw new Error("The export wasn't saved.");
    first.close();

    // Started again, a copy in a Linked folder, under another name, is known.
    const core = startCore(dataDir);
    const papers = await createSourceFolder();
    await writeSourceFile(papers, "Moon.txt", MOON);
    await copyFile(saved.file.path, join(papers, "Tides (final).md"));
    const documents = await linkAndProcess(core, papers);
    expect(documents.map((each) => [each.name, each.ownFile?.kind ?? null]).sort()).toEqual([
      ["Moon", null],
      ["Tides (final)", "export"],
    ]);
    expect(evidenceFrom(await core.searchEvidence("spring tides"))).toEqual(["Moon"]);
    core.close();

    // So is the Document's origin, and the User's choice to count it.
    const again = startCore(dataDir);
    const copy = (await again.listDocuments()).find((each) => each.name === "Tides (final)");
    expect(copy?.ownFile).toEqual({ kind: "export", counted: false });
  });

  test("bytes handed to the host as an export are IncarnaMind's too, wherever it saves them", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const mind = await core.createMind({ title: "Tides" });
    writeMind(await connectToMind(core, mind.id), [note(NOTE)]);
    const exported = await core.exportMind(mind.id, { format: "markdown" });
    const folder = await createSourceFolder();
    const path = join(folder, "Saved by the host.md");
    await writeFile(path, exported.data);
    const [document] = await addAndProcess(core, [path]);
    expect(document?.ownFile).toEqual({ kind: "export", counted: false });
  });

  test("an export the User edits after it was indexed stays IncarnaMind's; one only ever seen edited is the User's", async () => {
    const { core, papers } = await setUp();
    const exported = await exportMind(core, "Tides", NOTE, "markdown");

    // The User adds a line of their own: a new version, and still IncarnaMind's file.
    const changed = nextEvent(core, "document.status");
    await appendFile(exported.path, "\nMy own field note: the spring tide at Whitby was late.\n");
    await core.reconcileDocuments();
    await changed;
    const [edited] = await waitForProcessing(core, [exported.id]);
    expect(edited?.contentHash).not.toBe(exported.contentHash);
    expect(edited?.ownFile).toEqual({ kind: "export", counted: false });
    expect(evidenceFrom(await core.searchEvidence("spring tide Whitby"))).toEqual(["Moon"]);

    // Exported elsewhere and edited before IncarnaMind ever read it: nothing says IncarnaMind wrote it.
    const outside = await createSourceFolder();
    await core.setOutputLocation(outside);
    const mind = await core.createMind({ title: "Neap tides" });
    writeMind(await connectToMind(core, mind.id), [note("Neap tides come at the quarter moons.")]);
    const saved = await core.saveMindExport(mind.id, { format: "markdown" });
    if (saved.status !== "saved") throw new Error("The export wasn't saved.");
    await appendFile(saved.file.path, "\nSeen at Whitby on the first quarter.\n");
    await copyFile(saved.file.path, join(papers, "Neap tides.md"));
    const theirs = await indexed(core, join(papers, "Neap tides.md"));
    expect(theirs.ownFile).toBeNull();
  });

  test("an ordinary Answer's search still finds IncarnaMind's files", async () => {
    const model = scriptedModel((call) =>
      call.results.length === 0
        ? { calls: [{ tool: "search_documents", input: { query: "spring tides full moon" } }] }
        : { text: "Twice a month." },
    );
    const { core } = await setUp({ createChatModel: scriptedModels(model).createChatModel });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    await exportMind(core, "Tides", NOTE);
    const mind = await core.createMind({ title: "Questions" });
    const client = await connectToMind(core, mind.id);
    await askAndFinish(core, client, mind.id, "How often do spring tides come?");
    // The search Tool's result, as the model read it: the export's text, beside the User's note.
    const [, answered] = model.doStreamCalls;
    const results = JSON.stringify(answered?.prompt ?? []);
    expect(results).toContain("twice a month");
    expect(results).toContain("pull together");
  });

  test("a sentence's check doesn't read IncarnaMind's files, and names the one that matched, for Count it", async () => {
    const model = scriptedModel((call) =>
      call.results.length === 0
        ? { calls: [{ tool: "search_documents", input: { query: "spring tides full moon" } }] }
        : { text: "Verdict: unsupported" },
    );
    const { core, moon } = await setUp({ createChatModel: scriptedModels(model).createChatModel });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const exported = await exportMind(core, "Tides", NOTE);

    const result = await core.checkClaim({ claim: NOTE });

    expect(result).toMatchObject({
      verdict: "unsupported",
      versions: [{ documentId: moon.id, contentHash: moon.contentHash }],
      excluded: [{ documentId: exported.id, documentName: "Tides", reason: "own-file" }],
    });
    // What its search gave the model: the User's note, not the export.
    const [, checked] = model.doStreamCalls;
    const read = JSON.stringify(checked?.prompt.filter((message) => message.role === "tool"));
    expect(read).toContain('document=\\"Moon\\"');
    expect(read).not.toContain('document=\\"Tides\\"');
  });

  test("files the User added themselves, empty ones and their pasted text included, are never left out", async () => {
    const { core, papers } = await setUp();
    await exportMind(core, "Tides", NOTE);
    const empty = await indexed(core, await writeSourceFile(papers, "Empty.md", ""));
    expect(empty.ownFile).toBeNull();
    const pasted = await core.saveTextAsDocument({
      name: "Field notes",
      text: "Spring tides flooded the harbour steps at Whitby.",
    });
    await waitForProcessing(core, [pasted.id]);
    expect(pasted.ownFile).toBeNull();
    expect(evidenceFrom(await core.searchEvidence("spring tides")).sort()).toEqual([
      "Field notes",
      "Moon",
    ]);
  });
});

describe("Copies of the document being checked aren't evidence", () => {
  const DRAFT = "The harbour wall was finished in 1998, after the spring tides of 1997.";

  test("the checked Document, a renamed copy of it, and a copy of its earlier version are left out; ordinary search still finds them", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const folder = await createSourceFolder();
    const draftPath = await writeSourceFile(folder, "Draft.txt", DRAFT);
    const copyPath = await writeSourceFile(
      folder,
      join("Sent", "Harbour report (final).txt"),
      DRAFT,
    );
    const notesPath = await writeSourceFile(
      folder,
      "Harbour notes.txt",
      "The harbour wall dates from 1998, says the council's record.",
    );
    const [draft, copy, notes] = await addAndProcess(core, [draftPath, copyPath, notesPath]);
    if (!draft || !copy || !notes) throw new Error("The files weren't indexed.");

    // An earlier version's copy: the draft as it was, kept before it was edited.
    const olderPath = await writeSourceFile(folder, "Draft (older).txt", DRAFT);
    const [older] = await addAndProcess(core, [olderPath]);
    if (!older) throw new Error("The older draft wasn't indexed.");
    const changed = nextEvent(core, "document.status");
    await writeFile(draftPath, `${DRAFT} It was raised again in 2015.`);
    await core.reconcileDocuments();
    await changed;
    await waitForProcessing(core, [draft.id]);

    const found = await core.searchEvidence("harbour wall 1998", {
      checked: { documentIds: [draft.id] },
    });
    expect(evidenceFrom(found)).toEqual(["Harbour notes"]);
    expect(found.excluded.map((each) => each.documentName).sort()).toEqual([
      "Draft",
      "Draft (older)",
      "Harbour report (final)",
    ]);
    expect(new Set(found.excluded.map((each) => each.reason))).toEqual(
      new Set(["checked-document"]),
    );

    // By fingerprint alone, for a checked file that isn't a Document.
    const byHash = await core.searchEvidence("harbour wall 1998", {
      checked: { contentHashes: [sha256(DRAFT)] },
    });
    expect(evidenceFrom(byHash).sort()).toEqual(["Draft", "Harbour notes"]);

    // An Answer still finds them: the draft, and its copies, which search shows once (ADR-0010).
    const ordinary = new Set(
      (await core.searchPassages("harbour wall 1998")).map((passage) => passage.documentId),
    );
    expect(ordinary).toContain(draft.id);
    expect(ordinary).toContain(notes.id);
    expect(ordinary.has(copy.id) || ordinary.has(older.id)).toBe(true);
    for (const each of [copy, older]) {
      const scoped = await core.searchPassages("harbour wall 1998", { documentIds: [each.id] });
      expect(scoped.map((passage) => passage.documentId)).toContain(each.id);
    }
    await expect(
      core.searchEvidence("harbour", { checked: { documentIds: "all" as unknown as string[] } }),
    ).rejects.toThrow(InvalidInputError);
  });

  test("a copy of the checked document that IncarnaMind also wrote is left out as a copy, and Count it can't bring it back", async () => {
    const { core } = await setUp();
    const exported = await exportMind(core, "Tides", NOTE, "markdown");
    await core.setCountedAsEvidence(exported.id, true);
    const found = await core.searchEvidence("spring tides", {
      checked: { contentHashes: [exported.contentHash] },
    });
    expect(evidenceFrom(found)).toEqual(["Moon"]);
    expect(found.excluded).toMatchObject([{ documentId: exported.id, reason: "checked-document" }]);
  });
});

test("the fingerprint table holds no names or paths, only what was written, from which Folder, and when", async () => {
  const { core, data } = await setUp();
  await exportMind(core, "Tides", NOTE, "markdown");
  const rows = queryDatabase<Record<string, unknown>>(data, "SELECT * FROM own_files");
  expect(rows).toEqual([
    {
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      content_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      kind: "export",
      folder_id: null,
      created_at: expect.any(String),
      updated_at: expect.any(String),
      deleted_at: null,
    },
  ]);
});
