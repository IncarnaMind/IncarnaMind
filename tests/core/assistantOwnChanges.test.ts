import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import type { Core } from "../../src/core";
import { EDIT_INSTRUCTIONS } from "../../src/core/edits/prompt";
import { waitingProblemOf } from "../../src/renderer/src/changeProblems";
import { waitsForUser } from "../../src/shared/askedChanges";
import { pendingProposals, proposalRequestOf, resolveProposals } from "../../src/shared/proposals";
import { askAssistant, changesIn, lastResult, mindCalls } from "../helpers/assistant";
import { answerEnded } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { heading, note, shownWithChanges, writeMind } from "../helpers/minds";
import {
  claimCheckReply,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

/**
 * The assistant and its own changes still waiting, through the core's
 * public interface as the assistant asks: a later Question knows what an
 * earlier Answer's Tools really did, the Mind is read with its waiting
 * changes marked, "make it longer" revises the same waiting text, changes it
 * can't revise make it say so and change nothing, a reply that claims a
 * change no call made is asked for once more, and a failed change says why.
 * The model's choices are scripted; real models' are checked by hand and in
 * the everyday-requests evaluation.
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
  call.system === EDIT_INSTRUCTIONS
    ? (/<passage>\n([\s\S]*?)\n<\/passage>/.exec(call.prompt)?.[1] ?? null)
    : null;

const called = (call: ModelCall, tool: string) => call.results.some((each) => each.tool === tool);

/** A Mind "Q3 review" with the User's own summary, on a scripted model. */
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

/** The Mind an Answer made, connected. */
async function madeBy(core: Core, answer: Awaited<ReturnType<typeof askAssistant>>) {
  const made = changesIn(answer).find((change) => change.created);
  if (!made) throw new Error("The Answer made no Mind.");
  return connectToMind(core, made.mindId);
}

/** How many changes wait in a Mind from a request. */
const waitingFrom = (client: MindClient, request: string) =>
  pendingProposals(client.blocks).filter((each) => each.request === request).length;

const SUMMARY_PAGE = "## Summary\n\nThe paper is about spring tides.";

/** A Mind's top-level Blocks as stored, attributes and all: to tell it is exactly as it was. */
const exactly = (client: MindClient) =>
  client.blocks
    .toArray()
    .map((block) =>
      block instanceof Y.XmlElement
        ? { name: block.nodeName, attributes: block.getAttributes(), text: block.toString() }
        : null,
    );

describe("The assistant revises its own changes still waiting", { timeout: 30_000 }, () => {
  // protects=after "write a summary page", "make it longer" lengthens that same waiting summary: the next Question knows what the first Answer made, reads its text marked as waiting, and the Mind holds one summary whose count is the Answer's; fails_when=a second summary is added, the waiting text reads as empty, or the bar and the card disagree; no_claim=how well a real model lengthens it.
  test("“make it longer” lengthens the same waiting summary, and the Mind holds one", async () => {
    const seen: { record: string; read: string } = { record: "", read: "" };
    const model = scriptedModel((call): ScriptedReply => {
      const passage = editPassage(call);
      if (passage !== null) {
        return { text: `${passage} It also covers neap tides.\n<why>Longer.</why>` };
      }
      if (asked(call).endsWith("write a summary page")) {
        return called(call, "create_mind")
          ? { text: "Made “Tide notes” with a short summary." }
          : {
              calls: [
                { tool: "create_mind", input: { title: "Tide notes", content: SUMMARY_PAGE } },
              ],
            };
      }
      if (!called(call, "read_mind")) {
        seen.record = asked(call);
        return { calls: [{ tool: "read_mind", input: { mind: "Tide notes" } }] };
      }
      if (!called(call, "edit_mind")) {
        seen.read = call.results.find((each) => each.tool === "read_mind")?.text ?? "";
        return {
          calls: [
            {
              tool: "edit_mind",
              input: { mind: "Tide notes", part: "Summary", instruction: "Make it longer" },
            },
          ],
        };
      }
      return { text: "Lengthened the summary in “Tide notes”." };
    });
    const { core, mind } = await setUp(model);

    const first = await askAssistant(core, { text: "write a summary page", mindId: mind.id });
    const page = await madeBy(core, first);
    const [made] = changesIn(first);
    const second = await askAssistant(core, {
      text: "make the summary longer",
      mindId: mind.id,
      conversationId: first.conversationId,
    });

    expect(seen.record).toContain(
      "- create_mind: made the Mind “Tide notes” and proposed 2 changes, waiting for the User",
    );
    expect(seen.read).toContain("## [waiting change, adds: Summary]");
    expect(seen.read).toContain("[waiting change, adds: The paper is about spring tides.]");
    await page.settled();
    expect(shownWithChanges(page)).toEqual([
      "+ Summary",
      "+ The paper is about spring tides. It also covers neap tides.",
    ]);
    const [revised] = changesIn(second);
    expect(revised).toMatchObject({ mindId: made?.mindId, revised: true, proposals: 2 });
    expect(pendingProposals(page.blocks)).toHaveLength(revised?.proposals ?? -1);
    expect(waitingFrom(page, made?.request ?? "")).toBe(0);
    expect(lastResult(model)).toMatch(
      /^Revised your own text in “Tide notes”.*applies in the Mind at once/,
    );
    expect(second.steps?.unbackedClaims).toBeUndefined();
  });

  // protects=removing part of the assistant's waiting text removes it there and leaves one version, the rest still the first Answer's, so each card's count is its own; fails_when=the part stays, the rest is lost or moves to the new Answer, or the counts differ; no_claim=none beyond protects.
  test("“remove the part about…” removes it from the waiting text, and the counts agree", async () => {
    const model = scriptedModel((call): ScriptedReply => {
      if (editPassage(call) !== null) return { text: "<why>Removed it.</why>" };
      if (asked(call).endsWith("write a page on tides")) {
        const content =
          "## Spring tides\n\nThey come at new moon.\n\n## Neap tides\n\nThey come at half moon.";
        return called(call, "create_mind")
          ? { text: "Made “Tide notes”." }
          : { calls: [{ tool: "create_mind", input: { title: "Tide notes", content } }] };
      }
      return called(call, "edit_mind")
        ? { text: "Removed the neap tides section from “Tide notes”." }
        : {
            calls: [
              {
                tool: "edit_mind",
                input: { mind: "Tide notes", part: "Neap tides", instruction: "Remove it" },
              },
            ],
          };
    });
    const { core, mind } = await setUp(model);
    const first = await askAssistant(core, { text: "write a page on tides", mindId: mind.id });
    const page = await madeBy(core, first);

    const second = await askAssistant(core, {
      text: "remove the part about neap tides",
      mindId: mind.id,
      conversationId: first.conversationId,
    });

    await page.settled();
    expect(shownWithChanges(page)).toEqual(["+ Spring tides", "+ They come at new moon."]);
    const [revised] = changesIn(second);
    expect(revised).toMatchObject({ revised: true, proposals: 0 });
    expect(pendingProposals(page.blocks)).toHaveLength(2);
    expect(waitingFrom(page, changesIn(first)[0]?.request ?? "")).toBe(2);
  });

  // protects=edit_mind with new text replaces the assistant's own waiting section with it, as one version; fails_when=both versions stay, or it is refused; no_claim=none beyond protects.
  test("new text for its own waiting section takes that section's place", async () => {
    const longer = "## Summary\n\nThe paper is about spring tides, and how the moon drives them.";
    const model = scriptedModel((call): ScriptedReply => {
      if (asked(call).endsWith("write a summary page")) {
        return called(call, "create_mind")
          ? { text: "Made “Tide notes”." }
          : {
              calls: [
                { tool: "create_mind", input: { title: "Tide notes", content: SUMMARY_PAGE } },
              ],
            };
      }
      return called(call, "edit_mind")
        ? { text: "Rewrote the summary in “Tide notes”." }
        : {
            calls: [
              {
                tool: "edit_mind",
                input: { mind: "Tide notes", part: "Summary", content: longer },
              },
            ],
          };
    });
    const { core, mind } = await setUp(model);
    const first = await askAssistant(core, { text: "write a summary page", mindId: mind.id });
    const page = await madeBy(core, first);

    const second = await askAssistant(core, {
      text: "make it longer",
      mindId: mind.id,
      conversationId: first.conversationId,
    });

    await page.settled();
    expect(shownWithChanges(page)).toEqual([
      "+ Summary",
      "+ The paper is about spring tides, and how the moon drives them.",
    ]);
    expect(changesIn(second)).toEqual([expect.objectContaining({ revised: true, proposals: 2 })]);
  });

  // protects=asked to change all of a Mind where its own waiting text sits beside the User's, the assistant is told to name the section, and revises only its own; fails_when=the User's text is changed, or nothing is done; no_claim=none beyond protects.
  test("its waiting section beside the User's text is revised once the section is named", async () => {
    const model = scriptedModel((call): ScriptedReply => {
      const passage = editPassage(call);
      if (passage !== null) return { text: `${passage} The courier is late too.` };
      if (asked(call).endsWith("add a risks section")) {
        return called(call, "add_to_mind")
          ? { text: "Added a risks section to “Q3 review”." }
          : {
              calls: [
                {
                  tool: "add_to_mind",
                  input: { content: "## Risks\n\nThe supplier is late." },
                },
              ],
            };
      }
      const edits = call.results.filter((each) => each.tool === "edit_mind").length;
      if (edits === 0) {
        return { calls: [{ tool: "edit_mind", input: { instruction: "Make the risks longer" } }] };
      }
      if (edits === 1) {
        return {
          calls: [
            { tool: "edit_mind", input: { part: "Risks", instruction: "Make the risks longer" } },
          ],
        };
      }
      return { text: "Lengthened the risks in “Q3 review”." };
    });
    const { core, mind, client } = await setUp(model);
    const first = await askAssistant(core, { text: "add a risks section", mindId: mind.id });

    const second = await askAssistant(core, {
      text: "make the risks longer",
      mindId: mind.id,
      conversationId: first.conversationId,
    });

    const [whole, named] = mindCalls(second);
    expect(whole).toMatchObject({
      status: "failed",
      mindProblem: { kind: "waiting", mindId: mind.id, mixed: true },
    });
    expect(named).toMatchObject({ status: "done", mindChange: { revised: true } });
    await client.settled();
    expect(shownWithChanges(client)).toEqual([
      "Summary",
      "The quarter was very good, and sales were really strong.",
      "+ Risks",
      "+ The supplier is late. The courier is late too.",
    ]);
    expect(waitingProblemOf(second)).toBeNull();
  });
  const sameTurnSummary = (...finals: string[]) => {
    let revisions = 0;
    return scriptedModel((call): ScriptedReply => {
      const edits = call.results.filter((each) => each.tool === "edit_mind").length;
      const passage = editPassage(call);
      if (passage !== null) {
        if (passage.includes("really")) {
          return { text: passage.replace(/\b(?:very|really) /g, "") };
        }
        const final = finals[Math.min(revisions, Math.max(0, finals.length - 1))] ?? "";
        revisions += 1;
        return { text: final };
      }
      if (edits === 0) {
        return {
          calls: [
            { tool: "edit_mind", input: { part: "Summary", instruction: "Make it plainer" } },
          ],
        };
      }
      if (edits <= finals.length) {
        return {
          calls: [{ tool: "edit_mind", input: { part: "Summary", instruction: "Shorten it" } }],
        };
      }
      return { text: "Shortened the summary in “Q3 review”." };
    });
  };

  // protects=a second edit of the same text in one turn revises the first, rather than refusing the turn's own change as waiting for the User; fails_when=the second is refused, or the final text isn't the second rewrite; no_claim=how the window groups the turn into one Undo step.
  test("a second edit in the same turn revises the first", async () => {
    const model = sameTurnSummary(
      "## Summary\n\nThe quarter was good, and sales were quite strong.",
    );
    const { core, mind, client } = await setUp(model);

    const answer = await askAssistant(core, {
      text: "make the summary plainer, then shorter",
      mindId: mind.id,
    });

    const edits = mindCalls(answer).filter((call) => call.tool === "edit_mind");
    expect(edits).toHaveLength(2);
    expect(edits[1]).toMatchObject({
      status: "done",
      mindChange: { revised: true, replacedOwn: { paragraphs: 1, tables: 0, charts: 0 } },
    });
    expect(lastResult(model)).toContain("Revised your own text");
    expect(lastResult(model)).not.toContain("waiting for the User");
    await client.settled();
    expect(shownWithChanges(client)).toEqual([
      "Summary",
      "The quarter was [-very -]good, and sales were [-really-]{+quite+} strong.",
    ]);
  });

  // Value: protects=cumulative removal of original User text still waits during same-turn revision; fails_when=insert-only replacements hide earlier deletions; why_new=CodeRabbit's small-edit-then-large-revision path; seam=public Tool result and shared hold measure; no_claim=held Apply/Discard UI (existing destructive-edit e2e)
  test("a same-turn revision that removes most of the original text waits", async () => {
    const model = sameTurnSummary("## Summary\n\nThe quarter was good.");
    const { core, mind, client } = await setUp(model);

    const answer = await askAssistant(core, {
      text: "make the summary plainer, then shorter",
      mindId: mind.id,
    });

    const edits = mindCalls(answer).filter((call) => call.tool === "edit_mind");
    expect(edits).toHaveLength(2);
    expect(lastResult(model)).toContain("so it waits there for them");
    await client.settled();
    expect(
      waitsForUser(
        client.doc,
        new Set(edits.flatMap((call) => (call.mindChange ? [call.mindChange.request] : []))),
      ),
    ).toBe(true);
    expect(shownWithChanges(client)).toEqual([
      "Summary",
      "[-The quarter was very good, and sales were really strong.-]{+The quarter was good.+}",
    ]);
  });

  // Value: protects=removal stays cumulative across repeated replacements; fails_when=a third revision loses the original-text counts kept by the second; why_new=the first replacement moves text into revision history; seam=three public edit_mind calls; no_claim=real-model wording (scripted edits)
  test("a third same-turn revision keeps the original-text hold", async () => {
    const model = sameTurnSummary(
      "## Summary\n\nThe quarter was great, and sales were strong.",
      "## Summary\n\nThe quarter was good.",
    );
    const { core, mind, client } = await setUp(model);

    const answer = await askAssistant(core, {
      text: "make the summary plainer, then shorter, then shorter again",
      mindId: mind.id,
    });

    const edits = mindCalls(answer).filter((call) => call.tool === "edit_mind");
    expect(edits).toHaveLength(3);
    expect(lastResult(model)).toContain("so it waits there for them");
    await client.settled();
    expect(
      waitsForUser(
        client.doc,
        new Set(edits.flatMap((call) => (call.mindChange ? [call.mindChange.request] : []))),
      ),
    ).toBe(true);
    expect(shownWithChanges(client)).toEqual([
      "Summary",
      "[-The quarter was very good, and sales were really strong.-]{+The quarter was good.+}",
    ]);
  });

  // Value: protects=an empty destructive revision keeps a Proposal to reject; fails_when=the original disappears with no decision path; why_new=delete-only revisions cannot rely on insert Blocks; seam=public Tool result and resolveProposals rejection; no_claim=the Apply path (covered by destructive-edit e2e)
  test("an empty same-turn revision holds and rejects back to the original", async () => {
    const model = sameTurnSummary("<why>Removed it.</why>");
    const { core, mind, client } = await setUp(model);

    const answer = await askAssistant(core, {
      text: "make the summary plainer, then remove it",
      mindId: mind.id,
    });

    const edits = mindCalls(answer).filter((call) => call.tool === "edit_mind");
    const request = edits[1]?.mindChange?.request;
    if (!request) throw new Error("The empty revision was not recorded.");
    expect(lastResult(model)).toContain("so it waits there for them");
    await client.settled();
    expect(waitsForUser(client.doc, new Set([request]))).toBe(true);

    resolveProposals(client.blocks, (ref) => ref.request === request, "reject");
    await client.settled();
    expect(shownWithChanges(client)).toEqual([
      "Summary",
      "The quarter was very good, and sales were really strong.",
    ]);
  });

  // Value: protects=a mixed original and inserted range is refused rather than losing User text; fails_when=the second revision applies or deletes the first version; why_new=inserted Block ownership and placement cannot be reconstructed safely; seam=small edit plus insertion, then another revision; no_claim=ordinary inserted-text revision (covered by create/revise tests)
  test("a same-turn inserted paragraph beside original text is not revised", async () => {
    let revisions = 0;
    const model = scriptedModel((call): ScriptedReply => {
      const passage = editPassage(call);
      if (passage !== null) {
        revisions += 1;
        return {
          text:
            revisions === 1
              ? `${passage.replace(/\b(?:very|really) /g, "")}\n\nAdded sentence.`
              : "## Summary\n\nThe quarter was good.",
        };
      }
      const edits = call.results.filter((each) => each.tool === "edit_mind").length;
      if (edits < 2) {
        return {
          calls: [{ tool: "edit_mind", input: { part: "Summary", instruction: "Change it" } }],
        };
      }
      return { text: "Changed the summary." };
    });
    const { core, mind, client } = await setUp(model);

    const answer = await askAssistant(core, {
      text: "edit the summary and add a sentence, then shorten it",
      mindId: mind.id,
    });

    const edits = mindCalls(answer).filter((call) => call.tool === "edit_mind");
    expect(edits).toHaveLength(2);
    expect(edits[1]).toMatchObject({ status: "failed", mindProblem: { kind: "content-not-own" } });
    expect(lastResult(model)).toContain("they are not waiting for review");
    expect(lastResult(model)).not.toContain("accept or reject");
    await client.settled();
    expect(
      waitsForUser(
        client.doc,
        new Set(edits.flatMap((call) => (call.mindChange ? [call.mindChange.request] : []))),
      ),
    ).toBe(false);
    expect(shownWithChanges(client)).toContain(
      "The quarter was [-very -]good, and sales were [-really -]strong.",
    );
    expect(shownWithChanges(client)).toContain("+ Added sentence.");
  });

  // Value: protects=independent revision chains in one Answer accumulate their removals; fails_when=only the largest chain counts and two destructive edits auto-apply; why_new=review found cross-chain undercounting; seam=four public edit_mind calls over three original paragraphs; no_claim=other turns or other Minds
  test("independent same-turn revisions add their original-text removals", async () => {
    const longA = `${"a".repeat(99)}x`;
    const longB = `${"b".repeat(99)}x`;
    const longC = "c".repeat(100);
    let rewrites = 0;
    const model = scriptedModel((call): ScriptedReply => {
      const passage = editPassage(call);
      if (passage !== null) {
        rewrites += 1;
        return { text: rewrites <= 2 ? passage.replace("x", "") : "new" };
      }
      const edits = call.results.filter((each) => each.tool === "edit_mind").length;
      if (edits < 4) {
        return {
          calls: [
            {
              tool: "edit_mind",
              input: { part: edits % 2 === 0 ? "A" : "B", instruction: "Change it" },
            },
          ],
        };
      }
      return { text: "Changed A and B." };
    });
    const { core, mind, client } = await setUp(model);
    writeMind(client, [
      heading(2, "A"),
      note(longA),
      heading(2, "B"),
      note(longB),
      heading(2, "C"),
      note(longC),
    ]);
    await client.settled();

    const answer = await askAssistant(core, { text: "change A and B", mindId: mind.id });

    const edits = mindCalls(answer).filter((call) => call.tool === "edit_mind");
    expect(edits).toHaveLength(4);
    expect(lastResult(model)).toContain("so it waits there for them");
    await client.settled();
    expect(
      waitsForUser(
        client.doc,
        new Set(edits.flatMap((call) => (call.mindChange ? [call.mindChange.request] : []))),
      ),
    ).toBe(true);
    expect(shownWithChanges(client)).toContain(longC);
  });

  // Value: protects=translation remains exempt across same-turn replacements; fails_when=revision metadata loses the translation instruction; why_new=the original-text count is intentionally high for translation; seam=two public translation edit_mind calls; no_claim=translation quality (scripted text)
  test("same-turn translation revisions do not wait for the User", async () => {
    let revisions = 0;
    const model = scriptedModel((call): ScriptedReply => {
      const passage = editPassage(call);
      if (passage !== null) {
        revisions += 1;
        return {
          text: revisions === 1 ? "## 摘要\n\n季度表现很好，销售强劲。" : "## 摘要\n\n季度很好。",
        };
      }
      const edits = call.results.filter((each) => each.tool === "edit_mind").length;
      if (edits < 2) {
        return {
          calls: [
            {
              tool: "edit_mind",
              input: { part: "Summary", instruction: "Translate the summary into Chinese" },
            },
          ],
        };
      }
      return { text: "Translated the summary in “Q3 review”." };
    });
    const { core, mind, client } = await setUp(model);

    const answer = await askAssistant(core, { text: "translate the summary", mindId: mind.id });

    const edits = mindCalls(answer).filter((call) => call.tool === "edit_mind");
    expect(edits).toHaveLength(2);
    expect(lastResult(model)).not.toContain("so it waits there for them");
    await client.settled();
    expect(
      waitsForUser(
        client.doc,
        new Set(edits.flatMap((call) => (call.mindChange ? [call.mindChange.request] : []))),
      ),
    ).toBe(false);
    expect(shownWithChanges(client)).toEqual([
      "[-Summary-]{+摘要+}",
      "[-The quarter was very good, and sales were really strong.-]{+季度很好。+}",
    ]);
  });

  // Value: protects=content-based translation revisions keep the exemption; fails_when=the content caller omits translation metadata; why_new=content has no instruction field, so the language change identifies it; seam=instruction followed by content edit_mind; no_claim=translation quality (scripted text)
  test("content-based same-turn translation revisions do not wait", async () => {
    const model = scriptedModel((call): ScriptedReply => {
      const passage = editPassage(call);
      if (passage !== null) return { text: "## 摘要\n\n季度表现很好，销售强劲。" };
      const edits = call.results.filter((each) => each.tool === "edit_mind").length;
      if (edits === 0) {
        return {
          calls: [
            {
              tool: "edit_mind",
              input: { part: "Summary", instruction: "Translate the summary into Chinese" },
            },
          ],
        };
      }
      if (edits === 1) {
        return {
          calls: [
            {
              tool: "edit_mind",
              input: { part: "Summary", content: "## 摘要\n\n季度很好。" },
            },
          ],
        };
      }
      return { text: "Translated the summary in “Q3 review”." };
    });
    const { core, mind, client } = await setUp(model);

    const answer = await askAssistant(core, { text: "translate the summary", mindId: mind.id });

    const edits = mindCalls(answer).filter((call) => call.tool === "edit_mind");
    expect(edits).toHaveLength(2);
    expect(lastResult(model)).not.toContain("so it waits there for them");
    await client.settled();
    expect(
      waitsForUser(
        client.doc,
        new Set(edits.flatMap((call) => (call.mindChange ? [call.mindChange.request] : []))),
      ),
    ).toBe(false);
    expect(shownWithChanges(client)).toEqual([
      "[-Summary-]{+摘要+}",
      "[-The quarter was very good, and sales were really strong.-]{+季度很好。+}",
    ]);
  });

  // Value: protects=short source and target text keep the content translation exemption; fails_when=detectLanguage cannot name the target and the previous intent is ignored; why_new=short translations may not meet language thresholds; seam=Chinese instruction then short English content; no_claim=language detection beyond this fallback
  test("short content translations keep the previous intent", async () => {
    const model = scriptedModel((call): ScriptedReply => {
      const passage = editPassage(call);
      if (passage !== null) return { text: "## Summary\n\nGood." };
      const edits = call.results.filter((each) => each.tool === "edit_mind").length;
      if (edits === 0) {
        return {
          calls: [
            {
              tool: "edit_mind",
              input: { part: "摘要", instruction: "Translate into English" },
            },
          ],
        };
      }
      if (edits === 1) {
        return {
          calls: [{ tool: "edit_mind", input: { part: "摘要", content: "## Summary\n\nFine." } }],
        };
      }
      return { text: "Translated the summary." };
    });
    const { core, mind, client } = await setUp(model);
    writeMind(client, [heading(2, "摘要"), note("猫。")]);
    await client.settled();

    const answer = await askAssistant(core, { text: "translate the summary", mindId: mind.id });

    const edits = mindCalls(answer).filter((call) => call.tool === "edit_mind");
    expect(edits).toHaveLength(2);
    expect(lastResult(model)).not.toContain("so it waits there for them");
    await client.settled();
    expect(
      waitsForUser(
        client.doc,
        new Set(edits.flatMap((call) => (call.mindChange ? [call.mindChange.request] : []))),
      ),
    ).toBe(false);
  });

  // Value: protects=a current-turn Proposal authorizes only its own stretch, not untouched neighboring text; fails_when=a later whole-Mind revision replaces the untouched Block; why_new=the existing mixed-range case used an earlier Answer; seam=none; no_claim=safe same-turn revision when every Block has a current-turn Proposal (covered above)
  test("a current-turn Proposal does not make the untouched rest of the Mind revisable", async () => {
    const model = scriptedModel((call): ScriptedReply => {
      const passage = editPassage(call);
      if (passage !== null)
        return { text: passage.includes("Summary") ? "Rewritten summary" : "Everything replaced" };
      const edits = call.results.filter((each) => each.tool === "edit_mind").length;
      if (edits === 0) {
        return {
          calls: [
            { tool: "edit_mind", input: { part: "Summary", instruction: "Rewrite the summary" } },
          ],
        };
      }
      if (edits === 1) {
        return { calls: [{ tool: "edit_mind", input: { instruction: "Replace everything" } }] };
      }
      return { text: "Done." };
    });
    const { core, mind, client } = await setUp(model);
    writeMind(client, [
      heading(2, "Summary"),
      note("The quarter was good."),
      note("Do not change this."),
    ]);
    await client.settled();

    const answer = await askAssistant(core, {
      text: "Rewrite the summary, then replace everything",
      mindId: mind.id,
    });

    const edits = mindCalls(answer).filter((call) => call.tool === "edit_mind");
    expect(edits).toHaveLength(2);
    expect(edits[0]).toMatchObject({ status: "done" });
    expect(edits[1]).toMatchObject({ status: "failed", mindProblem: { kind: "waiting" } });
    await client.settled();
    expect(shownWithChanges(client).at(-1)).toBe("Do not change this.");
    expect(shownWithChanges(client)).not.toContain("Everything replaced");
  });
});

describe("Changes it can't revise", { timeout: 30_000 }, () => {
  // protects=over changes the User asked for (Edit with AI's, here from an earlier edit_mind), the assistant changes nothing, is told to say so first, the card says why, and the next Question knows it failed; fails_when=it changes the Mind another way, the problem isn't recorded, or the record says it worked; no_claim=how the model words it.
  test("over changes it can't revise, nothing changes, and it says why", async () => {
    let record = "";
    const model = scriptedModel((call): ScriptedReply => {
      const passage = editPassage(call);
      if (passage !== null) return { text: passage.replace(/\b(?:very|really) /g, "") };
      if (asked(call).endsWith("anything else?")) {
        record = call.prompt;
        return { text: "No." };
      }
      return called(call, "edit_mind")
        ? { text: "Done." }
        : { calls: [{ tool: "edit_mind", input: { instruction: "Shorten it" } }] };
    });
    const { core, mind, client } = await setUp(model);
    const first = await askAssistant(core, { text: "shorten the summary", mindId: mind.id });
    await client.settled();
    const before = shownWithChanges(client);
    const checkpoints = (await core.listCheckpoints(mind.id)).checkpoints.length;

    const second = await askAssistant(core, {
      text: "shorten it more",
      mindId: mind.id,
      conversationId: first.conversationId,
    });

    const [refused] = mindCalls(second);
    expect(refused).toMatchObject({
      status: "failed",
      mindProblem: { kind: "waiting", mindId: mind.id, count: 2, mixed: false },
    });
    expect(lastResult(model)).toContain("Say so first, in one sentence");
    await client.settled();
    expect(shownWithChanges(client)).toEqual(before);
    expect((await core.listCheckpoints(mind.id)).checkpoints).toHaveLength(checkpoints);
    expect(waitingProblemOf(second)).toEqual({ mindId: mind.id, count: 2 });

    await askAssistant(core, {
      text: "anything else?",
      mindId: mind.id,
      conversationId: first.conversationId,
    });
    expect(record).toContain("- edit_mind “Q3 review”: proposed 2 changes, waiting for the User");
    expect(record).toContain(
      "- edit_mind “Q3 review”: nothing changed: 2 changes the assistant can't revise waited there for the User",
    );
    expect(record).toContain("[waiting change, removes: very ]");
  });

  // protects=a failed change keeps why on its card: a heading that isn't there, a Mind that isn't; fails_when=the card has no reason; no_claim=none beyond protects.
  test("a heading or a Mind that isn't there is the reason on the card", async () => {
    const model = scriptedModel(
      ({ results }): ScriptedReply =>
        results.length === 0
          ? {
              calls: [
                { tool: "edit_mind", input: { part: "Risks", instruction: "Shorten it" } },
                { tool: "read_mind", input: { mind: "Chapter 9" } },
              ],
            }
          : { text: "There is no risks section, and no Chapter 9." },
    );
    const { core, mind } = await setUp(model);

    const answer = await askAssistant(core, { text: "shorten the risks", mindId: mind.id });

    expect(mindCalls(answer).map((call) => call.mindProblem)).toEqual([
      { kind: "no-heading", mindId: mind.id, heading: "Risks" },
      { kind: "not-found", name: "Chapter 9" },
    ]);
  });
});

describe("A reply that claims a change no call made", { timeout: 30_000 }, () => {
  const CLAIM = "I've added a risks section to “Q3 review”.";
  const ASKED_AGAIN = "but no Tool did that";

  // protects=a reply claiming a change no call made is asked for once more with the record, and the honest second reply is what the User reads, unflagged; fails_when=the claim stands, or the model isn't asked again; no_claim=that a real model corrects itself.
  test("is asked for once more, and the honest reply stands", async () => {
    let note = "";
    const model = scriptedModel(
      (call): ScriptedReply => {
        if (!call.prompt.includes(ASKED_AGAIN)) return { text: CLAIM };
        note = asked(call);
        return { text: "I haven't changed “Q3 review” yet: say if you'd like a risks section." };
      },
      { generate: (call) => claimCheckReply(call, [{ sentence: CLAIM, kind: "added" }]) },
    );
    const { core, mind, client } = await setUp(model);

    const answer = await askAssistant(core, { text: "add risks", mindId: mind.id });

    expect(model.doStreamCalls).toHaveLength(2);
    expect(note).toContain("<tool-record>");
    expect(note).toContain("- No Tool was called.");
    expect(note).toContain("Your reply says you added text to a Mind, but no Tool did that.");
    expect(answer.text).toBe(
      "I haven't changed “Q3 review” yet: say if you'd like a risks section.",
    );
    expect(answer.steps?.unbackedClaims).toBeUndefined();
    expect(pendingProposals(client.blocks)).toEqual([]);
  });

  // protects=asked again, the model may make the change it claimed, and then nothing is flagged; fails_when=the change isn't made, or the reply is still flagged; no_claim=none beyond protects.
  test("asked once more, it may make the change, and nothing is flagged", async () => {
    const model = scriptedModel(
      (call): ScriptedReply => {
        if (!call.prompt.includes(ASKED_AGAIN)) return { text: CLAIM };
        return called(call, "add_to_mind")
          ? { text: "Added a risks section to “Q3 review”." }
          : {
              calls: [
                { tool: "add_to_mind", input: { content: "## Risks\n\nThe supplier is late." } },
              ],
            };
      },
      {
        generate: (call) =>
          claimCheckReply(call, (prompt) =>
            prompt.includes('"tool": "add_to_mind"') ? [] : [{ sentence: CLAIM, kind: "added" }],
          ),
      },
    );
    const { core, mind, client } = await setUp(model);

    const answer = await askAssistant(core, { text: "add risks", mindId: mind.id });

    expect(answer.text).toBe("Added a risks section to “Q3 review”.");
    expect(answer.steps?.unbackedClaims).toBeUndefined();
    await client.settled();
    expect(shownWithChanges(client).slice(-2)).toEqual(["+ Risks", "+ The supplier is late."]);
  });

  // protects=a reply that still claims a change no call made is shown flagged, for the line under it (#1559); fails_when=it is shown as if the change were made, or is lost; no_claim=how the line reads.
  test("still claiming it, the reply is flagged", async () => {
    const model = scriptedModel((): ScriptedReply => ({ text: CLAIM }), {
      generate: (call) => claimCheckReply(call, [{ sentence: CLAIM, kind: "added" }]),
    });
    const { core, mind } = await setUp(model);

    const answer = await askAssistant(core, { text: "add risks", mindId: mind.id });

    expect(model.doStreamCalls).toHaveLength(2);
    expect(answer.text).toBe(CLAIM);
    expect(answer.steps?.unbackedClaims).toEqual(["added"]);
  });

  // protects=a claim a call backs is never asked about again; fails_when=the model is asked once more after a real change; no_claim=none beyond protects.
  test("a change a call made isn't asked about", async () => {
    const model = scriptedModel(
      ({ results }): ScriptedReply =>
        results.length === 0
          ? {
              calls: [
                { tool: "add_to_mind", input: { content: "## Risks\n\nThe supplier is late." } },
              ],
            }
          : { text: "Added a risks section to “Q3 review”." },
    );
    const { core, mind } = await setUp(model);

    const answer = await askAssistant(core, { text: "add risks", mindId: mind.id });

    expect(model.doStreamCalls).toHaveLength(2);
    expect(answer.steps?.unbackedClaims).toBeUndefined();
  });
});

describe("A turn that ends after a refused Tool with no reply", { timeout: 30_000 }, () => {
  // protects=a turn whose only Tool call is refused for a Mind that isn't there, and whose model then says nothing, still ends with a reply naming that Mind and saying the change wasn't made; fails_when=the Answer ends blank or fails, or the model isn't asked once more first; no_claim=how a real model words it.
  test.each([
    [
      "Budget forecast",
      "Shorten the summary in my Budget forecast Mind.",
      "There is no note called “Budget forecast”, so the change wasn’t made.",
    ],
    [
      "预算预测",
      "把我的预算预测 Mind 里的摘要缩短一点。",
      "没有名为“预算预测”的笔记，因此没有做这项改动。",
    ],
  ])("names “%s” and says the change wasn't made", async (name, request, said) => {
    let nudge = "";
    const model = scriptedModel((call): ScriptedReply => {
      if (call.results.length === 0) {
        return { calls: [{ tool: "read_mind", input: { mind: name } }] };
      }
      if (call.prompt.includes("Your reply is empty")) nudge = asked(call);
      return { text: "" };
    });
    const { core, mind, client } = await setUp(model);

    const answer = await askAssistant(core, { text: request, mindId: mind.id });

    expect(nudge).toContain(`there is no note called “${name}”`);
    expect(model.doStreamCalls).toHaveLength(3);
    expect(answer.status).toBe("done");
    expect(answer.text).toBe(said);
    expect(mindCalls(answer)[0]?.mindProblem).toEqual({ kind: "not-found", name });
    expect(pendingProposals(client.blocks)).toEqual([]);
  });
});

describe("The owner's four turns", { timeout: 30_000 }, () => {
  const PAGE = "Paper summaries";
  const FALSE_CLAIM = `The summary in “${PAGE}” has been updated with Citations.`;
  const HONEST = "The summary holds no Citations yet: ask, and the papers can be cited.";
  const RETOLD = "## Summary\n\nBoth papers train random neural networks, one by gradient descent.";

  // protects=the owner's conversation (write a summary page, make it longer, no citations?, write a summary of the 2 papers) leaves one summary in one page, revised in place each time, each turn knowing what the last really did, and the false claim of turn 3 never stands; fails_when=a second summary is written, a turn's record is missing or wrong, the false claim is shown, or the counts disagree; no_claim=what a real model chooses, which the everyday-requests evaluation checks.
  test("one page, one summary, each turn told what the last did, and no false claim", async () => {
    const prompts: Record<string, string> = {};
    const model = scriptedModel(
      (call): ScriptedReply => {
        const passage = editPassage(call);
        if (passage !== null) return { text: `${passage} It also compares how they are trained.` };
        const question = asked(call);
        if (question.endsWith("write a summary page")) {
          return called(call, "create_mind")
            ? { text: "It covers both papers." }
            : { calls: [{ tool: "create_mind", input: { title: PAGE, content: SUMMARY_PAGE } }] };
        }
        if (question.endsWith("make the summary section longer")) {
          prompts.second = call.prompt;
          return called(call, "edit_mind")
            ? { text: "It now says how each is trained." }
            : {
                calls: [
                  {
                    tool: "edit_mind",
                    input: { mind: PAGE, part: "Summary", instruction: "Make it longer" },
                  },
                ],
              };
        }
        if (question.endsWith("no citations?")) {
          prompts.third = call.prompt;
          return { text: FALSE_CLAIM };
        }
        if (call.prompt.includes("but no Tool did that")) return { text: HONEST };
        return called(call, "edit_mind")
          ? { text: "" }
          : {
              calls: [
                { tool: "edit_mind", input: { mind: PAGE, part: "Summary", content: RETOLD } },
              ],
            };
      },
      {
        generate: (call) => claimCheckReply(call, [{ sentence: FALSE_CLAIM, kind: "changed" }]),
      },
    );
    const { core, mind } = await setUp(model);
    const turn = (text: string, conversationId?: string) =>
      askAssistant(core, { text, mindId: mind.id, ...(conversationId && { conversationId }) });

    const first = await turn("write a summary page");
    const page = await madeBy(core, first);
    const second = await turn("make the summary section longer", first.conversationId);
    const third = await turn("no citations?", first.conversationId);
    const calls = model.doStreamCalls.length;
    const fourth = await turn("write a summary about these 2 papers", first.conversationId);

    expect(prompts.second).toContain(
      `- create_mind: made the Mind “${PAGE}” and proposed 2 changes, waiting for the User`,
    );
    expect(prompts.third).toContain(
      `- edit_mind “${PAGE}” (section “Summary”): revised your own waiting text in place, and proposed 2 changes, waiting for the User`,
    );
    expect(changesIn(second)).toEqual([expect.objectContaining({ revised: true, proposals: 2 })]);
    expect(third.text).toBe(HONEST);
    expect(third.steps?.unbackedClaims).toBeUndefined();
    expect(model.doStreamCalls.length - calls).toBe(2);
    expect(fourth.text).toBe("");
    const [retold] = changesIn(fourth);
    expect(retold).toMatchObject({ revised: true, proposals: 2 });
    await page.settled();
    expect(shownWithChanges(page)).toEqual([
      "+ Summary",
      "+ Both papers train random neural networks, one by gradient descent.",
    ]);
    expect(pendingProposals(page.blocks)).toHaveLength(retold?.proposals ?? -1);
    for (const earlier of [first, second]) {
      expect(waitingFrom(page, changesIn(earlier)[0]?.request ?? "")).toBe(0);
    }
  });
});

describe("Taking back a revision", { timeout: 30_000 }, () => {
  /** "write a summary page", then "make it longer" as new text for it; `again` scripts the Answer written again. */
  async function revised(again: () => ScriptedReply) {
    let regenerating = false;
    const model = scriptedModel((call): ScriptedReply => {
      if (regenerating) return again();
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
                input: {
                  mind: "Tide notes",
                  part: "Summary",
                  content: "## Summary\n\nThe paper is about spring tides and the moon.",
                },
              },
            ],
          };
    });
    const { core, mind } = await setUp(model);
    const first = await askAssistant(core, { text: "write a summary page", mindId: mind.id });
    const page = await madeBy(core, first);
    await page.settled();
    const before = exactly(page);
    const second = await askAssistant(core, {
      text: "make it longer",
      mindId: mind.id,
      conversationId: first.conversationId,
    });
    await page.settled();
    expect(exactly(page)).not.toEqual(before);
    const regenerate = async () => {
      regenerating = true;
      const result = await core.regenerateConversationAnswer({
        conversationId: second.conversationId,
        answerId: second.id,
      });
      if (!result.asked) throw new Error("Not asked again.");
      expect((await answerEnded(core, result.answerId)).event).toBe("finished");
      await page.settled();
    };
    return { page, before, second, regenerate };
  }

  // protects=a revision of the page saves a Checkpoint of it first, as any change the assistant makes does; fails_when=none is saved, so the old version can't be restored from history; no_claim=what the Checkpoint holds.
  test("a revision saves a Checkpoint of the page first", async () => {
    const model = scriptedModel((call): ScriptedReply => {
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
                input: {
                  mind: "Tide notes",
                  part: "Summary",
                  content: "## Summary\n\nThe paper is about spring tides and the moon.",
                },
              },
            ],
          };
    });
    const { core, mind } = await setUp(model);
    const first = await askAssistant(core, { text: "write a summary page", mindId: mind.id });
    const pageId = changesIn(first)[0]?.mindId ?? "";
    const before = (await core.listCheckpoints(pageId)).checkpoints.length;

    await askAssistant(core, {
      text: "make it longer",
      mindId: mind.id,
      conversationId: first.conversationId,
    });

    expect((await core.listCheckpoints(pageId)).checkpoints).toHaveLength(before + 1);
  });

  // protects=Reject all on the Answer that revised its own waiting text puts back exactly what was there, still waiting as the first Answer's; fails_when=the old text is lost, comes back changed, or comes back as the second Answer's; no_claim=none beyond protects.
  test("Reject all on the revising Answer brings back exactly what was there", async () => {
    const { page, before, second } = await revised(() => ({ text: "Unused." }));
    const request = changesIn(second)[0]?.request ?? "";

    page.doc.transact(() =>
      resolveProposals(page.blocks, (ref) => ref.request === request, "reject"),
    );
    await page.settled();

    expect(exactly(page)).toEqual(before);
  });

  // protects=Regenerate on the Answer that revised its own waiting text takes the revision back first, so the Mind is exactly as it was before it; fails_when=both versions stay, or the first is lost; no_claim=what the Answer written again does.
  test("Regenerate on the revising Answer brings back exactly what was there", async () => {
    const { page, before, regenerate } = await revised(() => ({
      text: "There is nothing to add.",
    }));

    await regenerate();

    expect(exactly(page)).toEqual(before);
  });

  // protects=a revision that only removed part of the waiting text is taken back by Regenerate too, in its place; fails_when=the removed section stays gone, or comes back elsewhere; no_claim=none beyond protects.
  test("Regenerate after removing part of it brings that part back in its place", async () => {
    let regenerating = false;
    const model = scriptedModel((call): ScriptedReply => {
      if (regenerating) return { text: "There is nothing to remove." };
      if (editPassage(call) !== null) return { text: "<why>Removed it.</why>" };
      if (asked(call).endsWith("write a page on tides")) {
        const content =
          "## Spring tides\n\nThey come at new moon.\n\n## Neap tides\n\nThey come at half moon.\n\n## Sources\n\nThe tide tables.";
        return called(call, "create_mind")
          ? { text: "It has three sections." }
          : { calls: [{ tool: "create_mind", input: { title: "Tide notes", content } }] };
      }
      return called(call, "edit_mind")
        ? { text: "The neap tides are out." }
        : {
            calls: [
              {
                tool: "edit_mind",
                input: { mind: "Tide notes", part: "Neap tides", instruction: "Remove it" },
              },
            ],
          };
    });
    const { core, mind } = await setUp(model);
    const first = await askAssistant(core, { text: "write a page on tides", mindId: mind.id });
    const page = await madeBy(core, first);
    await page.settled();
    const before = exactly(page);
    const second = await askAssistant(core, {
      text: "remove the part about neap tides",
      mindId: mind.id,
      conversationId: first.conversationId,
    });
    await page.settled();
    expect(shownWithChanges(page)).not.toContain("+ Neap tides");

    regenerating = true;
    const result = await core.regenerateConversationAnswer({
      conversationId: second.conversationId,
      answerId: second.id,
    });
    if (!result.asked) throw new Error("Not asked again.");
    await answerEnded(core, result.answerId);
    await page.settled();

    expect(exactly(page)).toEqual(before);
  });
});

