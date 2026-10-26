import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import type { ConversationAnswer, Core } from "../../src/core";
import { topLevelBlocks } from "../../src/core/answers/blocks";
import { MIND_CONTENT_FIELD } from "../../src/core/api";
import { EDIT_INSTRUCTIONS } from "../../src/core/edits/prompt";
import { plainText } from "../../src/core/mindText";
import { pendingProposals } from "../../src/shared/proposals";
import { askAssistant, mindCalls } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { note, writeMind } from "../helpers/minds";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

const textOf = (doc: Y.Doc) =>
  topLevelBlocks(doc.getXmlFragment(MIND_CONTENT_FIELD))
    .map((block) => plainText(block))
    .join("\n");

describe("Applying an assistant's changes in the core", () => {
  test("an unopened Mind is applied with Review state and core Undo and Redo", async () => {
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
    expect(await core.redoAskedChanges(application.undoId)).toBe(true);
    const redone = new Y.Doc();
    Y.applyUpdate(redone, (await core.openMind(mind.id)).state);
    expect(textOf(redone)).toBe("Hire a designer.\nA decision.");
    expect(await core.redoAskedChanges(application.undoId)).toBe(false);
    review.destroy();
    reopened.destroy();
    undone.destroy();
    redone.destroy();
  });

  // Value: protects=idempotent application and AI use; fails_when=duplicates reapply or record twice; why_new=no duplicate case; seam=none; no_claim=multi-window timing (scripted duplicates)
  test("duplicate and no-op applications change nothing and record once", async () => {
    const { core, mind } = await setUp(addingModel(["A decision.", "A second decision."]));
    const answer = await askAssistant(core, { text: "Add two decisions to Project plan" });
    const requests = mindCalls(answer).map((call) => call.mindChange?.request ?? "");
    const application = await applyFor(core, answer, mind.id);
    const repeated = await core.applyAskedChanges({
      answerId: answer.id,
      mindId: mind.id,
      requests: [...requests].reverse(),
    });
    expect(repeated?.undoId).toBe(application.undoId);
    expect(await core.listAiUse(mind.id)).toHaveLength(2);
    for (const requests of [[], ["foreign"]]) {
      expect(
        await core.applyAskedChanges({ answerId: answer.id, mindId: mind.id, requests }),
      ).toBeNull();
    }
    expect(
      await core.applyAskedChanges({ answerId: "another-answer", mindId: mind.id, requests }),
    ).toBeNull();
    expect(await core.undoAskedChanges("missing")).toBe(false);
    const state = await readState(core, mind.id);
    expect(textOf(state)).toBe("Hire a designer.\nA decision.\nA second decision.");
    state.destroy();
  });

  // Value: protects=stale and held changes never apply early; fails_when=stale is accepted or held is recorded; why_new=only applied changes; seam=none; no_claim=UndoManager disposal (internal only)
  test("stale and held changes are not applied or recorded", async () => {
    const stale = await setUp(
      rewritingModel((passage) => passage.replace("good.", "excellent.")),
      "The quarter was good. Sales rose and the margin held.",
    );
    const staleAnswer = await askAssistant(stale.core, {
      text: "Rewrite the paragraph",
      mindId: stale.mind.id,
    });
    const client = await connectToMind(stale.core, stale.mind.id);
    client.doc.transact(() => {
      const block = client.blocks.get(0);
      if (!(block instanceof Y.XmlElement)) throw new Error("No paragraph.");
      const text = block.get(0);
      if (!(text instanceof Y.XmlText)) throw new Error("No text.");
      const at = plainText(text).indexOf("good");
      if (at < 0) throw new Error("The original word wasn't found.");
      text.delete(at, 4);
      text.insert(at, "great");
    });
    await client.settled();
    client.doc.destroy();
    const staleApplication = await applyOptional(stale.core, staleAnswer, stale.mind.id);
    expect(staleApplication).toBeNull();
    expect(await stale.core.listAiUse(stale.mind.id)).toHaveLength(0);
    const staleState = await readState(stale.core, stale.mind.id);
    expect(textOf(staleState)).toContain("great");
    expect(pendingProposals(staleState.getXmlFragment(MIND_CONTENT_FIELD)).length).toBeGreaterThan(
      0,
    );
    staleState.destroy();

    const held = await setUp(
      rewritingModel(() => "Revenue fell in every region."),
      "The quarter was good. Sales rose and the margin held.",
    );
    const heldAnswer = await askAssistant(held.core, {
      text: "Rewrite the paragraph",
      mindId: held.mind.id,
    });
    const application = await applyFor(held.core, heldAnswer, held.mind.id);
    expect(application.held).toBe(true);
    expect(await held.core.undoAskedChanges(application.undoId)).toBe(false);
    expect(await held.core.listAiUse(held.mind.id)).toHaveLength(0);
    const heldState = await readState(held.core, held.mind.id);
    expect(textOf(heldState)).toBe("The quarter was good. Sales rose and the margin held.");
    expect(pendingProposals(heldState.getXmlFragment(MIND_CONTENT_FIELD)).length).toBeGreaterThan(
      0,
    );
    heldState.destroy();
  });

  // Value: protects=core Undo only while on top and loaded; fails_when=later edits or closing permits Undo; why_new=no changed-since or closed case; seam=none; no_claim=Undo after restart (out of contract)
  test("later edits and a closed Mind make core Undo inert", async () => {
    const later = await setUp(addingModel(["A decision."]));
    const answer = await askAssistant(later.core, { text: "Add a decision to Project plan" });
    const application = await applyFor(later.core, answer, later.mind.id);
    const client = await connectToMind(later.core, later.mind.id);
    writeMind(client, [note("Hire a designer."), note("A decision."), note("My later note.")]);
    await client.settled();
    client.doc.destroy();
    expect(await later.core.undoAskedChanges(application.undoId)).toBe(false);
    const laterState = await readState(later.core, later.mind.id);
    expect(textOf(laterState)).toBe("Hire a designer.\nA decision.\nMy later note.");
    laterState.destroy();

    const closed = await setUp(addingModel(["A decision."]));
    const closedAnswer = await askAssistant(closed.core, {
      text: "Add a decision to Project plan",
    });
    const closedApplication = await applyFor(closed.core, closedAnswer, closed.mind.id);
    await closed.core.closeMind(closed.mind.id);
    expect(await closed.core.undoAskedChanges(closedApplication.undoId)).toBe(false);
    const closedState = await readState(closed.core, closed.mind.id);
    expect(textOf(closedState)).toBe("Hire a designer.\nA decision.");
    closedState.destroy();

    const afterUndo = await setUp(addingModel(["A decision."]));
    const afterUndoAnswer = await askAssistant(afterUndo.core, {
      text: "Add a decision to Project plan",
    });
    const afterUndoApplication = await applyFor(afterUndo.core, afterUndoAnswer, afterUndo.mind.id);
    expect(await afterUndo.core.undoAskedChanges(afterUndoApplication.undoId)).toBe(true);
    const edited = await connectToMind(afterUndo.core, afterUndo.mind.id);
    writeMind(edited, [note("Hire a designer."), note("My later note.")]);
    await edited.settled();
    edited.doc.destroy();
    expect(await afterUndo.core.redoAskedChanges(afterUndoApplication.undoId)).toBe(false);
    const afterUndoState = await readState(afterUndo.core, afterUndo.mind.id);
    expect(textOf(afterUndoState)).toBe("Hire a designer.\nMy later note.");
    afterUndoState.destroy();
  });

  // Value: protects=untrusted input cannot write or delete Minds; fails_when=validation is bypassed; why_new=no invalid-input case; seam=none; no_claim=deleted-row database check (public list only)
  test("unknown Minds and malformed input are refused before a write", async () => {
    const { core, mind } = await setUp(addingModel(["A decision."]));
    const answer = await askAssistant(core, { text: "Add a decision to Project plan" });
    const application = await applyFor(core, answer, mind.id);
    await expect(
      core.applyAskedChanges({ answerId: "", mindId: mind.id, requests: [] }),
    ).rejects.toThrow();
    await expect(
      core.applyAskedChanges({ answerId: answer.id, mindId: "missing", requests: [] }),
    ).rejects.toThrow();
    await expect(
      core.applyAskedChanges({ answerId: answer.id, mindId: mind.id, requests: [""] }),
    ).rejects.toThrow();
    expect((await core.listMinds()).map((each) => each.id)).toEqual([mind.id]);
    await core.deleteMind(mind.id);
    expect(await core.undoAskedChanges(application.undoId)).toBe(false);
    expect(await core.listMinds()).toHaveLength(0);
  });

  // Value: protects=recording failure cannot strand applied text; fails_when=apply rejects after commit or loses Undo; why_new=500-entry recording boundary; seam=none; no_claim=record retry succeeds (injected limit only)
  test("a recording failure leaves the application usable", async () => {
    const paragraphs = Array.from({ length: 501 }, (_, index) => `Decision ${index}.`).join("\n\n");
    const { core, mind } = await setUp(addingModel([paragraphs]));
    const answer = await askAssistant(core, { text: "Add 501 decisions to Project plan" });
    const application = await applyFor(core, answer, mind.id);
    expect(application.held).toBe(false);
    expect((await applyOptional(core, answer, mind.id))?.undoId).toBe(application.undoId);
    const state = await readState(core, mind.id);
    expect(topLevelBlocks(state.getXmlFragment(MIND_CONTENT_FIELD))).toHaveLength(502);
    expect(await core.listAiUse(mind.id)).toHaveLength(0);
    state.destroy();
  });
});

