import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { askAssistant } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import { waitForProcessing } from "../helpers/documents";
import { type ScriptedReply, scriptedModel, scriptedModels } from "../helpers/models";

/**
 * Which Documents "these documents" are in the assistant, through the core's
 * public interface: the User's, not the examples', unless the Question is
 * asked from an example's Mind; each listed for the model with its title
 * when its name doesn't hold it.
 */

const EXAMPLES = resolve(__dirname, "../../resources/examples");
const REPORT = resolve(__dirname, "../fixtures/formats/Field Report.docx");

async function setUp() {
  let system = "";
  const model = scriptedModel((call): ScriptedReply => {
    system = call.system;
    return { text: "Both are covered." };
  });
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    paths: { dataDir, examples: EXAMPLES },
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const examples = await core.createExamples();
  await core.addDocuments([REPORT]);
  const ofExamples = () => core.listDocuments({ linkedFolderId: examples.linkedFolderId });
  // The example Documents come in as their Linked folder is read.
  await expect.poll(async () => (await ofExamples()).length, { timeout: 20_000 }).toBe(2);
  const all = await core.listDocuments();
  await waitForProcessing(
    core,
    all.map((document) => document.id),
    30_000,
  );
  const exampleNames = (await ofExamples()).map((document) => document.name);
  return { core, examples, exampleNames, sent: () => system };
}

describe("“These documents” in the assistant", { timeout: 60_000 }, () => {
  // protects=with no Search scope, a Question from the User's own Mind searches their Documents (listed with their titles) and none of the examples', which a Question from the example's Mind still does; fails_when=the examples are summarised beside the User's Documents, the example Mind loses its own, or a Document is listed by a file name that says nothing; no_claim=what the model writes.
  test("are the User's, not the examples', except from the example's Mind", async () => {
    const { core, examples, exampleNames, sent } = await setUp();
    expect(exampleNames.length).toBeGreaterThan(0);
    const mine = await core.createMind({ title: "Reading group" });

    await askAssistant(core, { text: "Summarise these documents", mindId: mine.id });
    expect(sent()).toContain("- Field Report (“Field Report: Northern Estuary”)");
    for (const name of exampleNames) expect(sent()).not.toContain(name);

    await askAssistant(core, {
      text: "Summarise these documents",
      mindId: examples.mindId ?? "",
    });
    for (const name of exampleNames) expect(sent()).toContain(name);
  });

  // protects=with only the examples, a Question from another Mind searches them: they are the User's Library until they have a Document of their own (#1942); fails_when=the examples are left out on day one, or the Question is told of a scope the User never set; no_claim=what the model writes.
  test("with only the examples, a Question from another Mind searches them (#1942)", async () => {
    let system = "";
    const model = scriptedModel((call): ScriptedReply => {
      system = call.system;
      return { text: "You have no Documents yet." };
    });
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, {
      paths: { dataDir, examples: EXAMPLES },
      createChatModel: scriptedModels(model).createChatModel,
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const examples = await core.createExamples();
    await expect
      .poll(
        async () => {
          const read = await core.listDocuments({ linkedFolderId: examples.linkedFolderId });
          return read.length === 2 && read.every((document) => document.status === "ready");
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    const mine = await core.createMind({ title: "Reading group" });

    await askAssistant(core, { text: "Summarise these documents", mindId: mine.id });

    // The examples' two are the Library, so they are listed and searchable on day one.
    expect(system).toContain("The User has added 2 Documents");
    for (const name of (await core.listDocuments()).map((document) => document.name)) {
      expect(system).toContain(name);
    }
    expect(system).not.toContain("None of the User's own Documents can be searched yet");
    expect(system).not.toContain("limited this Question");
  });

  // protects=the model is told the Library's whole count, which is the User's own once they have one: the examples' Documents no longer count (#1942, #1333); fails_when=the count includes the examples', so a reply says the Library holds three when its page shows one; no_claim=how a real model words its reply (the e2e and the hand test).
  test("carry the Library's count, the examples' Documents out of it (#1942)", async () => {
    const { core, exampleNames, sent } = await setUp();
    const mine = await core.createMind({ title: "Reading group" });
    expect(await core.listDocuments()).toHaveLength(3);

    await askAssistant(core, { text: "Summarise the two main documents.", mindId: mine.id });

    const told = sent();
    expect(told).toContain("The User has added 1 Document");
    for (const name of exampleNames) expect(told).not.toContain(name);
    // One Document and one in the Library: no whole-Library line, and none about the examples'.
    expect(told).not.toContain("The User's Library holds");
    expect(told).not.toContain("are in the Library too");
  });
});
