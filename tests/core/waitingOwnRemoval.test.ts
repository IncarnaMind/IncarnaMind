import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import { EDIT_INSTRUCTIONS, EDIT_INSTRUCTIONS_NAMED } from "../../src/core/edits/prompt";
import { pendingProposals, resolveProposals } from "../../src/shared/proposals";
import { askAssistant, lastResult, mindCalls } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import { boundEditor } from "../helpers/editor";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { exactly, heading, note, shownWithChanges, writeMind } from "../helpers/minds";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

/**
 * The assistant asks a second time to change text its own waiting change takes out whole (#2502):
 * its reply says that the removal still waits for the User, never that the text changed while it
 * was being read, nor that the waiting change is the User's or a Word file's. The Note and its
 * waiting change are left exactly as they were, so Undo has nothing of the refused call to take
 * back, and rejecting the change gives back the words as they were.
 */

/** The text of the last user message of a request: the Question it answers. */
const asked = ({ options }: ModelCall): string => {
  const last = options.prompt.filter((message) => message.role === "user").at(-1);
  if (!last) return "";
  return typeof last.content === "string"
    ? last.content
    : last.content.map((part) => ("text" in part ? part.text : "")).join("");
};

/** Edit with AI's request, and the passage it asks to rewrite; null for any other request. */
const editPassage = (call: ModelCall): string | null =>
  [EDIT_INSTRUCTIONS, EDIT_INSTRUCTIONS_NAMED].includes(call.system)
    ? (/<passage>\n([\s\S]*?)\n<\/passage>/.exec(call.prompt)?.[1] ?? null)
    : null;

const LONG = "The quarter was very good, and sales were really strong.";

const words = {
  en: {
    remove: "remove the paragraph about the quarter",
    removeAgain: "make the summary shorter",
    cut: "cut the long paragraph",
    said: "Removed it.",
  },
  "zh-CN": {
    remove: "删掉关于这个季度的段落",
    removeAgain: "把摘要改短一点",
    cut: "删掉长的那一段",
    said: "已删除。",
  },
} as const;

async function start(model: MockLanguageModelV4, blocks: Parameters<typeof writeMind>[1]) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const mind = await core.createMind({ title: "Q3 review" });
  const client = await connectToMind(core, mind.id);
  writeMind(client, blocks);
  await client.settled();
  return { core, mind, client };
}

/** The first Answer's own change, taken out whole and left waiting for the User. */
const removalReply = (): ScriptedReply => ({
  text: `## Summary\n\n<removed>${LONG}</removed>`,
});

const pending = (client: MindClient) => pendingProposals(client.blocks).map((each) => each.id);

