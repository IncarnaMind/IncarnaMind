import { getSchema } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { decideAll } from "../../eval/minds/state";
import { BLOCK_ID_ATTRIBUTE, type ConversationAnswer, type Core } from "../../src/core";
import { EDIT_INSTRUCTIONS } from "../../src/core/edits/prompt";
import { changedMinds } from "../../src/renderer/src/changedMinds";
import { writeAccepted } from "../../src/renderer/src/editor/arrivedChanges";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { resolveInEditor } from "../../src/renderer/src/editor/proposalReview";
import { allOrigins } from "../../src/shared/blockOrigins";
import { pendingProposals } from "../../src/shared/proposals";
import { askAssistant } from "../helpers/assistant";
import { answerEnded } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { boundEditor } from "../helpers/editor";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { heading, note, shownWithChanges, writeMind } from "../helpers/minds";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

/**
 * The assistant makes a new Mind and revises its own text there in the same
 * Answer, as Claude Haiku 5.5 did in the Minds evaluation: two read_mind calls,
 * a cite the app refuses beside create_mind, so its markers stay unrecorded,
 * then edit_mind with the whole text again. Its card counts that text once.
 * Then the User takes the Answer back or keeps it: on its card (with the
 * card's functions, as the Minds evaluation applies them), on the Mind's own
 * bar, applied at once as asked, or with Regenerate.
 */

const BRIEF = "Launch brief";
const MARKED =
  "# Launch brief\n\n## Milestones\n\n- The beta starts on 2 February, with the Nordic pilot group.[^1]\n- The launch is on 1 March.[^2]\n\n## Decisions\n\n- Hire a part-time designer.[^3]\n";
const UNMARKED = MARKED.replace(/\[\^\d\]/g, "");
const LONGER = UNMARKED.replace("1 March.", "1 March, in every region.");

/** Two Minds and a Document in the Library, asked from Home, on a script. */
async function setUp(script: (call: ModelCall) => ScriptedReply) {
  const model = scriptedModel(script);
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const sources = await createSourceFolder();
  const contract = "# Supplier contract\n\nIt runs for two years.\n";
  await addAndProcess(core, [await writeSourceFile(sources, "Supplier contract.md", contract)]);
  const seeds = {
    "Project plan": [
      heading(2, "Milestones"),
      note("The beta starts on 2 February, with the Nordic pilot group."),
      note("The launch is on 1 March."),
    ],
    "Meeting notes": [heading(2, "Decisions"), note("Hire a part-time designer.")],
  };
  for (const [title, blocks] of Object.entries(seeds)) {
    const mind = await core.createMind({ title });
    const client = await connectToMind(core, mind.id);
    writeMind(client, blocks);
    await client.settled();
  }
  return core;
}

const ran = (call: ModelCall, tool: string) =>
  call.results.filter((result) => result.tool === tool).length;

/** The calls of the evaluation's run, then edit_mind with each of `revisions` as `content`, then the reply. */
function madeThenRevised(revisions: readonly string[]) {
  return (call: ModelCall): ScriptedReply => {
    if (ran(call, "read_mind") === 0) {
      return {
        calls: [
          { tool: "read_mind", input: { mind: "Project plan" } },
          { tool: "read_mind", input: { mind: "Meeting notes" } },
        ],
      };
    }
    if (ran(call, "create_mind") === 0) {
      const record = (marker: number, passage: string, quote: string) => ({
        marker,
        passage,
        location: "§ Milestones",
        quote,
      });
      const citations = [
        record(1, "Project plan", "The beta starts on 2 February."),
        record(2, "Project plan", "The launch is on 1 March."),
        record(3, "Meeting notes", "Hire a part-time designer."),
      ];
      return {
        calls: [
          { tool: "cite", input: { citations } },
          { tool: "create_mind", input: { title: BRIEF, content: MARKED } },
        ],
      };
    }
    const content = revisions[ran(call, "edit_mind")];
    return content === undefined
      ? { text: "Made “Launch brief” with the milestones and the decision." }
      : { calls: [{ tool: "edit_mind", input: { mind: BRIEF, content } }] };
  };
}

const ASKED = { text: "Make a new note called Launch brief from the plan and the notes" };

const madeIn = (answer: ConversationAnswer) =>
  changedMinds(answer).find((row) => row.created)?.mindId ?? "";

/** A Mind as the User sees it, its waiting changes marked; null once it is gone. */
async function shown(core: Core, mindId: string): Promise<string[] | null> {
  if (!(await core.listMinds()).some((mind) => mind.id === mindId)) return null;
  return shownWithChanges(await connectToMind(core, mindId));
}

