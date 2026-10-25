import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { recordingLog } from "../helpers/log";
import { connectToMind } from "../helpers/mindClient";
import { note, question, writeMind } from "../helpers/minds";
import { scriptedModels } from "../helpers/models";

// The User's content and secrets: none of it may reach the log.
const DOCUMENT_NAME = "Merger plan for Northwind";
const DOCUMENT_TEXT = "The codeword for the merger is zanzibar-lantern.";
const MIND_TITLE = "Divorce settlement";
const NOTE = "My salary is 98,765 a year.";
const QUESTION = "Which codeword did Northwind choose?";
const API_KEY = "co-4f9b2c7e1d8a6053b2e9f4c1a7d0e3b5";
const CONTENT = [
  "Merger",
  "Northwind",
  "zanzibar",
  "codeword",
  "Divorce",
  "salary",
  "98,765",
  API_KEY,
  "4f9b2c7e",
];

/** A chat model whose provider refuses every request, quoting what it was sent and a key. */
function refusingModel(): MockLanguageModelV4 {
  const refuse = async (): Promise<never> => {
    throw new APICallError({
      message: `Bad request "${QUESTION}" about "${DOCUMENT_TEXT}" with key ${API_KEY}`,
      url: `https://api.example.com/v1/chat?key=${API_KEY}`,
      requestBodyValues: { prompt: NOTE },
      statusCode: 400,
      isRetryable: false,
    });
  };
  return new MockLanguageModelV4({ doGenerate: refuse, doStream: refuse });
}

describe("the log the core writes", { timeout: 30_000 }, () => {
  test("follows a Document's processing status by status, and a failure by its reason", async () => {
    const { log, entries } = recordingLog();
    const dataDir = await createTempDataFolder();
    const sources = await createTempDataFolder();
    const core = startCore(dataDir, { log });
    const [notes, broken] = await addAndProcess(core, [
      await writeSourceFile(sources, `${DOCUMENT_NAME}.txt`, DOCUMENT_TEXT),
      await writeSourceFile(sources, "Broken.pdf", "This isn't a PDF."),
    ]);
    if (!notes || !broken) throw new Error("Not everything was added.");
    await core.deleteDocument(notes.id);

    const about = (documentId: string) =>
      entries.filter((entry) => entry.fields?.documentId === documentId);
    const statuses = about(notes.id).map((entry) => entry.fields?.status ?? entry.event);
    expect(statuses[0]).toBe("queued");
    expect(statuses).toContain("extracting");
    expect(statuses.slice(-2)).toEqual(["ready", "document.deleted"]);
    // Each change once, however often the Document's progress was reported.
    expect(statuses.filter((status, index) => status === statuses[index - 1])).toEqual([]);
    expect(about(notes.id)[0]).toEqual({
      level: "info",
      event: "document.status",
      fields: { documentId: notes.id, kind: "text", status: "queued", bytes: notes.size },
    });

    expect(about(broken.id).at(-1)).toEqual({
      level: "warn",
      event: "document.failed",
      fields: { documentId: broken.id, kind: "pdf", reason: "unreadable" },
    });
    expect(JSON.stringify(entries)).not.toContain(DOCUMENT_NAME);
  });

  test("never receives the User's content: Documents, Minds, Questions, Answers or keys", async () => {
    const { log, entries } = recordingLog();
    const dataDir = await createTempDataFolder();
    const sources = await createTempDataFolder();
    const models = scriptedModels(refusingModel());
    const core = startCore(dataDir, { log, createChatModel: models.createChatModel });
    // A key for a cloud provider; then a local model, which becomes the default, so nothing needs consent.
    await core.saveChatProvider({ kind: "openai", apiKey: API_KEY, modelId: "gpt-5" });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });

    // A Document, which automatic tagging sends to the refusing model.
    const [document] = await addAndProcess(core, [
      await writeSourceFile(
        sources,
        `${DOCUMENT_NAME}.md`,
        `# ${DOCUMENT_NAME}\n\n${DOCUMENT_TEXT}\n`,
      ),
    ]);
    if (!document) throw new Error("Nothing was added.");
    await core.renameDocument(document.id, `${DOCUMENT_NAME} (final)`);

    // A Mind with a Note and a Question, whose Answer fails.
    const mind = await core.createMind({ title: MIND_TITLE });
    const client = await connectToMind(core, mind.id);
    const asked = question(QUESTION);
    writeMind(client, [note(NOTE), asked]);
    await client.settled();
    const result = await core.askQuestion({ mindId: mind.id, questionId: asked.attrs.id });
    if (!result.asked) throw new Error("The Question wasn't asked.");

    await vi.waitFor(() => {
      const events = entries.map((entry) => entry.event);
      expect(events).toContain("answer.failed");
      expect(events).toContain("tagging.failed");
    });
    // The provider's status and its words, without what they quote or the key.
    expect(entries).toContainEqual({
      level: "warn",
      event: "answer.failed",
      fields: {
        answerId: result.answerId,
        errorKind: "refused",
        status: 400,
        message: "Bad request [redacted] about [redacted] with key [redacted]",
      },
    });
    expect(entries).toContainEqual({
      level: "warn",
      event: "tagging.failed",
      fields: { documentId: document.id, errorKind: "refused" },
    });
    const logged = JSON.stringify(entries);
    for (const secret of [...CONTENT, DOCUMENT_TEXT, MIND_TITLE, NOTE, QUESTION]) {
      expect(logged).not.toContain(secret);
    }
  });
});
