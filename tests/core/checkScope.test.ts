/**
 * Where a check from a Mind looks (#1623): the Search scope the User set for the Mind, else its
 * Folder while that holds a Document, else every Document; text added from an Answer brings
 * the scope its Question was asked with; the file a Mind was imported from is never its evidence.
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { type Core, MIND_CONTENT_FIELD, type SearchScope } from "../../src/core";
import { messageReference } from "../../src/core/references";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { checkedScope, claimCheckShown } from "../../src/shared/claimChecks";
import { mindScopeOf, scopeBeforeOf, setMindScope } from "../../src/shared/mindScope";
import { folderScope, NO_SCOPE } from "../../src/shared/searchScope";
import { askAssistant } from "../helpers/assistant";
import { checkGenerate, checkReply, isCheckRun, type Plan } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, waitForDocuments, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";
import { wordFile, paragraph as wordParagraph } from "../helpers/word";
import { importWordBytes } from "../helpers/wordMinds";

const LANGUAGES = {
  en: {
    own: { name: "Okoro agreement", line: "The Employee may work from home two days a week." },
    other: { name: "Adeyemi agreement", line: "The Employee may work from home one day a week." },
    summary: "Summarise the agreement.",
  },
  "zh-CN": {
    own: { name: "林晓劳动合同", line: "乙方每周可在家工作两天。" },
    other: { name: "王芳劳动合同", line: "乙方每周可在家工作一天。" },
    summary: "总结这份合同。",
  },
} as const;
type Language = keyof typeof LANGUAGES;

const text = (value: string): JSONContent => ({ type: "text", text: value });
const documentsScope = (...documentIds: string[]): SearchScope => ({
  folderIds: [],
  tagIds: [],
  documentIds,
});

async function setUp(language: Language) {
  const words = LANGUAGES[language];
  const plans: Record<string, Plan> = {
    [words.own.line]: { verdict: "supported", quote: words.own.line },
  };
  const calls: ModelCall[] = [];
  const model = scriptedModel(
    (call) => {
      calls.push(call);
      return isCheckRun(call) ? checkReply(call, plans) : { text: words.own.line };
    },
    { generate: checkGenerate(plans) },
  );
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, { createChatModel: scriptedModels(model).createChatModel });
  await core.updateSettings({ user: { language } });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const sources = await createTempDataFolder();
  const [own, other] = await addAndProcess(core, [
    await writeSourceFile(
      sources,
      `${words.own.name}.md`,
      `# ${words.own.name}\n\n${words.own.line}\n`,
    ),
    await writeSourceFile(
      sources,
      `${words.other.name}.md`,
      `# ${words.other.name}\n\n${words.other.line}\n`,
    ),
  ]);
  if (!own || !other) throw new Error("The agreements weren't added.");
  const handed = (from = 0) =>
    new Set(
      calls
        .slice(from)
        .filter(isCheckRun)
        .flatMap((call) =>
          call.results
            .filter((result) => result.tool === "search_documents")
            .flatMap((result) => shownPassages(result.text).map((each) => each.document)),
        ),
    );
  return { core, dataDir, words, own, other, calls, handed };
}

async function mindWith(core: Core, line: string, folderId: string | null = null) {
  const mind = await core.createMind({ title: "Summary", folderId });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [{ type: "paragraph", attrs: { id: "one" }, content: [text(line)] }]);
  await client.settled();
  return { mindId: mind.id, client };
}

const checkAll = (core: Core, mindId: string, id = "all") =>
  core.checkMind({ requestId: `${id}-${mindId}`, mindId, mode: "all" });

async function checkOf(client: MindClient) {
  await client.settled();
  const [span] = claimSpans(readMind(client));
  if (!span) throw new Error("The sentence has no check.");
  return span;
}

describe.each(["en", "zh-CN"] as const)("A check from a Mind (%s)", (language) => {
  // protects=a Mind whose scope the User set to one Document is checked against that Document only, in no Folder, in a Folder holding others, and after a restart; fails_when=the check searches the Folder or every Document, or the scope is gone after a restart; no_claim=what the model then decides.
  test("with a chosen scope of one Document looks only there, unfiled or filed, and the scope is kept with the Mind", async () => {
    const { core, dataDir, words, own, other, calls, handed } = await setUp(language);
    const { mindId, client } = await mindWith(core, words.own.line);
    setMindScope(client.doc, documentsScope(own.id));
    await client.settled();

    await checkAll(core, mindId);
    expect([...handed()]).toEqual([words.own.name]);
    const unfiled = await checkOf(client);
    expect(unfiled.check).toMatchObject({ state: "supported" });
    expect(checkedScope(unfiled.check.scope)).toEqual(documentsScope(own.id));

    const folder = await core.createLibraryGroup({ name: "Agreements", description: "" });
    await core.moveToFolder({
      documentIds: [own.id, other.id],
      mindIds: [mindId],
      folderId: folder.id,
    });
    // Its check was made in its own scope, which the move didn't change.
    expect(
      claimCheckShown(unfiled.check, {
        text: unfiled.sentence.text,
        versions: null,
        folderId: folder.id,
        scope: documentsScope(own.id),
      }),
    ).toEqual({ state: "supported" });
    const before = calls.length;
    await checkAll(core, mindId, "filed");
    expect([...handed(before)]).toEqual([words.own.name]);
    expect(checkedScope((await checkOf(client)).check.scope)).toEqual(documentsScope(own.id));

    core.close();
    const restarted = await connectToMind(startCore(dataDir), mindId);
    expect(mindScopeOf(restarted.doc)).toEqual(documentsScope(own.id));
  });

  test("a wall keeps an all-Documents check in its Folder", async () => {
    const { core, words, own, handed } = await setUp(language);
    const folder = await core.createLibraryGroup({ name: "Walled agreements", description: "" });
    await core.assignDocumentGroup(own.id, folder.id);
    const { mindId, client } = await mindWith(core, words.own.line, folder.id);
    await core.updateLibraryGroup(folder.id, {
      name: folder.name,
      description: folder.description,
      keepInside: true,
    });

    await core.checkMind({
      requestId: `walled-${mindId}`,
      mindId,
      mode: "all",
      allDocuments: true,
    });

    expect([...handed()]).toEqual([words.own.name]);
    const checked = await checkOf(client);
    expect(checkedScope(checked.check.scope)).toEqual(folderScope(folder.id));
    expect(checked.check.scope.widened).toBe(false);
  });

  // protects=a Mind with no scope of its own is checked against its Folder while it holds a Document, and against every Document unfiled, with the mark saying which; fails_when=the Folder's Mind reads the other agreement, or the unfiled one is marked as checked in a Folder; no_claim=a Folder that holds no Document (#1359's tests).
  test("with no scope of its own looks in its Folder, or, in none, in every Document", async () => {
    const { core, words, own, calls, handed } = await setUp(language);
    const folder = await core.createLibraryGroup({ name: "Okoro", description: "" });
    await core.moveToFolder({ documentIds: [own.id], folderId: folder.id });
    const filed = await mindWith(core, words.own.line, folder.id);
    await checkAll(core, filed.mindId);
    expect([...handed()]).toEqual([words.own.name]);
    const inFolder = (await checkOf(filed.client)).check.scope;
    expect(inFolder.chosen).toBeUndefined();
    expect(checkedScope(inFolder)).toEqual(folderScope(folder.id));

    const before = calls.length;
    const unfiled = await mindWith(core, words.own.line);
    await checkAll(core, unfiled.mindId, "unfiled");
    expect(handed(before)).toEqual(new Set([words.own.name, words.other.name]));
    expect(checkedScope((await checkOf(unfiled.client)).check.scope)).toBeNull();
  });

  // protects=a summary added from an Answer asked with one Document as its scope is checked against that Document, a Mind's own scope isn't replaced, and an Answer that searched everything brings none; fails_when=the summary is checked against every Document, an own scope is overwritten, or a scope appears from nowhere; no_claim=Undo of the add.
  test("text added from an Answer asked of one Document brings that scope into a Mind with none, and its check looks there", async () => {
    const { core, words, own, other, handed } = await setUp(language);
    const answer = await askAssistant(core, { text: words.summary, scope: documentsScope(own.id) });
    const origin = {
      from: messageReference(answer.conversationId, answer.id),
      question: words.summary,
    };
    const blocks = [{ type: "paragraph", content: [text(words.own.line)] }];

    const summary = await core.createMind({ title: "Summary" });
    await core.addToNote({ mindId: summary.id, blocks, origin, model: null });
    const client = await connectToMind(core, summary.id);
    expect(mindScopeOf(client.doc)).toEqual(documentsScope(own.id));
    await checkAll(core, summary.id);
    expect([...handed()]).toEqual([words.own.name]);
    expect(checkedScope((await checkOf(client)).check.scope)).toEqual(documentsScope(own.id));

    const chosen = await mindWith(core, words.other.line);
    setMindScope(chosen.client.doc, documentsScope(other.id));
    await chosen.client.settled();
    await core.addToNote({ mindId: chosen.mindId, blocks, origin, model: null });
    expect(mindScopeOf((await connectToMind(core, chosen.mindId)).doc)).toEqual(
      documentsScope(other.id),
    );

    const everything = await askAssistant(core, { text: words.summary });
    const plain = await core.createMind({ title: "Plain" });
    await core.addToNote({
      mindId: plain.id,
      blocks,
      origin: { from: messageReference(everything.conversationId, everything.id), question: "" },
      model: null,
    });
    expect(mindScopeOf((await connectToMind(core, plain.id)).doc)).toBeNull();
  });

  // protects=Undo of Add to note takes back the scope the add brought, and leaves one the User set since; fails_when=the Mind keeps the Answer's scope after Undo, or Undo clears the User's own choice; no_claim=the editor's own Undo of an add into the open Mind (the same step, in the editor).
  test("Undo of the add takes back the scope it brought, unless the User changed it since", async () => {
    const { core, words, own, other } = await setUp(language);
    const answer = await askAssistant(core, { text: words.summary, scope: documentsScope(own.id) });
    const origin = { from: messageReference(answer.conversationId, answer.id), question: "" };
    const blocks = [{ type: "paragraph", content: [text(words.own.line)] }];

    const mind = await core.createMind({ title: "Summary" });
    const added = await core.addToNote({ mindId: mind.id, blocks, origin, model: null });
    const client = await connectToMind(core, mind.id);
    expect(mindScopeOf(client.doc)).toEqual(documentsScope(own.id));
    await core.undoAddToNote({ mindId: mind.id, blockIds: added.blockIds });
    expect(mindScopeOf((await connectToMind(core, mind.id)).doc)).toBeNull();

    const again = await core.addToNote({ mindId: mind.id, blocks, origin, model: null });
    setMindScope(client.doc, documentsScope(other.id));
    await client.settled();
    await core.undoAddToNote({ mindId: mind.id, blockIds: again.blockIds });
    expect(mindScopeOf((await connectToMind(core, mind.id)).doc)).toEqual(documentsScope(other.id));
  });

  // protects=a change of the Mind's own scope marks the checks made before it for a re-check, and Check again looks in the new scope; fails_when=earlier checks still show their verdicts as if they held, or Check again searches the old scope; no_claim=a Folder move (#96's tests).
  test("a change of the Mind's scope marks its earlier checks for a re-check, and Check again looks in the new one", async () => {
    const { core, words, own, other, calls, handed } = await setUp(language);
    const folder = await core.createLibraryGroup({ name: "Agreements", description: "" });
    await core.moveToFolder({ documentIds: [own.id], folderId: folder.id });
    const { mindId, client } = await mindWith(core, words.own.line, folder.id);
    await checkAll(core, mindId);
    const planned = () => core.planMindCheck(mindId, "changed");
    expect(await planned()).toMatchObject({ kind: "unchanged" });

    setMindScope(client.doc, documentsScope(other.id));
    await client.settled();
    const span = await checkOf(client);
    expect(
      claimCheckShown(span.check, {
        text: span.sentence.text,
        versions: null,
        folderId: folder.id,
        scope: documentsScope(other.id),
      }),
    ).toEqual({ state: "needs-recheck", why: "search-scope" });
    expect(await planned()).toMatchObject({ kind: "ready", sentences: 1 });
    const before = calls.length;
    await core.checkMind({ requestId: "again", mindId, mode: "changed" });
    expect([...handed(before)]).toEqual([words.other.name]);
    expect(checkedScope((await checkOf(client)).check.scope)).toEqual(documentsScope(other.id));

    // Back to the Mind's own Folder: the check made in the other Document needs one again.
    setMindScope(client.doc, null);
    await client.settled();
    expect(await planned()).toMatchObject({ kind: "ready", sentences: 1 });
  });
});

describe("A Mind with no scope of its own, as every Mind written before", () => {
  // protects=a Mind whose content has no scope key, as every Mind written before the scope was kept, is checked where it was before: its Folder while that holds a Document, else every Document marked as widened; fails_when=it is checked elsewhere, or its marks read as made in a chosen scope; no_claim=an older app opening a Mind with a scope (chosenScopeOlderVersion.test.ts).
  test("is checked in its Folder, else in every Document, as before", async () => {
    const { core, words, own } = await setUp("en");
    const older = async (folderId: string | null) => {
      const mind = await core.createMind({ title: "Older", folderId });
      const doc = new Y.Doc();
      const paragraph = new Y.XmlElement("paragraph");
      paragraph.setAttribute("id", "one");
      const line = new Y.XmlText();
      line.insert(0, words.own.line);
      paragraph.insert(0, [line]);
      doc.getXmlFragment(MIND_CONTENT_FIELD).push([paragraph]);
      await core.applyMindUpdate(mind.id, Y.encodeStateAsUpdate(doc));
      const client = await connectToMind(core, mind.id);
      expect(mindScopeOf(client.doc)).toBeNull();
      await checkAll(core, mind.id);
      return (await checkOf(client)).check.scope;
    };
    const folder = await core.createLibraryGroup({ name: "Okoro", description: "" });
    await core.moveToFolder({ documentIds: [own.id], folderId: folder.id });
    const empty = await core.createLibraryGroup({ name: "Nothing yet", description: "" });

    expect(await older(folder.id)).toEqual({ folderId: folder.id, widened: false });
    expect(await older(null)).toEqual({ folderId: null, widened: false });
    expect(await older(empty.id)).toEqual({ folderId: empty.id, widened: true });
  });
});

describe("A check whose chosen scope holds nothing to check against", () => {
  // protects=a Mind whose chosen scope is a deleted Document or a deleted Folder is told that its scope holds nothing, not that the Library is empty, nothing is sent and the scope stays as chosen; a Library with no Documents at all still reads as one; fails_when=the result reads as an empty Library, a check runs, or the scope widens by itself; no_claim=how the card words it (e2e).
  test("says it is the Mind's scope, never widens by itself, and an empty Library still reads as one", async () => {
    const { core, words, own, other, calls } = await setUp("en");
    const { mindId, client } = await mindWith(core, words.own.line);
    const nothingIn = (scope: SearchScope, folderId: string | null = null) => ({
      kind: "no-documents",
      folderId,
      chosen: { scope, onlyLeftOut: false },
    });

    setMindScope(client.doc, documentsScope(own.id));
    await client.settled();
    await core.deleteDocument(own.id);
    expect(await core.planMindCheck(mindId, "all")).toEqual(nothingIn(documentsScope(own.id)));
    expect(await checkAll(core, mindId)).toEqual(nothingIn(documentsScope(own.id)));

    const folder = await core.createLibraryGroup({ name: "Old agreements", description: "" });
    setMindScope(client.doc, folderScope(folder.id));
    await client.settled();
    await core.deleteLibraryGroup(folder.id);
    expect(await checkAll(core, mindId, "folder")).toEqual(
      nothingIn(folderScope(folder.id), folder.id),
    );
    expect(calls.filter(isCheckRun)).toHaveLength(0);
    expect(mindScopeOf(client.doc)).toEqual(folderScope(folder.id));

    await core.deleteDocument(other.id);
    expect(await checkAll(core, mindId, "empty")).toEqual({
      kind: "no-documents",
      folderId: folder.id,
    });
  });
});

describe("Where one click takes a narrowed scope back to", () => {
  // protects=a narrowed scope remembers the wide scope it narrowed, the Mind's own or every Document chosen, keeps it while narrowed further and after a restart, and forgets it once the scope is wide again; fails_when=the one click would go back elsewhere, or the way back is lost on a restart; no_claim=the chip that does it (e2e).
  test("is the Mind's own, or every Document when the User chose that, and survives a restart", async () => {
    const { core, dataDir, words, own, other } = await setUp("en");
    const folder = await core.createLibraryGroup({ name: "Agreements", description: "" });
    await core.moveToFolder({ documentIds: [own.id], folderId: folder.id });
    const { mindId, client } = await mindWith(core, words.own.line, folder.id);

    setMindScope(client.doc, documentsScope(own.id));
    expect(scopeBeforeOf(client.doc)).toBeNull();
    setMindScope(client.doc, NO_SCOPE);
    expect(scopeBeforeOf(client.doc)).toBeNull();
    setMindScope(client.doc, documentsScope(own.id));
    expect(scopeBeforeOf(client.doc)).toEqual(NO_SCOPE);
    setMindScope(client.doc, documentsScope(own.id, other.id));
    expect(scopeBeforeOf(client.doc)).toEqual(NO_SCOPE);
    await client.settled();

    core.close();
    const restarted = await connectToMind(startCore(dataDir), mindId);
    expect(mindScopeOf(restarted.doc)).toEqual(documentsScope(own.id, other.id));
    expect(scopeBeforeOf(restarted.doc)).toEqual(NO_SCOPE);
  });

  // protects=two devices narrowing the scope at once end on one device's scope with that device's way back, never one's scope with the other's; fails_when=the scope and its way back come from different devices; no_claim=which device wins (Yjs decides).
  test("two devices narrowing at once keep one device's scope with its own way back", () => {
    const first = new Y.Doc();
    const second = new Y.Doc();
    setMindScope(first, NO_SCOPE);
    Y.applyUpdate(second, Y.encodeStateAsUpdate(first));
    setMindScope(first, documentsScope("okoro"));
    setMindScope(second, null);
    setMindScope(second, documentsScope("adeyemi"));
    Y.applyUpdate(second, Y.encodeStateAsUpdate(first));
    Y.applyUpdate(first, Y.encodeStateAsUpdate(second));

    const ended = [mindScopeOf(first), scopeBeforeOf(first)];
    expect([mindScopeOf(second), scopeBeforeOf(second)]).toEqual(ended);
    expect([
      [documentsScope("okoro"), NO_SCOPE],
      [documentsScope("adeyemi"), null],
    ]).toContainEqual(ended);
  });
});

describe("A Mind imported from a Word file", () => {
  const LOAN = "The Northgate Bank term loan stood at £214,480.00 at 31 March 2026.";
  const BANK = "Balance outstanding at 31 March 2026: GBP 212,480.00.";

  // protects=a Word Mind whose chosen scope names its own original file still never counts that file, and the check names it as left out; fails_when=the original is handed to the model, or the check doesn't say it was left out; no_claim=how the card words it (e2e).
  test("whose chosen scope names its own file is never supported by it, and the check says it was left out", async () => {
    const plans: Record<string, Plan> = {
      [LOAN]: { verdict: "contradicted", quote: BANK, says: "The bank says £212,480.00." },
    };
    const calls: ModelCall[] = [];
    const model = scriptedModel(
      (call) => {
        calls.push(call);
        return checkReply(call, plans);
      },
      { generate: checkGenerate(plans) },
    );
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(model).createChatModel,
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const sources = await createTempDataFolder();
    const [bank] = await addAndProcess(core, [
      await writeSourceFile(
        sources,
        "Northgate Bank confirmation.md",
        `# Confirmation\n\n${BANK}\n`,
      ),
    ]);
    const { mindId, client } = await importWordBytes(
      core,
      sources,
      wordFile({ body: wordParagraph(`Revenue grew. ${LOAN}`) }),
      { name: "Draft memo.docx", origin: "own", folderId: null, addOriginal: true },
    );
    const listed = await waitForDocuments(core, (documents) =>
      expect(documents.filter((each) => each.status === "ready")).toHaveLength(2),
    );
    const memo = listed.find((each) => each.id !== bank?.id);
    if (!bank || !memo) throw new Error("The Documents weren't added.");
    setMindScope(client.doc, documentsScope(memo.id, bank.id));
    await client.settled();

    await checkAll(core, mindId);

    await client.settled();
    const loan = claimSpans(readMind(client)).find((span) => span.sentence.text.trim() === LOAN);
    expect(loan?.check).toMatchObject({
      state: "contradicted",
      evidence: { quote: BANK },
      excluded: [{ documentId: memo.id, reason: "checked-document" }],
    });
    const handedNames = calls
      .filter(isCheckRun)
      .flatMap((call) =>
        call.results
          .filter((result) => result.tool === "search_documents")
          .flatMap((result) => shownPassages(result.text).map((each) => each.document)),
      );
    expect(handedNames.length).toBeGreaterThan(0);
    expect(handedNames.some((name) => name.startsWith("Draft memo"))).toBe(false);
  });

  // protects=a Word Mind whose chosen scope holds only its own original file is told that is all its scope holds, and nothing is sent, while the Library has another Document; fails_when=it reads as an empty Library, or the original is checked against; no_claim=the card's words (e2e).
  test("whose chosen scope holds only its own file is told so, and nothing is sent", async () => {
    const calls: ModelCall[] = [];
    const model = scriptedModel((call) => {
      calls.push(call);
      return { text: "" };
    });
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(model).createChatModel,
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const sources = await createTempDataFolder();
    const [bank] = await addAndProcess(core, [
      await writeSourceFile(
        sources,
        "Northgate Bank confirmation.md",
        `# Confirmation\n\n${BANK}\n`,
      ),
    ]);
    const { mindId, client } = await importWordBytes(
      core,
      sources,
      wordFile({ body: wordParagraph(LOAN) }),
      { name: "Draft memo.docx", origin: "own", folderId: null, addOriginal: true },
    );
    const listed = await waitForDocuments(core, (documents) =>
      expect(documents.filter((each) => each.status === "ready")).toHaveLength(2),
    );
    const memo = listed.find((each) => each.id !== bank?.id);
    if (!memo) throw new Error("The original wasn't added.");
    setMindScope(client.doc, documentsScope(memo.id));
    await client.settled();

    expect(await checkAll(core, mindId)).toEqual({
      kind: "no-documents",
      folderId: null,
      chosen: { scope: documentsScope(memo.id), onlyLeftOut: true },
    });
    expect(calls.filter(isCheckRun)).toHaveLength(0);
  });
});
