import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { type Core, PROPOSAL_ATTRIBUTE } from "../../src/core";
import { EDIT_INSTRUCTIONS, EDIT_INSTRUCTIONS_NAMED } from "../../src/core/edits/prompt";
import { pendingProposals, proposalRequestOf, resolveProposals } from "../../src/shared/proposals";
import { wordFileOf, wordImportProgressOf } from "../../src/shared/wordFiles";
import { askAssistant, lastResult, mindCalls } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import { boundEditor, typeText } from "../helpers/editor";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { exactly, heading, note, shownWithChanges, writeMind } from "../helpers/minds";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";
import { paragraph, tracked, wordFile } from "../helpers/word";

/**
 * The assistant asks a second time to change text its own waiting change takes out whole (#2502):
 * its reply says that the removal still waits for the User, never that the text changed while it
 * was being read, nor that the waiting change is the User's or a Word file's. The Note and its
 * waiting change are left exactly as they were, so Undo has nothing of the refused call to take
 * back, and rejecting the change gives back the words as they were. The removal may be a whole
 * paragraph inside a list, a quote or a table cell, whose Block keeps the others.
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
const KEPT = "Costs fell.";

const wording = {
  en: {
    remove: "Delete the long text.",
    again: "Make it shorter.",
    said: "Removed it.",
  },
  "zh-CN": {
    remove: "删掉那段长文字。",
    again: "改短一点。",
    said: "已删除。",
  },
} as const;

const LANGUAGES = ["en", "zh-CN"] as const;

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

/** A paragraph of `text` followed by a Citation, as an Answer writes one. */
const cited = (text: string): JSONContent => ({
  type: "paragraph",
  attrs: { id: randomUUID() },
  content: [
    { type: "text", text },
    { type: "citation", attrs: { documentId: "tides", quote: "spring tides" } },
  ],
});

/** Connects to an imported Mind once its import has written every Block. */
async function importedClient(core: Core, mindId: string): Promise<MindClient> {
  const connected = await connectToMind(core, mindId);
  await new Promise<void>((resolve) => {
    const check = () => {
      if (wordFileOf(connected.doc) && wordImportProgressOf(connected.doc) === null) {
        connected.doc.off("update", check);
        resolve();
      }
    };
    connected.doc.on("update", check);
    check();
  });
  return connected;
}

/** Types a character into the last paragraph through the editor, so Undo has a step of its own. */
async function typedAtTheEnd(editor: ReturnType<typeof boundEditor>, client: MindClient) {
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  typeText(editor, "!");
  await client.settled();
}

/** A Note that is a "Summary" section and a "Notes" section, whose last paragraph Undo can type in. */
const withNotes = (): JSONContent[] => [
  heading(2, "Summary"),
  note(LONG),
  heading(2, "Notes"),
  note(KEPT),
];

const SHAPES = ["list", "quote", "cell"] as const;
type Shape = (typeof SHAPES)[number];

/** A "Summary" section whose second paragraph is nested in a Block that keeps another. */
const shapedNote = (shape: Shape): JSONContent[] => {
  const kept = note(KEPT);
  const long = note(LONG);
  switch (shape) {
    case "list":
      return [
        heading(2, "Summary"),
        {
          type: "bulletList",
          content: [kept, long].map((each) => ({ type: "listItem", content: [each] })),
        },
      ];
    case "quote":
      return [heading(2, "Summary"), { type: "blockquote", content: [kept, long] }];
    case "cell":
      return [
        heading(2, "Summary"),
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  attrs: { colspan: 1, rowspan: 1 },
                  content: [note("Note")],
                },
              ],
            },
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  attrs: { colspan: 1, rowspan: 1 },
                  content: [note(KEPT), note(LONG)],
                },
              ],
            },
          ],
        },
      ];
  }
};

/** The rewrite that keeps the first Block's text and takes the nested second paragraph out whole. */
const shapedReply = (shape: Shape): string =>
  shape === "list"
    ? `## Summary\n\n- ${KEPT}\n\n<removed>${LONG}</removed>`
    : shape === "quote"
      ? `## Summary\n\n> ${KEPT}\n\n<removed>${LONG}</removed>`
      : `## Summary\n\n${KEPT}\n\n<removed>${LONG}</removed>`;

/** The whole-Block delete proposals in the Note, with the request that made each. */
function wholeDeletes(client: MindClient): { request: string; source: string | null }[] {
  const found: { request: string; source: string | null }[] = [];
  const visit = (element: Y.XmlElement) => {
    const proposal = element.getAttribute(PROPOSAL_ATTRIBUTE) as
      | { kind?: string; request?: string }
      | undefined;
    if (proposal?.kind === "delete" && typeof proposal.request === "string") {
      found.push({
        request: proposal.request,
        source: proposalRequestOf(client.doc, proposal.request)?.source ?? null,
      });
    }
    for (const child of element.toArray()) {
      if (child instanceof Y.XmlElement) visit(child);
    }
  };
  for (const block of client.blocks.toArray()) {
    if (block instanceof Y.XmlElement) visit(block);
  }
  return found;
}

