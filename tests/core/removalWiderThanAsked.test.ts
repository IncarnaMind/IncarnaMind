/**
 * A removal wider than the request names waits for the User (#3178): "Delete the sentence about
 * the ferry." over a paragraph with no such sentence, where the model quotes the whole paragraph
 * as taken out. One small call reads the request against the paragraphs taken out; a "no", or no
 * answer, waits. The models are scripted.
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import type { ChatModelFactory } from "../../src/core";
import { TAKEN_OUT_SHOWN } from "../../src/core/edits/removalAsked";
import { recordProposalRequest, widerThanAsked } from "../../src/shared/proposals";
import { askAssistant } from "../helpers/assistant";
import { setUpWithDocuments } from "../helpers/citations";
import { createMemoryKeychain, createTempDataFolder, startCore } from "../helpers/core";
import { editingModel, type RemovalAnswer } from "../helpers/editing";
import { connectToMind } from "../helpers/mindClient";
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

describe("Which model reads the request against what was taken out", () => {
  // protects=an edit on one provider asks that provider's own quick-tasks model, never the one the User set on another: the request and the paragraph taken out go to the provider the edit already went to (#3178); fails_when=the call goes to the quick-tasks model on the other provider; no_claim=none.
  test("an edit on Anthropic with the quick-tasks model set on OpenAI asks Anthropic's", async () => {
    const line = "Boats leave at high water. The office opens at nine.";
    const asked = {
      edit: [] as string[],
      anthropicQuick: [] as string[],
      openaiQuick: [] as string[],
    };
    const reply = () => `¶1 <removed>${line}</removed>`;
    const models = {
      "claude-sonnet-5-5": editingModel(reply, [], { removal: "no", asked: asked.edit }),
      "claude-haiku-5-5": editingModel(reply, [], { removal: "no", asked: asked.anthropicQuick }),
      "gpt-6.1-sol": editingModel(reply, [], { removal: "yes", asked: asked.openaiQuick }),
    } as const;
    const createChatModel: ChatModelFactory = (spec) => {
      const model = models[spec.modelId as keyof typeof models];
      if (!model) throw new Error(`No model ${spec.modelId} in this test.`);
      return model;
    };
    const core = startCore(await createTempDataFolder(), {
      createChatModel,
      keychain: createMemoryKeychain(),
    });
    core.on("consent.requested", (request) => void core.respondToConsent(request.requestId, true));
    const anthropic = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-sonnet-5-5",
    });
    const openai = await core.saveChatProvider({
      kind: "openai",
      apiKey: "sk-test",
      modelId: "gpt-6.1-sol",
    });
    await core.updateSettings({
      user: {
        chatModel: { providerId: anthropic.id, modelId: "claude-sonnet-5-5" },
        quickTasksModel: { providerId: openai.id, modelId: "gpt-6.1-sol" },
      },
    });
    const mind = await core.createMind({ title: "Harbour" });
    const client = await connectToMind(core, mind.id);
    const first = paragraph(line);
    writeMind(client, [first, paragraph(SECOND)]);
    await client.settled();

    const result = await core.editWithAi({
      requestId: "routing",
      mindId: mind.id,
      from: { blockId: first.attrs.id, offset: 0 },
      to: { blockId: first.attrs.id, offset: line.length },
      text: line,
      action: "instruction",
      instruction: "Delete the sentence about the ferry.",
    });

    expect(asked.openaiQuick).toHaveLength(0);
    expect(asked.anthropicQuick).toHaveLength(1);
    expect(asked.anthropicQuick[0]).toContain(line);
    expect(result).toMatchObject({ kind: "proposed", held: true });
  });
});

describe("What the question is shown of the paragraphs taken out", () => {
  const first = "Boats leave at high water. The office opens at nine.";
  const second = "Fees are charged per night and are lower between November and March.";

  const setUp = async (reply: string, removal: RemovalAnswer, asked: string[], lines: string[]) => {
    const { core, mind, client } = await setUpWithDocuments(
      editingModel(() => reply, [], { removal, asked }),
      [],
    );
    const blocks = lines.map(paragraph);
    writeMind(client, blocks);
    await client.settled();
    const last = blocks.at(-1) as (typeof blocks)[number];
    const from = { blockId: (blocks[0] as (typeof blocks)[number]).attrs.id, offset: 0 };
    const to = { blockId: last.attrs.id, offset: lines.at(-1)?.length ?? 0 };
    return { core, mind, from, to };
  };

  // protects=each paragraph taken out is shown with its place in the passage, as the edit model numbers it, so an ordinal request ("the second paragraph") is read against the paragraph it names; fails_when=the places are left out, or counted another way; no_claim=how a real model reads them.
  test("each paragraph taken out starts with its place", async () => {
    const asked: string[] = [];
    const { core, mind, from, to } = await setUp(`¶2 <removed>${second}</removed>`, "yes", asked, [
      first,
      second,
    ]);

    await core.editWithAi({
      requestId: "places",
      mindId: mind.id,
      from,
      to,
      text: [first, second].join("\n"),
      action: "instruction",
      instruction: "Delete the second paragraph.",
    });

    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(`¶2 ${second}`);
    expect(asked[0]).not.toContain("¶1");
  });

  // protects=text taken out that is more than the question shows waits for the User without being asked: a yes about the part shown can't speak for the rest; fails_when=a removal bigger than the question shows applies on an answer about its start; no_claim=none.
  test("more taken out than the question shows waits unasked", async () => {
    const asked: string[] = [];
    const long = `${first} ${"The harbour keeps a register of every vessel. ".repeat(Math.ceil(TAKEN_OUT_SHOWN / 40))}`;
    const { core, mind, from, to } = await setUp(`¶1 <removed>${long}</removed>`, "yes", asked, [
      long,
      second,
    ]);

    const result = await core.editWithAi({
      requestId: "long",
      mindId: mind.id,
      from,
      to: { ...to },
      text: [long, second].join("\n"),
      action: "instruction",
      instruction: "Remove the ferry text.",
    });

    expect(asked).toHaveLength(0);
    expect(result).toMatchObject({ kind: "proposed", held: true });
  });

  // protects=a later part of the same request that is recorded again keeps what an earlier part was held for; fails_when=the flag is lost and the assistant is told nothing waits for a removal that does; no_claim=none.
  test("a request recorded again keeps the flag that held an earlier part", () => {
    const doc = new Y.Doc();
    const made = {
      source: "edit-with-ai" as const,
      providerId: "p",
      modelId: "m",
      createdAt: "2026-11-16T00:00:00.000Z",
      action: "instruction" as const,
    };
    recordProposalRequest(doc, "r", { ...made, widerThanAsked: true });
    recordProposalRequest(doc, "r", { ...made, reason: "Shorter." });

    expect(widerThanAsked(doc, "r")).toBe(true);
  });
});
