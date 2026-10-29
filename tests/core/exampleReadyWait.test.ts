import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { Core, RecognizedLine, TextRecognizer } from "../../src/core";
import { createFakeTextRecognizer } from "../../src/core/documents/scan/fake";
import { EXAMPLE_SETS } from "../../src/core/exampleSets";
import { createTempDataFolder, NO_MODEL_FILES, startCore } from "../helpers/core";
import { waitForProcessing } from "../helpers/documents";
import { buildPdf } from "../helpers/pdf";

/**
 * Asking the example's ready Question presses the first button a newcomer presses (#2218): while
 * its Documents are read it waits, saying so, and answers; a Document that can't be read, a read
 * that never ends, and Stop each say what happened instead of swallowing the click.
 */

const EXAMPLES = join(import.meta.dirname, "../../resources/examples");
const SCANS = join(import.meta.dirname, "../fixtures/scans");
const picture = (id: string) => readFileSync(join(SCANS, `${id}.jpg`));
const CREDIT = EXAMPLE_SETS.credit.en;
const QUOTES = CREDIT.ready?.quotes ?? [];
const NAMES = QUOTES.map((quote) => quote.document);

/** A recognizer whose pages are read only when the test releases them: the reading, held still. */
function heldRecognizer(): { recognizer: TextRecognizer; release(): void } {
  const lines = QUOTES.map((quote) => quote.quote);
  const fake = createFakeTextRecognizer({ script: { pages: { "1": { lines } } } });
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const recognizer: TextRecognizer = {
    load: (files) => fake.load(files),
    async read(drawn, page): Promise<RecognizedLine[]> {
      await held;
      return fake.read(drawn, page);
    },
    readFile: (file, page) => fake.readFile(file, page),
    close: () => fake.close(),
  };
  return { recognizer, release };
}

/** An examples folder of the test's own: the same names as the shipped ones, holding `files`. */
async function examplesFolder(files: (name: string) => Uint8Array): Promise<string> {
  const folder = await createTempDataFolder();
  await mkdir(join(folder, "credit", "en"), { recursive: true });
  await writeFile(join(folder, "LICENSE"), "Test fixtures.");
  for (const name of NAMES) {
    await writeFile(join(folder, "credit", "en", `${name}.pdf`), files(name));
  }
  return folder;
}

/** A core whose example is made of the test's Documents, read as `recognizer` says. */
async function startWith(
  overrides: Parameters<typeof startCore>[1] = {},
  examples = EXAMPLES,
): Promise<Core> {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    paths: { dataDir, examples },
    ...overrides,
  });
  await core.createExamples();
  return core;
}

const exampleDocuments = async (core: Core) => {
  const { linkedFolderId } = await core.getExamples();
  return (await core.listDocuments()).filter((each) => each.linkedFolderId === linkedFolderId);
};

test("the ready Question names the Document it waits for, and asking answers once it is read", async () => {
  const core = await startWith();
  // Asked at the first frame, before its Documents have been read: it says what it waits for.
  const ready = await core.readyQuestion();
  expect(ready?.question).toBe(CREDIT.ready?.question);
  expect(ready?.waitingFor).not.toBeNull();
  expect(NAMES).toContain(ready?.waitingFor);

  // The click is not swallowed: the Answer comes once the Documents are read.
  const asked = await core.askExampleReadyQuestion();
  expect(asked.stopped).toBe(false);
  const { messages } = await core.getConversation(asked.conversationId);
  const answer = messages.find((each) => each.kind === "answer");
  expect(answer).toMatchObject({ status: "done", text: CREDIT.ready?.answer });
  expect(answer?.kind === "answer" ? answer.citations : []).toHaveLength(2);
});

test("answered once its Documents are read, it waits for nothing", async () => {
  const core = await startWith();
  await waitForProcessing(
    core,
    (await exampleDocuments(core)).map((each) => each.id),
  );
  const ready = await vi.waitFor(async () => {
    const now = await core.readyQuestion();
    expect(now?.waitingFor).toBeNull();
    return now;
  });
  expect(ready?.waitingFor).toBeNull();
  const asked = await core.askExampleReadyQuestion();
  const { messages } = await core.getConversation(asked.conversationId);
  expect(messages.find((each) => each.kind === "answer")).toMatchObject({ status: "done" });
});

test("Stop while it waits keeps the Question and a stopped Answer, with no text", async () => {
  const { recognizer, release } = heldRecognizer();
  const examples = await examplesFolder(() => buildPdf([{ scan: picture("en-clean") }]));
  const core = await startWith(
    { textRecognizer: recognizer, textRecognitionModelSource: NO_MODEL_FILES },
    examples,
  );
  const waiting = core.askExampleReadyQuestion();
  // Its first look at the Documents is done: the wait it is in is the one Stop ends.
  await vi.waitFor(async () => expect((await core.readyQuestion())?.waitingFor).not.toBeNull());
  await core.stopExampleReadyQuestion();
  const asked = await waiting;
  expect(asked.stopped).toBe(true);
  const { messages } = await core.getConversation(asked.conversationId);
  expect(messages.find((each) => each.kind === "question")).toMatchObject({
    kind: "question",
    text: CREDIT.ready?.question,
  });
  expect(messages.find((each) => each.kind === "answer")).toMatchObject({
    status: "stopped",
    text: "",
  });
  release();
});

test("a read that never ends says so, rather than waiting for ever", async () => {
  const { recognizer, release } = heldRecognizer();
  const examples = await examplesFolder(() => buildPdf([{ scan: picture("en-clean") }]));
  const core = await startWith(
    {
      textRecognizer: recognizer,
      textRecognitionModelSource: NO_MODEL_FILES,
      exampleReadyWaitMs: 300,
    },
    examples,
  );
  await expect(core.askExampleReadyQuestion()).rejects.toMatchObject({
    wording: { key: "error.examples.reading" },
  });
  release();
});

test("a Document that can't be read takes the Question away, and asking says why", async () => {
  const examples = await examplesFolder(() => new TextEncoder().encode("%PDF-1.4 not a PDF"));
  const core = await startWith({}, examples);
  await waitForProcessing(
    core,
    (await exampleDocuments(core)).map((each) => each.id),
  );
  // No button to press: the card shows the unread-files line instead.
  await vi.waitFor(async () => expect(await core.readyQuestion()).toBeNull());
  await expect(core.askExampleReadyQuestion()).rejects.toMatchObject({
    wording: { key: "error.examples.unreadable" },
  });
});