describe("Asking again for a reply that claims a change", { timeout: 30_000 }, () => {
  const CLAIM = "I've added a risks section to “Q3 review”.";
  const ASKED_AGAIN = "but no Tool did that";

  /** The text an Answer showed as it streamed, delta by delta. */
  const shownDeltas = (core: Core) => {
    const deltas: string[] = [];
    core.on("answer.delta", (event) => deltas.push(event.text));
    return deltas;
  };

  // protects=the sentence that may claim a change waits until it is checked: the User never sees it before the honest reply replaces it, while the sentences before it show as they come; fails_when=the claim streams out first; no_claim=none beyond protects.
  test("the claim is held back until checked, and never shows", async () => {
    const model = scriptedModel(
      (call): ScriptedReply =>
        call.prompt.includes(ASKED_AGAIN)
          ? { text: "No section was added. Say if you'd like one." }
          : { text: `The supplier is late. ${CLAIM}` },
      { generate: (call) => claimCheckReply(call, [{ sentence: CLAIM, kind: "added" }]) },
    );
    const { core, mind } = await setUp(model);
    const deltas = shownDeltas(core);

    const answer = await askAssistant(core, { text: "what are the risks?", mindId: mind.id });

    expect(deltas.join("")).not.toContain("added a risks section");
    expect(deltas.join("")).toMatch(/^The supplier is late\. No section was added\./);
    expect(answer.text).toBe("No section was added. Say if you'd like one.");
    expect(answer.steps?.unbackedClaims).toBeUndefined();
  });

  // protects=when the request asking again fails, the first reply comes back, flagged; fails_when=the Answer fails, shows nothing, or shows the claim unflagged; no_claim=none beyond protects.
  test("a failed second request brings back the first reply, flagged", async () => {
    const model = scriptedModel(
      (call): ScriptedReply =>
        call.prompt.includes(ASKED_AGAIN)
          ? { error: { status: 400, message: "The request was malformed." } }
          : { text: CLAIM },
      { generate: (call) => claimCheckReply(call, [{ sentence: CLAIM, kind: "added" }]) },
    );
    const { core, mind } = await setUp(model);

    const answer = await askAssistant(core, { text: "add risks", mindId: mind.id });

    expect(answer.status).toBe("done");
    expect(answer.text).toBe(CLAIM);
    expect(answer.steps?.unbackedClaims).toEqual(["added"]);
  });

  // protects=when the provider refuses the request asking again, the first reply comes back, flagged; fails_when=it reads as a model without Tools, or the claim is unflagged; no_claim=none beyond protects.
  test("a refused second request brings back the first reply, flagged", async () => {
    const model = scriptedModel(
      (call): ScriptedReply =>
        call.prompt.includes(ASKED_AGAIN)
          ? { error: { status: 400, message: "tools are not supported by this model" } }
          : { text: CLAIM },
      { generate: (call) => claimCheckReply(call, [{ sentence: CLAIM, kind: "added" }]) },
    );
    const { core, mind } = await setUp(model);

    const answer = await askAssistant(core, { text: "add risks", mindId: mind.id });

    expect(answer.text).toBe(CLAIM);
    expect(answer.steps?.unbackedClaims).toEqual(["added"]);
  });

  // protects=Stop while the model is asked again keeps what the second reply showed and never the claim; fails_when=the claim is kept, or the Answer doesn't stop; no_claim=none beyond protects.
  test("Stop while it is asked again keeps no claim", async () => {
    let retrying: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      retrying = resolve;
    });
    const model = scriptedModel(
      (call): ScriptedReply => {
        if (!call.prompt.includes(ASKED_AGAIN)) return { text: CLAIM };
        retrying();
        return {
          text: "No section was added yet. Say if you'd like one.",
          pause: { after: 30, until: new Promise(() => undefined) },
        };
      },
      { generate: (call) => claimCheckReply(call, [{ sentence: CLAIM, kind: "added" }]) },
    );
    const { core, mind } = await setUp(model);
    const asked = await core.askInConversation({ text: "add risks", mindId: mind.id });
    if (!asked.asked) throw new Error("Not asked.");
    const ended = answerEnded(core, asked.answerId);
    await reached;

    await core.stopConversationAnswer({
      conversationId: asked.conversation.id,
      answerId: asked.answerId,
    });

    expect(await ended).toMatchObject({ payload: { status: "stopped" } });
    const { messages } = await core.getConversation(asked.conversation.id);
    const answer = messages.find((message) => message.id === asked.answerId);
    expect(answer?.kind === "answer" && answer.text).not.toContain("added a risks section");
  });
});

