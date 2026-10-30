import type { JSONContent } from "@tiptap/core";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import { pendingProposals } from "../../src/shared/proposals";
import {
  answerRequests,
  askAssistant,
  changesIn,
  lastResult,
  mindCalls,
} from "../helpers/assistant";
import { checkReply, isCheckRun } from "../helpers/checks";
import { answerEnded, shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { createSourceFolder, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { heading, note, readMind, shownWithChanges, writeMind } from "../helpers/minds";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

/**
 * The assistant changes Minds and makes them (#202), through the core's
 * public interface as the assistant asks: what the User types decides whether
 * the Answer answers, changes a Mind or makes one, and every change arrives
 * in its Mind as Proposals, after a Checkpoint of it. The model's choices are
 * scripted here; real models' are checked by hand and in
 * tests/live/assistantChangesMinds.live.test.ts.
 */

/** A model that calls one Minds' Tool first, then replies with `reply`; edits drop "very" and "really". */
function toolModel(call: { tool: string; input: Record<string, unknown> } | null, reply: string) {
  return scriptedModel(
    (model: ModelCall): ScriptedReply =>
      shortened(model) ??
      (call && model.results.length === 0 ? { calls: [call] } : { text: reply }),
  );
}

/** Edit with AI's reply, to the request edit_mind makes: the passage with its "very"s and "really"s taken out. */
function shortened({ prompt }: ModelCall): ScriptedReply | null {
  const passage = /<passage>\n([\s\S]*?)\n<\/passage>/.exec(prompt)?.[1];
  return passage === undefined ? null : { text: passage.replace(/\b(?:very|really) /g, "") };
}

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
  return { core, mind, client };
}

const ask = askAssistant;

async function checkpointsOf(core: Core, mindId: string) {
  return (await core.listCheckpoints(mindId)).checkpoints;
}

describe("The assistant changes Minds as Proposals", { timeout: 30_000 }, () => {
  // protects=a change request edits the Mind in focus as Proposals, after a Checkpoint, and its card says so; fails_when=the Mind changes outright, no Checkpoint is saved first, or the card doesn't name the Mind; no_claim=how well a real model rewrites.
  test("a change request proposes changes in the Mind in focus, after a Checkpoint", async () => {
    const model = toolModel(
      { tool: "edit_mind", input: { instruction: "Shorten it" } },
      "Shortened the summary in “Q3 review”: dropped two fillers.",
    );
    const { core, mind, client } = await setUp(model);
    expect(await checkpointsOf(core, mind.id)).toHaveLength(0);

    const answer = await ask(core, { text: "Shorten the summary", mindId: mind.id });

    await client.settled();
    expect(shownWithChanges(client)).toEqual([
      "Summary",
      "The quarter was [-very -]good, and sales were [-really -]strong.",
    ]);
    const [checkpoint] = await checkpointsOf(core, mind.id);
    expect(checkpoint?.reason).toBe("accept");
    expect(changesIn(answer)).toEqual([
      { mindId: mind.id, created: false, request: expect.any(String), proposals: 2, changed: 1 },
    ]);
    expect(mindCalls(answer)[0]?.status).toBe("done");
    expect(answer.text).toBe("Shortened the summary in “Q3 review”: dropped two fillers.");
    expect(lastResult(model)).toMatch(/^Changed 2 places in “Q3 review” \(from 11 to 9 words\)/);
  });

  // protects=a rewrite that is no shorter is reported that way to the model, with no keyword reading of the instruction; fails_when=the result says only the same count and lets a reply call it shortened; no_claim=whether the model heeds the result.
  test("a rewrite of the same length is reported as not shorter", async () => {
    const model = scriptedModel((call: ModelCall): ScriptedReply => {
      if (call.prompt.includes("<passage>")) {
        return { text: "The quarter was quite good, and revenue was truly very robust." };
      }
      return call.results.length === 0
        ? { calls: [{ tool: "edit_mind", input: { part: "Summary", instruction: "Shorten it" } }] }
        : { text: "Shortened the summary." };
    });
    const { core, mind } = await setUp(model);

    await ask(core, { text: "Shorten the summary", mindId: mind.id });

    expect(lastResult(model)).toContain("from 11 to 11 words, not shorter");
  });

  // protects=edit_mind's rewrite is asked of the Answer's model with thinking off, as its quick calls are: a rewrite as asked needs no reasoning first, and Kimi K2.6 thought for a minute on one (#1635); fails_when=the rewrite goes to the Answer's thinking model; no_claim=how well a real model rewrites without thinking, which the everyday evaluation measures.
  test("edit_mind's rewrite is asked of the Answer's model with thinking off", async () => {
    const answering = toolModel(
      { tool: "edit_mind", input: { instruction: "Shorten it" } },
      "Shortened the summary.",
    );
    const quick = scriptedModel(
      (call: ModelCall): ScriptedReply => shortened(call) ?? { text: "" },
    );
    const core = startCore(await createTempDataFolder(), {
      createChatModel: (spec) => (spec.thinking === "off" ? quick : answering),
    });
    // A model on a service: Ollama's thinking is its own settings', not the request's.
    const saved = await core.saveChatProvider({
      kind: "anthropic",
      modelId: "claude-haiku-5-5",
      apiKey: "sk-ant-test",
    });
    if (saved.service) await core.allowDataFlow("chat", saved.service.id);
    const mind = await core.createMind({ title: "Q3 review" });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [note("The quarter was very good, and sales were really strong.")]);
    await client.settled();

    await ask(core, { text: "Shorten the summary", mindId: mind.id });

    await client.settled();
    expect(shownWithChanges(client)).toEqual([
      "The quarter was [-very -]good, and sales were [-really -]strong.",
    ]);
    const rewrites = (model: MockLanguageModelV4) =>
      model.doStreamCalls.filter((call) => JSON.stringify(call.prompt).includes("<passage>"));
    expect(rewrites(quick)).toHaveLength(1);
    expect(rewrites(answering)).toHaveLength(0);
  });

  // protects=when the Answer's model can't be asked to skip thinking, edit_mind's rewrite goes to it as it thinks, the edit is still proposed, and the log names the model (#1635); fails_when=the edit fails, or the fallback is silent; no_claim=which models can't skip thinking.
  test("a rewrite whose model can't skip thinking is made as it thinks, and the log says so", async () => {
    const answering = toolModel(
      { tool: "edit_mind", input: { instruction: "Shorten it" } },
      "Shortened the summary.",
    );
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const core = startCore(await createTempDataFolder(), {
        createChatModel: (spec) => {
          if (spec.thinking === "off") throw new Error("This model always thinks.");
          return answering;
        },
      });
      const saved = await core.saveChatProvider({
        kind: "anthropic",
        modelId: "claude-haiku-5-5",
        apiKey: "sk-ant-test",
      });
      if (saved.service) await core.allowDataFlow("chat", saved.service.id);
      const mind = await core.createMind({ title: "Q3 review" });
      const client = await connectToMind(core, mind.id);
      writeMind(client, [note("The quarter was very good, and sales were really strong.")]);
      await client.settled();

      await ask(core, { text: "Shorten the summary", mindId: mind.id });

      await client.settled();
      expect(shownWithChanges(client)).toEqual([
        "The quarter was [-very -]good, and sales were [-really -]strong.",
      ]);
      expect(
        answering.doStreamCalls.filter((call) => JSON.stringify(call.prompt).includes("<passage>")),
      ).toHaveLength(1);
      expect(
        warned.mock.calls.some((call) => String(call[0]).includes("anthropic/claude-haiku-5-5")),
      ).toBe(true);
    } finally {
      warned.mockRestore();
    }
  });

  // protects=a Question is answered and changes nothing, though the Minds' Tools are offered; fails_when=the Mind or its Checkpoints change; no_claim=that a real model never edits on a Question.
  test("a Question is answered and changes no Mind", async () => {
    const model = toolModel(null, "The quarter was good.");
    const { core, mind, client } = await setUp(model);
    const before = JSON.stringify(client.blocks.toJSON());

    const answer = await ask(core, { text: "How was the quarter?", mindId: mind.id });

    expect(model.doStreamCalls[0]?.tools?.map((each) => each.name)).toEqual(
      expect.arrayContaining(["read_mind", "edit_mind", "add_to_mind", "create_mind"]),
    );
    expect(answer.text).toBe("The quarter was good.");
    expect(mindCalls(answer)).toEqual([]);
    await client.settled();
    expect(JSON.stringify(client.blocks.toJSON())).toBe(before);
    expect(await checkpointsOf(core, mind.id)).toHaveLength(0);
  });

  // protects=a write request naming another Mind adds to that Mind, not the one in focus; fails_when=the focused Mind changes, or the named one gets no Proposals or Checkpoint; no_claim=none beyond protects.
  test("a write request adds to the Mind it names, under the section it names", async () => {
    const model = toolModel(
      {
        tool: "add_to_mind",
        input: {
          mind: "Project plan",
          // As <mind> shows it, with its Markdown mark.
          after: "## Decisions",
          content: "Ship the beta in May.",
        },
      },
      "Added today's decision to “Project plan”.",
    );
    const { core, mind, client } = await setUp(model);
    const plan = await core.createMind({ title: "Project plan" });
    const planClient = await connectToMind(core, plan.id);
    writeMind(planClient, [
      heading(2, "Decisions"),
      note("Hire a designer."),
      heading(2, "Risks"),
      note("The supplier is late."),
    ]);
    await planClient.settled();

    const answer = await ask(core, {
      text: "Add today's decision to Project plan",
      mindId: mind.id,
    });

    await planClient.settled();
    expect(shownWithChanges(planClient)).toEqual([
      "Decisions",
      "Hire a designer.",
      "+ Ship the beta in May.",
      "Risks",
      "The supplier is late.",
    ]);
    expect(pendingProposals(client.blocks)).toEqual([]);
    expect(await checkpointsOf(core, plan.id)).toHaveLength(1);
    expect(await checkpointsOf(core, mind.id)).toHaveLength(0);
    expect(changesIn(answer)).toEqual([
      {
        mindId: plan.id,
        created: false,
        request: expect.any(String),
        proposals: 1,
        paragraphs: 1,
      },
    ]);
  });

  // protects=a request for a new note makes a Mind in the Search scope's Folder, its draft as Proposals with checked Citations; fails_when=the Mind is made elsewhere, its text is accepted outright, or a Citation isn't checked; no_claim=how a real model drafts.
  test("a request for a new note makes a Mind in the Folder, its draft as changes with checked Citations", async () => {
    const SPRING = "Spring tides happen just after a new moon or a full moon.";
    const model = scriptedModel(({ results }): ScriptedReply => {
      const search = results.find((result) => result.tool === "search_documents");
      if (!search) {
        return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
      }
      if (!results.some((result) => result.tool === "cite")) {
        const [passage] = shownPassages(search.text);
        const record = { marker: 1, passage: passage?.id, pageFrom: 1, pageTo: 1, quote: SPRING };
        return { calls: [{ tool: "cite", input: { citations: [record] } }] };
      }
      if (!results.some((result) => result.tool === "create_mind")) {
        const content = "## Tides\n\nSpring tides come at new and full moon [^1].";
        return { calls: [{ tool: "create_mind", input: { title: "Tide notes", content } }] };
      }
      return { text: "Made “Tide notes” from your Documents." };
    });
    const { core, mind } = await setUp(model);
    const folder = await core.createLibraryGroup({ name: "Coast", description: "" });
    const sources = await createSourceFolder();
    const pdf = buildPdf([{ lines: ["Spring and neap tides", SPRING] }]);
    const added = await core.addDocuments([await writeSourceFile(sources, "Tides.pdf", pdf)], {
      groupId: folder.id,
    });
    await waitForProcessing(
      core,
      added.documents.map((document) => document.id),
    );

    const answer = await ask(core, {
      text: "Summarise these Documents into a new note",
      mindId: mind.id,
      scope: { folderIds: [folder.id], tagIds: [], documentIds: [] },
    });

    const [change] = changesIn(answer);
    expect(change).toMatchObject({ created: true, proposals: 2 });
    const made = (await core.listMinds()).find((each) => each.id === change?.mindId);
    expect(made).toMatchObject({ title: "Tide notes", folderId: folder.id });
    const madeClient = await connectToMind(core, change?.mindId ?? "");
    expect(shownWithChanges(madeClient)).toEqual([
      "+ Tides",
      "+ Spring tides come at new and full moon ⟨found⟩.",
    ]);
  });

  // protects=a Mind the assistant makes starts with its title as a Heading 1, written with the Mind and not a change to accept, and a draft that begins with a heading of its own gets no second one (#908, the owner's résumé summary); fails_when=the title is missing, waits as a change, or shows twice; no_claim=how a real model titles a page.
  test("a new note starts with its title as a heading, once, whatever the level of a heading the model began with", async () => {
    const pages = [
      { title: "Tide notes", content: "Spring tides come at new moon." },
      { title: "张瑜简历总结", content: "# 张瑜简历总结\n\n教育背景。" },
      { title: "工作经历", content: "## 工作经历\n\n2019 年至今。" },
    ];
    const model = scriptedModel(({ results }): ScriptedReply => {
      const page = pages[results.filter((result) => result.tool === "create_mind").length];
      return page ? { calls: [{ tool: "create_mind", input: page }] } : { text: "Made both." };
    });
    const { core, mind } = await setUp(model);
    const answer = await ask(core, { text: "Make two notes", mindId: mind.id });

    const [tides, resume, work] = changesIn(answer);
    expect(tides).toMatchObject({ created: true, proposals: 1 });
    const tidesPage = readMind(await connectToMind(core, tides?.mindId ?? ""));
    expect(tidesPage.firstChild?.toJSON()).toEqual({
      type: "heading",
      attrs: expect.objectContaining({ level: 1 }),
      // The title is the assistant's own text, so a later rewrite of the Note's text can keep it (#1898).
      content: [{ type: "text", text: "Tide notes", marks: [{ type: "generated" }] }],
    });
    const resumeClient = await connectToMind(core, resume?.mindId ?? "");
    expect(shownWithChanges(resumeClient)).toEqual(["+ 张瑜简历总结", "+ 教育背景。"]);
    expect(readMind(resumeClient).firstChild?.attrs.level).toBe(1);
    // A heading of any level the model began with is its title: no second one above it.
    const workClient = await connectToMind(core, work?.mindId ?? "");
    expect(shownWithChanges(workClient)).toEqual(["+ 工作经历", "+ 2019 年至今。"]);
  });

  // protects=a Mind the User names that doesn't exist, or no Mind at all, changes nothing and the model is told why; fails_when=another Mind is changed, or the call says it worked; no_claim=how the model words it.
  test("a Mind that isn't there, or none in focus, changes nothing and says why", async () => {
    const named = toolModel(
      { tool: "edit_mind", input: { mind: "Chapter 9", instruction: "Shorten it" } },
      "There is no note called Chapter 9.",
    );
    const { core, mind, client } = await setUp(named);
    const answer = await ask(core, { text: "Shorten Chapter 9", mindId: mind.id });
    expect(mindCalls(answer)[0]?.status).toBe("failed");
    expect(lastResult(named)).toContain("The User has no note called “Chapter 9”.");
    expect(lastResult(named)).toContain("“Q3 review”");
    expect(pendingProposals(client.blocks)).toEqual([]);

    const none = toolModel(
      { tool: "edit_mind", input: { instruction: "Shorten it" } },
      "No Note is open.",
    );
    const other = await setUp(none);
    const unfocused = await ask(other.core, { text: "Shorten the summary" });
    expect(mindCalls(unfocused)[0]?.status).toBe("failed");
    expect(lastResult(none)).toContain("No Note is open beside the assistant");
    expect(pendingProposals(other.client.blocks)).toEqual([]);
    expect(await checkpointsOf(other.core, other.mind.id)).toHaveLength(0);
  });

  // protects=what the User selected is what edit_mind changes when no section is named; fails_when=the rest of the Mind is rewritten too; no_claim=none beyond protects.
  test("with text selected, the change is to the selected paragraphs only", async () => {
    const model = toolModel(
      { tool: "edit_mind", input: { instruction: "Shorten it" } },
      "Shortened the selected paragraph.",
    );
    const { core, mind, client } = await setUp(model);
    writeMind(client, [
      note("Very first, really."),
      note("The quarter was very good, and sales were really strong."),
    ]);
    await client.settled();
    const selected = blockIdAt(client, 1);

    await ask(core, {
      text: "Shorten this",
      mindId: mind.id,
      focus: { selection: "The quarter was very good", blockIds: [selected] },
    });

    await client.settled();
    expect(shownWithChanges(client)).toEqual([
      "Very first, really.",
      "The quarter was [-very -]good, and sales were [-really -]strong.",
    ]);
  });
});

