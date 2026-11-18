/**
 * A sentence about the Library itself is checked by counting the Library's own lists (#2525): the
 * check's model runs code over them on this computer, and its verdict rests on that count.
 * Through the core's public interface, with a scripted model and a stand-in for Python.
 */
import { expect, onTestFinished, test } from "vitest";
import { createFakeAnalysisRuntime, type FakeAnswer } from "../../src/core/analysis/fake";
import { libraryLists, libraryVersion } from "../../src/core/library/lists";
import { ANALYSIS_TOOLS } from "../../src/core/tools";
import { LIBRARY_FACTS } from "../../src/shared/libraryFacts";
import { isCheckRun } from "../helpers/checks";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";

const CODE = 'result("documents", len(inputs["files"]))';
const CLAIM = "Your Library holds two Documents.";
const SUPPORTED =
  "Verdict: supported\nExplanation: The Library's list of Documents has two rows.\nEvidence: []\nWorking: Counted the rows of the Documents list, giving 2.";
const figure = (name: string, value: number) =>
  ({ kind: "figure", name, label: name, unit: null, value }) as const;
/** The count the code names, then one whose name the code worked out from a row, and what it printed. */
const counted = (value: number): FakeAnswer => ({
  output: {
    results: [figure("documents", value), figure("Harbour office", 1)],
    printed: "Tides\nHarbour office\n",
  },
});

/** A core with two Documents, one of them in the Folder "Client A", and a model that counts the Documents list once. */
async function setUp(python: FakeAnswer | "none", { walled = false } = {}) {
  const calls: ModelCall[] = [];
  let reply = SUPPORTED;
  const model = scriptedModel(
    (call) => {
      if (!isCheckRun(call)) return { text: "" };
      calls.push(call);
      const offered = call.tools.includes(ANALYSIS_TOOLS.run);
      const ran = call.results.some((result) => result.tool === ANALYSIS_TOOLS.run);
      const searched = call.results.some((result) => result.tool === "search_documents");
      if (offered && !ran) {
        const inputs = [{ name: "files", library: "documents" }];
        return {
          calls: [{ tool: ANALYSIS_TOOLS.run, input: { title: "Documents", inputs, code: CODE } }],
        };
      }
      if (!offered && !searched)
        return { calls: [{ tool: "search_documents", input: { query: "Library Documents" } }] };
      return { text: reply };
    },
    { generate: () => ({ text: "{}" }) },
  );
  const runtime =
    python === "none" ? undefined : createFakeAnalysisRuntime({ answer: () => python });
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
    ...(runtime && { analysisRuntime: runtime }),
  });
  onTestFinished(() => core.close());
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-test",
    modelId: "claude-haiku-5-5",
  });
  if (saved.service) await core.allowDataFlow("checks", saved.service.id);
  const sources = await createTempDataFolder();
  const [tides, office] = await addAndProcess(core, [
    await writeSourceFile(sources, "Tides.md", "# Tides\n\nSpring tides come at new moon.\n"),
    await writeSourceFile(sources, "Harbour office.md", "# Office\n\nThe office opens at nine.\n"),
  ]);
  const client = await core.createLibraryGroup({ name: "Client A", description: "" });
  if (office) await core.assignDocumentGroup(office.id, client.id);
  if (walled)
    await core.updateLibraryGroup(client.id, {
      name: "Client A",
      description: "",
      keepInside: true,
    });
  const outside = await core.createMind({ title: "Rundown", folderId: null });
  const inside = await core.createMind({ title: "Client rundown", folderId: client.id });
  return {
    core,
    sources,
    outside,
    inside,
    tides,
    calls,
    jobs: () => runtime?.jobs ?? [],
    /** What the model was told of its run. */
    told: () =>
      calls.at(-1)?.results.find((result) => result.tool === ANALYSIS_TOOLS.run)?.text ?? "",
    repliesWith(next: string) {
      reply = next;
    },
  };
}

