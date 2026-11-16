/**
 * A removal wider than the request names waits for the User (#3178): "Delete the sentence about
 * the ferry." over a paragraph with no such sentence, where the model quotes the whole paragraph
 * as taken out. One small call reads the request against the paragraphs taken out; a "no", or no
 * answer, waits. The models are scripted.
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { askAssistant } from "../helpers/assistant";
import { setUpWithDocuments } from "../helpers/citations";
import { editingModel, type RemovalAnswer } from "../helpers/editing";
import { resolveChanges, shownWithChanges, writeMind } from "../helpers/minds";
import {
  type GenerateCall,
  judgesNothing,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
} from "../helpers/models";

let ids = 0;
const paragraph = (value: string): JSONContent & { attrs: { id: string } } => ({
  type: "paragraph",
  attrs: { id: `wide-${++ids}` },
  content: [{ type: "text", text: value }],
});

const SECOND = "Second paragraph stays.";
/** Text the request doesn't touch, so a paragraph taken out is under half of the Note's words. */
const FILLER = {
  English:
    "The harbour keeps a register of every vessel that ties up at the north quay during the season.",
  Chinese: "港口对整个季节里在北码头靠泊的每一艘船只都有登记，并在年底汇总公布。",
} as const;
const CASES = [
  {
    name: "English",
    first: "Boats leave at high water. The office opens at nine.",
    asked: "Delete the sentence about the ferry.",
    all: "Delete this paragraph.",
  },
  {
    name: "Chinese",
    first: "船只在涨潮时出港。办公室九点开门。",
    asked: "删掉关于渡轮的那句话。",
    all: "把这一段删掉。",
  },
] as const;

describe.each(CASES)("A removal wider than the request names ($name)", (each) => {
  const onlyFirst = async (removal: RemovalAnswer, asked: string[] = []) => {
    const { core, mind, client } = await setUpWithDocuments(
      editingModel(() => `¶1 <removed>${each.first}</removed>`, [], { removal, asked }),
      [],
    );
    const first = paragraph(each.first);
    writeMind(client, [first, paragraph(SECOND)]);
    await client.settled();
    const input = (instruction: string) => ({
      requestId: `wide-${each.name}`,
      mindId: mind.id,
      from: { blockId: first.attrs.id, offset: 0 },
      to: { blockId: first.attrs.id, offset: each.first.length },
      text: each.first,
      action: "instruction" as const,
      instruction,
    });
    return { core, client, input };
  };

  // protects=a request that names a sentence the paragraph doesn't have, whose reply quotes the whole paragraph as taken out, waits for the User: the small model is shown the request and the paragraph taken out, and says no; fails_when=the paragraph goes at once, or the question doesn't carry what was taken out; no_claim=how often a real model overshoots (3 of 3 runs of #3178's probe on main).
  test("Edit with AI: the whole paragraph taken out for a sentence waits", async () => {
    const asked: string[] = [];
    const { core, client, input } = await onlyFirst("no", asked);

    const result = await core.editWithAi(input(each.asked));
    await client.settled();

    expect(result).toMatchObject({ kind: "proposed", held: true });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(each.asked);
    expect(asked[0]).toContain(each.first);
    await resolveChanges(client, "reject");
    expect(shownWithChanges(client)).toEqual([each.first, SECOND]);
  });

  // protects=a request that names all of what the reply takes out applies at once, as before (#2180); fails_when=a deletion the User asked for waits; no_claim=how a real model reads other wordings.
  test("Edit with AI: the whole paragraph taken out for the paragraph applies at once", async () => {
    const asked: string[] = [];
    const { core, client, input } = await onlyFirst("yes", asked);

    const result = await core.editWithAi(input(each.all));
    await client.settled();

    expect(result).toMatchObject({ kind: "proposed" });
    expect(result).not.toHaveProperty("held");
    expect(asked).toHaveLength(1);
  });

  // protects=a question that can't be asked or read waits for the User, never applies; fails_when=the paragraph goes on no answer; no_claim=why it failed.
  test.each(["fails", "unreadable"] as const)(
    "Edit with AI: the question %s: the removal waits",
    async (removal) => {
      const { core, input } = await onlyFirst(removal);

      const result = await core.editWithAi(input(each.all));

      expect(result).toMatchObject({ kind: "proposed", held: true });
    },
  );

  const throughAssistant = async (answer: "yes" | "no") => {
    const told: string[] = [];
    const model = scriptedModel(
      (call: ModelCall): ScriptedReply => {
        if (/<passage>\n/.test(call.prompt)) return { text: `¶1 <removed>${each.first}</removed>` };
        if (call.results.length > 0) {
          told.push(JSON.stringify(call.results));
          return { text: "Done." };
        }
        return {
          calls: [
            {
              tool: "edit_mind",
              input: {
                part: /\p{Script=Han}/u.test(each.first)
                  ? each.first.slice(0, 8)
                  : each.first.split(" ").slice(0, 4).join(" "),
                instruction: each.asked,
                removes_only: true,
              },
            },
          ],
        };
      },
      {
        generate: (call: GenerateCall) =>
          call.question === "removal-asked"
            ? { text: JSON.stringify({ asks_for_all: answer }) }
            : judgesNothing(call),
      },
    );
    const { core, mind, client } = await setUpWithDocuments(model, []);
    writeMind(client, [
      paragraph(each.first),
      paragraph(SECOND),
      paragraph(FILLER[each.name]),
      paragraph(FILLER[each.name]),
    ]);
    await client.settled();
    await askAssistant(core, { text: each.asked, mindId: mind.id });
    await client.settled();
    return { client, told: told.join("") };
  };

  // protects=through the assistant, with removes_only given, a removal wider than the words names waits for the User and the model is told it waits, and the Note keeps the paragraph until they decide; fails_when=the assistant's removal applies, or it is told it applied; no_claim=how a real model words its reply.
  test("the assistant: the whole paragraph taken out for a sentence waits", async () => {
    const { client, told } = await throughAssistant("no");

    expect(told).toContain("whole paragraphs");
    expect(told).toContain("waits there for them");
    expect(shownWithChanges(client)[0]).toBe(`- ${each.first}`);
    await resolveChanges(client, "reject");
    expect(shownWithChanges(client)[0]).toBe(each.first);
  });

  // protects=through the assistant a removal the words name in full is told to apply at once; fails_when=a deletion the User asked for waits; no_claim=none.
  test("the assistant: the paragraph named in full applies at once", async () => {
    const { told } = await throughAssistant("yes");

    expect(told).toContain("applies in the Note at once");
  });
});