describe("A waiting change that takes out a whole paragraph", { timeout: 30_000 }, () => {
  // protects=a second edit_mind in the Answer that takes a paragraph out whole says its own removal still waits for the User, never that the text changed while it was being read; fails_when=the reply blames a change to the text, or the Note or the change waiting is not exactly as it was; no_claim=how a real model words the reply.
  for (const language of ["en", "zh-CN"] as const) {
    test(`the Answer's own whole-paragraph removal is said to wait, not to have changed (${language})`, async () => {
      const said = words[language];
      let seen: MindClient | null = null;
      let beforeRefusal: ReturnType<typeof exactly> | null = null;
      const model = scriptedModel((call): ScriptedReply => {
        const passage = editPassage(call);
        if (passage !== null) return removalReply();
        const edits = call.results.filter((each) => each.tool === "edit_mind").length;
        if (asked(call).endsWith(said.remove) && edits === 0)
          return {
            calls: [{ tool: "edit_mind", input: { part: "Summary", instruction: said.remove } }],
          };
        // The same Answer asks again over the text its first change takes out.
        if (edits === 1) {
          if (seen) beforeRefusal = exactly(seen);
          return {
            calls: [
              { tool: "edit_mind", input: { part: "Summary", instruction: said.removeAgain } },
            ],
          };
        }
        return { text: said.said };
      });
      const { core, mind, client } = await start(model, [heading(2, "Summary"), note(LONG)]);
      seen = client;
      const original = exactly(client);
      const editor = boundEditor(client);

      const answer = await askAssistant(core, { text: said.remove, mindId: mind.id });

      const edits = mindCalls(answer).filter((call) => call.tool === "edit_mind");
      expect(edits).toHaveLength(2);
      expect(edits[1]).toMatchObject({
        status: "failed",
        mindProblem: { kind: "waiting", mindId: mind.id, count: 1, mixed: false },
      });
      const told = lastResult(model);
      expect(told).toContain("your own change there takes text out of it");
      expect(told).toContain(
        language === "zh-CN"
          ? "审阅 under your reply shows it"
          : "Review under your reply shows it",
      );
      expect(told).not.toContain("changed while it was being read");
      expect(told).not.toContain("the User's own requests");
      await client.settled();
      expect(beforeRefusal).not.toBeNull();
      expect(exactly(client)).toEqual(beforeRefusal);
      expect(shownWithChanges(client)).toEqual(["Summary", `- ${LONG}`]);

      // The refusal wrote nothing, so Undo has nothing of its own to take back: the Note is
      // still exactly as the first change left it.
      editor.commands.undo();
      await client.settled();
      expect(exactly(client)).toEqual(beforeRefusal);

      // Rejecting the waiting change gives back the words exactly as they were.
      resolveProposals(client.blocks, () => true, "reject");
      await client.settled();
      expect(exactly(client)).toEqual(original);
    });
  }

  // protects=a second edit_mind over its own waiting removal and the User's other paragraph names the Answer's own removal as what waits, leaving the User's paragraph and the Note as they were; fails_when=the reason names the User's own requests or a Word file's changes, or anything changes; no_claim=how a real model words the reply.
  for (const language of ["en", "zh-CN"] as const) {
    test(`with the User's paragraph in the range, the reason names the Answer's own removal (${language})`, async () => {
      const said = words[language];
      const model = scriptedModel((call): ScriptedReply => {
        const passage = editPassage(call);
        if (passage !== null)
          return { text: `## Summary\n\n<removed>${LONG}</removed>\n\nCosts fell.` };
        const edits = call.results.filter((each) => each.tool === "edit_mind").length;
        if (asked(call).endsWith(said.cut)) {
          return edits === 0
            ? { calls: [{ tool: "edit_mind", input: { part: "Summary", instruction: said.cut } }] }
            : { text: said.said };
        }
        if (edits === 0)
          return {
            calls: [
              { tool: "edit_mind", input: { part: "Summary", instruction: said.removeAgain } },
            ],
          };
        return { text: said.said };
      });
      const { core, mind, client } = await start(model, [
        heading(2, "Summary"),
        note(LONG),
        note("Costs fell."),
      ]);
      const original = exactly(client);
      const editor = boundEditor(client);
      const first = await askAssistant(core, { text: said.cut, mindId: mind.id });
      await client.settled();
      const waiting = pending(client);
      expect(waiting.length).toBeGreaterThan(0);
      const beforeRefusal = exactly(client);
      const checkpoints = (await core.listCheckpoints(mind.id)).checkpoints.length;

      const second = await askAssistant(core, {
        text: said.removeAgain,
        mindId: mind.id,
        conversationId: first.conversationId,
      });

      const [refused] = mindCalls(second);
      expect(refused).toMatchObject({
        status: "failed",
        mindProblem: { kind: "waiting", mindId: mind.id, count: 1, mixed: false },
      });
      const told = lastResult(model);
      expect(told).toContain("your own change there takes text out of it");
      expect(told).toContain(
        language === "zh-CN"
          ? "审阅 under your reply shows it"
          : "Review under your reply shows it",
      );
      expect(told).not.toContain("the User's own requests");
      expect(told).not.toContain("Word file");
      await client.settled();
      expect(exactly(client)).toEqual(beforeRefusal);
      expect(pending(client)).toEqual(waiting);
      expect(shownWithChanges(client)).toEqual(["Summary", `- ${LONG}`, "Costs fell."]);
      expect((await core.listCheckpoints(mind.id)).checkpoints).toHaveLength(checkpoints);

      // The refusal wrote nothing, so Undo has nothing of its own to take back.
      editor.commands.undo();
      await client.settled();
      expect(exactly(client)).toEqual(beforeRefusal);

      // Rejecting the waiting change gives back the Note exactly as it was.
      resolveProposals(client.blocks, () => true, "reject");
      await client.settled();
      expect(exactly(client)).toEqual(original);
    });
  }

  // protects=a change waiting from the User's own Edit with AI is still refused as one the assistant can't revise, with the reason that names it, and nothing changes; fails_when=the Answer's own-removal reason takes its place, or the User's words are touched; no_claim=none beyond protects.
  test("the User's own waiting change keeps its own reason", async () => {
    const model = scriptedModel((call): ScriptedReply => {
      const passage = editPassage(call);
      if (passage !== null) return { text: passage.replace("very ", "") };
      const edits = call.results.filter((each) => each.tool === "edit_mind").length;
      return edits === 0
        ? {
            calls: [
              { tool: "edit_mind", input: { part: "Summary", instruction: "Make it shorter" } },
            ],
          }
        : { text: "I can't change it yet." };
    });
    const { core, mind, client } = await start(model, [heading(2, "Summary"), note(LONG)]);
    const paragraph = client.blocks.get(1);
    const blockId = paragraph && "getAttribute" in paragraph ? paragraph.getAttribute("id") : null;
    if (typeof blockId !== "string") throw new Error("The paragraph has no id.");
    const edited = await core.editWithAi({
      requestId: "edit-shorter",
      mindId: mind.id,
      from: { blockId, offset: 0 },
      to: { blockId, offset: LONG.length },
      text: LONG,
      action: "instruction",
      instruction: "Make it shorter",
    });
    expect(edited).toMatchObject({ kind: "proposed" });
    await client.settled();
    const before = exactly(client);

    await askAssistant(core, { text: "make the summary shorter", mindId: mind.id });

    const told = lastResult(model);
    expect(told).toContain(
      "the text you asked to change holds some that you can't revise (the User's own requests, or someone's from a Word file)",
    );
    expect(told).not.toContain("your own change there takes text out of it");
    await client.settled();
    expect(exactly(client)).toEqual(before);
  });
});
