import { describe, expect, test } from "vitest";
import type { AskInConversationInput, Core, SearchScope } from "../../src/core";
import { answerEnded, recordSearches, setUpWithDocuments } from "../helpers/citations";
import { type ModelCall, scriptedModel } from "../helpers/models";

/**
 * A Note behind a wall searches its own Folder, never a Folder beside it (#2427): the wall is
 * the outer limit, not the Folder the Note reads. A Note in the wall's own Folder reads it all.
 */

const FILES = [
  { name: "Chapter two terms.txt", contents: "The terms of Chapter two are net 30.\n" },
  { name: "Chapter three terms.txt", contents: "The terms of Chapter three are net 60.\n" },
  { name: "Outside terms.txt", contents: "The terms outside the wall are net 90.\n" },
];

const folderScope = (folderId: string): SearchScope => ({
  folderIds: [folderId],
  tagIds: [],
  documentIds: [],
});

const searchThenAnswer = (call: ModelCall) =>
  call.results.length === 0
    ? { calls: [{ tool: "search_documents", input: { query: "terms" } }] }
    : { text: "Here is what your Documents say." };

async function setUp() {
  const { searches, answerSearch } = recordSearches();
  const setup = await setUpWithDocuments(scriptedModel(searchThenAnswer), FILES, {
    answerSearch,
  });
  const thesis = await setup.core.createLibraryGroup({ name: "Thesis", description: "" });
  await setup.core.updateLibraryGroup(thesis.id, {
    name: thesis.name,
    description: thesis.description,
    keepInside: true,
  });
  const chapter2 = await setup.core.createLibraryGroup({
    name: "Chapter 2",
    description: "",
    parentId: thesis.id,
  });
  const chapter3 = await setup.core.createLibraryGroup({
    name: "Chapter 3",
    description: "",
    parentId: thesis.id,
  });
  const document = (part: string) =>
    setup.documents.find((each) => each.name.includes(part)) as { id: string };
  await setup.core.assignDocumentGroup(document("Chapter two").id, chapter2.id);
  await setup.core.assignDocumentGroup(document("Chapter three").id, chapter3.id);
  await setup.core.moveToFolder({ mindIds: [setup.mind.id], folderId: chapter2.id });
  const wholeWall = await setup.core.createMind({ title: "The whole wall", folderId: thesis.id });
  return { ...setup, searches, wholeWall, thesis, chapter2 };
}

async function ask(core: Core, input: AskInConversationInput) {
  const result = await core.askInConversation(input);
  if (!result.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(result)}`);
  expect((await answerEnded(core, result.answerId)).event).toBe("finished");
}

describe("A Note in a sub-Folder of a wall", { timeout: 30_000 }, () => {
  // protects=a Note in a sub-Folder searches that Folder alone, never a sibling inside the same wall (#2427); fails_when=the search reaches the sibling; no_claim=none beyond protects.
  test("reads that Folder, not its sibling, in English and in Chinese", async () => {
    const { core, mind, searches, chapter2 } = await setUp();
    // As the composer sends it: the Note's own Folder (#1359).
    await ask(core, {
      text: "What do my Documents say about the terms?",
      mindId: mind.id,
      scope: folderScope(chapter2.id),
    });
    expect(searches.at(-1)).toEqual(["Chapter two terms"]);
    await core.updateSettings({ user: { language: "zh-CN" } });
    await ask(core, {
      text: "我的文档里关于条款是怎么说的？",
      mindId: mind.id,
      scope: folderScope(chapter2.id),
    });
    expect(searches.at(-1)).toEqual(["Chapter two terms"]);
  });

  // protects=the wall is the only limit for a Note in its own Folder: both sub-Folders are read, nothing outside it (#2427); fails_when=the search reaches a Document outside the wall; no_claim=none beyond protects.
  test("a Note in the wall's own Folder reads the whole wall, never outside it, in English and in Chinese", async () => {
    const { core, wholeWall, searches, thesis } = await setUp();
    await ask(core, {
      text: "What do my Documents say about the terms?",
      mindId: wholeWall.id,
      scope: folderScope(thesis.id),
    });
    expect(searches.at(-1)).toEqual(["Chapter three terms", "Chapter two terms"]);
    await core.updateSettings({ user: { language: "zh-CN" } });
    await ask(core, {
      text: "我的文档里关于条款是怎么说的？",
      mindId: wholeWall.id,
      scope: folderScope(thesis.id),
    });
    expect(searches.at(-1)).toEqual(["Chapter three terms", "Chapter two terms"]);
  });
});