describe("Written again", { timeout: 30_000 }, () => {
  // protects=Regenerate on an Answer that changed Minds takes back what still waits from it first, so nothing is proposed twice and a Mind it made, still empty of the User's words, goes; fails_when=the changes double, or the first new Mind stays beside the second; no_claim=what the User has accepted, which stays.
  test("regenerating takes back its changes still waiting, and the Mind it made", async () => {
    const model = scriptedModel(
      (call): ScriptedReply =>
        shortened(call) ??
        (call.results.length === 0
          ? {
              calls: [
                { tool: "edit_mind", input: { instruction: "Shorten it" } },
                { tool: "create_mind", input: { title: "Notes", content: "One line." } },
              ],
            }
          : { text: "Done." }),
    );
    const { core, mind, client } = await setUp(model);
    const first = await ask(core, { text: "Shorten it and make notes", mindId: mind.id });
    const made = changesIn(first).find((change) => change.created)?.mindId;
    await client.settled();
    expect(pendingProposals(client.blocks)).toHaveLength(2);

    const result = await core.regenerateConversationAnswer({
      conversationId: first.conversationId,
      answerId: first.id,
    });
    if (!result.asked) throw new Error("Not asked again.");
    await answerEnded(core, result.answerId);

    await client.settled();
    expect(pendingProposals(client.blocks)).toHaveLength(2);
    expect(shownWithChanges(client)).toEqual([
      "Summary",
      "The quarter was [-very -]good, and sales were [-really -]strong.",
    ]);
    const notes = (await core.listMinds()).filter((each) => each.title === "Notes");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.id).not.toBe(made);
  });
});