function addingModel(contents: readonly string[]) {
  return scriptedModel(
    (call): ScriptedReply =>
      call.results.length === 0
        ? {
            calls: contents.map((content) => ({
              tool: "add_to_mind",
              input: { mind: "Project plan", content },
            })),
          }
        : { text: "Added the decisions to “Project plan”." },
  );
}

function rewritingModel(rewrite: (passage: string) => string) {
  return scriptedModel((call): ScriptedReply => {
    const passage = editPassage(call);
    if (passage !== null) return { text: rewrite(passage) };
    if (call.results.length > 0) return { text: "Rewrote the paragraph." };
    return {
      calls: [
        {
          tool: "edit_mind",
          input: { part: "The quarter was", instruction: "Rewrite it" },
        },
      ],
    };
  });
}

const editPassage = (call: ModelCall): string | null =>
  call.system === EDIT_INSTRUCTIONS
    ? (/<passage>\n([\s\S]*?)\n<\/passage>/.exec(call.prompt)?.[1] ?? null)
    : null;

async function setUp(model: MockLanguageModelV4, text = "Hire a designer.") {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const mind = await core.createMind({ title: "Project plan" });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [note(text)]);
  await client.settled();
  client.doc.destroy();
  return { core, mind };
}

async function applyFor(core: Core, answer: ConversationAnswer, mindId: string) {
  const application = await applyOptional(core, answer, mindId);
  if (!application) throw new Error("Nothing was applied.");
  return application;
}

const applyOptional = (core: Core, answer: ConversationAnswer, mindId: string) =>
  core.applyAskedChanges({
    answerId: answer.id,
    mindId,
    requests: mindCalls(answer).map((call) => call.mindChange?.request ?? ""),
  });

async function readState(core: Core, mindId: string): Promise<Y.Doc> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, (await core.openMind(mindId)).state);
  return doc;
}
