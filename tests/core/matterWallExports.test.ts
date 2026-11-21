import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Core } from "../../src/core";
import {
  documentOrFolderChoices,
  keptFrom,
} from "../../src/renderer/src/components/documentOrFolder";
import { blockedFrom, type ScopeLibrary, scopeChoices } from "../../src/renderer/src/scope";
import { keptInsideName } from "../../src/renderer/src/walls";
import { NO_SCOPE } from "../../src/shared/searchScope";
import { askAssistant } from "../helpers/assistant";
import { setUpWithDocuments } from "../helpers/citations";
import { indexed, linkWithExports } from "../helpers/evidence";
import { connectToMind } from "../helpers/mindClient";
import { note, writeMind } from "../helpers/minds";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

/**
 * A file IncarnaMind writes from a walled Note stays behind the wall when it comes back as a
 * Document, as an export into a Linked folder that holds the Output location does (#1934).
 */

const OFFER = "Client A settlement offer: 2.5 million zeta.";

async function setUp() {
  const calls: ModelCall[] = [];
  const model = scriptedModel((call): ScriptedReply => {
    calls.push(call);
    const done = (tool: string) => call.results.some((each) => each.tool === tool);
    const exporting = /Export note (\S+)/.exec(call.prompt);
    if (exporting && !done("run_command")) {
      const input = { command: "mind.export", ids: [exporting[1]], format: "markdown" };
      return { calls: [{ tool: "run_command", input }] };
    }
    if (!exporting && !done("search_documents")) {
      return { calls: [{ tool: "search_documents", input: { query: "settlement offer" } }] };
    }
    return { text: "Done." };
  });
  const setup = await setUpWithDocuments(model, []);
  const { core } = setup;
  const { papers } = await linkWithExports(core, [
    { name: "General memo.txt", contents: "The general memo has no offer in it.\n" },
  ]);
  const folder = await core.createLibraryGroup({ name: "Client A", description: "" });
  await core.updateLibraryGroup(folder.id, { name: "Client A", description: "", keepInside: true });
  const walled = await core.createMind({ title: "Client A privileged", folderId: folder.id });
  writeMind(await connectToMind(core, walled.id), [note(OFFER)]);
  const exported = join(papers, "Exports", "Client A privileged.md");
  return { core, calls, walled, outside: setup.mind, exported };
}

type Setup = Awaited<ReturnType<typeof setUp>>;

/** What search_documents gave the model in the requests from `from` on. */
const searched = (calls: readonly ModelCall[], from: number) =>
  calls
    .slice(from)
    .flatMap((call) => call.results.filter((each) => each.tool === "search_documents"))
    .map((each) => each.text)
    .join("\n");

const sent = (calls: readonly ModelCall[], from: number) =>
  calls
    .slice(from)
    .map((call) => `${call.system}\n${call.prompt}`)
    .join("\n");

async function askBothSides(s: Setup) {
  const from = s.calls.length;
  await askAssistant(s.core, { text: "What is the settlement offer?", mindId: s.outside.id });
  const found = searched(s.calls, from);
  expect(found).toContain("has no offer in it");
  expect(found).not.toContain("2.5 million zeta");
  const inside = s.calls.length;
  await askAssistant(s.core, { text: "What is the settlement offer?", mindId: s.walled.id });
  expect(sent(s.calls, inside)).toContain("2.5 million zeta");
}

