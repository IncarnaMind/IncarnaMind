import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import { EDIT_INSTRUCTIONS } from "../../src/core/edits/prompt";
import { resolveInEditor } from "../../src/renderer/src/editor/proposalReview";
import { pendingProposals } from "../../src/shared/proposals";
import { askAssistant, changesIn } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import { boundEditor } from "../helpers/editor";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { heading, note, resolveChanges, shownWithChanges, writeMind } from "../helpers/minds";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

/**
 * The assistant remembers what it wrote and what the User did with it, also
 * in a long conversation (#945): the record of each Answer's Tool calls
 * outlasts that Answer's text when the history's budget runs out, and says
 * what the User accepted or rejected since. Through the core's public
 * interface; the model's choices are scripted, real models' are checked by hand.
 */

/** The text of the last user message of a request: the Question it answers. */
const asked = ({ options }: ModelCall): string => {
  const last = options.prompt.filter((message) => message.role === "user").at(-1);
  if (!last) return "";
  return typeof last.content === "string"
    ? last.content
    : last.content.map((part) => ("text" in part ? part.text : "")).join("");
};

const editPassage = (call: ModelCall): string | null =>
  call.system.startsWith(EDIT_INSTRUCTIONS)
    ? (/<passage>\n([\s\S]*?)\n<\/passage>/.exec(call.prompt)?.[1] ?? null)
    : null;

const called = (call: ModelCall, tool: string) => call.results.some((each) => each.tool === tool);

async function setUp(
  model: MockLanguageModelV4,
  title = "Q3 review",
  blocks = [heading(2, "Summary"), note("The quarter was good.")],
) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const mind = await core.createMind({ title });
  const client = await connectToMind(core, mind.id);
  writeMind(client, blocks);
  await client.settled();
  return { core, mind, client };
}

const waitingIn = (client: MindClient) => pendingProposals(client.blocks).length;

describe("The assistant remembers in a long conversation", { timeout: 120_000 }, () => {
  const FILLER = "Spring tides follow the new and full moon. ".repeat(80);
  const SUMMARY_PAGE = "## Summary\n\nThe paper is about spring tides.";

  // protects=thirty turns later, with the first Answer's text out of the history, "make the summary longer" still revises the page the first turn wrote, from its record; fails_when=the first Answer's text is still sent, the record is lost and the model doesn't know the page, or a second page is made; no_claim=how a real model finds the page.
  test("after 30 turns, “make the summary longer” revises the page the first turn wrote", async () => {
    let seen = "";
    const model = scriptedModel((call): ScriptedReply => {
      const passage = editPassage(call);
      if (passage !== null)
        return { text: `${passage} It also covers neap tides.\n<why>Longer.</why>` };
      const question = asked(call);
      if (question.endsWith("write a summary page")) {
        return called(call, "create_mind")
          ? { text: "Made “Tide notes” with a short summary." }
          : {
              calls: [
                { tool: "create_mind", input: { title: "Tide notes", content: SUMMARY_PAGE } },
              ],
            };
      }
      if (question.endsWith("make the summary longer")) {
        seen = call.prompt;
        if (called(call, "edit_mind")) return { text: "Lengthened the summary." };
        const knows = call.prompt.includes("create_mind: made the Note “Tide notes”");
        return knows
          ? {
              calls: [
                {
                  tool: "edit_mind",
                  input: { mind: "Tide notes", part: "Summary", instruction: "Make it longer" },
                },
              ],
            }
          : { text: "Which summary do you mean?" };
      }
      return { text: `Answer to ${question.split("\n\n").at(-1)}. ${FILLER}` };
    });
    const { core, mind } = await setUp(model);

    const first = await askAssistant(core, { text: "write a summary page", mindId: mind.id });
    const page = await connectToMind(core, changesIn(first)[0]?.mindId ?? "");
    for (let turn = 2; turn < 30; turn++) {
      await askAssistant(core, {
        text: `question ${turn}`,
        mindId: mind.id,
        conversationId: first.conversationId,
      });
    }
    const last = await askAssistant(core, {
      text: "make the summary longer",
      mindId: mind.id,
      conversationId: first.conversationId,
    });

    expect(seen).not.toContain("with a short summary");
    expect(seen).not.toContain("Answer to question 2.");
    expect(seen).toContain("Answer to question 29.");
    expect(seen).toContain(
      "- create_mind: made the Note “Tide notes” and proposed 2 changes, waiting for the User",
    );
    await page.settled();
    expect(shownWithChanges(page)).toEqual([
      "+ Summary",
      "+ The paper is about spring tides. It also covers neap tides.",
    ]);
    expect(changesIn(last)).toMatchObject([{ mindId: changesIn(first)[0]?.mindId, revised: true }]);
  });
});

