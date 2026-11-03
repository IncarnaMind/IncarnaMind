import { rename, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import type { Core, CoreAdapters, Document, Folder, SearchScope } from "../../src/core";
import {
  answerEnded,
  askAndFinish,
  citingModel,
  recordSearches,
  setUpWithDocuments,
  shownPassages,
} from "../helpers/citations";
import { startCore } from "../helpers/core";
import { createSourceFolder, linkAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import {
  answerIn,
  answerText,
  editMind,
  question,
  readMind,
  scopeAttributes,
  writeMind,
} from "../helpers/minds";
import {
  type GenerateCall,
  type GeneratedReply,
  type ModelCall,
  promptOf,
  scriptedModel,
} from "../helpers/models";

/**
 * The library: a Linked folder with the folders Coast › Rivers › Deltas,
 * Kitchen, and Empty (whose only file has gone missing), a Tag, and two
 * files added on their own. Every Document mentions tides, so a search for
 * tides would find each of them.
 */
const LINKED = [
  { name: "Coast/Harbour.txt", contents: "Harbour tides rise twice a day along the quay.\n" },
  { name: "Coast/Rivers/Estuary.txt", contents: "Estuary tides push salt water up the river.\n" },
  { name: "Coast/Rivers/Deltas/Delta.txt", contents: "Delta tides spread across the mud flats.\n" },
  {
    name: "Kitchen/Recipes.txt",
    contents: "Cook mussels at low tides, with garlic and white wine.\n",
  },
  { name: "Empty/Gone.txt", contents: "These tides went with the file.\n" },
];
const SINGLES = [
  { name: "Moon.txt", contents: "The Moon's pull raises the tides on both sides of the Earth.\n" },
  { name: "Almanac.txt", contents: "The almanac lists the times of the tides for the year.\n" },
];

const ALL = ["Almanac", "Delta", "Estuary", "Harbour", "Moon", "Recipes"];

/** A search hands Passages from at most 4 Documents, so an unscoped one shows 4 of ALL. */
const someOfAll = (names: readonly string[]) => {
  expect(names).toHaveLength(4);
  expect(ALL).toEqual(expect.arrayContaining([...names]));
};

/**
 * A model that calls Tools: it searches once for tides, then answers without
 * citing. `generate` answers what isn't streamed, such as Organize.
 */
function searchingModel(generate?: (call: GenerateCall) => GeneratedReply): MockLanguageModelV4 {
  return scriptedModel(
    (call: ModelCall) => {
      if (!call.tools.includes("search_documents")) return { text: "No Tools were offered." };
      if (call.results.length === 0) {
        return { calls: [{ tool: "search_documents", input: { query: "tides" } }] };
      }
      return { text: "Here is what your Documents say." };
    },
    { generate },
  );
}

/** The library in a core whose searches are recorded: the Documents of the Passages each hands the model, by name. */
async function setUpLibrary(model: MockLanguageModelV4 = searchingModel()) {
  const { searches, answerSearch } = recordSearches();
  const setup = await setUpWithDocuments(model, SINGLES, { answerSearch });
  const { core } = setup;
  const library = await createSourceFolder();
  // Each file a minute newer than the one before, so which is newest doesn't depend on how
  // finely the file system keeps modified times.
  for (const [at, file] of LINKED.entries()) {
    const modified = new Date(Date.UTC(2026, 0, 1, 9, at));
    await utimes(await writeSourceFile(library, file.name, file.contents), modified, modified);
  }
  const linked = await linkAndProcess(core, library);
  await rm(join(library, "Empty", "Gone.txt"));
  await core.reconcileDocuments();
  const documents = Object.fromEntries(
    [...setup.documents, ...linked].map((document) => [document.name, document]),
  ) as Record<string, Document>;
  const id = (name: string) => (documents[name] as Document).id;
  const folders = await core.listFolders();
  const folder = (relativePath: string) =>
    folders.find((each) => each.relativePath === relativePath) as Folder;
  const astronomy = await core.createTag({ name: "Astronomy" });
  await core.addDocumentTag(id("Moon"), astronomy.id);

  return {
    ...setup,
    searches,
    answerSearch,
    id,
    library,
    path: (name: string) => (documents[name] as Document).path,
    folders: {
      coast: folder("Coast"),
      rivers: folder("Coast/Rivers"),
      deltas: folder("Coast/Rivers/Deltas"),
      kitchen: folder("Kitchen"),
      empty: folder("Empty"),
    },
    tags: { astronomy },
  };
}

/** Renames the Kitchen folder on disk: its Folder goes, and its Documents move to a new one. */
async function renameKitchen(core: Core, library: string): Promise<void> {
  await rename(join(library, "Kitchen"), join(library, "Cookery"));
  await core.reconcileDocuments();
}

/** Writes a Question with a Search scope, asks it, and waits for its Answer. */
async function askScoped(
  core: Core,
  client: MindClient,
  mindId: string,
  scope: Partial<SearchScope>,
  text = "What do my Documents say about tides?",
) {
  const asked = question(text, undefined, scope);
  writeMind(client, [asked]);
  await client.settled();
  const result = await core.askQuestion({ mindId, questionId: asked.attrs.id });
  if (!result.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(result)}`);
  const ended = await answerEnded(core, result.answerId);
  if (ended.event !== "finished") throw new Error(JSON.stringify(ended.payload));
  return { questionId: asked.attrs.id, answerId: result.answerId, finished: ended.payload };
}

/** The Documents of the Passages the model was shown by its searches, by name. */
function shownDocuments(model: MockLanguageModelV4): string[] {
  const names = new Set<string>();
  for (const call of model.doStreamCalls) {
    for (const message of call.prompt) {
      if (message.role !== "tool") continue;
      for (const part of message.content) {
        if (part.type !== "tool-result" || part.output.type !== "text") continue;
        for (const passage of shownPassages(part.output.value)) names.add(passage.document);
      }
    }
  }
  return [...names].sort();
}

describe("Resolving a Search scope", { timeout: 30_000 }, () => {
  test("a Question with no Search scope searches every Document", async () => {
    const { core, client, mind, searches } = await setUpLibrary();

    await askScoped(core, client, mind.id, {});

    expect(searches).toHaveLength(1);
    someOfAll(searches[0] ?? []);
  });

  test("an in-app folder scopes by assignment, including files from different source locations", async () => {
    const { core, client, mind, searches, id } = await setUpLibrary();
    const folder = await core.createLibraryGroup({
      name: "Research",
      description: "Ocean science",
    });
    await core.assignDocumentGroup(id("Moon"), folder.id);
    await core.assignDocumentGroup(id("Harbour"), folder.id);
    await askScoped(core, client, mind.id, { folderIds: [folder.id] });
    expect(searches).toEqual([["Harbour", "Moon"]]);
    await core.assignDocumentGroup(id("Moon"), null);
    await askScoped(core, client, mind.id, { folderIds: [folder.id] });
    expect(searches.at(-1)).toEqual(["Harbour"]);
    await core.deleteLibraryGroup(folder.id);
    const before = searches.length;
    await askScoped(core, client, mind.id, { folderIds: [folder.id] });
    expect(searches).toHaveLength(before);
  });

  test("a Suggested Folder counts in its Folder's scope until it is rejected", async () => {
    let suggested = "";
    const { core, client, mind, searches, id } = await setUpLibrary(
      searchingModel(() => ({ text: JSON.stringify({ groupId: suggested, tags: [] }) })),
    );
    const folder = await core.createLibraryGroup({
      name: "Research",
      description: "Ocean science",
    });
    suggested = folder.id;
    const [provider] = await core.listChatProviders();
    await core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId: provider?.id ?? "", modelId: "local" } },
      automatic: false,
    });
    await core.classifyDocuments([id("Moon")]);
    await vi.waitFor(async () =>
      expect((await core.getLibrary()).assignments).toEqual([
        expect.objectContaining({ groupId: folder.id, suggested: true, status: "classified" }),
      ]),
    );

    await askScoped(core, client, mind.id, { folderIds: [folder.id] });
    expect(searches).toEqual([["Moon"]]);
    await core.rejectAssignments([id("Moon")]);
    await askScoped(core, client, mind.id, { folderIds: [folder.id] });
    expect(searches).toHaveLength(1);
  });

  test("a Folder covers its Documents and those of its sub-Folders, at any depth", async () => {
    const { core, client, mind, searches, folders } = await setUpLibrary();

    await askScoped(core, client, mind.id, { folderIds: [folders.coast.id] });
    await askScoped(core, client, mind.id, { folderIds: [folders.rivers.id] });
    await askScoped(core, client, mind.id, { folderIds: [folders.deltas.id] });

    expect(searches).toEqual([["Delta", "Estuary", "Harbour"], ["Delta", "Estuary"], ["Delta"]]);
  });

  test("a Tag covers the Documents that carry it, and a Document covers itself", async () => {
    const { core, client, mind, searches, tags, id } = await setUpLibrary();

    await askScoped(core, client, mind.id, { tagIds: [tags.astronomy.id] });
    await askScoped(core, client, mind.id, { documentIds: [id("Almanac")] });

    expect(searches).toEqual([["Moon"], ["Almanac"]]);
  });

  test("Folders, Tags and Documents together cover the union of their Documents", async () => {
    const { core, client, mind, searches, folders, tags, id } = await setUpLibrary();

    await askScoped(core, client, mind.id, {
      folderIds: [folders.deltas.id, folders.kitchen.id],
      tagIds: [tags.astronomy.id],
      // Delta is in a Folder of the scope too: it counts once.
      documentIds: [id("Almanac"), id("Delta")],
    });

    expect(searches).toEqual([["Almanac", "Delta", "Moon", "Recipes"]]);
  });

  test("deleted Folders, Tags and Documents are ignored", async () => {
    const { core, client, mind, searches, folders, tags, id, library } = await setUpLibrary();
    const comets = await core.createTag({ name: "Comets" });
    await core.addDocumentTag(id("Almanac"), comets.id);
    await renameKitchen(core, library);
    await core.deleteTag(comets.id);
    await core.deleteDocument(id("Harbour"));

    await askScoped(core, client, mind.id, {
      folderIds: [folders.kitchen.id, folders.deltas.id],
      tagIds: [comets.id, tags.astronomy.id],
      documentIds: [id("Harbour")],
    });

    // Recipes left with the Kitchen folder's name; Almanac lost the deleted Tag.
    expect(searches).toEqual([["Delta", "Moon"]]);
  });

  test("a missing Document is left out, even when the scope names it", async () => {
    const { core, client, mind, searches, folders, id, path } = await setUpLibrary();
    await rm(path("Delta"));
    await core.reconcileDocuments();

    await askScoped(core, client, mind.id, {
      folderIds: [folders.rivers.id],
      documentIds: [id("Delta")],
    });

    expect(searches).toEqual([["Estuary"]]);
  });

  test("the scope is resolved when the Question is asked: Documents moved in since are in it, those moved out aren't", async () => {
    const { core, client, mind, searches, folders, library, path } = await setUpLibrary();
    // Files moved on disk: one added on its own into Deltas, Estuary out of Rivers.
    await rename(path("Almanac"), join(library, "Coast/Rivers/Deltas/Almanac.txt"));
    await rename(path("Estuary"), join(library, "Kitchen/Estuary.txt"));
    await core.reconcileDocuments();

    await askScoped(core, client, mind.id, { folderIds: [folders.rivers.id] });

    expect(searches).toEqual([["Almanac", "Delta"]]);
  });
});

describe("A Search scope with no Documents to search", { timeout: 30_000 }, () => {
  /** The instructions the model was sent: they say the scope holds no Documents (#748). */
  const toldEmpty = (model: ReturnType<typeof searchingModel>) =>
    expect(promptOf(model)[0]?.text).toContain("holds no Documents");

  test("goes to the model, told the scope is empty, with nothing searched", async () => {
    const model = searchingModel();
    const { core, client, mind, searches, folders } = await setUpLibrary(model);

    const { answerId, finished } = await askScoped(core, client, mind.id, {
      folderIds: [folders.empty.id],
    });

    // Not refused: the model wrote the Answer, and it had no Documents to search or cite.
    expect(model.doStreamCalls).toHaveLength(1);
    expect(finished).toMatchObject({ status: "done", citations: [], citationSupport: null });
    expect(answerIn(client, answerId).attrs).toMatchObject({ status: "done" });
    expect(answerIn(client, answerId).attrs?.modelId).not.toBeNull();
    expect(searches).toEqual([]);
    toldEmpty(model);
  });

  test("a scope whose Folders, Tags and Documents were all deleted is empty, not every Document", async () => {
    const model = searchingModel();
    const { core, client, mind, searches, folders, id, library } = await setUpLibrary(model);
    await renameKitchen(core, library);
    await core.deleteDocument(id("Almanac"));

    await askScoped(core, client, mind.id, {
      folderIds: [folders.kitchen.id],
      documentIds: [id("Almanac")],
    });

    expect(model.doStreamCalls).toHaveLength(1);
    expect(searches).toEqual([]);
    toldEmpty(model);
  });
});

describe("Searching within a Search scope", { timeout: 30_000 }, () => {
  test("the model's searches return Passages only from the scope, and it is told what it is limited to", async () => {
    const model = searchingModel();
    const { core, client, mind, folders } = await setUpLibrary(model);

    await askScoped(core, client, mind.id, { folderIds: [folders.rivers.id] });

    expect(shownDocuments(model)).toEqual(["Delta", "Estuary"]);
    expect(promptOf(model)[0]?.text).toContain("limited this Question to 2 Documents");
  });

  test("an Answer cites a Passage from the scope", async () => {
    const model = citingModel({
      query: "tides",
      records: (passages) =>
        passages.map((passage, index) => ({
          marker: index + 1,
          passage: passage.id,
          quote: passage.text.split("\n").at(-1) ?? "",
        })),
      answer: "Your Documents describe tides [^1] [^2].",
    });
    const { core, client, mind, tags, id } = await setUpLibrary(model);

    const { finished } = await askScoped(core, client, mind.id, {
      tagIds: [tags.astronomy.id],
      documentIds: [id("Harbour")],
    });

    expect(finished.citations.map((citation) => citation.documentName).sort()).toEqual([
      "Harbour",
      "Moon",
    ]);
    expect(finished.citations.every((citation) => citation.check === "found")).toBe(true);
  });

  test("a model that can't call Tools searches once, only within the scope", async () => {
    const shown: string[] = [];
    const model = scriptedModel((call) => {
      if (call.tools.length > 0) {
        return { error: { status: 400, message: "this model does not support tools" } };
      }
      shown.push(...shownPassages(call.system).map((passage) => passage.document));
      return { text: JSON.stringify({ answer: "Tides, in short.", citations: [] }) };
    });
    const { core, client, mind, folders, searches } = await setUpLibrary(model);

    const { finished } = await askScoped(core, client, mind.id, {
      folderIds: [folders.deltas.id, folders.kitchen.id],
    });

    expect(finished.citationSupport).toBe("structured-output");
    expect(searches).toEqual([["Delta", "Recipes"]]);
    expect([...new Set(shown)].sort()).toEqual(["Delta", "Recipes"]);
  });
});

describe("A Question's Search scope", { timeout: 30_000 }, () => {
  test("is kept on the Question across a restart, and regenerating uses the scope as it is now", async () => {
    const model = searchingModel();
    const { core, client, mind, dataDir, folders, tags, answerSearch, searches, models } =
      await setUpLibrary(model);
    const { questionId, answerId } = await askScoped(core, client, mind.id, {
      folderIds: [folders.rivers.id],
      tagIds: [tags.astronomy.id],
    });
    core.close();

    const adapters: Partial<CoreAdapters> = {
      createChatModel: models.createChatModel,
      answerSearch,
    };
    const restarted = startCore(dataDir, adapters);
    const reader = await connectToMind(restarted, mind.id);
    let stored: Record<string, unknown> | null = null;
    readMind(reader).forEach((block) => {
      if (block.attrs.id === questionId) stored = block.attrs;
    });
    expect(stored).toMatchObject(
      scopeAttributes({ folderIds: [folders.rivers.id], tagIds: [tags.astronomy.id] }),
    );

    await restarted.regenerateAnswer({ mindId: mind.id, answerId });
    await answerEnded(restarted, answerId);

    // The User narrows the scope to the Tag; regenerating searches only that.
    editMind(reader, (blocks) =>
      blocks.map((block) =>
        block.attrs?.id === questionId
          ? {
              ...block,
              attrs: { ...block.attrs, ...scopeAttributes({ tagIds: [tags.astronomy.id] }) },
            }
          : block,
      ),
    );
    await reader.settled();
    await restarted.regenerateAnswer({ mindId: mind.id, answerId });
    await answerEnded(restarted, answerId);

    expect(searches).toEqual([
      ["Delta", "Estuary", "Moon"],
      ["Delta", "Estuary", "Moon"],
      ["Moon"],
    ]);
  });

  test("an Answer to an unscoped Question still sees every Document after a scoped one", async () => {
    const { core, client, mind, searches, folders } = await setUpLibrary();

    await askScoped(core, client, mind.id, { folderIds: [folders.deltas.id] });
    await askAndFinish(core, client, mind.id, "And everything else?");

    expect(searches[0]).toEqual(["Delta"]);
    expect(searches).toHaveLength(2);
    someOfAll(searches[1] ?? []);
  });
});

/** The Document names a model's instructions list, in order, and the line that counts the rest, if any. */
function listedNames(system: string): string[] {
  const lines = system.split("\n");
  const from = lines.findIndex((line) =>
    /^(?:Its name|Their names, newest first|The names of the \d+ added most recently):$/.test(line),
  );
  if (from < 0) return [];
  const names: string[] = [];
  for (const line of lines.slice(from + 1)) {
    if (!line.startsWith("- ")) break;
    names.push(line.slice(2));
  }
  return names;
}

/** The text of a request's last user message, which ends with the Question. */
function questionOf(call: ModelCall): string {
  const last = call.options.prompt.filter((message) => message.role === "user").at(-1);
  return (last?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

/**
 * A model that knows the User's Documents from its instructions alone: asked
 * which Documents there are, it lists the names it was given; asked to
 * compare some, it searches for each one the Question names, then answers.
 */
function namesModel(): MockLanguageModelV4 {
  return scriptedModel((call) => {
    const names = listedNames(call.system);
    const asked = questionOf(call);
    if (/which documents/i.test(asked)) return { text: `You have ${names.join(", ")}.` };
    const named = names.filter((name) => asked.includes(name));
    const searched = call.results.filter((result) => result.tool === "search_documents").length;
    const next = named[searched];
    if (next) return { calls: [{ tool: "search_documents", input: { query: next } }] };
    return { text: `Compared ${named.join(" and ")}.` };
  });
}

describe("The Documents an Answer is told about", { timeout: 60_000 }, () => {
  test("are named in its instructions, newest first, so a model can say which there are; with a Search scope, only the scope's", async () => {
    const model = namesModel();
    const { core, client, mind, folders } = await setUpLibrary(model);

    const all = await askScoped(core, client, mind.id, {}, "Which documents do I have?");
    // The Linked folder's were added last. It indexes its newest file first, so Harbour,
    // its oldest, was added most recently. The missing one isn't named.
    expect(answerText(client, all.answerId)).toBe(
      "You have Harbour, Estuary, Delta, Recipes, Almanac, Moon.",
    );

    const rivers = await askScoped(
      core,
      client,
      mind.id,
      { folderIds: [folders.rivers.id] },
      "Which documents do I have?",
    );
    expect(answerText(client, rivers.answerId)).toBe("You have Estuary, Delta.");
    // No Document outside the scope is named.
    const scoped = promptOf(model, 1)[0]?.text ?? "";
    expect(scoped).toContain("limited this Question to 2 Documents");
    for (const name of ["Harbour", "Moon", "Almanac", "Recipes"]) {
      expect(scoped).not.toContain(name);
    }
  });

  test("a model can compare two Documents the Question names: it finds them by name and searches each", async () => {
    const model = namesModel();
    const { core, client, mind } = await setUpLibrary(model);

    const { answerId } = await askScoped(
      core,
      client,
      mind.id,
      {},
      "Compare Harbour with Estuary.",
    );

    expect(answerText(client, answerId)).toBe("Compared Harbour and Estuary.");
    const calls = JSON.parse(answerIn(client, answerId).attrs.toolCalls as string) as {
      input: { query: string };
    }[];
    expect(calls.map((call) => call.input.query)).toEqual(["Harbour", "Estuary"]);
    expect(shownDocuments(model)).toEqual(expect.arrayContaining(["Estuary", "Harbour"]));
  });

  test("past 50, the 50 added most recently are named and the rest counted; a scope's are all named", async () => {
    const files = Array.from({ length: 52 }, (_, at) => {
      const number = String(at + 1).padStart(2, "0");
      return { name: `Log ${number}.txt`, contents: `Log ${number}: the tide turned.\n` };
    });
    const model = namesModel();
    const { core, client, mind, documents } = await setUpWithDocuments(model, files);

    await askAndFinish(core, client, mind.id, "Which documents do I have?");

    const system = promptOf(model)[0]?.text ?? "";
    expect(system).toContain("The User has added 52 Documents");
    const names = listedNames(system);
    expect(names).toHaveLength(51);
    expect(names.slice(0, 2)).toEqual(["Log 52", "Log 51"]);
    expect(names.slice(-2)).toEqual(["Log 03", "…and 2 more"]);

    // The two oldest and one more, by hand: all three named, and nothing else.
    const picked = [0, 1, 29].map((at) => documents[at]?.id as string);
    await askScoped(core, client, mind.id, { documentIds: picked }, "Which documents do I have?");

    const scoped = promptOf(model, 1)[0]?.text ?? "";
    expect(scoped).toContain("limited this Question to 3 Documents");
    expect(listedNames(scoped)).toEqual(["Log 30", "Log 02", "Log 01"]);
  });

  test("read_document refuses a Document outside the Question's Search scope", async () => {
    const model = scriptedModel((call) =>
      call.results.length === 0
        ? { calls: [{ tool: "read_document", input: { document: "Moon", pages: "1" } }] }
        : { text: "I couldn't read Moon." },
    );
    const { core, client, mind, id } = await setUpLibrary(model);

    const { answerId } = await askScoped(core, client, mind.id, {
      documentIds: [id("Delta")],
    });

    expect(answerText(client, answerId)).toBe("I couldn't read Moon.");
    const calls = JSON.parse(answerIn(client, answerId).attrs.toolCalls as string) as {
      tool: string;
      resultCount: number | null;
      input: Record<string, unknown>;
    }[];
    expect(calls).toContainEqual({
      tool: "read_document",
      resultCount: 0,
      input: { document: "Moon", pages: "1" },
      id: expect.any(String),
      source: "documents",
      status: "done",
    });
  });
});
