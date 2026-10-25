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

  // protects=with only the examples, a Question from another Mind has no Documents to search, and the model is told they aren't the User's rather than that the User limited the Question; fails_when=it searches the examples, or is told of a scope the User never set; no_claim=what the model writes.
  test("with only the examples, there are none from another Mind", async () => {
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
        async () => (await core.listDocuments({ linkedFolderId: examples.linkedFolderId })).length,
        {
          timeout: 20_000,
        },
      )
      .toBe(2);
    const mine = await core.createMind({ title: "Reading group" });

    await askAssistant(core, { text: "Summarise these documents", mindId: mine.id });

    expect(system).toContain(
      "None of the User's own Documents can be searched yet (the examples IncarnaMind made aren't theirs)",
    );
    expect(system).not.toContain("limited this Question");
  });
});