describe("A Search scope with no Documents", { timeout: 30_000 }, () => {
  // protects=a request to change a Mind in a Folder with no Documents still changes it, and the model is told the scope is empty; fails_when=the canned empty-scope Answer comes instead, or search is offered; no_claim=what a real model says to a Question there.
  test("a Mind in a Folder with no Documents can still be changed, and the model knows the scope is empty", async () => {
    const model = toolModel(
      { tool: "edit_mind", input: { instruction: "Shorten it" } },
      "Shortened the summary.",
    );
    const { core, mind, client } = await setUp(model);
    const folder = await core.createLibraryGroup({ name: "Empty", description: "" });

    const answer = await ask(core, {
      text: "Shorten the summary",
      mindId: mind.id,
      scope: { folderIds: [folder.id], tagIds: [], documentIds: [] },
    });

    expect(answer.text).toBe("Shortened the summary.");
    expect(answer.model).not.toBeNull();
    const [first] = model.doStreamCalls;
    expect(first?.tools?.map((each) => each.name)).not.toContain("search_documents");
    expect(JSON.stringify(first?.prompt)).toContain(
      "holds no Documents, so there is nothing to search",
    );
    await client.settled();
    expect(pendingProposals(client.blocks).length).toBe(2);
  });
});

describe("The Minds' Tools find what the model names", { timeout: 30_000 }, () => {
  // protects=edit_mind with a section's heading changes that section only, to the next heading as high; fails_when=the rest of the Mind is rewritten, or a lower heading ends the section; no_claim=none beyond protects.
  test("a section named by its heading is what changes", async () => {
    const model = toolModel(
      { tool: "edit_mind", input: { part: "risks", instruction: "Shorten it" } },
      "Shortened the risks.",
    );
    const { core, mind, client } = await setUp(model);
    writeMind(client, [
      heading(2, "Summary"),
      note("Sales were really strong."),
      heading(2, "Risks"),
      note("The supplier is very late."),
      heading(3, "Mitigation"),
      note("We are really looking."),
      heading(2, "Next"),
      note("Really soon."),
    ]);
    await client.settled();

    await ask(core, { text: "Shorten the risks", mindId: mind.id });

    await client.settled();
    expect(shownWithChanges(client)).toEqual([
      "Summary",
      "Sales were really strong.",
      "Risks",
      "The supplier is [-very -]late.",
      "Mitigation",
      "We are [-really -]looking.",
      "Next",
      "Really soon.",
    ]);
  });

  // protects=edit_mind with a paragraph's first words changes that paragraph only, even with the whole Mind selected; fails_when=the others are rewritten too; no_claim=that a model names it.
  test("a paragraph named by its first words is all that changes, the whole Mind selected", async () => {
    const model = toolModel(
      {
        tool: "edit_mind",
        input: { part: "Margins were really thin", instruction: "Make it more formal" },
      },
      "Done.",
    );
    const { core, mind, client } = await setUp(model);
    writeMind(client, [
      note("Sales were really strong."),
      note("Margins were really thin in the north."),
      note("Hiring was very slow."),
    ]);
    await client.settled();
    const all = [0, 1, 2].map((index) => blockIdAt(client, index));

    await ask(core, {
      text: "Make the second paragraph more formal",
      mindId: mind.id,
      focus: { selection: "everything", blockIds: all },
    });

    await client.settled();
    expect(shownWithChanges(client)).toEqual([
      "Sales were really strong.",
      "Margins were [-really -]thin in the north.",
      "Hiring was very slow.",
    ]);
  });

  // protects=the model's chosen stretch, never a pattern over the request, decides what changes; fails_when=an ordinal narrows edit_mind after the model chose the whole selection; no_claim=which stretch a real model chooses.
  test.each([
    "Make the second paragraph more formal and leave the others as they are",
    "把第二段改得更正式，其他段落保持不变",
    "Tighten the last paragraph",
  ])("“%s” leaves the stretch to the model", async (text) => {
    const model = toolModel({ tool: "edit_mind", input: { instruction: "Rewrite it" } }, "Done.");
    const { core, mind, client } = await setUp(model);
    const lines = [
      "Sales were really strong.",
      "Margins were really thin in the north.",
      "Hiring was very slow.",
    ];
    writeMind(
      client,
      lines.map((line) => note(line)),
    );
    await client.settled();
    const all = [0, 1, 2].map((index) => blockIdAt(client, index));

    await ask(core, { text, mindId: mind.id, focus: { selection: "everything", blockIds: all } });

    await client.settled();
    const shown = shownWithChanges(client);
    expect(shown).toHaveLength(3);
    for (const line of shown) expect(line).toContain("[-");
  });

  // protects=a request that leaves the named paragraph alone, or reaches past it, isn't narrowed to it; fails_when=only that paragraph is rewritten, the opposite of what was asked; no_claim=what a real model then changes.
  test.each([
    "Shorten everything but the second paragraph",
    "Don't change the second paragraph, shorten the rest",
    "第二段不要改，其他的缩短",
    "Make the whole thing more formal, especially the second paragraph",
  ])("“%s” isn't narrowed to that paragraph", async (text) => {
    const model = toolModel({ tool: "edit_mind", input: { instruction: "Shorten it" } }, "Done.");
    const { core, mind, client } = await setUp(model);
    writeMind(client, [note("Sales were really strong."), note("Margins were really thin.")]);
    await client.settled();

    await ask(core, { text, mindId: mind.id });

    await client.settled();
    expect(shownWithChanges(client)[0]).toBe("Sales were [-really -]strong.");
  });

  // protects=a section named as <mind> shows it, marks and all, is found; fails_when=the call is refused for no such heading; no_claim=none beyond protects.
  test.each(["### [waiting change, adds: Risks]", "## **Risks**"])(
    "a section named “%s” is what changes",
    async (part) => {
      const model = toolModel(
        { tool: "edit_mind", input: { part, instruction: "Shorten it" } },
        "Done.",
      );
      const { core, mind, client } = await setUp(model);
      writeMind(client, [
        heading(2, "Summary"),
        note("Sales were really strong."),
        heading(2, "Risks"),
        note("The supplier is very late."),
      ]);
      await client.settled();

      await ask(core, { text: "Shorten the risks", mindId: mind.id });

      await client.settled();
      expect(shownWithChanges(client)).toEqual([
        "Summary",
        "Sales were really strong.",
        "Risks",
        "The supplier is [-very -]late.",
      ]);
    },
  );

  // protects=a paragraph named by a few Chinese first words is all that changes; fails_when=the call is refused or the other paragraphs change; no_claim=none beyond protects.
  test("a paragraph named by its first Chinese words changes alone", async () => {
    const model = toolModel(
      { tool: "edit_mind", input: { part: "团队里有两个人请假", instruction: "Shorten it" } },
      "Done.",
    );
    const { core, mind, client } = await setUp(model);
    writeMind(client, [
      note("Sales were really strong."),
      note("Margins were really thin."),
      note("团队里有两个人请假，进度 really 很慢。"),
    ]);
    await client.settled();

    await ask(core, { text: "把第三段缩短", mindId: mind.id });

    await client.settled();
    const shown = shownWithChanges(client);
    expect(shown.slice(0, 2)).toEqual(["Sales were really strong.", "Margins were really thin."]);
    expect(shown[2]).toContain("[-really -]");
  });

  // protects=the model is told which sentences are no longer in the text, so what it says was removed is what was; fails_when=the result names none, or names a sentence that stays; no_claim=how the model words its reply.
  test("an edit's result names the sentences that are no longer in the text", async () => {
    const model = scriptedModel((call: ModelCall): ScriptedReply => {
      const passage = /<passage>\n([\s\S]*?)\n<\/passage>/.exec(call.prompt)?.[1];
      if (passage !== undefined) {
        return {
          text: `${passage.replace("Work is full time. ", "")}\n<why>Removed the hours.</why>`,
        };
      }
      return call.results.length === 0
        ? { calls: [{ tool: "edit_mind", input: { instruction: "Remove the part about hours" } }] }
        : { text: "Done." };
    });
    const { core, mind, client } = await setUp(model);
    writeMind(client, [note("Pay is monthly. Work is full time. The post is senior.")]);
    await client.settled();

    await ask(core, { text: "Remove the part about the hours", mindId: mind.id });

    const told = lastResult(model);
    expect(told).toContain(
      "no longer in the text as they were (taken out or reworded): “Work is full time.”",
    );
    expect(told).not.toContain("“Pay is monthly.”");
  });

  // protects=the result names what the Mind really lost, not what the rewrite left out: a paragraph the reply drops stays unless the request asks to remove it, and the model isn't told it went; fails_when=the result lists a paragraph that is still there, or leaves out one that went; no_claim=how the model words its reply.
  test.each([
    {
      asked: "Make it shorter",
      stays: true,
      notes: ["Pay is monthly.", "Work is full time, Monday to Friday."],
    },
    {
      asked: "删去整个“工作安排”部分，其他部分保持不变。",
      stays: false,
      notes: ["薪酬按月发放。", "全职，周一至周五上班。"],
    },
  ])(
    "a paragraph the reply leaves out is told as gone only when it went: $asked",
    async ({ asked, stays, notes }) => {
      const model = scriptedModel((call: ModelCall): ScriptedReply => {
        const passage = /<passage>\n([\s\S]*?)\n<\/passage>/.exec(call.prompt)?.[1];
        if (passage !== undefined) {
          return { text: `${passage.split("\n\n")[0]} Noted.\n<why>Done.</why>` };
        }
        return call.results.length === 0
          ? { calls: [{ tool: "edit_mind", input: { instruction: asked } }] }
          : { text: "Done." };
      });
      const { core, mind, client } = await setUp(model);
      writeMind(client, [note(notes[0] as string), note(notes[1] as string)]);
      await client.settled();

      await ask(core, { text: asked, mindId: mind.id });

      await client.settled();
      const told = lastResult(model);
      expect(told).toContain(
        stays ? "they are still in the text" : "no longer in the text as they were",
      );
      expect(told).toContain(`“${notes[1]}”`);
      expect(told).not.toContain(
        stays ? "no longer in the text as they were" : "they are still in the text",
      );
      expect(shownWithChanges(client).join(" ").includes(`- ${notes[1]}`)).toBe(!stays);
    },
  );

  // protects=a rewrite that answers with no text and a comment, for a request that doesn't ask to remove, is a failure whose result says the text is as it was; fails_when=the model is left with the comment alone and repeats "already removed"; no_claim=how the model words its reply.
  test("a rewrite's comment with no text is reported as nothing changed, whatever it says", async () => {
    const model = scriptedModel((call: ModelCall): ScriptedReply => {
      if (/<passage>/.test(call.prompt))
        return { text: "<why>The section was already removed.</why>" };
      return call.results.length === 0
        ? { calls: [{ tool: "edit_mind", input: { instruction: "Tidy the section" } }] }
        : { text: "Done." };
    });
    const { core, mind, client } = await setUp(model);
    writeMind(client, [note("Pay is monthly."), note("Work is full time.")]);
    await client.settled();
    const before = shownWithChanges(client);

    await ask(core, { text: "Tidy it", mindId: mind.id });

    await client.settled();
    expect(shownWithChanges(client)).toEqual(before);
    expect(lastResult(model)).toContain("The section was already removed.");
    expect(lastResult(model)).toContain(
      "the text is as it was: don't say it was changed, removed or already done",
    );
  });

  // protects=a section the Mind doesn't have is refused with the Mind's headings, so the model can name one on its next call; fails_when=the refusal gives no headings, or something is changed; no_claim=that a real model then names one.
  test("a section the Mind doesn't have is refused with the Mind's own headings", async () => {
    const model = toolModel(
      { tool: "edit_mind", input: { part: "Hours.", instruction: "Remove it" } },
      "Done.",
    );
    const { core, mind, client } = await setUp(model);
    writeMind(client, [
      heading(2, "Role"),
      note("The post is senior."),
      heading(2, "Working pattern"),
      note("Full time."),
    ]);
    await client.settled();
    const before = shownWithChanges(client);

    await ask(core, { text: "Remove the part about the hours", mindId: mind.id });

    await client.settled();
    expect(shownWithChanges(client)).toEqual(before);
    expect(lastResult(model)).toContain("its headings are “Role”, “Working pattern”");
  });

  // protects=a wrong start is refused instead of the request's ordinal overriding the model; fails_when=the paragraph the pattern guessed is edited anyway; no_claim=that a real model chooses a wrong start.
  test("a wrong start does not fall back to the paragraph the request names", async () => {
    const model = toolModel(
      { tool: "edit_mind", input: { part: "Nothing starts like this", instruction: "Shorten it" } },
      "Done.",
    );
    const { core, mind, client } = await setUp(model);
    writeMind(client, [
      note("Sales were really strong."),
      note("Margins were really thin."),
      note("团队里有两个人请假，进度 really 很慢。"),
    ]);
    await client.settled();
    const before = shownWithChanges(client);

    const answer = await ask(core, { text: "Shorten the third paragraph", mindId: mind.id });

    await client.settled();
    expect(shownWithChanges(client)).toEqual(before);
    expect(mindCalls(answer)[0]).toMatchObject({
      status: "failed",
      mindProblem: { kind: "no-heading", mindId: mind.id, heading: "Nothing starts like this" },
    });
    expect(lastResult(model)).toContain("The request may mean paragraph 3.");
  });

  // protects=the User's own first-person words are written as given, whatever they say of finding or looking; fails_when=they are taken for the assistant's talk of searching and left out; no_claim=none beyond protects.
  test("“Add to my notes: I found three issues…” writes that sentence", async () => {
    const sentence = "I found three issues in the lease, and I looked at the break clause twice.";
    const model = toolModel({ tool: "add_to_mind", input: { content: sentence } }, "Added.");
    const { core, mind, client } = await setUp(model);

    await ask(core, { text: `Add to my notes: ${sentence}`, mindId: mind.id });

    await client.settled();
    expect(shownWithChanges(client)).toContain(`+ ${sentence}`);
  });

  // protects=read_mind gives another Mind's text, as the Mind in focus is read; fails_when=the model gets nothing, or the wrong Mind; no_claim=none beyond protects.
  test("read_mind gives the Mind the User names", async () => {
    const model = toolModel({ tool: "read_mind", input: { mind: "“project PLAN”" } }, "Read it.");
    const { core, mind } = await setUp(model);
    const plan = await core.createMind({ title: "Project plan" });
    const planClient = await connectToMind(core, plan.id);
    writeMind(planClient, [heading(2, "Decisions"), note("Hire a designer.")]);
    await planClient.settled();

    await ask(core, { text: "What does the project plan decide?", mindId: mind.id });

    expect(lastResult(model)).toBe(
      ['<mind name="Project plan">', "## Decisions", "", "Hire a designer.", "</mind>"].join("\n"),
    );
  });
});

