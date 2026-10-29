import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import type { ConversationAnswer, Core } from "../../src/core";
import { topLevelBlocks } from "../../src/core/answers/blocks";
import { MIND_CONTENT_FIELD } from "../../src/core/api";
import { plainText } from "../../src/core/mindText";
import { outOfDateProposals, pendingProposals } from "../../src/shared/proposals";
import { askAssistant, mindCalls } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import { isEditPrompt } from "../helpers/editPrompt";
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

const pendingIds = (doc: Y.Doc) =>
  new Set(pendingProposals(doc.getXmlFragment(MIND_CONTENT_FIELD)).map((each) => each.id));

describe("Applying an assistant's changes in the core", () => {
  for (const language of ["en", "zh-CN"] as const) {
    test(`${language}: one core Undo removes an addition revised twice in the same turn`, async () => {
      const heading = language === "en" ? "Decision" : "决定";
      const versions =
        language === "en"
          ? ["A decision.", "A clearer decision.", "A final decision."]
          : ["一个决定。", "一个更明确的决定。", "最终决定。"];
      let revised = 0;
      const model = scriptedModel((call): ScriptedReply => {
        if (editPassage(call) !== null) {
          revised++;
          return { text: `## ${heading}\n\n${versions[revised]}\n<why>Revised.</why>` };
        }
        if (!call.results.some((result) => result.tool === "add_to_mind")) {
          return {
            calls: [
              {
                tool: "add_to_mind",
                input: { mind: "Project plan", content: `## ${heading}\n\n${versions[0]}` },
              },
            ],
          };
        }
        if (call.results.filter((result) => result.tool === "edit_mind").length < 2) {
          return {
            calls: [
              {
                tool: "edit_mind",
                input: { mind: "Project plan", part: heading, instruction: "Revise this decision" },
              },
            ],
          };
        }
        return {
          text: language === "en" ? "Added and revised the decision." : "已添加并修改决定。",
        };
      });
      const { core, mind } = await setUp(model);
      await core.updateSettings({ user: { language } });
      const answer = await askAssistant(core, {
        text:
          language === "en"
            ? "Add a decision to Project plan and revise it twice"
            : "给 Project plan 添加一个决定，再修改两次",
      });
      expect(revised).toBe(2);
      const application = await applyFor(core, answer, mind.id);
      expect(application.held).toBe(false);
      for (let cycle = 0; cycle < 2; cycle++) {
        const applied = await readState(core, mind.id);
        expect(textOf(applied)).toBe(`Hire a designer.\n${heading}\n${versions[2]}`);
        expect(pendingProposals(applied.getXmlFragment(MIND_CONTENT_FIELD))).toHaveLength(0);
        applied.destroy();
        expect(await core.undoAskedChanges(application.undoId)).not.toBeNull();
        const undone = await readState(core, mind.id);
        expect(textOf(undone)).toBe("Hire a designer.");
        expect(pendingProposals(undone.getXmlFragment(MIND_CONTENT_FIELD))).toHaveLength(0);
        undone.destroy();
        expect(await core.redoAskedChanges(application.undoId)).not.toBeNull();
      }
    });
  }

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
    const undoneVector = await core.undoAskedChanges(application.undoId);
    expect(undoneVector?.vector).toBeInstanceOf(Uint8Array);
    const undone = new Y.Doc();
    Y.applyUpdate(undone, (await core.openMind(mind.id)).state);
    expect(Y.encodeStateVector(undone)).toEqual(undoneVector?.vector);
    expect(textOf(undone)).toBe("Hire a designer.");
    expect(pendingProposals(undone.getXmlFragment(MIND_CONTENT_FIELD))).toHaveLength(0);
    expect(await core.undoAskedChanges(application.undoId)).toBeNull();
    const redoneVector = await core.redoAskedChanges(application.undoId);
    expect(redoneVector?.vector).toBeInstanceOf(Uint8Array);
    const redone = new Y.Doc();
    Y.applyUpdate(redone, (await core.openMind(mind.id)).state);
    expect(Y.encodeStateVector(redone)).toEqual(redoneVector?.vector);
    expect(textOf(redone)).toBe("Hire a designer.\nA decision.");
    expect(await core.undoAskedChanges(application.undoId)).not.toBeNull();
    const undoneAgain = await readState(core, mind.id);
    expect(textOf(undoneAgain)).toBe("Hire a designer.");
    undoneAgain.destroy();
    expect(await core.redoAskedChanges(application.undoId)).not.toBeNull();
    const redoneAgain = await readState(core, mind.id);
    expect(textOf(redoneAgain)).toBe("Hire a designer.\nA decision.");
    redoneAgain.destroy();
    expect(await core.redoAskedChanges(application.undoId)).toBeNull();
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
    expect(await core.undoAskedChanges("missing")).toBeNull();
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
    await replaceOriginalWord(stale.core, stale.mind.id, "good", "great");
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
    expect(await held.core.undoAskedChanges(application.undoId)).toBeNull();
    expect(await held.core.listAiUse(held.mind.id)).toHaveLength(0);
    const heldState = await readState(held.core, held.mind.id);
    expect(textOf(heldState)).toBe("The quarter was good. Sales rose and the margin held.");
    expect(pendingProposals(heldState.getXmlFragment(MIND_CONTENT_FIELD)).length).toBeGreaterThan(
      0,
    );
    heldState.destroy();
  });

  // Value: protects=mixed fresh/stale Proposals keep their own fate through Apply, Undo and Redo; fails_when=Undo discards a stale Proposal or Redo accepts it; why_new=only all-stale applications were covered; seam=none; no_claim=partial Review anchors (separate renderer path)
  test("mixed fresh and stale Proposals keep their own fate through Undo and Redo", async () => {
    const { core, mind } = await setUp(
      rewritingModel(
        (passage) => passage.replace("good.", "excellent.").replace("Sales rose", "Revenue rose"),
        null,
      ),
      ["The quarter was good.", "Sales rose and the margin held."],
    );
    const answer = await askAssistant(core, { text: "Rewrite both paragraphs", mindId: mind.id });
    await replaceOriginalWord(core, mind.id, "good", "great");
    const before = await readState(core, mind.id);
    const staleIds = outOfDateProposals(before.getXmlFragment(MIND_CONTENT_FIELD));
    const freshIds = new Set([...pendingIds(before)].filter((id) => !staleIds.has(id)));
    expect(staleIds.size).toBeGreaterThan(0);
    expect(freshIds.size).toBeGreaterThan(0);
    before.destroy();

    const application = await applyFor(core, answer, mind.id);
    expect(new Set(application.accepted)).toEqual(freshIds);
    const applied = await readState(core, mind.id);
    expect(textOf(applied)).toContain("Revenue rose");
    expect(pendingIds(applied)).toEqual(staleIds);
    applied.destroy();

    expect(await core.undoAskedChanges(application.undoId)).not.toBeNull();
    const undone = await readState(core, mind.id);
    expect(textOf(undone)).toContain("great");
    expect(textOf(undone)).toContain("Sales rose");
    expect(pendingIds(undone)).toEqual(staleIds);
    undone.destroy();

    expect(await core.redoAskedChanges(application.undoId)).not.toBeNull();
    const redone = await readState(core, mind.id);
    expect(textOf(redone)).toContain("great");
    expect(textOf(redone)).toContain("Revenue rose");
    expect(pendingIds(redone)).toEqual(staleIds);
    redone.destroy();
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
    expect(await later.core.undoAskedChanges(application.undoId)).toBeNull();
    const laterState = await readState(later.core, later.mind.id);
    expect(textOf(laterState)).toBe("Hire a designer.\nA decision.\nMy later note.");
    laterState.destroy();

    const closed = await setUp(addingModel(["A decision."]));
    const closedAnswer = await askAssistant(closed.core, {
      text: "Add a decision to Project plan",
    });
    const closedApplication = await applyFor(closed.core, closedAnswer, closed.mind.id);
    await closed.core.closeMind(closed.mind.id);
    expect(await closed.core.undoAskedChanges(closedApplication.undoId)).toBeNull();
    const closedState = await readState(closed.core, closed.mind.id);
    expect(textOf(closedState)).toBe("Hire a designer.\nA decision.");
    closedState.destroy();

    const afterUndo = await setUp(addingModel(["A decision."]));
    const afterUndoAnswer = await askAssistant(afterUndo.core, {
      text: "Add a decision to Project plan",
    });
    const afterUndoApplication = await applyFor(afterUndo.core, afterUndoAnswer, afterUndo.mind.id);
    expect(await afterUndo.core.undoAskedChanges(afterUndoApplication.undoId)).not.toBeNull();
    const edited = await connectToMind(afterUndo.core, afterUndo.mind.id);
    writeMind(edited, [note("Hire a designer."), note("My later note.")]);
    await edited.settled();
    edited.doc.destroy();
    expect(await afterUndo.core.redoAskedChanges(afterUndoApplication.undoId)).toBeNull();
    const afterUndoState = await readState(afterUndo.core, afterUndo.mind.id);
    expect(textOf(afterUndoState)).toBe("Hire a designer.\nMy later note.");
    afterUndoState.destroy();
  });

  // Value: protects=untrusted input cannot write or delete Minds; fails_when=validation is bypassed; why_new=no invalid-input case; seam=none; no_claim=deleted-row database check (public list only)
  test("unknown Minds and malformed input are refused before a write", async () => {
    const { core, mind } = await setUp(addingModel(["A decision."]));
    const answer = await askAssistant(core, { text: "Add a decision to Project plan" });
    const application = await applyFor(core, answer, mind.id);
    await expect(Reflect.apply(core.applyAskedChanges, core, [null])).rejects.toMatchObject({
      wording: { key: "error.askedChanges.input" },
    });
    await expect(
      core.applyAskedChanges({ answerId: "", mindId: mind.id, requests: [] }),
    ).rejects.toMatchObject({ wording: { key: "error.askedChanges.answer" } });
    await expect(
      core.applyAskedChanges({ answerId: answer.id, mindId: "missing", requests: [] }),
    ).rejects.toThrow();
    await expect(
      core.applyAskedChanges({ answerId: answer.id, mindId: mind.id, requests: [""] }),
    ).rejects.toThrow();
    expect((await core.listMinds()).map((each) => each.id)).toEqual([mind.id]);
    await core.deleteMind(mind.id);
    expect(await core.undoAskedChanges(application.undoId)).toBeNull();
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
    expect(await core.undoAskedChanges(application.undoId)).not.toBeNull();
    const undone = await readState(core, mind.id);
    expect(textOf(undone)).toBe("Hire a designer.");
    undone.destroy();
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

function rewritingModel(
  rewrite: (passage: string) => string,
  part: string | null = "The quarter was",
) {
  return scriptedModel((call): ScriptedReply => {
    const passage = editPassage(call);
    if (passage !== null) return { text: rewrite(passage) };
    if (call.results.length > 0) return { text: "Rewrote the paragraph." };
    return {
      calls: [
        {
          tool: "edit_mind",
          input: { ...(part !== null && { part }), instruction: "Rewrite it" },
        },
      ],
    };
  });
}

const editPassage = (call: ModelCall): string | null =>
  isEditPrompt(call.system)
    ? (/<passage>\n([\s\S]*?)\n<\/passage>/.exec(call.prompt)?.[1] ?? null)
    : null;

async function setUp(
  model: MockLanguageModelV4,
  text: string | readonly string[] = "Hire a designer.",
) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const mind = await core.createMind({ title: "Project plan" });
  const client = await connectToMind(core, mind.id);
  writeMind(
    client,
    (typeof text === "string" ? [text] : text).map((line) => note(line)),
  );
  await client.settled();
  client.doc.destroy();
  return { core, mind };
}

async function replaceOriginalWord(core: Core, mindId: string, from: string, to: string) {
  const client = await connectToMind(core, mindId);
  client.doc.transact(() => {
    const block = client.blocks.get(0);
    if (!(block instanceof Y.XmlElement)) throw new Error("No paragraph.");
    const text = block.get(0);
    if (!(text instanceof Y.XmlText)) throw new Error("No text.");
    const at = plainText(text).indexOf(from);
    if (at < 0) throw new Error("The original word wasn't found.");
    text.delete(at, from.length);
    text.insert(at, to);
  });
  await client.settled();
  client.doc.destroy();
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
