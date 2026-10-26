import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { topLevelBlocks } from "../../src/core/answers/blocks";
import { MIND_CONTENT_FIELD } from "../../src/core/api";
import { plainText } from "../../src/core/mindText";
import { pendingProposals } from "../../src/shared/proposals";
import { askAssistant, mindCalls } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { note, writeMind } from "../helpers/minds";
import { type ScriptedReply, scriptedModel, scriptedModels } from "../helpers/models";

const textOf = (doc: Y.Doc) =>
  topLevelBlocks(doc.getXmlFragment(MIND_CONTENT_FIELD))
    .map((block) => plainText(block))
    .join("\n");

describe("Applying an assistant's changes in the core", () => {
  test("an unopened Mind is applied with Review state and one core Undo", async () => {
    const model = scriptedModel(
      (call): ScriptedReply =>
        call.results.length === 0
          ? {
              calls: [
                { tool: "add_to_mind", input: { mind: "Project plan", content: "A decision." } },
              ],
            }
          : { text: "Added a decision to “Project plan”." },
    );
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(model).createChatModel,
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const mind = await core.createMind({ title: "Project plan" });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [note("Hire a designer.")]);
    await client.settled();
    client.doc.destroy();
    const answer = await askAssistant(core, { text: "Add a decision to Project plan" });
    const application = await core.applyAskedChanges({
      answerId: answer.id,
      mindId: mind.id,
      requests: mindCalls(answer).map((call) => call.mindChange?.request ?? ""),
    });
    if (!application) throw new Error("Nothing was applied.");
    expect(application.held).toBe(false);
    expect(await core.listAiUse(mind.id)).toHaveLength(1);
    const review = new Y.Doc();
    Y.applyUpdate(review, application.reviewBefore);
    expect(pendingProposals(review.getXmlFragment(MIND_CONTENT_FIELD)).length).toBeGreaterThan(0);
    const reopened = new Y.Doc();
    Y.applyUpdate(reopened, (await core.openMind(mind.id)).state);
    expect(textOf(reopened)).toBe("Hire a designer.\nA decision.");
    expect(await core.undoAskedChanges(application.undoId)).toBe(true);
    const undone = new Y.Doc();
    Y.applyUpdate(undone, (await core.openMind(mind.id)).state);
    expect(textOf(undone)).toBe("Hire a designer.");
    expect(pendingProposals(undone.getXmlFragment(MIND_CONTENT_FIELD))).toHaveLength(0);
    expect(await core.undoAskedChanges(application.undoId)).toBe(false);
    review.destroy();
    reopened.destroy();
    undone.destroy();
  });
});