const blockIdAt = (client: MindClient, index: number): string => {
  const block = client.blocks.get(index);
  const id = "getAttribute" in block ? block.getAttribute("id") : undefined;
  if (typeof id !== "string") throw new Error("That Block has no id.");
  return id;
};

describe("New Blocks come in as the model writes them", { timeout: 30_000 }, () => {
  const CONTENT = "## Risks\n\nThe supplier is late.\n\nThe courier contract renews in February.";

  /** A model that adds CONTENT, its input streamed, held back from "courier" on until `until`. */
  function streamingAdd(until: Promise<void>) {
    const after = JSON.stringify({ content: CONTENT }).indexOf("courier");
    return scriptedModel(
      ({ results }): ScriptedReply =>
        results.length === 0
          ? {
              calls: [{ tool: "add_to_mind", input: { content: CONTENT }, streamInput: true }],
              pause: { after, until },
            }
          : { text: "Added a risks section." },
    );
  }

  /** Each "mind.writing" event, in order, as they come: whether it is writing. */
  const writingEvents = (core: Core) => {
    const seen: { writing: boolean }[] = [];
    core.on("mind.writing", ({ place }) => seen.push({ writing: place !== null }));
    return seen;
  };

  // protects=each Block the model finishes goes into the Mind as a change while the rest is still being written, with "Writing…" where the next goes, and all of them once it ends, none twice; fails_when=nothing shows until the call ends, a Block is written twice, or Writing… stays; no_claim=how a real provider chunks its input.
  test("finished Blocks are in the Mind while the rest is written, then all of them, once each", async () => {
    let release: () => void = () => undefined;
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { core, mind, client } = await setUp(streamingAdd(until));
    const seen = writingEvents(core);
    const asked = await core.askInConversation({ text: "Add a risks section", mindId: mind.id });
    if (!asked.asked) throw new Error("Not asked.");

    await expect
      .poll(() => shownWithChanges(client), { timeout: 10_000 })
      .toEqual([
        "Summary",
        "The quarter was very good, and sales were really strong.",
        "+ Risks",
        "+ The supplier is late.",
      ]);
    expect(seen.at(-1)?.writing).toBe(true);
    // The card says so while the call is still being written.
    const stored = async () => {
      const { messages } = await core.getConversation(asked.conversation.id);
      const answer = messages.find((message) => message.id === asked.answerId);
      return answer?.kind === "answer" ? changesIn(answer) : [];
    };
    await expect.poll(stored).toEqual([
      {
        mindId: mind.id,
        created: false,
        request: expect.any(String),
        proposals: 2,
        paragraphs: 1,
      },
    ]);

    release();
    expect((await answerEnded(core, asked.answerId)).event).toBe("finished");
    await client.settled();
    expect(shownWithChanges(client)).toEqual([
      "Summary",
      "The quarter was very good, and sales were really strong.",
      "+ Risks",
      "+ The supplier is late.",
      "+ The courier contract renews in February.",
    ]);
    expect(seen.at(-1)?.writing).toBe(false);
    expect(await checkpointsOf(core, mind.id)).toHaveLength(1);
  });

  // protects=a call that names another Mind writes its Blocks there as they come, never first into the Mind in focus; fails_when=Blocks show in the focused Mind, even for a moment; no_claim=a model that names the Mind after its content.
  test("a call naming another Mind writes there as it comes, never into the Mind in focus", async () => {
    const input = { mind: "Project plan", content: CONTENT };
    const after = JSON.stringify(input).indexOf("courier");
    const { core, mind, client } = await setUp(
      scriptedModel(
        ({ results }): ScriptedReply =>
          results.length === 0
            ? {
                calls: [{ tool: "add_to_mind", input, streamInput: true }],
                pause: { after, until: new Promise(() => undefined) },
              }
            : { text: "Added." },
        { chunkSize: 4 },
      ),
    );
    const plan = await core.createMind({ title: "Project plan" });
    const planClient = await connectToMind(core, plan.id);
    let focusedChanged = false;
    client.blocks.observeDeep(() => {
      if (pendingProposals(client.blocks).length > 0) focusedChanged = true;
    });

    const asked = await core.askInConversation({
      text: "Add risks to Project plan",
      mindId: mind.id,
    });
    if (!asked.asked) throw new Error("Not asked.");
    await expect
      .poll(() => shownWithChanges(planClient), { timeout: 10_000 })
      .toEqual(["+ Risks", "+ The supplier is late."]);
    expect(focusedChanged).toBe(false);
    await core.stopConversationAnswer({
      conversationId: asked.conversation.id,
      answerId: asked.answerId,
    });
  });

  // protects=a model that writes its content before naming the Mind gets its Blocks taken back from the Mind in focus and written into the one it named, once each, with nothing left behind; fails_when=a streamed Block stays in the focused Mind, or one is written twice; no_claim=how long the take-back shows.
  test("content written before the Mind is named is taken back from the Mind in focus and goes to the one named", async () => {
    // Content first, then the Mind: against the schema's order, as a model may write it.
    const input = { content: CONTENT, mind: "Project plan" };
    const { core, mind, client } = await setUp(
      scriptedModel(
        ({ results }): ScriptedReply =>
          results.length === 0
            ? { calls: [{ tool: "add_to_mind", input, streamInput: true }] }
            : { text: "Added." },
        { chunkSize: 4 },
      ),
    );
    const plan = await core.createMind({ title: "Project plan" });
    const planClient = await connectToMind(core, plan.id);
    let streamedHere = false;
    client.blocks.observeDeep(() => {
      if (pendingProposals(client.blocks).length > 0) streamedHere = true;
    });

    const asked = await core.askInConversation({ text: "Add risks", mindId: mind.id });
    if (!asked.asked) throw new Error("Not asked.");
    expect((await answerEnded(core, asked.answerId)).event).toBe("finished");
    await client.settled();
    await planClient.settled();

    expect(streamedHere).toBe(true);
    expect(shownWithChanges(client)).toEqual([
      "Summary",
      "The quarter was very good, and sales were really strong.",
    ]);
    expect(pendingProposals(client.blocks)).toEqual([]);
    expect(shownWithChanges(planClient)).toEqual([
      "+ Risks",
      "+ The supplier is late.",
      "+ The courier contract renews in February.",
    ]);
  });

  // protects=Stop while the model writes keeps the Blocks already written, as changes, on the Answer's card, and Writing… goes; fails_when=they vanish, or the card has no row for them; no_claim=none beyond protects.
  test("Stop keeps the Blocks already written, as changes on the card", async () => {
    const { core, mind, client } = await setUp(streamingAdd(new Promise(() => undefined)));
    const seen = writingEvents(core);
    const asked = await core.askInConversation({ text: "Add a risks section", mindId: mind.id });
    if (!asked.asked) throw new Error("Not asked.");
    await expect.poll(() => pendingProposals(client.blocks).length, { timeout: 10_000 }).toBe(2);

    await core.stopConversationAnswer({
      conversationId: asked.conversation.id,
      answerId: asked.answerId,
    });
    await client.settled();
    expect(pendingProposals(client.blocks)).toHaveLength(2);
    expect(seen.at(-1)?.writing).toBe(false);
    const { messages } = await core.getConversation(asked.conversation.id);
    const stopped = messages.find((message) => message.id === asked.answerId);
    if (stopped?.kind !== "answer") throw new Error("No Answer.");
    expect(changesIn(stopped)).toEqual([
      {
        mindId: mind.id,
        created: false,
        request: expect.any(String),
        proposals: 2,
        paragraphs: 1,
      },
    ]);
  });
});