describe("The assistant's own text already in the Mind (#1061)", { timeout: 30_000 }, () => {
  // protects=“make the summary longer” after Add to note writes the longer summary over the added one, its new words added where they go, tagged as asked so it applies, in English and Chinese; fails_when=the longer text goes in beside the old one, the old one is removed whole, or the change isn't asked for; no_claim=that a real model chooses content over instruction.
  test.each([
    [
      "Make the summary longer.",
      "The paper is",
      "The paper is about spring tides.",
      "The paper is about spring tides, which come at new and full moon, when the tide rises highest.",
      "The paper is about spring tides{+, which come at new and full moon, when the tide rises highest+}.",
    ],
    [
      "把摘要写长一点。",
      "这篇论文讲的是",
      "这篇论文讲的是大潮。",
      "这篇论文讲的是大潮：大潮出现在新月和满月前后，这时潮水涨得最高。",
      "这篇论文讲的是大潮{+：大潮出现在新月和满月前后，这时潮水涨得最高+}。",
    ],
  ])(
    "“%s” writes over the summary added from an Answer, never adding a second",
    async (request, part, summary, longer, shown) => {
      const model = scriptedModel((call): ScriptedReply => {
        if (call.results.length > 0) return { text: "Done." };
        return {
          calls: [{ tool: "edit_mind", input: { part, content: longer } }],
        };
      });
      const { core, mind, client } = await setUp(model);
      await core.addToNote({
        mindId: mind.id,
        blocks: [{ type: "paragraph", content: [{ type: "text", text: summary }] }],
        origin: null,
        model: null,
      });
      await client.settled();

      const answer = await askAssistant(core, { text: request, mindId: mind.id });

      await client.settled();
      const [change] = changesIn(answer);
      expect(proposalRequestOf(client.doc, change?.request ?? "")).toMatchObject({
        requested: "edit",
      });
      expect(lastResult(model)).toContain("applies in the Mind at once");
      expect(lastResult(model)).toContain("don't repeat the new text");
      expect(shownWithChanges(client).slice(-2)).toEqual([
        "The quarter was very good, and sales were really strong.",
        shown,
      ]);
      client.doc.transact(() => resolveProposals(client.blocks, () => true, "accept"));
      await client.settled();
      expect(shownWithChanges(client)).toEqual([
        "Summary",
        "The quarter was very good, and sales were really strong.",
        longer,
      ]);
    },
  );

  // protects=a summary written anew over the one added from an Answer changes each paragraph where it stands and counts each once, in the Answer's record as in the Mind, the heading it keeps left as it is; fails_when=a paragraph is removed and added again, or counted twice (20 for 10 paragraphs written anew); no_claim=how a real model writes it (#1335, #1488).
  test.each([
    ["10 paragraphs written anew", 10, 10, 10, 10],
    ["10 paragraphs written anew as 12", 10, 12, 12, 12],
    ["one paragraph written anew as 10", 1, 10, 10, 10],
    ["10 paragraphs written anew as 8", 10, 8, 10, 10],
  ])(
    "%s is %i → %i, changed %i, with %i changes to accept",
    async (_, before, after, changed, waiting) => {
      const paragraphs = (count: number, say: string) =>
        Array.from({ length: count }, (_, index) => `${say} ${index + 1}.`);
      const old = paragraphs(before, "The quarter went to plan, as paragraph");
      const longer = paragraphs(after, "The quarter went to plan and then some, as paragraph");
      const model = scriptedModel((call): ScriptedReply => {
        if (call.results.length > 0) return { text: "Done." };
        return {
          calls: [
            {
              tool: "edit_mind",
              input: { part: "Tide notes", content: `## Tide notes\n\n${longer.join("\n\n")}` },
            },
          ],
        };
      });
      const { core, mind, client } = await setUp(model);
      await core.addToNote({
        mindId: mind.id,
        blocks: [
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Tide notes" }] },
          ...old.map((words) => ({ type: "paragraph", content: [{ type: "text", text: words }] })),
        ],
        origin: null,
        model: null,
      });
      await client.settled();

      const answer = await askAssistant(core, {
        text: "Make the summary longer.",
        mindId: mind.id,
      });

      await client.settled();
      const [change] = changesIn(answer);
      expect(change).toMatchObject({ changed, proposals: waiting });
      expect(waitingFrom(client, change?.request ?? "")).toBe(waiting);
    },
  );

  // protects=new text for the assistant's summary that leaves out a Citation tells the model so, as an instruction's rewrite does; fails_when=the Citation goes with no word to the model; no_claim=what the model then says.
  test("new text that leaves out a Citation of the summary says so to the model", async () => {
    const model = scriptedModel((call): ScriptedReply => {
      if (call.results.length > 0) return { text: "Done." };
      return {
        calls: [
          {
            tool: "edit_mind",
            input: {
              part: "The paper is about",
              content: "The paper is about spring tides, at new and full moon.",
            },
          },
        ],
      };
    });
    const { core, mind, client } = await setUp(model);
    await core.addToNote({
      mindId: mind.id,
      blocks: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "The paper is about spring tides." },
            { type: "citation", attrs: { documentId: "tides", quote: "spring tides" } },
          ],
        },
      ],
      origin: null,
      model: null,
    });
    await client.settled();

    await askAssistant(core, { text: "Make the summary longer.", mindId: mind.id });

    expect(lastResult(model)).toContain("1 Citation would be removed");
  });

  // protects=a formula the User put inside or between the assistant's paragraphs already in the Mind stays theirs: new text for those paragraphs is refused, and the Mind is left as it was; fails_when=“make the summary longer” deletes the formula with the summary; no_claim=formulas in the assistant's text still waiting.
  test.each([
    ["inside its paragraph", "The paper is about"],
    ["between its paragraphs", "Spring tides"],
  ])("a formula the User put %s keeps the summary from being written anew", async (_, part) => {
    const model = scriptedModel((call): ScriptedReply => {
      if (call.results.length > 0) return { text: "Done." };
      return {
        calls: [
          {
            tool: "edit_mind",
            input: { part, content: "The paper is about spring tides, at new and full moon." },
          },
        ],
      };
    });
    const { core, mind, client } = await setUp(model);
    const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
    const inline = part === "The paper is about";
    await core.addToNote({
      mindId: mind.id,
      blocks: inline
        ? [paragraph("The paper is about spring tides.")]
        : [
            { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: part }] },
            paragraph("Spring tides come at new and full moon."),
            paragraph("Neap tides come at the quarter moons."),
          ],
      origin: null,
      model: null,
    });
    await client.settled();
    client.doc.transact(() => {
      const formula = new Y.XmlElement(inline ? "inlineMath" : "blockMath");
      formula.setAttribute("latex", "h = a \\cos(\\omega t)");
      const last = client.blocks.get(client.blocks.length - 1);
      if (inline && last instanceof Y.XmlElement) last.insert(last.length, [formula]);
      else client.blocks.insert(client.blocks.length - 1, [formula]);
    });
    await client.settled();
    const before = exactly(client);

    const answer = await askAssistant(core, { text: "Make the summary longer.", mindId: mind.id });

    await client.settled();
    expect(mindCalls(answer)[0]?.mindProblem).toMatchObject({ kind: "content-not-own" });
    expect(exactly(client)).toEqual(before);
  });

  // protects=asked to make the summary longer, a longer version added beside the summary from an Answer is refused, with how to change it in place, and the change in place follows; fails_when=a second summary goes in, or the model isn't told to use edit_mind; no_claim=that a real model then changes it in place.
  test.each([
    [
      "in one paragraph",
      "The paper is about spring tides and the times they come at, new and full moon, when the tide rises highest.",
    ],
    [
      "split into paragraphs",
      "The paper looks at spring tides, new and full moon.\n\nThey come at the times the tide rises highest.",
    ],
  ])(
    "a longer version added beside it %s is refused, and the summary is changed in place",
    async (_, beside) => {
      const summary = "The paper is about spring tides and the times they come at.";
      const longer =
        "The paper is about spring tides and the times they come at, new and full moon, when the tide rises highest.";
      const told: string[] = [];
      const model = scriptedModel((call): ScriptedReply => {
        const results = call.results.map((each) => each.text);
        if (results.length === 0) {
          return { calls: [{ tool: "add_to_mind", input: { content: beside } }] };
        }
        if (results.length === 1) {
          told.push(results[0] ?? "");
          return {
            calls: [{ tool: "edit_mind", input: { part: "The paper is about", content: longer } }],
          };
        }
        return { text: "Done." };
      });
      const { core, mind, client } = await setUp(model);
      await core.addToNote({
        mindId: mind.id,
        blocks: [{ type: "paragraph", content: [{ type: "text", text: summary }] }],
        origin: null,
        model: null,
      });
      await client.settled();

      const answer = await askAssistant(core, {
        text: "Make the summary longer.",
        mindId: mind.id,
      });

      await client.settled();
      expect(told[0]).toContain("Change that text in place with edit_mind");
      expect(mindCalls(answer)[0]?.mindProblem).toMatchObject({ kind: "new-version" });
      client.doc.transact(() => resolveProposals(client.blocks, () => true, "accept"));
      await client.settled();
      expect(shownWithChanges(client)).toEqual([
        "Summary",
        "The quarter was very good, and sales were really strong.",
        longer,
      ]);
    },
  );
});
