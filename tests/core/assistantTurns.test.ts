import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { Core } from "../../src/core";
import { createElement } from "../../src/core/answers/blocks";
import { GENERATED_MARK, PROPOSAL_ATTRIBUTE } from "../../src/core/api";
import { EDIT_INSTRUCTIONS } from "../../src/core/edits/prompt";
import { unbackedClaimLine } from "../../src/renderer/src/changeProblems";
import type { Translate } from "../../src/renderer/src/objects";
import { translate } from "../../src/shared/i18n";
import {
  pendingProposals,
  proposalRequestOf,
  recordProposalRequest,
  resolveProposals,
} from "../../src/shared/proposals";
import { askAssistant, changesIn, lastResult } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { heading, note, shownWithChanges, writeMind } from "../helpers/minds";
import {
  claimCheckReply,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

/**
 * Every turn in the assistant has the Minds' Tools, and the model decides
 * (#1559): through the core's public interface, a reply that claims a change
 * no call made is asked for once more and then flagged, and the requests the
 * calls make record what they were, for the changes that apply at once
 * (#880). The model's choices are scripted.
 */

const asked = ({ options }: ModelCall): string => {
  const last = options.prompt.filter((message) => message.role === "user").at(-1);
  if (!last) return "";
  return typeof last.content === "string"
    ? last.content
    : last.content.map((part) => ("text" in part ? part.text : "")).join("");
};

const called = (call: ModelCall, tool: string) => call.results.some((each) => each.tool === tool);

const editPassage = (call: ModelCall): string | null =>
  call.system === EDIT_INSTRUCTIONS
    ? (/<passage>\n([\s\S]*?)\n<\/passage>/.exec(call.prompt)?.[1] ?? null)
    : null;

const ASKED_AGAIN = "but no Tool did that";
const SUMMARY_PAGE = "## Summary\n\nThe paper is about spring tides.";
const MIND_TOOL_NAMES = ["read_mind", "edit_mind", "add_to_mind", "create_mind"];

async function setUp(model: MockLanguageModelV4) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const mind = await core.createMind({ title: "Q3 review" });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [
    heading(2, "Summary"),
    note("The quarter was very good, and sales were really strong."),
  ]);
  await client.settled();
  return { core, mind };
}

async function madeBy(core: Core, answer: Awaited<ReturnType<typeof askAssistant>>) {
  const made = changesIn(answer).find((change) => change.created);
  if (!made) throw new Error("The Answer made no Mind.");
  return connectToMind(core, made.mindId);
}

describe("Every turn has the write and edit commands (#1559)", { timeout: 30_000 }, () => {
  // protects=a Question, a request no keyword names and a request for a piece alike are offered the Minds' Tools, whatever the Question's language; fails_when=a turn goes without them; no_claim=that a real model chooses well, or what the prompt says.
  test.each([
    "how was the quarter?",
    "Could you shorten my summary?",
    "帮我写一份关于这个知识库的总结",
    "用 English 总结",
  ])("“%s” is offered them", async (text) => {
    const calls: ModelCall[] = [];
    const model = scriptedModel((call): ScriptedReply => {
      calls.push(call);
      return { text: "The quarter was good." };
    });
    const { core, mind } = await setUp(model);

    const answer = await askAssistant(core, { text, mindId: mind.id });

    expect(answer.text).toBe("The quarter was good.");
    expect(model.doStreamCalls).toHaveLength(1);
    expect(calls[0]?.tools).toEqual(expect.arrayContaining(MIND_TOOL_NAMES));
  });

  // protects=a request for a piece, answered by the model with a new Mind, makes it with its change tagged as written, so it applies at once; fails_when=the change waits as Proposals to accept; no_claim=that a real model calls create_mind.
  test("a piece the model writes into a new Mind applies at once", async () => {
    const model = scriptedModel(
      (call): ScriptedReply =>
        called(call, "create_mind")
          ? { text: "Wrote “Tide notes”." }
          : {
              calls: [
                { tool: "create_mind", input: { title: "Tide notes", content: SUMMARY_PAGE } },
              ],
            },
    );
    const { core, mind } = await setUp(model);

    const answer = await askAssistant(core, { text: "write a summary page", mindId: mind.id });

    const page = await madeBy(core, answer);
    await page.settled();
    expect(answer.text).toBe("Wrote “Tide notes”.");
    expect(answer.steps?.unbackedClaims).toBeUndefined();
    expect(proposalRequestOf(page.doc, changesIn(answer)[0]?.request ?? "")).toMatchObject({
      source: "answer-added",
      requested: "write",
    });
  });

  // protects=a piece written into the empty Mind in front says so on its change, for the panel's "Wrote it into" line; fails_when=the fill reads as an edit of the Mind; no_claim=none beyond protects.
  test("a piece written into the empty Mind in front is marked as filling it", async () => {
    const model = scriptedModel(
      (call): ScriptedReply =>
        called(call, "add_to_mind")
          ? { text: "Done." }
          : { calls: [{ tool: "add_to_mind", input: { content: SUMMARY_PAGE } }] },
    );
    const { core, mind } = await setUp(model);
    const empty = await core.createMind({ title: "" });

    const filled = await askAssistant(core, { text: "write a summary", mindId: empty.id });
    const added = await askAssistant(core, { text: "add a summary", mindId: mind.id });

    expect(changesIn(filled)[0]).toMatchObject({ mindId: empty.id, filled: true });
    expect(changesIn(added)[0]).not.toHaveProperty("filled");
  });
});