describe("an export of walled work, indexed again through a Linked folder", () => {
  test("the User's own export stays behind the wall", async () => {
    const s = await setUp();
    const saved = await s.core.saveMindExport(s.walled.id, { format: "markdown" });
    if (saved.status !== "saved") throw new Error(`The export wasn't saved: ${saved.status}.`);
    const copy = await indexed(s.core, saved.file.path);
    expect(copy.ownFile?.kind).toBe("export");
    await askBothSides(s);
  });

  test("the assistant's export stays behind the wall", async () => {
    const s = await setUp();
    await askAssistant(s.core, { text: `Export note ${s.walled.id}`, mindId: s.walled.id });
    const copy = await indexed(s.core, s.exported);
    expect(copy.ownFile?.kind).toBe("export");
    await askBothSides(s);
  });

  test("a Note in a wall inside another keeps its export from the outer wall and from outside", async () => {
    const s = await setUp();
    const clientA = (await s.core.getLibrary()).groups.find((group) => group.name === "Client A");
    if (!clientA) throw new Error("Client A is gone.");
    const clientB = await s.core.createLibraryGroup({
      name: "Client B",
      description: "",
      parentId: clientA.id,
    });
    await s.core.updateLibraryGroup(clientB.id, {
      name: "Client B",
      description: "",
      keepInside: true,
    });
    const drafts = await s.core.createLibraryGroup({
      name: "Drafts",
      description: "",
      parentId: clientB.id,
    });
    await s.core.moveToFolder({ mindIds: [s.walled.id], folderId: drafts.id });
    const saved = await s.core.saveMindExport(s.walled.id, { format: "markdown" });
    if (saved.status !== "saved") throw new Error(`The export wasn't saved: ${saved.status}.`);
    const copy = await indexed(s.core, saved.file.path);
    expect(copy.ownFile?.kind).toBe("export");
    await askBothSides(s);

    // A Note in the outer wall does not find the inner wall's export either.
    const outer = await s.core.createMind({ title: "Outer", folderId: clientA.id });
    const from = s.calls.length;
    await askAssistant(s.core, { text: "What is the settlement offer?", mindId: outer.id });
    expect(searched(s.calls, from)).not.toContain("2.5 million zeta");

    // The copy is the inner wall's, not the outer wall's: a turn behind the outer wall can't
    // move it, and a turn behind the inner wall can.
    await expect(
      s.core.moveToFolder({ documentIds: [copy.id], folderId: clientA.id, wall: clientA.id }),
    ).rejects.toMatchObject({ wording: { key: "error.folder.wallMove" } });
    await s.core.moveToFolder({ documentIds: [copy.id], folderId: drafts.id, wall: clientB.id });
    expect(
      (await s.core.getLibrary()).assignments.find((each) => each.documentId === copy.id)?.groupId,
    ).toBe(drafts.id);
  });

  test("a Note in a sub-Folder of the wall keeps its export behind the wall too", async () => {
    const s = await setUp();
    const clientA = (await s.core.getLibrary()).groups.find((group) => group.name === "Client A");
    if (!clientA) throw new Error("Client A is gone.");
    const drafts = await s.core.createLibraryGroup({
      name: "Drafts",
      description: "",
      parentId: clientA.id,
    });
    await s.core.moveToFolder({ mindIds: [s.walled.id], folderId: drafts.id });

    const saved = await s.core.saveMindExport(s.walled.id, { format: "markdown" });
    if (saved.status !== "saved") throw new Error(`The export wasn't saved: ${saved.status}.`);
    const copy = await indexed(s.core, saved.file.path);
    expect(copy.ownFile?.kind).toBe("export");
    await askBothSides(s);
  });

  // protects=the core's LibrarySnapshot carries a written file's wall for Citations and both pickers across re-indexing, wall changes and moving the Note that wrote it (#3131); fails_when=the snapshot omits the written file's wall or fails to refresh on those changes; no_claim=none beyond protects.
  test("the Library snapshot gives the export's wall for Citations and pickers as the file, the wall and the Note change (#3131)", async () => {
    const s = await setUp();
    const clientA = (await s.core.getLibrary()).groups.find((group) => group.name === "Client A");
    if (!clientA) throw new Error("Client A is gone.");
    let libraryChanges = 0;
    s.core.on("library.changed", () => libraryChanges++);

    const saved = await s.core.saveMindExport(s.walled.id, { format: "markdown" });
    if (saved.status !== "saved") throw new Error(`The export wasn't saved: ${saved.status}.`);
    const copy = await indexed(s.core, saved.file.path);
    expect(libraryChanges).toBeGreaterThan(0);

    const windowView = async (core: Core, documentId: string, mindId: string) => {
      const library = structuredClone(await core.getLibrary());
      const documents = await core.listDocuments();
      const minds = await core.listMinds();
      const folderId = minds.find((each) => each.id === mindId)?.folderId ?? null;
      const wall =
        folderId !== null && library.groups.find((group) => group.id === folderId)?.keepInside
          ? folderId
          : null;
      const scopeLibrary: ScopeLibrary = {
        folders: await core.listFolders(),
        groups: library.groups,
        tags: await core.listTags(),
        documents,
        assignments: library.assignments,
        documentWalls: library.documentWalls,
        minds,
      };
      const scopeChoice = scopeChoices(scopeLibrary, NO_SCOPE, "").find(
        (each) => each.kind === "document" && each.id === documentId,
      );
      const docChoice = documentOrFolderChoices(scopeLibrary, "").find(
        (each) => each.kind === "document" && each.id === documentId,
      );
      if (!scopeChoice || !docChoice) throw new Error(`Document ${documentId} not in pickers.`);
      return {
        wallEntry: library.documentWalls?.[documentId] ?? null,
        keptInside: keptInsideName(library, documentId, folderId),
        scopeBlocked: blockedFrom(scopeLibrary, scopeChoice, wall),
        pickerKept: keptFrom(scopeLibrary, docChoice, wall),
      };
    };

    const recheck = async (mindId: string, contentHash: string, quote = OFFER) =>
      s.core.recheckCitation({
        documentId: copy.id,
        quote,
        pageFrom: 1,
        pageTo: 1,
        contentHash,
        mindId,
      });

    // Unfiled export: behind Client A's wall, not yet user-filed in it.
    expect(await recheck(s.outside.id, copy.contentHash)).toEqual({ keptInside: "Client A" });
    expect(await windowView(s.core, copy.id, s.outside.id)).toEqual({
      wallEntry: { wallId: clientA.id, byUser: false },
      keptInside: "Client A",
      scopeBlocked: true,
      pickerKept: { inside: "Client A" },
    });
    expect("keptInside" in (await recheck(s.walled.id, copy.contentHash))).toBe(false);
    expect(await windowView(s.core, copy.id, s.walled.id)).toEqual({
      wallEntry: { wallId: clientA.id, byUser: false },
      keptInside: null,
      scopeBlocked: true,
      pickerKept: "outside",
    });

    // Once the User files the export in Client A, a Note behind the wall searches and picks it.
    const beforeAssign = libraryChanges;
    await s.core.assignDocumentGroup(copy.id, clientA.id);
    expect(libraryChanges).toBeGreaterThan(beforeAssign);
    expect(await windowView(s.core, copy.id, s.walled.id)).toEqual({
      wallEntry: { wallId: clientA.id, byUser: true },
      keptInside: null,
      scopeBlocked: false,
      pickerKept: null,
    });
    expect(await windowView(s.core, copy.id, s.outside.id)).toEqual({
      wallEntry: { wallId: clientA.id, byUser: true },
      keptInside: "Client A",
      scopeBlocked: true,
      pickerKept: { inside: "Client A" },
    });
    const scopedToCopy = { folderIds: [], tagIds: [], documentIds: [copy.id] };
    const fromInside = s.calls.length;
    await askAssistant(s.core, {
      text: "What is the settlement offer?",
      mindId: s.walled.id,
      scope: scopedToCopy,
    });
    expect(searched(s.calls, fromInside)).toContain("2.5 million zeta");

    // Unfiled again, then edited and indexed again from the Linked folder: still behind the wall.
    await s.core.assignDocumentGroup(copy.id, null);
    const editedOffer = "Client A settlement offer: 2.5 million zeta, revised.";
    await writeFile(saved.file.path, `${editedOffer}\n`);
    const reindexed = await indexed(s.core, saved.file.path);
    expect(reindexed.contentHash).not.toBe(copy.contentHash);
    expect(await recheck(s.outside.id, reindexed.contentHash, editedOffer)).toEqual({
      keptInside: "Client A",
    });
    expect(await windowView(s.core, copy.id, s.outside.id)).toEqual({
      wallEntry: { wallId: clientA.id, byUser: false },
      keptInside: "Client A",
      scopeBlocked: true,
      pickerKept: { inside: "Client A" },
    });

    // The Folder loses its wall, then gains it again.
    await s.core.updateLibraryGroup(clientA.id, {
      name: "Client A",
      description: "",
      keepInside: false,
    });
    expect("keptInside" in (await recheck(s.outside.id, reindexed.contentHash, editedOffer))).toBe(
      false,
    );
    expect(await windowView(s.core, copy.id, s.outside.id)).toEqual({
      wallEntry: null,
      keptInside: null,
      scopeBlocked: false,
      pickerKept: null,
    });
    await s.core.updateLibraryGroup(clientA.id, {
      name: "Client A",
      description: "",
      keepInside: true,
    });
    expect(await recheck(s.outside.id, reindexed.contentHash, editedOffer)).toEqual({
      keptInside: "Client A",
    });
    expect(await windowView(s.core, copy.id, s.outside.id)).toEqual({
      wallEntry: { wallId: clientA.id, byUser: false },
      keptInside: "Client A",
      scopeBlocked: true,
      pickerKept: { inside: "Client A" },
    });

    // The Note that wrote the file moves outside the wall: the file stays behind Client A's wall,
    // and from that moved Note the core and the window both treat it as kept inside Client A.
    await s.core.moveToFolder({ mindIds: [s.walled.id], folderId: null });
    expect(await recheck(s.walled.id, reindexed.contentHash, editedOffer)).toEqual({
      keptInside: "Client A",
    });
    expect(await windowView(s.core, copy.id, s.walled.id)).toEqual({
      wallEntry: { wallId: clientA.id, byUser: false },
      keptInside: "Client A",
      scopeBlocked: true,
      pickerKept: { inside: "Client A" },
    });
    const fromMoved = s.calls.length;
    await askAssistant(s.core, {
      text: "What is the settlement offer?",
      mindId: s.walled.id,
      scope: scopedToCopy,
    });
    expect(searched(s.calls, fromMoved)).not.toContain("2.5 million zeta");
  });
});
