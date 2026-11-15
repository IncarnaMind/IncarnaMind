import { describe, expect, test } from "vitest";
import type { AskInConversationInput, Core, SearchScope } from "../../src/core";
import { answerEnded, recordSearches, setUpWithDocuments } from "../helpers/citations";
import { type ModelCall, scriptedModel } from "../helpers/models";

/**
 * A Folder keeping its work inside it, inside another that does, is a wall of its own (#246): a
 * Note in either reads its own side only. The window's pickers and Citations say the same
 * (`tests/renderer/nestedWalls.test.ts`).
 */

const OUTER_TERMS = "The terms of the outer Folder are net 30.";
const INNER_TERMS = "The terms of the inner Folder are net 60.";
const FILES = [
  { name: "Outer terms.txt", contents: `${OUTER_TERMS}\n` },
  { name: "Inner terms.txt", contents: `${INNER_TERMS}\n` },
  { name: "Open terms.txt", contents: "The terms outside every wall are net 90.\n" },
];

const scope = (parts: Partial<SearchScope>): SearchScope => ({
  folderIds: [],
  tagIds: [],
  documentIds: [],
  ...parts,
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
  const { core } = setup;
  const walled = async (name: string, parentId?: string) => {
    const folder = await core.createLibraryGroup({ name, description: "", parentId });
    await core.updateLibraryGroup(folder.id, { name, description: "", keepInside: true });
    return folder;
  };
  const outer = await walled("Client A");
  const inner = await walled("Sealed", outer.id);
  const document = (part: string) => {
    const found = setup.documents.find((each) => each.name.startsWith(part));
    if (!found) throw new Error(`The Document ${part} wasn't added.`);
    return found;
  };
  await core.assignDocumentGroup(document("Outer").id, outer.id);
  await core.assignDocumentGroup(document("Inner").id, inner.id);
  const noteOuter = await core.createMind({ title: "Outer note", folderId: outer.id });
  const noteInner = await core.createMind({ title: "Inner note", folderId: inner.id });
  return { core, searches, outer, inner, noteOuter, noteInner, document };
}

async function ask(core: Core, input: AskInConversationInput) {
  const result = await core.askInConversation(input);
  if (!result.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(result)}`);
  expect((await answerEnded(core, result.answerId)).event).toBe("finished");
}

const quote = (document: { id: string; contentHash: string }, text: string) => ({
  documentId: document.id,
  quote: text,
  pageFrom: 1,
  pageTo: 1,
  contentHash: document.contentHash,
});

describe("A wall inside a wall", { timeout: 30_000 }, () => {
  // protects=a Note in the outer wall never searches the inner wall's Documents, whether it names the inner Folder or its Document (#246); fails_when=a search from the outer Note reaches "Inner terms"; no_claim=what the composer shows for the dropped pick.
  test("a Note in the outer Folder searches its own side, whatever it picks", async () => {
    const { core, searches, outer, inner, noteOuter, document } = await setUp();
    const text = "What do my Documents say about the terms?";
    await ask(core, { text, mindId: noteOuter.id, scope: scope({ folderIds: [outer.id] }) });
    expect(searches.at(-1)).toEqual(["Outer terms"]);
    await ask(core, { text, mindId: noteOuter.id, scope: scope({ folderIds: [inner.id] }) });
    expect(searches.at(-1)).toEqual(["Outer terms"]);
    await ask(core, {
      text,
      mindId: noteOuter.id,
      scope: scope({ documentIds: [document("Inner").id] }),
    });
    expect(searches.at(-1)).toEqual(["Outer terms"]);
  });

  // protects=a Note in the inner wall never searches the outer wall's Documents (#246); fails_when=a search from the inner Note reaches "Outer terms"; no_claim=none beyond protects.
  test("a Note in the inner Folder searches the inner Folder only", async () => {
    const { core, searches, outer, noteInner } = await setUp();
    await ask(core, {
      text: "What do my Documents say about the terms?",
      mindId: noteInner.id,
      scope: scope({ folderIds: [outer.id] }),
    });
    expect(searches.at(-1)).toEqual(["Inner terms"]);
  });

  // protects=a Citation is read again only from its own side of a nested wall (#246, #1934); fails_when=either Note reads the other wall's Document again; no_claim=none beyond protects.
  test("neither Note reads the other wall's Document again", async () => {
    const { core, noteOuter, noteInner, document } = await setUp();
    expect(
      await core.recheckCitation({
        ...quote(document("Outer"), OUTER_TERMS),
        mindId: noteInner.id,
      }),
    ).toEqual({ keptInside: "Client A" });
    expect(
      await core.recheckCitation({
        ...quote(document("Inner"), INNER_TERMS),
        mindId: noteOuter.id,
      }),
    ).toEqual({ keptInside: "Sealed" });
    const own = await core.recheckCitation({
      ...quote(document("Inner"), INNER_TERMS),
      mindId: noteInner.id,
    });
    expect("keptInside" in own).toBe(false);
  });
});
