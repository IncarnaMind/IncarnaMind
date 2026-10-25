import { getSchema } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { decideAll } from "../../eval/minds/state";
import type { ConversationAnswer, Core } from "../../src/core";
import { changedMinds } from "../../src/renderer/src/changedMinds";
import { writeAccepted } from "../../src/renderer/src/editor/arrivedChanges";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { resolveInEditor } from "../../src/renderer/src/editor/proposalReview";
import { pendingProposals } from "../../src/shared/proposals";
import { askAssistant } from "../helpers/assistant";
import { answerEnded } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { boundEditor } from "../helpers/editor";
import { connectToMind } from "../helpers/mindClient";
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
 * then edit_mind with the whole text again. Then the User takes the Answer
 * back or keeps it: on its card (with the card's functions, as the Minds
 * evaluation applies them), on the Mind's own bar, applied at once as asked,
 * or with Regenerate.
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

describe("A Mind that was there, revised twice in one Answer", { timeout: 30_000 }, () => {
  const RISKS = [
    "## Risks\n\nLegal review may take longer than planned.",
    "## Risks\n\nThe legal review may take two weeks longer than planned.",
  ];

  // protects=Reject all on an Answer that revised an earlier Answer's waiting text twice brings that text back exactly, still waiting, and leaves the Mind; fails_when=the first revision comes back waiting instead, or the Mind goes; no_claim=none beyond protects.
  test("Reject all brings back the earlier Answer's text, still waiting", async () => {
    let revising = false;
    const core = await setUp((call) => {
      if (!revising) {
        return ran(call, "add_to_mind") === 0
          ? {
              calls: [
                {
                  tool: "add_to_mind",
                  input: {
                    mind: "Project plan",
                    content: "## Risks\n\nLegal review may take longer.",
                  },
                },
              ],
            }
          : { text: "Added the risks." };
      }
      const content = RISKS[ran(call, "edit_mind")];
      return content === undefined
        ? { text: "Said more about the legal review." }
        : {
            calls: [{ tool: "edit_mind", input: { mind: "Project plan", part: "Risks", content } }],
          };
    });
    const first = await askAssistant(core, { text: "Add the risks to the Project plan" });
    const planId = changedMinds(first)[0]?.mindId ?? "";
    const before = await shown(core, planId);
    revising = true;
    const second = await askAssistant(core, {
      text: "Say more about the legal review",
      conversationId: first.conversationId,
    });
    expect(await shown(core, planId)).toContain(
      "+ The legal review may take two weeks longer than planned.",
    );

    await decideAll(core, changedMinds(second), "reject");

    expect(await shown(core, planId)).toEqual(before);
    expect(before).toContain("+ Legal review may take longer.");
  });
});