// protects=a sentence about the Library is Supported on a finished count of the Library's own lists, with no search and no quote: its evidence is the Library's row, and its working keeps which lists were counted; fails_when=it reads Not checked for want of a search or a quote, or the card has nothing to show for what was counted.
test("a sentence about the Library is supported on the count of its lists", async () => {
  const { core, outside, jobs } = await setUp(counted(2));

  const result = await core.checkClaim({ claim: CLAIM, mindId: outside.id });

  expect(result.verdict).toBe("supported");
  if (result.verdict !== "supported") return;
  expect(result.evidence).toMatchObject({
    documentId: LIBRARY_FACTS,
    location: {
      kind: "library",
      source: { kind: "library" },
      fact: { kind: "documents", count: 2 },
    },
    check: "found",
  });
  expect(result.parts?.[0]?.working).toMatchObject({
    code: CODE,
    rows: [],
    library: { source: { kind: "library" }, lists: [{ list: "documents", count: 2 }] },
  });
  expect(jobs()[0]?.inputs[0]).toMatchObject({
    kind: "table",
    name: "files",
    columns: ["name", "kind", "folder", "folder_path", "tags"],
    rows: expect.arrayContaining([
      ["Tides", "markdown", "", "", ""],
      ["Harbour office", "markdown", "Client A", "Client A", ""],
    ]),
  });
});

// protects=the lists stay on this computer: the model is told the numbers its code gave, each under a name only where the code writes that name out, and nothing else: not what the code printed, not a name it worked out from a row, not how many rows a list has, and no word of an error's message, which could quote a Document's name; fails_when=a run over the lists sends names, Folders, Tags or the size of a list to the model's provider.
test("the model is told only the numbers a run over the lists gave", async () => {
  const done = await setUp(counted(2));
  await done.core.checkClaim({ claim: CLAIM, mindId: done.outside.id });
  expect(done.told()).toContain("- documents: 2");
  expect(done.told()).toContain("- result 2: 1");
  expect(done.told()).not.toContain("Tides");
  expect(done.told()).not.toContain("Harbour office");
  expect(done.told()).not.toMatch(/\d+ rows/);

  const failed = await setUp({
    end: { kind: "error", message: "KeyError: 'Harbour office'\nHarbour office", line: 1 },
  });
  const result = await failed.core.checkClaim({ claim: CLAIM, mindId: failed.outside.id });
  expect(failed.told()).toContain("did not finish (error on line 1)");
  expect(failed.told()).not.toContain("KeyError");
  expect(failed.told()).not.toContain("Harbour");
  expect(result).toMatchObject({ verdict: "not-checked", reason: "rows-run-failed" });
});

// protects=a verdict rests on the Library only where the code gave a number: a run that read the lists and gave none told the model nothing, so a Supported with no quote is not accepted on it; fails_when=a ✓ rests on a count nobody made.
test("a run that gave no number is no evidence", async () => {
  const { core, outside } = await setUp({ output: { printed: "2\n" } });

  const result = await core.checkClaim({ claim: CLAIM, mindId: outside.id });

  expect(result).toMatchObject({ verdict: "not-checked", reason: "no-evidence" });
});

// protects=a sentence the model counted the Library's lists for and still found nothing to state (what the files cover) reads Not checked with that reason, never Not found with an offer to cut it; fails_when=a reading of the names is marked not found.
test("a sentence the lists were counted for and don't settle reads not checked", async () => {
  const { core, outside, repliesWith } = await setUp(counted(2));
  repliesWith(
    "Verdict: not found\nExplanation: The lists hold names and kinds, not what the files cover.\nEvidence: []",
  );

  const result = await core.checkClaim({
    claim: "Your Library holds two Documents, mostly about the harbour.",
    mindId: outside.id,
  });

  expect(result).toMatchObject({ verdict: "not-checked", reason: "library-unsettled" });
});

// protects=a count the lists don't give reads Contradicted, resting on the Library's row; fails_when=a wrong count of the Library reads Supported or stays Not found.
test("a count the lists don't give is contradicted", async () => {
  const { core, outside, repliesWith } = await setUp(counted(2));
  repliesWith(
    "Verdict: contradicted\nExplanation: The Library's list of Documents has two rows, not five.\nEvidence: []\nWorking: Counted the rows of the Documents list, giving 2.\nChange 1: five\nTo 1: two",
  );

  const result = await core.checkClaim({
    claim: "Your Library holds five Documents.",
    mindId: outside.id,
  });

  expect(result.verdict).toBe("contradicted");
  if (result.verdict !== "contradicted") return;
  expect(result.evidence?.location).toMatchObject({ kind: "library" });
});