describe("A claim needs its command (#1559)", { timeout: 30_000 }, () => {
  // protects=a reply that claims a write no call made is checked, the model is asked once more with the record of what its calls did, and the write it then makes stands with its reply; fails_when=the final claim is unbacked, the model isn't asked again, or the second reply is flagged; no_claim=that a real model then writes.
  test("is asked for once more, and a write then made stands", async () => {
    const notes: string[] = [];
    const claim = "I've added a Summary section to “Q3 review”.";
    const model = scriptedModel(
      (call): ScriptedReply => {
        notes.push(asked(call));
        if (!asked(call).includes(ASKED_AGAIN)) return { text: claim };
        return called(call, "add_to_mind")
          ? { text: "Added a summary to “Q3 review”." }
          : { calls: [{ tool: "add_to_mind", input: { content: SUMMARY_PAGE } }] };
      },
      {
        generate: (call) =>
          claimCheckReply(call, (prompt) =>
            prompt.includes('"tool": "add_to_mind"') ? [] : [{ sentence: claim, kind: "added" }],
          ),
      },
    );
    const { core, mind } = await setUp(model);
    const shown: string[] = [];
    core.on("answer.delta", (event) => shown.push(event.text));

    const answer = await askAssistant(core, { text: "add a summary", mindId: mind.id });

    expect(notes[1]).toContain(ASKED_AGAIN);
    expect(shown.join("")).not.toContain("I've added");
    expect(answer.text).toBe("Added a summary to “Q3 review”.");
    expect(answer.steps?.unbackedClaims).toBeUndefined();
    expect(changesIn(answer)).toHaveLength(1);
  });

  // protects=still claiming after its one retry, the reply stays and the Answer records the claim, for the "Nothing was written" line under it, with no third ask; fails_when=the model is asked again, the reply is lost, or the claim isn't recorded; no_claim=how the line reads.
  test("still claimed after the one retry, the reply stays and the claim is recorded", async () => {
    const claim = "I've added a Summary section to “Q3 review”.";
    const model = scriptedModel((): ScriptedReply => ({ text: claim }), {
      generate: (call) => claimCheckReply(call, [{ sentence: claim, kind: "added" }]),
    });
    const { core, mind } = await setUp(model);

    const answer = await askAssistant(core, { text: "add a summary", mindId: mind.id });

    expect(model.doStreamCalls).toHaveLength(2);
    expect(answer.status).toBe("done");
    expect(answer.text).toBe("I've added a Summary section to “Q3 review”.");
    expect(answer.steps?.unbackedClaims).toEqual(["added"]);
    expect(changesIn(answer)).toEqual([]);
  });

  // protects=in Local mode the local quick model checks a claim and the reply still gets the line when it stays unbacked; fails_when=no local check runs, or the claim stands without the line; no_claim=that a cloud model is used.
  test("Local mode checks the claim with the local model", async () => {
    const claim = "I've added a Summary section to “Q3 review”.";
    const model = scriptedModel((): ScriptedReply => ({ text: claim }), {
      generate: (call) => claimCheckReply(call, [{ sentence: claim, kind: "added" }]),
    });
    const { core, mind } = await setUp(model);
    await core.setLocalOnly(true);

    const answer = await askAssistant(core, { text: "add a summary", mindId: mind.id });

    expect(answer.steps?.unbackedClaims).toEqual(["added"]);
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  // protects=the change-claim judge goes to the provider's quick-tasks model, not a second full Answer's model; fails_when=the quick model is never asked, or the claim isn't checked; no_claim=which provider the test uses.
  test("the quick-tasks model judges the reply", async () => {
    const claim = "I've added a Summary section to “Q3 review”.";
    const answering = scriptedModel(
      (call): ScriptedReply => ({
        text: call.prompt.includes(ASKED_AGAIN) ? "No section was added." : claim,
      }),
    );
    const quick = scriptedModel(() => ({ text: "" }), {
      generate: (call) => claimCheckReply(call, [{ sentence: claim, kind: "added" }]),
    });
    const core = startCore(await createTempDataFolder(), {
      createChatModel: (spec) => (spec.thinking === "off" ? quick : answering),
    });
    const saved = await core.saveChatProvider({
      kind: "anthropic",
      modelId: "claude-haiku-5-5",
      apiKey: "sk-ant-test",
    });
    if (saved.service) await core.allowDataFlow("chat", saved.service.id);
    const mind = await core.createMind({ title: "Q3 review" });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [heading(2, "Summary"), note("The quarter was very good.")]);
    await client.settled();

    const answer = await askAssistant(core, { text: "add a summary", mindId: mind.id });

    expect(quick.doGenerateCalls).toHaveLength(2);
    expect(answer.text).toBe("No section was added.");
    expect(answer.steps?.unbackedClaims).toBeUndefined();
  });

  // protects=a reply that names a fix its edit didn't make (the 2026-10-21 run's "Fix the typos in this") is asked for once more with the word left and its edit's record reading as applied, not waiting (#1559's review: told it waits, Haiku and Kimi told the User so), and the honest reply then stands; fails_when=the claim passes, the model isn't told which word, or the record says the edit waits; no_claim=that a real model then fixes it.
  test("a fix the edit didn't make is asked about, by the word left", async () => {
    const notes: string[] = [];
    const model = scriptedModel((call): ScriptedReply => {
      const passage = editPassage(call);
      if (passage !== null) return { text: passage.replace("visted", "visited") };
      notes.push(asked(call));
      if (!called(call, "edit_mind")) {
        return { calls: [{ tool: "edit_mind", input: { instruction: "Fix the typos" } }] };
      }
      return asked(call).includes("your edits left")
        ? { text: "Fixed “visted” in “Trip notes”." }
        : { text: "Fixed “visted” and “compleatly” in “Trip notes”." };
    });
    const { core } = await setUp(model);
    const trip = await core.createMind({ title: "Trip notes" });
    const client = await connectToMind(core, trip.id);
    writeMind(client, [note("We visted the harbour, and the tide went out compleatly.")]);
    await client.settled();

    const answer = await askAssistant(core, { text: "Fix the typos in this", mindId: trip.id });

    expect(notes.at(-1)).toContain("that you fixed “compleatly”, but your edits left it");
    expect(notes.at(-1)).toContain("proposed 1 change, applied in the Mind at once");
    expect(notes.at(-1)).not.toContain("waiting for the User");
    expect(answer.text).toBe("Fixed “visted” in “Trip notes”.");
    expect(answer.steps?.unbackedClaims).toBeUndefined();
  });

  // Value: protects=the claim record agrees with requested-only application; fails_when=an unrequested non-translation revision disables a translation's applied state; why_new=final review found the same boundary in appliedInTurn; seam=one public Answer with an unrequested revision and a destructive translation; no_claim=unrequested text itself applying (it is not part of the requested set)
  test("an unrequested revision does not make an applied translation read as waiting", async () => {
    const model = scriptedModel((call): ScriptedReply => {
      const passage = editPassage(call);
      if (passage !== null) return { text: "## Summary\n\nGood." };
      const edits = call.results.filter((each) => each.tool === "edit_mind").length;
      if (edits === 0) {
        return {
          calls: [
            {
              tool: "edit_mind",
              input: { part: "Added", content: "## Added\n\nRewritten text" },
            },
          ],
        };
      }
      if (edits === 1) {
        return {
          calls: [
            {
              tool: "edit_mind",
              input: { part: "Summary", instruction: "Translate into English" },
            },
          ],
        };
      }
      return { text: "Translated the summary." };
    });
    const { core, mind } = await setUp(model);
    const client = await connectToMind(core, mind.id);
    const proposal = (id: string) => ({ id, request: "old", kind: "insert" });
    client.blocks.insert(client.blocks.length, [
      createElement({
        type: "heading",
        attrs: { id: "old-heading", level: 2, [PROPOSAL_ATTRIBUTE]: proposal("old-heading") },
        content: [{ type: "text", text: "Added", marks: [{ type: GENERATED_MARK }] }],
      }),
      createElement({
        type: "paragraph",
        attrs: { id: "old-text", [PROPOSAL_ATTRIBUTE]: proposal("old-text") },
        content: [{ type: "text", text: "Unrequested text", marks: [{ type: GENERATED_MARK }] }],
      }),
    ]);
    recordProposalRequest(client.doc, "old", {
      source: "answer-added",
      instruction: "write",
      providerId: "local",
      modelId: "local",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await client.settled();

    const answer = await askAssistant(core, {
      text: "rewrite the added text and translate the summary",
      mindId: mind.id,
    });

    await client.settled();
    const changes = answer.toolCalls.flatMap((call) => (call.mindChange ? [call.mindChange] : []));
    const direct = changes[0];
    const translation = changes[1];
    if (!direct || !translation) throw new Error("The two revisions weren't recorded.");
    const requestedOf = (request: string) => {
      const made = proposalRequestOf(client.doc, request);
      return made && "requested" in made ? made.requested : undefined;
    };
    expect(requestedOf(direct.request)).toBeUndefined();
    expect(requestedOf(translation.request)).toBe("edit");
    const prompt = JSON.stringify(model.doGenerateCalls.map((call) => call.prompt));
    expect(prompt).toContain('\\"applied\\": true');
  });

  // protects=a request a Tool refused (no Mind open) isn't asked for again: the refusal is the answer; fails_when=the model is asked to write after it was told it can't; no_claim=none beyond protects.
  test("one a Tool refused isn't asked for again", async () => {
    const model = scriptedModel(
      ({ results }): ScriptedReply =>
        results.length === 0
          ? { calls: [{ tool: "add_to_mind", input: { content: "## Risks\n\nLate." } }] }
          : { text: "No Mind is open: open one, or ask for a new Mind." },
    );
    const { core } = await setUp(model);

    const answer = await askAssistant(core, { text: "add a risks section" });

    expect(answer.text).toBe("No Mind is open: open one, or ask for a new Mind.");
    expect(model.doStreamCalls).toHaveLength(2);
  });
});

describe("A plain Question never carries the write line (#2194)", { timeout: 30_000 }, () => {
  const en: Translate = (key, params) => translate("en", key, params);
  const zh: Translate = (key, params) => translate("zh-CN", key, params);
  const honest = ["I've sorted out what the Volunteer Handbook says.", "我整理了手册的要点。"];

  // protects=a judge that calls the sentence the reply's own text — as the small model did with these replies — leaves no unbackedClaims, no "Nothing was written" line, and no second ask, in English and Chinese; fails_when=a claim the judge does not call a change to a Mind is counted; no_claim=what a real judge answers now (the pull request's before and after runs).
  test.each(honest)("“%s” gets no line", async (reply) => {
    const model = scriptedModel((): ScriptedReply => ({ text: reply }), {
      generate: () => ({
        text: JSON.stringify({
          claims: [{ sentence: reply, kind: "added", about: "reply", backed: false }],
        }),
      }),
    });
    const { core, mind } = await setUp(model);

    const answer = await askAssistant(core, {
      text: "What does ‘Volunteer Handbook’ say?",
      mindId: mind.id,
    });

    expect(answer.text).toBe(reply);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(answer.steps?.unbackedClaims).toBeUndefined();
    expect(unbackedClaimLine(en, answer)).toBeNull();
    expect(unbackedClaimLine(zh, answer)).toBeNull();
  });

  // protects=a claim naming the Mind it changed is still asked about once and then spoken of under the Answer, so the catch is not lost; fails_when=the line goes missing for a real claim; no_claim=how a real model words the claim.
  test("a claim naming the Mind it changed still gets the line", async () => {
    const claim = "I've added a risks section to “Q3 review”.";
    const model = scriptedModel((): ScriptedReply => ({ text: claim }), {
      generate: (call) => claimCheckReply(call, [{ sentence: claim, kind: "added" }]),
    });
    const { core, mind } = await setUp(model);

    const answer = await askAssistant(core, { text: "add a risks section", mindId: mind.id });

    expect(model.doStreamCalls).toHaveLength(2);
    expect(answer.steps?.unbackedClaims).toEqual(["added"]);
    expect(unbackedClaimLine(en, answer)).toBe(
      "Nothing was written: the assistant didn’t run the write",
    );
    expect(unbackedClaimLine(zh, answer)).toBe("未写入任何内容：助手没有执行写入");
  });

  // protects=a judge that fails or returns nothing leaves no line under an honest Answer; fails_when=the failure is read as a claim; no_claim=none beyond protects.
  test("a failed judge leaves no line", async () => {
    const model = scriptedModel((): ScriptedReply => ({ text: "It says the tide rises." }), {
      generate: () => ({ error: { status: 500, message: "It failed." } }),
    });
    const { core, mind } = await setUp(model);

    const answer = await askAssistant(core, {
      text: "What does the paper say about tides?",
      mindId: mind.id,
    });

    expect(answer.steps?.unbackedClaims).toBeUndefined();
    expect(unbackedClaimLine(en, answer)).toBeNull();
  });
});

describe("What each change's request records", { timeout: 30_000 }, () => {
  // protects=the owner's two requests tag their changes by what they are: the new page "write", the edit of it "edit", and a revision of the page's text, still waiting, "edit" too; fails_when=a tag is missing or wrong; no_claim=how #880 applies them.
  test("a page made is tagged write, an edit of it edit, as is a revision of its waiting text", async () => {
    const model = scriptedModel((call): ScriptedReply => {
      const passage = editPassage(call);
      if (passage !== null) return { text: `${passage} It also covers neap tides.` };
      if (asked(call).endsWith("write a summary page")) {
        return called(call, "create_mind")
          ? { text: "It covers the paper." }
          : {
              calls: [
                { tool: "create_mind", input: { title: "Tide notes", content: SUMMARY_PAGE } },
              ],
            };
      }
      return called(call, "edit_mind")
        ? { text: "It says more now." }
        : {
            calls: [
              {
                tool: "edit_mind",
                input: { mind: "Tide notes", part: "Summary", instruction: "Make it longer" },
              },
            ],
          };
    });
    const { core, mind } = await setUp(model);
    const first = await askAssistant(core, { text: "write a summary page", mindId: mind.id });
    const page = await madeBy(core, first);
    await page.settled();
    const tagOf = (answer: Awaited<ReturnType<typeof askAssistant>>) =>
      proposalRequestOf(page.doc, changesIn(answer)[0]?.request ?? "");
    expect(tagOf(first)).toMatchObject({ requested: "write" });

    const revising = await askAssistant(core, {
      text: "make the summary section longer",
      mindId: mind.id,
      conversationId: first.conversationId,
    });
    await page.settled();
    expect(changesIn(revising)[0]).toMatchObject({ revised: true });
    expect(tagOf(revising)).toMatchObject({ requested: "edit" });

    page.doc.transact(() => resolveProposals(page.blocks, () => true, "accept"));
    await page.settled();
    expect(pendingProposals(page.blocks)).toEqual([]);
    const editing = await askAssistant(core, {
      text: "make the summary section longer",
      mindId: mind.id,
      conversationId: first.conversationId,
    });
    await page.settled();

    expect(changesIn(editing)[0]).not.toHaveProperty("revised");
    expect(tagOf(editing)).toMatchObject({ source: "edit-with-ai", requested: "edit" });
  });
});

describe("How each change is tagged, and what the model is told", { timeout: 30_000 }, () => {
  const results = (call: ModelCall) => call.results.map((each) => each.text);

  /** A model that makes `calls` once, keeping the results it read, and rewrites a passage as `rewrite` says. */
  function editing(calls: ScriptedReply, rewrite: (passage: string) => string) {
    const read: string[][] = [];
    const model = scriptedModel((call): ScriptedReply => {
      const passage = editPassage(call);
      if (passage !== null) return { text: rewrite(passage) };
      if (call.results.length > 0) {
        read.push(results(call));
        return { text: "Done." };
      }
      return calls;
    });
    return { model, read };
  }

  // protects=an edit is told as applied, and one that would take out most of the User's own text as waiting for them, so the reply says which; fails_when=the held rewrite is told it applied; no_claim=that a real model then words it so.
  test.each([
    ["adds to the paragraph", (passage: string) => `${passage} It also covers neap tides.`, true],
    ["rewrites the paragraph", () => "Revenue fell in every region.", false],
  ])("an edit that %s is told as applied: %s", async (_name, rewrite, applies) => {
    const { model, read } = editing(
      {
        calls: [
          { tool: "edit_mind", input: { part: "The quarter was", instruction: "Rewrite it" } },
        ],
      },
      rewrite,
    );
    const { core, mind } = await setUp(model);

    await askAssistant(core, { text: "rewrite my summary", mindId: mind.id });

    const [told] = read[0] ?? [];
    expect(told).toContain(applies ? "applies in the Mind at once" : "it waits there for them");
    expect(told).not.toContain(applies ? "waits there for them" : "applies in the Mind at once");
  });

  // protects=a change the assistant makes in a second Mind is tagged as the first is, so it applies and the panel names that Mind with Open and Undo; fails_when=the second Mind's change waits, untagged; no_claim=which Mind a real model changes first.
  test("a change in a second Mind applies too", async () => {
    const { model } = editing(
      {
        calls: [
          { tool: "edit_mind", input: { part: "The quarter was", instruction: "Tighten it" } },
          {
            tool: "edit_mind",
            input: { mind: "Q4 plan", instruction: "Tighten it" },
          },
        ],
      },
      (passage) => `${passage} More.`,
    );
    const { core, mind } = await setUp(model);
    const other = await core.createMind({ title: "Q4 plan" });
    const plan = await connectToMind(core, other.id);
    writeMind(plan, [note("Hire a designer before the spring.")]);
    await plan.settled();

    const answer = await askAssistant(core, { text: "tighten my summary", mindId: mind.id });

    await plan.settled();
    const [here, there] = changesIn(answer);
    const page = await connectToMind(core, mind.id);
    await page.settled();
    expect(proposalRequestOf(page.doc, here?.request ?? "")).toMatchObject({ requested: "edit" });
    expect(proposalRequestOf(plan.doc, there?.request ?? "")).toMatchObject({ requested: "edit" });
    expect(there?.mindId).toBe(other.id);
  });

  // protects=#1061's Chinese request to lengthen the summary, made with edit_mind, is tagged so it applies at once; fails_when=it isn't tagged; no_claim=what a real model writes.
  test("“把摘要写长一点。” edited is tagged", async () => {
    const { model } = editing(
      {
        calls: [{ tool: "edit_mind", input: { part: "The quarter was", instruction: "写长一点" } }],
      },
      (passage) => `${passage} Margins held.`,
    );
    const { core, mind } = await setUp(model);

    const answer = await askAssistant(core, { text: "把摘要写长一点。", mindId: mind.id });

    const page = await connectToMind(core, mind.id);
    await page.settled();
    const [changed] = changesIn(answer);
    expect(proposalRequestOf(page.doc, changed?.request ?? "")).toMatchObject({
      requested: "edit",
    });
  });

  // protects=a section added and a rewrite of the User's text made alongside it are each tagged by what they are, so both apply; fails_when=either waits untagged; no_claim=that a real model makes both calls.
  test("a section added and a rewrite alongside it both apply", async () => {
    const { model } = editing(
      {
        calls: [
          { tool: "add_to_mind", input: { content: "## Risks\n\nThe supplier is late." } },
          { tool: "edit_mind", input: { part: "The quarter was", instruction: "Make it longer" } },
        ],
      },
      (passage) => `${passage} Margins held.`,
    );
    const { core, mind } = await setUp(model);

    const answer = await askAssistant(core, { text: "add a risks section", mindId: mind.id });

    const page = await connectToMind(core, mind.id);
    await page.settled();
    const [added, rewritten] = changesIn(answer);
    expect(proposalRequestOf(page.doc, added?.request ?? "")).toMatchObject({ requested: "write" });
    expect(proposalRequestOf(page.doc, rewritten?.request ?? "")).toMatchObject({
      requested: "edit",
    });
  });
});

describe("A second copy", { timeout: 30_000 }, () => {
  const RISKS = [
    "## Risks",
    "The supplier of the main part is three weeks late, and nobody has told us why.",
    "The courier who takes the parts to the plant has raised its prices twice this year.",
  ].join("\n\n");

  // protects=adding again a section the assistant wrote and that still waits is refused, the Mind keeps one, and the model is told to revise it with edit_mind, as it streams in and as it ends; fails_when=a second copy is written, or the model isn't told how to revise; no_claim=that a real model then revises.
  test.each([false, true])(
    "of its own waiting section is refused, streamed: %s",
    async (streamed) => {
      const model = scriptedModel((call): ScriptedReply => {
        if (call.results.some((each) => each.tool === "add_to_mind")) return { text: "Done." };
        const longer = asked(call).includes("write more about the risks");
        return {
          calls: [
            {
              tool: "add_to_mind",
              input: { content: longer ? `${RISKS}\n\nThe courier is late too.` : RISKS },
              streamInput: streamed,
            },
          ],
        };
      });
      const { core, mind } = await setUp(model);
      const client = await connectToMind(core, mind.id);
      const first = await askAssistant(core, { text: "add a risks section", mindId: mind.id });

      const second = await askAssistant(core, {
        text: "write more about the risks",
        mindId: mind.id,
        conversationId: first.conversationId,
      });

      await client.settled();
      expect(shownWithChanges(client).filter((line) => line.includes("Risks"))).toEqual([
        "+ Risks",
      ]);
      const [refused] = second.toolCalls.filter((call) => call.tool === "add_to_mind");
      expect(refused).toMatchObject({
        status: "failed",
        mindProblem: { kind: "copy", mindId: mind.id, text: "Risks" },
      });
      expect(lastResult(model)).toContain("Revise it with edit_mind");
    },
  );

  // protects=a second summary goes in beside the first though they share headings, short fixed lines, and "not covered" lines under different headings, as the summarise Skill writes them; fails_when=it is refused as a second copy; no_claim=none beyond protects.
  test("isn't a second summary that shares headings, short lines, and long lines under other headings with the first", async () => {
    const summary = (name: string, claim: string) =>
      [
        `## ${name}`,
        "### Key claims",
        `${name} claims that ${claim}, in every harbour it measured over two years.`,
        "### Methods",
        "The Passages found don't describe the methods.",
        `### ${name === "Paper A" ? "Limitations" : "Open questions"}`,
        "The Passages found don't say how the tide was measured or over how many harbours.",
        "Nor do they say which years the measurements cover, or who took them.",
        "Not reported.",
        "Not reported.",
      ].join("\n\n");
    const model = scriptedModel((call): ScriptedReply => {
      if (called(call, "add_to_mind")) return { text: "Done." };
      const content = asked(call).includes("Paper B")
        ? summary("Paper B", "the tide falls faster in winter")
        : summary("Paper A", "the tide rises faster at new moon");
      return { calls: [{ tool: "add_to_mind", input: { content } }] };
    });
    const { core, mind } = await setUp(model);
    const client = await connectToMind(core, mind.id);
    const first = await askAssistant(core, { text: "add a summary of Paper A", mindId: mind.id });

    const second = await askAssistant(core, {
      text: "add a summary of Paper B",
      mindId: mind.id,
      conversationId: first.conversationId,
    });

    await client.settled();
    expect(second.toolCalls.find((call) => call.tool === "add_to_mind")).toMatchObject({
      status: "done",
    });
    const shown = shownWithChanges(client);
    expect(shown.filter((line) => line === "+ Key claims")).toHaveLength(2);
    expect(shown.filter((line) => line === "+ Not reported.")).toHaveLength(4);
  });
});
