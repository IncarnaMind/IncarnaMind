import { expect, test } from "vitest";
import { askAssistant } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { scriptedModel, scriptedModels } from "../helpers/models";

/**
 * A Citation shown in an Answer inside a walled conversation asks that conversation's wall when it
 * is checked again (#2782): a Document kept in another walled Folder isn't read from there, and
 * the check it was made with stands. A Citation in a Document's viewer reads as browsing does.
 */

const TERM = "The term is 60 days from the start.";

async function start() {
  const model = scriptedModel(() => ({ text: "The lease says 60 days." }), {
    judgesItsAnswers: true,
  });
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const sources = await createTempDataFolder();
  const walled = async (name: string, file: string) => {
    const folder = await core.createLibraryGroup({ name, description: "" });
    await core.updateLibraryGroup(folder.id, {
      name: folder.name,
      description: folder.description,
      keepInside: true,
    });
    const [document] = await addAndProcess(core, [
      await writeSourceFile(sources, file, `# ${name}\n\n${TERM}\n`),
    ]);
    if (!document) throw new Error(`The Document ${file} wasn't added.`);
    await core.assignDocumentGroup(document.id, folder.id);
    return { folder, document };
  };
  const a = await walled("Client A", "Client A lease.md");
  const b = await walled("Client B", "Client B lease.md");
  // A conversation in Client B's wall, with no Note: its Answers' Citations are judged there.
  const answer = await askAssistant(core, { text: "What is the term?" });
  await core.moveToFolder({ conversationIds: [answer.conversationId], folderId: b.folder.id });
  const quote = (document: { id: string; contentHash: string }) => ({
    documentId: document.id,
    quote: TERM,
    pageFrom: 1,
    pageTo: 1,
    contentHash: document.contentHash,
  });
  return { core, a, b, conversationId: answer.conversationId, quote };
}

test("a Citation in a walled conversation isn't read again from a Document behind another wall", async () => {
  const { core, a, conversationId, quote } = await start();

  expect(
    await core.recheckCitation({ ...quote(a.document), mindId: null, conversationId }),
  ).toEqual({ keptInside: "Client A" });
});

test("from the wall the conversation is in, and from browsing, the Citation is checked again", async () => {
  const { core, a, b, conversationId, quote } = await start();

  const own = await core.recheckCitation({
    ...quote(b.document),
    mindId: null,
    conversationId,
  });
  if ("keptInside" in own) throw new Error("The conversation couldn't read its own wall.");
  expect(own.contentHash).toBe(b.document.contentHash);
  expect(own.check).toBe("found");

  // The viewer has neither a Note nor a conversation: it reads as browsing is, which may.
  const browsing = await core.recheckCitation({ ...quote(a.document), mindId: null });
  if ("keptInside" in browsing) throw new Error("Browsing was kept outside a wall.");
  expect(browsing.contentHash).toBe(a.document.contentHash);
  expect(browsing.check).toBe("found");
});