/** The origin of each Block in a Mind, as the Answer it names. */
const originsOf = (client: MindClient) => {
  const origins = allOrigins(client.doc);
  return client.blocks
    .toArray()
    .flatMap((block) =>
      block instanceof Y.XmlElement ? [String(block.getAttribute(BLOCK_ID_ATTRIBUTE))] : [],
    )
    .map((blockId) => JSON.stringify(origins.get(blockId)?.from ?? null));
};

/** How many changes wait in every Mind there. */
async function waitingAnywhere(core: Core): Promise<number> {
  let waiting = 0;
  for (const mind of await core.listMinds()) {
    waiting += pendingProposals((await connectToMind(core, mind.id)).blocks).length;
  }
  return waiting;
}

describe("A new Mind the assistant revised in the same Answer", { timeout: 30_000 }, () => {
  // protects=Reject all on the card takes back a Mind the Answer made and then revised, leaving nothing waiting, and Undo brings it back with the revised text waiting; fails_when=the Mind stays with create_mind's text waiting, or Undo brings back something else; no_claim=how often a real model revises its own new Mind.
  test("Reject all removes it, nothing waits, and Undo brings it back as it was", async () => {
    const core = await setUp(madeThenRevised([UNMARKED]));
    const answer = await askAssistant(core, ASKED);
    const mindId = madeIn(answer);
    const before = await shown(core, mindId);
    const waiting = await waitingAnywhere(core);
    expect(before).toContain("The launch is on 1 March.");

    const rejected = await decideAll(core, changedMinds(answer), "reject");

    expect(await shown(core, mindId)).toBeNull();
    expect(await waitingAnywhere(core)).toBe(0);
    expect(rejected.count).toBe(waiting);

    await rejected.undo();

    expect(await shown(core, mindId)).toEqual(before);
    expect(await waitingAnywhere(core)).toBe(waiting);
  });

  // protects=Accept all on the card keeps the revised text of a Mind the Answer made and revised, and nothing of the first version waits; fails_when=create_mind's version comes back waiting, or the revision is lost; no_claim=none beyond protects.
  test("Accept all keeps the revised text, and nothing waits", async () => {
    const core = await setUp(madeThenRevised([LONGER]));
    const answer = await askAssistant(core, ASKED);

    await decideAll(core, changedMinds(answer), "accept");

    expect(await shown(core, madeIn(answer))).toEqual([
      "Launch brief",
      "Milestones",
      "The beta starts on 2 February, with the Nordic pilot group.",
      "The launch is on 1 March, in every region.",
      "Decisions",
      "Hire a part-time designer.",
    ]);
    expect(await waitingAnywhere(core)).toBe(0);
  });

  // protects=the card counts the text the Mind holds once, though create_mind wrote it and edit_mind wrote it again, once or twice, with markers cite recorded or not; fails_when=it counts each version, or none; no_claim=how the card words it.
  test.each([
    ["once", [UNMARKED], MARKED],
    ["twice", [UNMARKED, LONGER], MARKED],
    ["with no markers", [LONGER], UNMARKED],
  ] as const)("the card counts its paragraphs once, revised %s", async (_, revisions, made) => {
    const revise = madeThenRevised(revisions);
    const core = await setUp((call) => {
      const reply = revise(call);
      if (!("calls" in reply) || !reply.calls) return reply;
      return {
        calls: reply.calls.map((each) =>
          each.tool === "create_mind" ? { ...each, input: { title: BRIEF, content: made } } : each,
        ),
      };
    });
    const answer = await askAssistant(core, ASKED);

    expect(changedMinds(answer)).toMatchObject([{ created: true, wrote: 3, tables: 0 }]);
  });

  // protects=the record of the Tools the next Question reads says what create_mind wrote, though edit_mind revised it and cite recorded none of its markers; fails_when=it reads as an empty Mind; no_claim=how the card counts it.
  test("the next Question reads what create_mind wrote, not an empty Mind", async () => {
    let next = "";
    const revise = madeThenRevised([UNMARKED]);
    const core = await setUp((call) => {
      if (!call.prompt.includes("What is in it?")) return revise(call);
      next = call.prompt;
      return { text: "The milestones and the decision." };
    });
    const answer = await askAssistant(core, ASKED);
    await askAssistant(core, { text: "What is in it?", conversationId: answer.conversationId });

    expect(next).toContain(
      "- create_mind: made the Mind “Launch brief” and proposed 5 changes, none waiting any more; 3 markers had no Citation recorded with cite, so they were left out",
    );
    expect(next).not.toContain("empty");
  });

  // protects=Reject all takes back a Mind made and then revised twice in one Answer; fails_when=the version in between comes back waiting; no_claim=none beyond protects.
  test("revised twice, Reject all still removes it, and Undo brings back the last version", async () => {
    const core = await setUp(madeThenRevised([UNMARKED, LONGER]));
    const answer = await askAssistant(core, ASKED);
    const mindId = madeIn(answer);
    const before = await shown(core, mindId);
    expect(before).toContain("The launch is on 1 March, in every region.");

    const rejected = await decideAll(core, changedMinds(answer), "reject");

    expect(await shown(core, mindId)).toBeNull();
    expect(await waitingAnywhere(core)).toBe(0);

    await rejected.undo();

    expect(await shown(core, mindId)).toEqual(before);
  });

  // protects=applied at once as the User asked, one Undo takes the whole Answer back, the first version with the revision; fails_when=create_mind's version is left waiting after Undo; no_claim=how the window opens the Mind.
  test("applied at once, Undo takes it all back and nothing waits", async () => {
    const core = await setUp(madeThenRevised([UNMARKED]));
    const answer = await askAssistant(core, ASKED);
    const [row] = changedMinds(answer);
    const client = await connectToMind(core, row?.mindId ?? "");
    const applying = {};
    const steps = new Y.UndoManager(client.blocks, { trackedOrigins: new Set([applying]) });
    const asked = new Set(row?.requests);

    writeAccepted(client.doc, asked, {}, applying, getSchema(noteExtensions()));
    expect(shownWithChanges(client)).toContain("The launch is on 1 March.");
    steps.undo();

    expect(pendingProposals(client.blocks)).toHaveLength(0);
    expect(shownWithChanges(client).join("")).toBe("");
  });

  // protects=Reject all on the Mind's own bar takes back the revised text and the first version with it, and ⌘Z brings back the revised text waiting; fails_when=create_mind's version comes back waiting; no_claim=none beyond protects.
  test("Reject all on the Mind's bar leaves nothing waiting, and Undo brings it back", async () => {
    const core = await setUp(madeThenRevised([UNMARKED]));
    const answer = await askAssistant(core, ASKED);
    const client = await connectToMind(core, madeIn(answer));
    const before = shownWithChanges(client);
    const editor = boundEditor(client);

    resolveInEditor(editor, "all", "reject");

    expect(pendingProposals(client.blocks)).toHaveLength(0);
    expect(shownWithChanges(client).join("")).toBe("");

    editor.commands.undo();

    expect(shownWithChanges(client)).toEqual(before);
  });

  // protects=Reject all in the review pane's ⋯ menu, which rejects the changes it lists, takes back the first version too, and ⌘Z brings back the revised text waiting; fails_when=create_mind's version comes back waiting; no_claim=none beyond protects.
  test("Reject all in the review pane leaves nothing waiting, and Undo brings it back", async () => {
    const core = await setUp(madeThenRevised([UNMARKED]));
    const answer = await askAssistant(core, ASKED);
    const client = await connectToMind(core, madeIn(answer));
    const before = shownWithChanges(client);
    const listed = new Set(pendingProposals(client.blocks).map((each) => each.id));
    const editor = boundEditor(client);

    resolveInEditor(editor, listed, "reject");

    expect(pendingProposals(client.blocks)).toHaveLength(0);
    expect(shownWithChanges(client).join("")).toBe("");

    editor.commands.undo();

    expect(shownWithChanges(client)).toEqual(before);
  });

  // protects=Regenerate takes back a Mind the Answer made and then revised before writing again; fails_when=the Mind stays with create_mind's text waiting; no_claim=what the Answer written again does.
  test("Regenerate takes it back before writing again", async () => {
    let again = false;
    const revise = madeThenRevised([UNMARKED]);
    const core = await setUp((call) => (again ? { text: "Nothing to make." } : revise(call)));
    const answer = await askAssistant(core, ASKED);
    const mindId = madeIn(answer);

    again = true;
    const result = await core.regenerateConversationAnswer({
      conversationId: answer.conversationId,
      answerId: answer.id,
    });
    if (!result.asked) throw new Error("Not asked again.");
    await answerEnded(core, result.answerId);

    expect(await shown(core, mindId)).toBeNull();
    expect(await waitingAnywhere(core)).toBe(0);
  });
});