describe("The assistant knows what the User did with its changes", { timeout: 60_000 }, () => {
  /** A model that adds `content` to the Mind in focus once, then records what it was told next turn. */
  function addingModel(content: string, sent: string[]) {
    return scriptedModel((call): ScriptedReply => {
      const question = asked(call);
      if (/add (a|two|three)/.test(question)) {
        return called(call, "add_to_mind")
          ? { text: "Added them." }
          : { calls: [{ tool: "add_to_mind", input: { content } }] };
      }
      sent.push(call.prompt);
      return { text: "Understood." };
    });
  }

  // protects=after the User rejects all of a written change, the next turn's context says so and holds none of the rejected text, so "make it longer" has nothing of it to bring back; fails_when=the record still says it waits, or the rejected text is in the context; no_claim=none beyond protects.
  test("after the User rejects a written page, the next turn's context says so", async () => {
    const sent: string[] = [];
    const { core, mind, client } = await setUp(
      addingModel("## Risks\n\nThe supplier is late.", sent),
    );
    const first = await askAssistant(core, { text: "add a risks section", mindId: mind.id });
    expect(waitingIn(client)).toBe(2);
    await client.settled();
    await resolveChanges(client, "reject");

    const second = await askAssistant(core, {
      text: "make it longer",
      mindId: mind.id,
      conversationId: first.conversationId,
    });

    const [context] = sent;
    expect(context).toContain(
      "- add_to_mind “Q3 review”: proposed 2 new Blocks, then the User rejected all 2",
    );
    expect(context).not.toContain("waiting for the User");
    expect(context).not.toContain("The supplier is late");
    expect(changesIn(second)).toEqual([]);
    await client.settled();
    expect(shownWithChanges(client)).toEqual(["Summary", "The quarter was good."]);
  });

  // protects=part of a change accepted shows as "accepted 2 of 3", with the rest still waiting, also for a Mind and a Question in Chinese; fails_when=the record still says all three wait, or the count is lost; no_claim=none beyond protects.
  test.each([
    {
      language: "English",
      title: "Q3 review",
      request: "add three risks",
      content: "One.\n\nTwo.\n\nThree.",
      blocks: [heading(2, "Summary"), note("The quarter was good.")],
    },
    {
      language: "Chinese",
      title: "第三季度回顾",
      request: "添加三条风险",
      content: "第一条。\n\n第二条。\n\n第三条。",
      blocks: [heading(2, "摘要"), note("本季度表现不错。")],
    },
  ])("accepting 2 of 3 reads as that next turn ($language)", async (each) => {
    const sent: string[] = [];
    const model = scriptedModel((call): ScriptedReply => {
      const question = asked(call);
      if (question.endsWith(each.request)) {
        return called(call, "add_to_mind")
          ? { text: "Done." }
          : { calls: [{ tool: "add_to_mind", input: { content: each.content } }] };
      }
      sent.push(call.prompt);
      return { text: "Ok." };
    });
    const { core, mind, client } = await setUp(model, each.title, each.blocks);
    const first = await askAssistant(core, { text: each.request, mindId: mind.id });
    expect(waitingIn(client)).toBe(3);
    await client.settled();
    await resolveChanges(client, "accept", (_, index) => index < 2);

    await askAssistant(core, {
      text: "next",
      mindId: mind.id,
      conversationId: first.conversationId,
    });

    expect(sent[0]).toContain(
      `- add_to_mind “${each.title}”: proposed 3 new Blocks, then the User accepted 2 of 3, 1 still waiting`,
    );
  });

  // protects=a decision taken back with Undo in the editor takes its count with it, so a later decision reads as what it is: accept all, Undo, reject all reads as rejected, and reject all then Undo as waiting; fails_when=the counts stay (the rejection is lost as "none waiting any more", or a taken-back rejection reads as rejected); no_claim=none beyond protects.
  test("Undo takes a decision's count back too", async () => {
    const sent: string[] = [];
    const { core, mind, client } = await setUp(addingModel("Late.\n\nVery late.", sent));
    const first = await askAssistant(core, { text: "add two lines", mindId: mind.id });
    await client.settled();
    const editor = boundEditor(client);
    const next = async () => {
      await client.settled();
      await askAssistant(core, {
        text: "next",
        mindId: mind.id,
        conversationId: first.conversationId,
      });
      return sent.at(-1) ?? "";
    };

    resolveInEditor(editor, "all", "reject");
    editor.commands.undo();
    expect(waitingIn(client)).toBe(2);
    expect(await next()).toContain("proposed 2 new Blocks, waiting for the User");

    resolveInEditor(editor, "all", "accept");
    editor.commands.undo();
    expect(waitingIn(client)).toBe(2);
    resolveInEditor(editor, "all", "reject");
    expect(waitingIn(client)).toBe(0);
    expect(await next()).toContain("proposed 2 new Blocks, then the User rejected all 2");
  });

  // protects=a made page whose Mind the User deleted after rejecting it reads as gone, not as waiting; fails_when=the record says it waits; no_claim=none beyond protects.
  test("a made page whose Mind was deleted reads as gone", async () => {
    const sent: string[] = [];
    const model = scriptedModel((call): ScriptedReply => {
      const question = asked(call);
      if (question.endsWith("write a page")) {
        return called(call, "create_mind")
          ? { text: "Made it." }
          : { calls: [{ tool: "create_mind", input: { title: "Notes", content: "Hello." } }] };
      }
      sent.push(call.prompt);
      return { text: "Ok." };
    });
    const { core, mind } = await setUp(model);
    const first = await askAssistant(core, { text: "write a page", mindId: mind.id });
    const made = await connectToMind(core, changesIn(first)[0]?.mindId ?? "");
    await made.settled();
    await resolveChanges(made, "reject");
    await core.deleteMind(changesIn(first)[0]?.mindId ?? "");

    await askAssistant(core, {
      text: "next",
      mindId: mind.id,
      conversationId: first.conversationId,
    });

    expect(sent[0]).toContain(
      "- create_mind: made the Note “Notes” and proposed 1 change, but the Note is no longer there",
    );
  });
});