describe("A name that fits several places asks which one", { timeout: 30_000 }, () => {
  const PART_1 = "Part one was very good, and sales were really strong.";
  const PART_2 = "Part two was very late, and the courier was really slow.";
  const TWO_SUMMARIES = () => [
    heading(1, "Part 1"),
    heading(2, "Summary"),
    note(PART_1),
    heading(1, "Part 2"),
    heading(2, "Summary"),
    note(PART_2),
  ];
  const ASKS_WHICH =
    "There are 2 headings called “Summary”: under “Part 1” and under “Part 2”. Which one?";

  async function withBlocks(model: MockLanguageModelV4, blocks: JSONContent[]) {
    const set = await setUp(model);
    writeMind(set.client, blocks);
    await set.client.settled();
    return set;
  }

  /** The Mind still reads as it was, and nothing waits or was saved. */
  async function expectUntouched(
    { core, mind, client }: Awaited<ReturnType<typeof setUp>>,
    shown: string[],
  ) {
    await client.settled();
    expect(shownWithChanges(client)).toEqual(shown);
    expect(pendingProposals(client.blocks)).toEqual([]);
    expect(await checkpointsOf(core, mind.id)).toHaveLength(0);
  }

  // protects=a section name on two headings changes nothing and the model is told to ask, naming both places; fails_when=the first heading is changed, or the places aren't named by their parent headings; no_claim=how a real model words the question.
  test("edit_mind on two headings called Summary changes nothing and names both places", async () => {
    const model = toolModel(
      { tool: "edit_mind", input: { part: "Summary", instruction: "Shorten it" } },
      "There are two. Which one?",
    );
    const set = await withBlocks(model, TWO_SUMMARIES());

    const answer = await ask(set.core, { text: "Make the Summary shorter", mindId: set.mind.id });

    expect(mindCalls(answer)[0]?.status).toBe("failed");
    expect(mindCalls(answer)[0]?.mindProblem).toEqual({
      kind: "several-places",
      mindId: set.mind.id,
      name: "Summary",
      adding: false,
    });
    expect(changesIn(answer)).toEqual([]);
    expect(lastResult(model)).toContain(`"${ASKS_WHICH}"`);
    expect(lastResult(model)).toContain(`as in part: "Part 1 > Summary"`);
    expect(model.doStreamCalls).toHaveLength(2);
    await expectUntouched(set, ["Part 1", "Summary", PART_1, "Part 2", "Summary", PART_2]);
  });

  // protects=naming the parent heading picks one of two same-named headings; fails_when=the other section changes, or the first is changed because it comes first; no_claim=none beyond protects.
  test("edit_mind on Part 2 > Summary changes that section only", async () => {
    const model = toolModel(
      { tool: "edit_mind", input: { part: "Part 2 > Summary", instruction: "Shorten it" } },
      "Shortened the summary under Part 2.",
    );
    const set = await withBlocks(model, TWO_SUMMARIES());

    const answer = await ask(set.core, {
      text: "Make the Summary under Part 2 shorter",
      mindId: set.mind.id,
    });

    await set.client.settled();
    expect(mindCalls(answer)[0]?.status).toBe("done");
    expect(shownWithChanges(set.client)).toEqual([
      "Part 1",
      "Summary",
      PART_1,
      "Part 2",
      "Summary",
      "Part two was [-very -]late, and the courier was [-really -]slow.",
    ]);
  });

  // protects=the headings a name is under are matched like any name, whole text first: "Chapter 1" is not "Chapter 10", the quotes round each heading are dropped, and a start under the named parent counts though a whole name sits elsewhere; fails_when=a section under Chapter 10 is changed for Chapter 1, the quoted path isn't found, or "Part 2 > Summary" fails because Part 2 holds only "Summary of Q3"; no_claim=none beyond protects.
  test.each([
    {
      what: "Chapter 1 is not Chapter 10",
      part: "Chapter 1 > Notes",
      blocks: [
        heading(1, "Chapter 1"),
        heading(2, "Notes"),
        note("One was very short."),
        heading(1, "Chapter 10"),
        heading(2, "Notes"),
        note("Ten was very long."),
      ],
      shown: [
        "Chapter 1",
        "Notes",
        "One was [-very -]short.",
        "Chapter 10",
        "Notes",
        "Ten was very long.",
      ],
    },
    {
      what: "quotes round each heading",
      part: "“Part 2” > “Summary”",
      blocks: TWO_SUMMARIES(),
      shown: [
        "Part 1",
        "Summary",
        PART_1,
        "Part 2",
        "Summary",
        "Part two was [-very -]late, and the courier was [-really -]slow.",
      ],
    },
    {
      what: "a start under the named parent, a whole name elsewhere",
      part: "Part 2 > Summary",
      blocks: [
        heading(1, "Part 1"),
        heading(2, "Summary"),
        note("One was very short."),
        heading(1, "Part 2"),
        heading(2, "Summary of Q3"),
        note("Two was very long."),
      ],
      shown: [
        "Part 1",
        "Summary",
        "One was very short.",
        "Part 2",
        "Summary of Q3",
        "Two was [-very -]long.",
      ],
    },
  ])("a path to a section: $what", async ({ part, blocks, shown }) => {
    const model = toolModel(
      { tool: "edit_mind", input: { part, instruction: "Shorten it" } },
      "Shortened it.",
    );
    const set = await withBlocks(model, blocks);

    const answer = await ask(set.core, { text: "Shorten that section", mindId: set.mind.id });

    await set.client.settled();
    expect(mindCalls(answer)[0]?.status).toBe("done");
    expect(shownWithChanges(set.client)).toEqual(shown);
  });

  // protects=the question echoes the heading's own case, not the model's; fails_when=a heading typed in lower case is asked about in lower case; no_claim=none beyond protects.
  test("the question names the heading as written in the Mind", async () => {
    const model = toolModel(
      { tool: "edit_mind", input: { part: "summary", instruction: "Shorten it" } },
      "Which one?",
    );
    const set = await withBlocks(model, TWO_SUMMARIES());

    await ask(set.core, { text: "Make the summary shorter", mindId: set.mind.id });

    expect(lastResult(model)).toContain(`"${ASKS_WHICH}"`);
    expect(lastResult(model)).toContain(`as in part: "Part 1 > Summary"`);
  });

  // protects=a name on one heading behaves as before: the whole text wins over a start, and a start is enough alone; fails_when=either case asks which, or changes another section; no_claim=none beyond protects.
  test.each(["summary", "Summary of"])("a single match is changed as before (%s)", async (part) => {
    const model = toolModel(
      { tool: "edit_mind", input: { part, instruction: "Shorten it" } },
      "Shortened it.",
    );
    const set = await withBlocks(model, [
      heading(2, "Summary of risks"),
      note("Risk one is very small."),
      heading(2, "Summary"),
      note("Sales were really strong."),
    ]);

    await ask(set.core, { text: "Shorten the summary", mindId: set.mind.id });

    await set.client.settled();
    const [risks, risksText, summary, summaryText] = shownWithChanges(set.client);
    expect([risks, summary]).toEqual(["Summary of risks", "Summary"]);
    if (part === "summary") {
      expect([risksText, summaryText]).toEqual([
        "Risk one is very small.",
        "Sales were [-really -]strong.",
      ]);
    } else {
      expect([risksText, summaryText]).toEqual([
        "Risk one is [-very -]small.",
        "Sales were really strong.",
      ]);
    }
  });

  // protects=places with the same parent, or none, are told apart by number, and the model is told what the User can do; fails_when=two places are both named "under" one heading, or a number can't be told from another; no_claim=none beyond protects.
  test("places that no parent heading tells apart are numbered", async () => {
    const model = toolModel(
      { tool: "edit_mind", input: { part: "Notes", instruction: "Shorten it" } },
      "Which one?",
    );
    const set = await withBlocks(model, [
      heading(1, "Notes"),
      note("Note one."),
      heading(1, "Notes"),
      note("Note two."),
    ]);

    await ask(set.core, { text: "Shorten the notes", mindId: set.mind.id });

    expect(lastResult(model)).toContain(
      '"There are 2 headings called “Notes”: number 1 and number 2. Which one?"',
    );
    expect(lastResult(model)).toContain("select the one they mean in the Note");
    await expectUntouched(set, ["Notes", "Note one.", "Notes", "Note two."]);
  });

  // protects=every place is listed, however many; fails_when=a place is left out of the question; no_claim=none beyond protects.
  test("three places are all named", async () => {
    const model = toolModel(
      { tool: "edit_mind", input: { part: "## Summary", instruction: "Shorten it" } },
      "Which one?",
    );
    const set = await withBlocks(model, [
      ...[1, 2, 3].flatMap((part) => [heading(1, `Part ${part}`), heading(2, "Summary")]),
      note("Text."),
    ]);

    await ask(set.core, { text: "Shorten the summary", mindId: set.mind.id });

    expect(lastResult(model)).toContain(
      "There are 3 headings called “Summary”: under “Part 1”, under “Part 2”, and under “Part 3”. Which one?",
    );
  });

  // protects=add_to_mind on a heading name found twice adds nothing, however the call is written, and the Answer goes on to ask; fails_when=text is added after the first, or the Answer fails while its input streams in; no_claim=none beyond protects.
  test.each([
    ["in one piece", false],
    ["streamed in", true],
  ])(
    "add_to_mind after two headings called Summary adds nothing (%s)",
    async (_how, streamInput) => {
      const model = scriptedModel(
        ({ results }): ScriptedReply =>
          results.length === 0
            ? {
                calls: [
                  {
                    tool: "add_to_mind",
                    input: { after: "Summary", content: "A new line.\n\nAnother new line." },
                    streamInput,
                  },
                ],
              }
            : { text: "Which one?" },
      );
      const set = await withBlocks(model, TWO_SUMMARIES());

      const answer = await ask(set.core, {
        text: "Add a line to the Summary",
        mindId: set.mind.id,
      });

      expect(mindCalls(answer)[0]?.status).toBe("failed");
      expect(mindCalls(answer)[0]?.mindProblem).toMatchObject({
        kind: "several-places",
        adding: true,
      });
      expect(lastResult(model)).toContain(`"${ASKS_WHICH}"`);
      expect(lastResult(model)).toContain(`as in after: "Part 1 > Summary"`);
      await expectUntouched(set, ["Part 1", "Summary", PART_1, "Part 2", "Summary", PART_2]);
    },
  );

  // protects=naming the parent heading adds at the end of that section; fails_when=the text goes after the first Summary; no_claim=none beyond protects.
  test("add_to_mind after Part 2 > Summary adds at the end of that section", async () => {
    const model = toolModel(
      { tool: "add_to_mind", input: { after: "Part 2 > Summary", content: "A new line." } },
      "Added it.",
    );
    const set = await withBlocks(model, TWO_SUMMARIES());

    await ask(set.core, { text: "Add a line to the Summary under Part 2", mindId: set.mind.id });

    await set.client.settled();
    expect(shownWithChanges(set.client)).toEqual([
      "Part 1",
      "Summary",
      PART_1,
      "Part 2",
      "Summary",
      PART_2,
      "+ A new line.",
    ]);
  });

  // protects=a paragraph named by its first words, found under two headings, is asked about like a heading, and its parent picks one; fails_when=the first paragraph is chosen without asking, or the parent doesn't pick; no_claim=none beyond protects.
  test("two paragraphs starting alike are asked about, and a parent heading picks one", async () => {
    const blocks = [
      heading(1, "Part 1"),
      note("Revenue grew in the north."),
      heading(1, "Part 2"),
      note("Revenue grew in the south."),
      note("Costs fell."),
    ];
    const asks = toolModel(
      { tool: "add_to_mind", input: { after: "Revenue grew", content: "A new line." } },
      "Which one?",
    );
    const first = await withBlocks(asks, blocks);

    await ask(first.core, {
      text: "Add a line after the revenue paragraph",
      mindId: first.mind.id,
    });

    expect(lastResult(asks)).toContain(
      '"There are 2 paragraphs starting “Revenue grew”: under “Part 1” and under “Part 2”. Which one?"',
    );
    await expectUntouched(first, [
      "Part 1",
      "Revenue grew in the north.",
      "Part 2",
      "Revenue grew in the south.",
      "Costs fell.",
    ]);

    const picks = toolModel(
      { tool: "add_to_mind", input: { after: "Part 2 > Revenue grew", content: "A new line." } },
      "Added it.",
    );
    const second = await withBlocks(picks, blocks);

    await ask(second.core, {
      text: "Add a line after the revenue paragraph",
      mindId: second.mind.id,
    });

    await second.client.settled();
    expect(shownWithChanges(second.client)).toEqual([
      "Part 1",
      "Revenue grew in the north.",
      "Part 2",
      "Revenue grew in the south.",
      "+ A new line.",
      "Costs fell.",
    ]);
  });

  // protects=a Question in Chinese is answered in Chinese's words for the places, and Chinese headings are told apart the same way; fails_when=the question is English, or the Chinese headings aren't found; no_claim=how a real model words it.
  test("Chinese headings: the question is in Chinese, and the parent heading picks one", async () => {
    const blocks = [
      heading(1, "第一部分"),
      heading(2, "摘要"),
      note("第一部分：销售 really 强劲。"),
      heading(1, "第二部分"),
      heading(2, "摘要"),
      note("第二部分：销售 really 强劲。"),
    ];
    const asks = toolModel(
      { tool: "edit_mind", input: { part: "摘要", instruction: "改短一点" } },
      "有两个。",
    );
    const first = await withBlocks(asks, blocks);

    await ask(first.core, { text: "把摘要改短一点", mindId: first.mind.id });

    expect(lastResult(asks)).toContain(
      "有 2 个标题叫“摘要”：在“第一部分”下和在“第二部分”下。要改哪一个？",
    );
    await expectUntouched(first, [
      "第一部分",
      "摘要",
      "第一部分：销售 really 强劲。",
      "第二部分",
      "摘要",
      "第二部分：销售 really 强劲。",
    ]);

    const picks = toolModel(
      { tool: "edit_mind", input: { part: "第二部分 > 摘要", instruction: "改短一点" } },
      "已改短。",
    );
    const second = await withBlocks(picks, blocks);

    await ask(second.core, { text: "把第二部分的摘要改短一点", mindId: second.mind.id });

    await second.client.settled();
    expect(shownWithChanges(second.client)).toEqual([
      "第一部分",
      "摘要",
      "第一部分：销售 really 强劲。",
      "第二部分",
      "摘要",
      "第二部分：销售 [-really -]强劲。",
    ]);
  });
});