// protects=a Folder that keeps its work inside it is listed only for a Note in that Folder, and the row says whose lists were counted; fails_when=a Note outside a walled Folder counts that Folder's Documents, or a Note inside it counts the rest of the Library.
test("a walled Folder's Documents are counted only for a Note inside it", async () => {
  const { core, outside, inside, jobs } = await setUp(counted(1), { walled: true });

  const from = await core.checkClaim({ claim: CLAIM, mindId: outside.id });
  const within = await core.checkClaim({ claim: CLAIM, mindId: inside.id });

  expect(jobs().map((job) => job.inputs[0])).toMatchObject([
    { rows: [["Tides", "markdown", "", "", ""]] },
    { rows: [["Harbour office", "markdown", "Client A", "Client A", ""]] },
  ]);
  expect(from.verdict === "supported" && from.evidence?.location).toMatchObject({
    source: { kind: "left-out", folders: 1 },
  });
  expect(within.verdict === "supported" && within.evidence?.location).toMatchObject({
    source: { kind: "scope", name: "Client A" },
  });
});

// protects=a check that counted the Library keeps the version of its lists, which the window compares with the Library as it is now: adding a Document changes it; fails_when=a ✓ counted from the Library stays after the Library changed.
test("the check keeps the version of the lists it counted, which a new Document changes", async () => {
  const { core, sources, outside } = await setUp(counted(2));

  const result = await core.checkClaim({ claim: CLAIM, mindId: outside.id });
  const before = await core.libraryListsVersion(outside.id);

  expect(result.versions).toContainEqual({ documentId: LIBRARY_FACTS, contentHash: before });
  await addAndProcess(core, [await writeSourceFile(sources, "Ferry.md", "# Ferry\n\nAt seven.\n")]);
  expect(await core.libraryListsVersion(outside.id)).not.toBe(before);
});

// protects=the Library's lists are offered only where Python can run; without it the sentence is judged from the Passages as before; fails_when=a check offers a count it can't run.
test("with no Python on this computer, the lists aren't offered", async () => {
  const { core, outside, calls, repliesWith } = await setUp("none");
  repliesWith(
    "Verdict: not found\nExplanation: No Passage says what the Library holds.\nEvidence: []",
  );

  const result = await core.checkClaim({ claim: CLAIM, mindId: outside.id });

  expect(calls.some((call) => call.tools.includes(ANALYSIS_TOOLS.run))).toBe(false);
  expect(result).toMatchObject({ verdict: "unsupported", unsupported: { word: "not-found" } });
});

// protects=two Folders of one name under different parents are told apart by their paths, in the Folders' rows and in each Document's; fails_when=a count of one such Folder takes in the other's Documents, or moving a Document between them leaves the lists' version as it was.
test("Folders of one name are told apart by their paths", () => {
  const folder = (id: string, name: string, parentId: string | null) => ({ id, name, parentId });
  const seen = (inNorth: boolean) =>
    libraryLists({
      source: { kind: "library" },
      documents: [{ id: "d1", name: "Lease", kind: "pdf", tags: [] }],
      folders: [
        folder("north", "North", null),
        folder("south", "South", null),
        folder("na", "Archive", "north"),
        folder("sa", "Archive", "south"),
      ],
      folderOf: new Map([["d1", inNorth ? "na" : "sa"]]),
      tagNames: new Map(),
      notes: [{ name: "Rundown", folderId: "sa" }],
    });

  const lists = seen(true);

  expect(lists.documents.rows).toEqual([["Lease", "pdf", "Archive", "North / Archive", ""]]);
  expect(lists.folders.rows).toEqual([
    ["North", "", "North", 1],
    ["South", "", "South", 0],
    ["Archive", "North", "North / Archive", 1],
    ["Archive", "South", "South / Archive", 0],
  ]);
  expect(lists.notes.rows).toEqual([["Rundown", "Archive", "South / Archive"]]);
  expect(libraryVersion(seen(false))).not.toBe(libraryVersion(lists));
});
