import { resolve } from "node:path";
import { expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import { EXAMPLE_SETS } from "../../src/core/exampleSets";
import type { Language } from "../../src/core/language";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";

/**
 * The first open's ready Question (#2084): about the User's own Document as soon as one of
 * theirs can be answered, the example's only while they have none.
 */

const EXAMPLES = resolve(__dirname, "../../resources/examples");
const exampleQuestion = (language: Language) =>
  EXAMPLE_SETS.credit[language].ready?.question as string;

/** A core whose example is made, and a folder to write the User's own files in. */
async function start(): Promise<{ core: Core; sources: string }> {
  const dataDir = await createTempDataFolder();
  const sources = await createTempDataFolder();
  const core = startCore(dataDir, { paths: { dataDir, examples: EXAMPLES } });
  await core.createExamples();
  return { core, sources };
}

const BRIEF = "# Project brief\n\nThe project brief sets out the harbour plan.\n";

test("no Document of the User's own: the example's Question", async () => {
  const { core } = await start();
  expect(await core.readyQuestion()).toEqual({ question: exampleQuestion("en"), scope: null });
});

test("a file of their own still being read: no Question, and not the example's", async () => {
  const { core, sources } = await start();
  const { documents } = await core.addDocuments([
    await writeSourceFile(sources, "Project brief.md", BRIEF),
  ]);
  expect(["queued", "extracting"]).toContain(documents[0]?.status);
  expect(await core.readyQuestion()).toBeNull();
});

test("one Document of their own read: the Question is about it, named, and asks about it alone", async () => {
  const { core, sources } = await start();
  const [brief] = await addAndProcess(core, [
    await writeSourceFile(sources, "Project brief.md", BRIEF),
  ]);
  expect(await core.readyQuestion()).toEqual({
    question: "What does ‘Project brief’ say?",
    scope: { folderIds: [], tagIds: [], documentIds: [brief?.id] },
  });
});

test("two Documents of their own: the one added last, the file just added", async () => {
  const { core, sources } = await start();
  await addAndProcess(core, [await writeSourceFile(sources, "Harbour notes.md", BRIEF)]);
  const [latest] = await addAndProcess(core, [
    await writeSourceFile(sources, "Project brief.md", BRIEF),
  ]);
  expect(await core.readyQuestion()).toEqual({
    question: "What does ‘Project brief’ say?",
    scope: { folderIds: [], tagIds: [], documentIds: [latest?.id] },
  });
});

test("a file of their own that couldn't be read: no Question, and not the example's", async () => {
  const { core, sources } = await start();
  const [broken] = await addAndProcess(core, [
    await writeSourceFile(sources, "damaged.pdf", "%PDF-1.4 this is not a PDF"),
  ]);
  expect(broken?.status).toBe("failed");
  expect(await core.readyQuestion()).toBeNull();
});

test("a Document they keep as their own workings: no Question about it, as no Answer may cite it", async () => {
  const { core, sources } = await start();
  const [brief] = await addAndProcess(core, [
    await writeSourceFile(sources, "Project brief.md", BRIEF),
  ]);
  await core.setNotCited(brief?.id as string, true);
  expect(await core.readyQuestion()).toBeNull();
});

test("with a Document of theirs ready, the example's Answer is still asked: it needs none of theirs", async () => {
  // As a library that has the User's own Documents before the example is made (the everyday
  // harness asks the example's Answer there first, then the User's Questions).
  const { core, sources } = await start();
  await addAndProcess(core, [await writeSourceFile(sources, "Project brief.md", BRIEF)]);
  expect((await core.readyQuestion())?.scope).not.toBeNull();
  const asked = await vi.waitFor(() => core.askExampleReadyQuestion(), {
    timeout: 20_000,
    interval: 100,
  });
  const { messages } = await core.getConversation(asked.conversationId);
  expect(messages.find((each) => each.kind === "answer")).toMatchObject({
    status: "done",
    text: EXAMPLE_SETS.credit.en.ready?.answer,
    steps: expect.objectContaining({ example: true }),
  });
});

test("a Chinese Document with the English interface: the Question in English, naming it", async () => {
  const { core, sources } = await start();
  const [brief] = await addAndProcess(core, [
    await writeSourceFile(sources, "项目简报.md", "# 项目简报\n\n项目简报写明了港口计划。\n"),
  ]);
  expect(await core.readyQuestion()).toEqual({
    question: "What does ‘项目简报’ say?",
    scope: { folderIds: [], tagIds: [], documentIds: [brief?.id] },
  });
});

test("an English Document with the Chinese interface: the Question in Chinese, naming it", async () => {
  const { core, sources } = await start();
  await core.updateSettings({ user: { language: "zh-CN" } });
  const [brief] = await addAndProcess(core, [
    await writeSourceFile(sources, "Project brief.md", BRIEF),
  ]);
  expect(await core.readyQuestion()).toEqual({
    question: "“Project brief”讲了什么？",
    scope: { folderIds: [], tagIds: [], documentIds: [brief?.id] },
  });
});