describe("A Mind that was there, its waiting text revised by a later Answer", {
  timeout: 30_000,
}, () => {
  const RISKS = [
    "## Risks\n\nLegal review may take longer than planned.",
    "## Risks\n\nThe legal review may take two weeks longer than planned.",
  ];

  const LONGER_RISK = "It may take two weeks.";

  /**
   * An earlier Answer's waiting risks in the Project plan, which a second Answer revises `times`
   * times, with new text as `content` or with an `instruction` for Edit with AI to carry out.
   */
  async function revised(times: 1 | 2, how: "content" | "instruction" = "content") {
    let revising = false;
    const core = await setUp((call) => {
      if (call.system === EDIT_INSTRUCTIONS) {
        const passage = /<passage>\n([\s\S]*?)\n<\/passage>/.exec(call.prompt)?.[1] ?? "";
        return { text: `${passage} ${LONGER_RISK}\n<why>Longer.</why>` };
      }
      if (how === "instruction" && revising) {
        const instruction = "Make the risks longer";
        return ran(call, "edit_mind") === 0
          ? {
              calls: [
                { tool: "edit_mind", input: { mind: "Project plan", part: "Risks", instruction } },
              ],
            }
          : { text: "Made the risks longer." };
      }
      if (!revising) {
        const content = "## Risks\n\nLegal review may take longer.";
        return ran(call, "add_to_mind") === 0
          ? { calls: [{ tool: "add_to_mind", input: { mind: "Project plan", content } }] }
          : { text: "Added the risks." };
      }
      const content = RISKS.slice(0, times)[ran(call, "edit_mind")];
      return content === undefined
        ? { text: "Said more about the legal review." }
        : {
            calls: [{ tool: "edit_mind", input: { mind: "Project plan", part: "Risks", content } }],
          };
    });
    const first = await askAssistant(core, { text: "Add the risks to the Project plan" });
    const planId = changedMinds(first)[0]?.mindId ?? "";
    const before = await shown(core, planId);
    const originsBefore = originsOf(await connectToMind(core, planId));
    expect(before).toContain("+ Legal review may take longer.");
    revising = true;
    const second = await askAssistant(core, {
      text: "Say more about the legal review",
      conversationId: first.conversationId,
    });
    const last = how === "content" ? (RISKS[times - 1]?.split("\n\n")[1] ?? "") : LONGER_RISK;
    const now = await shown(core, planId);
    expect(now?.some((line) => line.startsWith("+") && line.includes(last))).toBe(true);
    return { core, planId, before, originsBefore, second };
  }

  // protects=Reject all on an Answer that revised an earlier Answer's waiting text twice brings that text back exactly, still waiting, and leaves the Mind; fails_when=the first revision comes back waiting instead, or the Mind goes; no_claim=none beyond protects.
  test("revised twice, Reject all on the card brings back the earlier Answer's text, still waiting", async () => {
    const { core, planId, before, second } = await revised(2);

    await decideAll(core, changedMinds(second), "reject");

    expect(await shown(core, planId)).toEqual(before);
  });

  // protects=Reject all on the Mind's bar, as ⌘K's, takes back the later Answer's revisions and leaves the earlier Answer's text waiting, as it was; fails_when=the earlier Answer's text is thrown away too, or a revision in between comes back; no_claim=none beyond protects.
  test("revised twice, Reject all on the Mind's bar brings back the earlier Answer's text, still waiting", async () => {
    const { core, planId, before } = await revised(2);
    const client = await connectToMind(core, planId);

    resolveInEditor(boundEditor(client), "all", "reject");

    expect(shownWithChanges(client)).toEqual(before);
  });

  // protects=an earlier Answer's waiting text that a later Answer revised, with new text or with an instruction, comes back waiting with each Reject all (the card, the Mind's bar as ⌘K's, the review pane), each Block with its earlier origin (#1950); fails_when=it is thrown away with the revision, the revision stays, or a Block keeps the later Answer's origin; no_claim=what the rewrite says.
  test.each([
    ["content", "the card"],
    ["content", "the Mind's bar"],
    ["content", "the review pane"],
    ["instruction", "the card"],
    ["instruction", "the Mind's bar"],
    ["instruction", "the review pane"],
  ] as const)(
    "revised with %s, Reject all on %s brings back the earlier Answer's text, still waiting",
    async (how, where) => {
      const { core, planId, before, originsBefore, second } = await revised(1, how);
      const client = await connectToMind(core, planId);

      if (where === "the card") await decideAll(core, changedMinds(second), "reject");
      else {
        const listed = new Set(pendingProposals(client.blocks).map((each) => each.id));
        resolveInEditor(boundEditor(client), where === "the Mind's bar" ? "all" : listed, "reject");
        await client.settled();
      }

      expect(await shown(core, planId)).toEqual(before);
      expect(originsOf(await connectToMind(core, planId))).toEqual(originsBefore);
    },
  );
});