describe("Arguments a model gets slightly wrong cost no extra step", { timeout: 30_000 }, () => {
  const SPRING = "Spring tides happen just after a new moon or a full moon.";

  // protects=cite takes its records as one record alone, or as an array written in JSON, even encoded twice, in the model's very next step; fails_when=the model has to send it again, or the Citation isn't checked; no_claim=what a real model sends.
  test.each([
    ["one record alone", (record: object) => record],
    ["an array written in JSON", (record: object) => JSON.stringify([record])],
    ["an array encoded twice", (record: object) => JSON.stringify(JSON.stringify([record]))],
  ])("cite given %s", async (_how, wrap) => {
    const model = scriptedModel((call): ScriptedReply => {
      if (isCheckRun(call)) return checkReply(call, {});
      const { results } = call;
      const search = results.find((result) => result.tool === "search_documents");
      if (!search)
        return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
      if (!results.some((result) => result.tool === "cite")) {
        const [passage] = shownPassages(search.text);
        const record = { marker: 1, passage: passage?.id, pageFrom: 1, pageTo: 1, quote: SPRING };
        return { calls: [{ tool: "cite", input: { citations: wrap(record) } }] };
      }
      if (!results.some((result) => result.tool === "create_mind")) {
        const content = "## Tides\n\nSpring tides come at new and full moon [^1].";
        return { calls: [{ tool: "create_mind", input: { title: "Tide notes", content } }] };
      }
      return { text: "Made “Tide notes”." };
    });
    const { core, mind } = await setUp(model);
    const sources = await createSourceFolder();
    const pdf = buildPdf([{ lines: ["Spring and neap tides", SPRING] }]);
    const added = await core.addDocuments([await writeSourceFile(sources, "Tides.pdf", pdf)]);
    await waitForProcessing(
      core,
      added.documents.map((document) => document.id),
    );

    const answer = await ask(core, {
      text: "Summarise these Documents into a new note",
      mindId: mind.id,
    });

    expect(answerRequests(model)).toHaveLength(4);
    const [change] = changesIn(answer);
    const madeClient = await connectToMind(core, change?.mindId ?? "");
    expect(shownWithChanges(madeClient)).toEqual([
      "+ Tides",
      "+ Spring tides come at new and full moon ⟨found⟩.",
    ]);
  });
});