describe("A waiting change that takes out a whole paragraph", { timeout: 30_000 }, () => {
  // protects=a second edit_mind in the Answer that takes a paragraph out whole says its own removal still waits for the User, never that the text changed while it was being read; fails_when=the reply blames a change to the text, or the Note or the change waiting is not exactly as it was; no_claim=how a real model words the reply.
  for (const language of LANGUAGES) {
    test(`the Answer's own whole-paragraph removal is said to wait, not to have changed (${language})`, async () => {
      const said = wording[language];
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
            calls: [{ tool: "edit_mind", input: { part: "Summary", instruction: said.again } }],
          };
        }
        return { text: said.said };
      });
      const { core, mind, client } = await start(model, withNotes());
      seen = client;
      const original = exactly(client);
      const editor = boundEditor(client);
      // A step of the User's own, which the refused call must leave on the Undo stack.
      await typedAtTheEnd(editor, client);
      const typed = shownWithChanges(client);
      expect(typed).toContain(`${KEPT}!`);

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
      expect(shownWithChanges(client)).toEqual(["Summary", `- ${LONG}`, "Notes", `${KEPT}!`]);

      // The refused call added no step: Undo still takes the User's typing back, and the
      // waiting change stays as the first change left it.
      expect(editor.commands.undo()).toBe(true);
      await client.settled();
      expect(shownWithChanges(client)).toEqual(["Summary", `- ${LONG}`, "Notes", KEPT]);
      expect(pending(client)).not.toEqual([]);

      // Rejecting the waiting change gives back the words exactly as they were.
      resolveProposals(client.blocks, () => true, "reject");
      await client.settled();
      expect(exactly(client)).toEqual(original);
    });
  }

  // protects=a second edit_mind over its own waiting removal and the User's other paragraph names the Answer's own removal as what waits, leaving the User's paragraph and the Note as they were; fails_when=the reason names the User's own requests or a Word file's changes, or anything changes; no_claim=how a real model words the reply.
  for (const language of LANGUAGES) {
    test(`with the User's paragraph in the range, the reason names the Answer's own removal (${language})`, async () => {
      const said = wording[language];
      const model = scriptedModel((call): ScriptedReply => {
        const passage = editPassage(call);
        if (passage !== null)
          return { text: `## Summary\n\n<removed>${LONG}</removed>\n\n${KEPT}` };
        const edits = call.results.filter((each) => each.tool === "edit_mind").length;
        if (asked(call).endsWith(said.remove)) {
          return edits === 0
            ? {
                calls: [
                  { tool: "edit_mind", input: { part: "Summary", instruction: said.remove } },
                ],
              }
            : { text: said.said };
        }
        if (edits === 0)
          return {
            calls: [{ tool: "edit_mind", input: { part: "Summary", instruction: said.again } }],
          };
        return { text: said.said };
      });
      const { core, mind, client } = await start(model, [
        heading(2, "Summary"),
        note(LONG),
        note(KEPT),
      ]);
      const original = exactly(client);
      const originalShown = shownWithChanges(client);
      const editor = boundEditor(client);
      const first = await askAssistant(core, { text: said.remove, mindId: mind.id });
      await client.settled();
      const waiting = pending(client);
      expect(waiting).not.toEqual([]);
      const checkpoints = (await core.listCheckpoints(mind.id)).checkpoints.length;
      // A step of the User's own, which the refused call must leave on the Undo stack.
      await typedAtTheEnd(editor, client);
      expect(shownWithChanges(client)).toContain(`${KEPT}!`);
      const beforeRefusal = exactly(client);

      const second = await askAssistant(core, {
        text: said.again,
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
      expect(shownWithChanges(client)).toEqual(["Summary", `- ${LONG}`, `${KEPT}!`]);
      expect((await core.listCheckpoints(mind.id)).checkpoints).toHaveLength(checkpoints);

      // The refused call added no step: Undo still takes the User's typing back.
      expect(editor.commands.undo()).toBe(true);
      await client.settled();
      expect(shownWithChanges(client)).toEqual(["Summary", `- ${LONG}`, KEPT]);
      expect(pending(client)).toEqual(waiting);

      // Rejecting the waiting change gives back the Note exactly as it was.
      resolveProposals(client.blocks, () => true, "reject");
      await client.settled();
      expect(exactly(client)).toEqual(original);
      expect(shownWithChanges(client)).toEqual(originalShown);
    });
  }

  // protects=a removal nested in a list, a quote or a table cell, whose Block keeps another, is refused in the same Answer and in a later Answer with the Answer's own reason, not "changed while it was being read" and not the User's or a Word file's, and the Note stays as it was; fails_when=the nested removal is revised and the lie returns, or the old reason returns; no_claim=how a real model words the reply.
  for (const language of LANGUAGES) {
    for (const shape of SHAPES) {
      test(`a nested whole-paragraph removal, in a ${shape} (${language})`, async () => {
        const said = wording[language];

        const sameAnswer = scriptedModel((call): ScriptedReply => {
          const passage = editPassage(call);
          if (passage !== null) return { text: shapedReply(shape) };
          const edits = call.results.filter((each) => each.tool === "edit_mind").length;
          if (asked(call).endsWith(said.remove) && edits === 0)
            return {
              calls: [{ tool: "edit_mind", input: { part: "Summary", instruction: said.remove } }],
            };
          if (edits === 1)
            return {
              calls: [{ tool: "edit_mind", input: { part: "Summary", instruction: said.again } }],
            };
          return { text: said.said };
        });
        {
          const { core, mind, client } = await start(sameAnswer, shapedNote(shape));
          const originalShown = shownWithChanges(client);
          const answer = await askAssistant(core, { text: said.remove, mindId: mind.id });
          const edits = mindCalls(answer).filter((call) => call.tool === "edit_mind");
          expect(edits).toHaveLength(2);
          expect(edits[1]).toMatchObject({ status: "failed", mindProblem: { kind: "waiting" } });
          const told = lastResult(sameAnswer);
          expect(told).toContain("your own change there takes text out of it");
          expect(told).not.toContain("changed while it was being read");
          expect(told).not.toContain("the User's own requests");
          await client.settled();
          const waiting = pending(client);
          expect(waiting).not.toEqual([]);
          resolveProposals(client.blocks, () => true, "reject");
          await client.settled();
          expect(shownWithChanges(client)).toEqual(originalShown);
        }

        const laterAnswer = scriptedModel((call): ScriptedReply => {
          const passage = editPassage(call);
          if (passage !== null) return { text: shapedReply(shape) };
          const edits = call.results.filter((each) => each.tool === "edit_mind").length;
          if (asked(call).endsWith(said.remove)) {
            return edits === 0
              ? {
                  calls: [
                    { tool: "edit_mind", input: { part: "Summary", instruction: said.remove } },
                  ],
                }
              : { text: said.said };
          }
          return edits === 0
            ? {
                calls: [{ tool: "edit_mind", input: { part: "Summary", instruction: said.again } }],
              }
            : { text: said.said };
        });
        {
          const { core, mind, client } = await start(laterAnswer, shapedNote(shape));
          const originalShown = shownWithChanges(client);
          const first = await askAssistant(core, { text: said.remove, mindId: mind.id });
          await client.settled();
          const waiting = pending(client);
          expect(waiting).not.toEqual([]);
          const beforeRefusal = exactly(client);
          const second = await askAssistant(core, {
            text: said.again,
            mindId: mind.id,
            conversationId: first.conversationId,
          });
          const [refused] = mindCalls(second);
          expect(refused).toMatchObject({ status: "failed", mindProblem: { kind: "waiting" } });
          const told = lastResult(laterAnswer);
          expect(told).toContain("your own change there takes text out of it");
          expect(told).not.toContain("changed while it was being read");
          expect(told).not.toContain("the User's own requests");
          expect(told).not.toContain("Word file");
          await client.settled();
          expect(exactly(client)).toEqual(beforeRefusal);
          expect(pending(client)).toEqual(waiting);
          resolveProposals(client.blocks, () => true, "reject");
          await client.settled();
          expect(shownWithChanges(client)).toEqual(originalShown);
        }
      });
    }
  }

  // protects=a same-turn second edit over a held change that took a Citation out with a removed sentence still revises in place: an inline node's own delete is no whole-Block removal; fails_when=the whole-block refusal says the text takes text out and can't be revised; no_claim=none beyond protects.
  test("a removed sentence's Citation is no whole-Block removal", async () => {
    let rewrites = 0;
    const model = scriptedModel((call): ScriptedReply => {
      const passage = editPassage(call);
      if (passage !== null) {
        rewrites += 1;
        return {
          text:
            rewrites === 1
              ? "## Summary\n\nKeep this line. The quarter figures were strong."
              : "## Summary\n\nKeep this line, and more.",
        };
      }
      const edits = call.results.filter((each) => each.tool === "edit_mind").length;
      if (edits === 0)
        return {
          calls: [
            {
              tool: "edit_mind",
              input: {
                part: "Summary",
                instruction: "Remove the quarter figures",
                removes_only: true,
              },
            },
          ],
        };
      if (edits === 1)
        return {
          calls: [
            { tool: "edit_mind", input: { part: "Summary", instruction: "Make the line longer" } },
          ],
        };
      return { text: "Changed it." };
    });
    const { core, mind, client } = await start(model, [
      heading(2, "Summary"),
      cited("Keep this line. The quarter was very good, and sales were really strong."),
    ]);

    const answer = await askAssistant(core, {
      text: "remove the quarter figures, then make the line longer",
      mindId: mind.id,
    });

    const edits = mindCalls(answer).filter((call) => call.tool === "edit_mind");
    expect(edits).toHaveLength(2);
    expect(edits[0]).toMatchObject({ status: "done" });
    expect(edits[1]).toMatchObject({ status: "done", mindChange: { revised: true } });
    expect(lastResult(model)).not.toContain("takes text out of it");
    await client.settled();
    expect(shownWithChanges(client).join(" ")).toContain("Keep this line, and more.");
  });

  // protects=a whole-paragraph removal waiting from the User's own Edit with AI keeps the old reason, so the source of the request, not only its shape, keeps it from being the Answer's own; fails_when=it is read as the Answer's own because it is a whole-Block removal; no_claim=none beyond protects.
  test("the User's own whole-paragraph removal keeps its own reason", async () => {
    const summary = heading(2, "Summary");
    const line = note(LONG);
    const model = scriptedModel((call): ScriptedReply => {
      const passage = editPassage(call);
      if (passage !== null) return removalReply();
      const edits = call.results.filter((each) => each.tool === "edit_mind").length;
      return edits === 0
        ? {
            calls: [
              { tool: "edit_mind", input: { part: "Summary", instruction: "Make it shorter" } },
            ],
          }
        : { text: "I can't change it yet." };
    });
    const { core, mind, client } = await start(model, [summary, line]);
    const edited = await core.editWithAi({
      requestId: "edit-remove",
      mindId: mind.id,
      from: { blockId: summary.attrs?.id as string, offset: 0 },
      to: { blockId: line.attrs?.id as string, offset: LONG.length },
      text: `Summary\n${LONG}`,
      action: "instruction",
      instruction: "Delete the paragraph about the quarter",
    });
    expect(edited).toMatchObject({ kind: "proposed" });
    await client.settled();
    const deletes = wholeDeletes(client);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.source).toBe("edit-with-ai");
    const made = proposalRequestOf(client.doc, deletes[0]?.request ?? "");
    expect(made !== null && "requested" in made ? made.requested : undefined).toBeUndefined();
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

  // protects=a whole-paragraph removal waiting from someone's tracked change in a Word file keeps the old reason; fails_when=the imported Block's removal is read as the Answer's own; no_claim=none beyond protects.
  test("a Word file's whole-paragraph removal keeps its own reason", async () => {
    const model = scriptedModel((call): ScriptedReply => {
      const edits = call.results.filter((each) => each.tool === "edit_mind").length;
      return edits === 0
        ? {
            calls: [
              { tool: "edit_mind", input: { part: "Summary", instruction: "Make it shorter" } },
            ],
          }
        : { text: "I can't change it yet." };
    });
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, {
      createChatModel: scriptedModels(model).createChatModel,
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const path = join(dataDir, "Draft.docx");
    await writeFile(
      path,
      wordFile({
        body: [
          paragraph("Summary", { style: "Heading1" }),
          paragraph(KEPT),
          // Someone marked the whole paragraph, mark and words, as deleted (#108).
          `<w:p><w:pPr><w:rPr><w:del w:id="9" w:author="Priya Nair" w:date="2026-10-02T09:00:00Z"/></w:rPr></w:pPr>${tracked("del", 10, "Priya Nair", LONG)}</w:p>`,
        ].join(""),
      }),
    );
    const imported = await core.importWordFile({ path, origin: "someone-else" });
    if (!imported.ok) throw new Error(`Refused: ${imported.refusal}`);
    const client = await importedClient(core, imported.mind.id);
    const deletes = wholeDeletes(client);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.source).toBe("word-change");
    const before = exactly(client);

    await askAssistant(core, { text: "make the note shorter", mindId: imported.mind.id });

    const told = lastResult(model);
    expect(told).toContain(
      "the text you asked to change holds some that you can't revise (the User's own requests, or someone's from a Word file)",
    );
    expect(told).not.toContain("your own change there takes text out of it");
    await client.settled();
    expect(exactly(client)).toEqual(before);
  });
});
