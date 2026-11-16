/**
 * A rewrite that finds nothing to do declines with a reply that is `<why>` alone (#2589): nothing
 * is proposed, the Note stays as it was, and the reason is shown and told to the assistant. The
 * code never reads a decline from a reply's words. The model is scripted.
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { EDIT_INSTRUCTIONS, EDIT_INSTRUCTIONS_NAMED } from "../../src/core/edits/prompt";
import { askAssistant } from "../helpers/assistant";
import { setUpWithDocuments } from "../helpers/citations";
import { resolveChanges, shownWithChanges, writeMind } from "../helpers/minds";
import {
  judgesNothing,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
} from "../helpers/models";

let ids = 0;
const paragraph = (value: string): JSONContent & { attrs: { id: string } } => ({
  type: "paragraph",
  attrs: { id: `own-${++ids}` },
  content: [{ type: "text", text: value }],
});

const SECOND = "Second paragraph stays.";
/** The first words of a paragraph, as `edit_mind` names it: three words, or six Chinese characters, at least. */
const partOf = (line: string) =>
  /\p{Script=Han}/u.test(line) ? line.slice(0, 8) : line.split(" ").slice(0, 4).join(" ");
const CASES = [
  {
    name: "English",
    first: "Boats leave at high water. The office opens at nine.",
    asked: "Delete the sentence about the ferry.",
    why: "There is no sentence about the ferry in the passage, so nothing needs to change.",
  },
  {
    name: "Chinese",
    first: "船只在涨潮时出港。办公室九点开门。",
    asked: "删掉关于渡轮的那句话。",
    why: "原文中没有关于渡轮的句子，所以不需要修改。",
  },
  {
    name: "English over a Chinese paragraph",
    first: "船只在涨潮时出港。办公室九点开门。",
    asked: "删掉关于渡轮的那句话。",
    why: "There is no sentence about the ferry in the passage, so nothing needs to change.",
  },
] as const;

describe("A decline: a reply that is why alone", () => {
  // protects=an instruction the passage has nothing for, answered by the why line alone, changes nothing through Edit with AI and the assistant, in English and Chinese and in a language the paragraph isn't in; the window shows the reason and the assistant is told it with the text as it was; fails_when=the paragraph is replaced, a failure is reported, or the reason is lost; no_claim=how often a real model declines (tests/live/ownLineDecline.live.test.ts).
  describe.each(CASES)("$name", (each) => {
    const setUp = async (told: string[] = []) => {
      const { core, mind, client } = await setUpWithDocuments(
        scriptedModel(
          (call: ModelCall): ScriptedReply => {
            if (/<passage>\n/.test(call.prompt)) return { text: `<why>${each.why}</why>` };
            if (call.results.length > 0) {
              told.push(JSON.stringify(call.results));
              return { text: "Done." };
            }
            return {
              calls: [
                {
                  tool: "edit_mind",
                  input: { part: partOf(each.first), instruction: each.asked },
                },
              ],
            };
          },
          { generate: judgesNothing },
        ),
        [],
      );
      const first = paragraph(each.first);
      writeMind(client, [first, paragraph(SECOND)]);
      await client.settled();
      return { core, mind, client, first };
    };

    test("Edit with AI", async () => {
      const { core, mind, client, first } = await setUp();

      const result = await core.editWithAi({
        requestId: `own-${each.name}`,
        mindId: mind.id,
        from: { blockId: first.attrs.id, offset: 0 },
        to: { blockId: first.attrs.id, offset: each.first.length },
        text: each.first,
        action: "instruction",
        instruction: each.asked,
      });
      await client.settled();

      expect(result).toEqual({ kind: "unchanged", said: each.why });
      expect(shownWithChanges(client)).toEqual([each.first, SECOND]);
    });

    test("the assistant", async () => {
      const told: string[] = [];
      const { core, mind, client } = await setUp(told);

      await askAssistant(core, { text: each.asked, mindId: mind.id });
      await client.settled();
      await resolveChanges(client, "accept");

      expect(shownWithChanges(client)).toEqual([each.first, SECOND]);
      expect(told.join("")).toContain(each.why);
      expect(told.join("")).toContain("don't say it was changed");
    });
  });

  // protects=Improve, which is asked without paragraph names, can decline the same way, and its instructions say how; fails_when=a why line alone fails or writes something, or the instructions without names don't tell the model how to decline; no_claim=whether a real model follows them.
  test("a fixed task declines too, and both instructions say how", async () => {
    const { core, mind, client } = await setUpWithDocuments(
      scriptedModel(() => ({ text: "<why>It already reads well.</why>" }), {
        generate: judgesNothing,
      }),
      [],
    );
    const only = paragraph("Boats leave at high water.");
    writeMind(client, [only]);
    await client.settled();

    const result = await core.editWithAi({
      requestId: "own-improve",
      mindId: mind.id,
      from: { blockId: only.attrs.id, offset: 0 },
      to: { blockId: only.attrs.id, offset: "Boats leave at high water.".length },
      text: "Boats leave at high water.",
      action: "improve",
    });

    expect(result).toEqual({ kind: "unchanged", said: "It already reads well." });
    expect(shownWithChanges(client)).toEqual(["Boats leave at high water."]);
    for (const instructions of [EDIT_INSTRUCTIONS, EDIT_INSTRUCTIONS_NAMED]) {
      expect(instructions).toContain("your whole reply is <why> alone");
    }
  });

  // protects=a reply with no text and no why is still a failure, not a decline; fails_when=an empty reply is read as the model declining; no_claim=none.
  test("a reply with nothing at all fails", async () => {
    const { core, mind, client } = await setUpWithDocuments(
      scriptedModel(() => ({ text: "" }), { generate: judgesNothing }),
      [],
    );
    const only = paragraph("Boats leave at high water.");
    writeMind(client, [only]);
    await client.settled();

    const result = await core.editWithAi({
      requestId: "own-empty",
      mindId: mind.id,
      from: { blockId: only.attrs.id, offset: 0 },
      to: { blockId: only.attrs.id, offset: "Boats leave at high water.".length },
      text: "Boats leave at high water.",
      action: "improve",
    });

    expect(result).toMatchObject({
      kind: "failed",
      error: { message: "The model gave nothing back." },
    });
  });
});
