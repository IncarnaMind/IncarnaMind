import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { type Core, GENERATED_MARK } from "../../src/core";
import { MIND_CONTENT_FIELD } from "../../src/core/api";
import { EDIT_INSTRUCTIONS, EDIT_INSTRUCTIONS_NAMED } from "../../src/core/edits/prompt";
import { waitingProblemOf } from "../../src/renderer/src/changeProblems";
import { resolveInEditor } from "../../src/renderer/src/editor/proposalReview";
import { waitsForUser } from "../../src/shared/askedChanges";
import { pendingProposals, proposalRequestOf, resolveProposals } from "../../src/shared/proposals";
import { askAssistant, changesIn, lastResult, mindCalls } from "../helpers/assistant";
import { answerEnded, answerJudged } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { boundEditor } from "../helpers/editor";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import {
  exactly,
  heading,
  note,
  readMind,
  resolveChanges,
  shownWithChanges,
  writeMind,
} from "../helpers/minds";
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
  [EDIT_INSTRUCTIONS, EDIT_INSTRUCTIONS_NAMED].includes(call.system)
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
      "- create_mind: made the Note “Tide notes” and proposed 2 changes, waiting for the User",
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
      /^Revised your own text in “Tide notes”.*applies in the Note at once/,
    );
    expect(second.steps?.unbackedClaims).toBeUndefined();
  });

  // protects=bold and italic of the assistant's waiting text survive "make it longer", and a * _ or ~ it holds as a character comes back as itself; fails_when=the label's asterisks land in the words, or price*volume*margin loses its stars; no_claim=how well a real model lengthens it.
  test.each([
    {
      name: "a bold label stays bold, and its new words are read as written",
      page: "## Summary\n\n**Role.** The post is senior.",
      seen: "**Role.** The post is senior.",
      reply: "## Summary\n\n**Role.** The post is senior and well paid.",
      shown: "+ Summary / + Role. The post is senior and well paid.",
      bold: ["Role."],
    },
    {
      name: "a star the User's words hold as a character is shown escaped and kept",
      page: "## Summary\n\nTotal = price\\*volume\\*margin, see note.",
      seen: "Total = price\\*volume\\*margin, see note.",
      reply: "## Summary\n\nTotal = price\\*volume\\*margin, see the note.",
      shown: "+ Summary / + Total = price*volume*margin, see the note.",
      bold: [],
    },
    {
      name: "a Chinese label beside a full-width colon stays bold, and the words beside it stay plain",
      page: "## Summary\n\n**上限：**每月五千元。",
      seen: "**上限：**每月五千元。",
      reply: "## Summary\n\n**上限：**每月五千元，含税。",
      shown: "+ Summary / + 上限：每月五千元，含税。",
      bold: ["上限："],
    },
  ])(
    "“make it longer” over waiting text: $name",
    async ({ page: content, seen, reply, shown, bold }) => {
      const passages: string[] = [];
      const model = scriptedModel((call): ScriptedReply => {
        const passage = editPassage(call);
        if (passage !== null) {
          passages.push(passage);
          return { text: `${reply}\n<why>Longer.</why>` };
        }
        if (asked(call).endsWith("write a summary page")) {
          return called(call, "create_mind")
            ? { text: "Made “Tide notes”." }
            : { calls: [{ tool: "create_mind", input: { title: "Tide notes", content } }] };
        }
        return called(call, "edit_mind")
          ? { text: "Lengthened the summary." }
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
      const made = await madeBy(core, first);
      await askAssistant(core, {
        text: "make the summary longer",
        mindId: mind.id,
        conversationId: first.conversationId,
      });

      await made.settled();
      expect(passages).toHaveLength(1);
      expect(passages[0]).toContain(seen);
      expect(shownWithChanges(made).join(" / ")).toBe(shown);
      const runs: { text: string; bold: boolean }[] = [];
      readMind(made).descendants((node) => {
        if (node.isText) {
          runs.push({
            text: node.text ?? "",
            bold: node.marks.some((mark) => mark.type.name === "bold"),
          });
        }
      });
      expect(runs.filter((run) => run.bold).map((run) => run.text)).toEqual(bold);
      expect(runs.map((run) => run.text).join("")).not.toMatch(/\*\*|\\/);
    },
  );

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

  // protects=a revision of the assistant's own waiting text whose reply names only the paragraph it changes is told the length of the whole text once revised, and isn't told the paragraphs it left as they were were taken out (#2356); fails_when=the heading it didn't name is reported as gone, or the length counts the reply alone; no_claim=how the model words its reply.
  test("a named revision of one paragraph is told the whole text's length, and what it left is not reported gone", async () => {
    const model = scriptedModel((call): ScriptedReply => {
      if (editPassage(call) !== null) {
        return { text: "¶2 They come at new moon and at full moon.\n<why>Says both.</why>" };
      }
      if (asked(call).endsWith("write a page on tides")) {
        const content = "## Spring tides\n\nThey come at new moon.";
        return called(call, "create_mind")
          ? { text: "Made “Tide notes”." }
          : { calls: [{ tool: "create_mind", input: { title: "Tide notes", content } }] };
      }
      return called(call, "edit_mind")
        ? { text: "Done." }
        : {
            calls: [
              {
                tool: "edit_mind",
                input: { mind: "Tide notes", part: "Spring tides", instruction: "Add full moon" },
              },
            ],
          };
    });
    const { core, mind } = await setUp(model);
    const first = await askAssistant(core, { text: "write a page on tides", mindId: mind.id });
    const page = await madeBy(core, first);

    await askAssistant(core, {
      text: "say they also come at full moon",
      mindId: mind.id,
      conversationId: first.conversationId,
    });

    await page.settled();
    expect(shownWithChanges(page)).toEqual([
      "+ Spring tides",
      "+ They come at new moon and at full moon.",
    ]);
    const told = lastResult(model);
    expect(told).toContain("from 7 to 11 words");
    expect(told).not.toContain("“Spring tides”");
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

  // protects=a Mind the assistant made from text with no heading of its own (the app puts the title above it) can be written anew as a whole by edit_mind with content, as it can when the text starts with its own heading; fails_when=it is refused because of the title heading, or the title is lost; no_claim=how well a real model lengthens it.
  test.each([
    {
      when: "while the first change still waits",
      accept: false,
      shown: ["+ Tide notes", "+ The paper is about spring tides, and how the moon drives them."],
    },
    {
      when: "after the first change applied",
      accept: true,
      shown: ["Tide notes", "The paper is about spring tides{+, and how the moon drives them+}."],
    },
  ])(
    "new text for a Mind made from text with no heading of its own, $when",
    async ({ accept, shown }) => {
      const longer = "The paper is about spring tides, and how the moon drives them.";
      const model = scriptedModel((call): ScriptedReply => {
        if (asked(call).endsWith("write a summary page")) {
          return called(call, "create_mind")
            ? { text: "Made “Tide notes”." }
            : {
                calls: [
                  {
                    tool: "create_mind",
                    input: { title: "Tide notes", content: "The paper is about spring tides." },
                  },
                ],
              };
        }
        return called(call, "edit_mind")
          ? { text: "Rewrote the summary in “Tide notes”." }
          : { calls: [{ tool: "edit_mind", input: { mind: "Tide notes", content: longer } }] };
      });
      const { core, mind } = await setUp(model);
      const first = await askAssistant(core, { text: "write a summary page", mindId: mind.id });
      const page = await madeBy(core, first);
      await page.settled();
      if (accept) {
        await resolveChanges(page, "accept");
        await page.settled();
      }

      const second = await askAssistant(core, {
        text: "make it longer",
        mindId: mind.id,
        conversationId: first.conversationId,
      });

      await page.settled();
      expect(lastResult(model)).not.toMatch(/Nothing was changed/);
      expect(shownWithChanges(page)).toEqual(shown);
      expect(changesIn(second)).toHaveLength(1);
    },
  );

  // protects=a title the User typed in or edited stays the User's text: new text over it is refused, with the reason; fails_when=the assistant's content replaces it; no_claim=none beyond protects.
  test("new text over a title the User edited is refused, and the title stays", async () => {
    const model = scriptedModel((call): ScriptedReply => {
      if (asked(call).endsWith("write a summary page")) {
        return called(call, "create_mind")
          ? { text: "Made “Tide notes”." }
          : {
              calls: [
                {
                  tool: "create_mind",
                  input: { title: "Tide notes", content: "The paper is about spring tides." },
                },
              ],
            };
      }
      return called(call, "edit_mind")
        ? { text: "It could not change the title." }
        : {
            calls: [
              {
                tool: "edit_mind",
                input: { mind: "Tide notes", content: "The paper is about neap tides." },
              },
            ],
          };
    });
    const { core, mind } = await setUp(model);
    const first = await askAssistant(core, { text: "write a summary page", mindId: mind.id });
    const page = await madeBy(core, first);
    await resolveChanges(page, "accept");
    await page.settled();
    const title = (page.blocks.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    page.doc.transact(() => title.insert(title.length, "!", { [GENERATED_MARK]: null }));
    await page.settled();

    await askAssistant(core, {
      text: "change it",
      mindId: mind.id,
      conversationId: first.conversationId,
    });

    await page.settled();
    expect(lastResult(model)).toMatch(/content only replaces your own text/);
    expect(shownWithChanges(page)).toEqual(["Tide notes!", "The paper is about spring tides."]);
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
              ? `${passage.replace(/\b(?:very|really) /g, "")}\n\n¶+ Added sentence.`
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
    const longA = `${"alpha ".repeat(16)}x`;
    const longB = `${"bravo ".repeat(16)}x`;
    const longC = "c".repeat(100);
    let rewrites = 0;
    const model = scriptedModel((call): ScriptedReply => {
      const passage = editPassage(call);
      if (passage !== null) {
        rewrites += 1;
        return {
          text:
            rewrites <= 2
              ? passage.replace(" x", "")
              : passage.replace(/\n\n(.+)$/s, "\n\n<removed>$1</removed>"),
        };
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
    // The summary's rewrite applies at once, so the refusal says so, and offers no Review (#2356).
    expect(edits[1]).toMatchObject({ status: "failed", mindProblem: { kind: "content-not-own" } });
    expect(lastResult(model)).toContain("they are not waiting for review");
    await client.settled();
    expect(shownWithChanges(client).at(-1)).toBe("Do not change this.");
    expect(shownWithChanges(client)).not.toContain("Everything replaced");
  });
});

describe("Changes it can't revise", { timeout: 30_000 }, () => {
  // protects=when the assistant can't act, its Answer offers Review (the waiting problem the Answer's line reads) and changes nothing: over changes the User asked for, nothing changes, the model is told to say so first and to point at Review under its reply, and the next Question knows it failed; fails_when=it changes the Mind another way, the problem isn't recorded, or the record says it worked; no_claim=how the model words it.
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
        ? {
            text: "The changes are waiting there; accept or reject them first. Review under my reply shows them.",
          }
        : { calls: [{ tool: "edit_mind", input: { instruction: "Shorten it" } }] };
    });
    const { core, mind, client } = await setUp(model);
    const first = await askAssistant(core, { text: "shorten the summary", mindId: mind.id });
    await client.settled();
    const before = shownWithChanges(client);
    const waiting = pendingProposals(client.blocks).map((each) => each.id);
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
    expect(lastResult(model)).toContain("Review under your reply shows them");
    expect(second.text).toContain("Review under my reply shows them");
    await client.settled();
    expect(shownWithChanges(client)).toEqual(before);
    expect(pendingProposals(client.blocks).map((each) => each.id)).toEqual(waiting);
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

  // protects=a Chinese Answer is told the Review control's Chinese label, 审阅, which its reply must name as the button reads; fails_when=the tool result names only the English Review; no_claim=how a real model words it.
  test("in Chinese, the refused change names the Review control 审阅", async () => {
    const model = scriptedModel((call): ScriptedReply => {
      const passage = editPassage(call);
      if (passage !== null) return { text: passage.replace(/\b(?:very|really) /g, "") };
      return called(call, "edit_mind")
        ? { text: "这些修改还在等待你确认。审阅在我回复的下方。" }
        : { calls: [{ tool: "edit_mind", input: { instruction: "缩短摘要" } }] };
    });
    const { core, mind, client } = await setUp(model);

    const first = await askAssistant(core, { text: "缩短摘要", mindId: mind.id });
    await client.settled();
    const second = await askAssistant(core, {
      text: "再短一点",
      mindId: mind.id,
      conversationId: first.conversationId,
    });

    expect(mindCalls(second)[0]).toMatchObject({
      status: "failed",
      mindProblem: { kind: "waiting" },
    });
    expect(lastResult(model)).toContain("审阅 under your reply shows them");
    expect(second.text).toContain("审阅");
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
  const HONEST = "I haven't changed “Q3 review” yet: say if you'd like a risks section.";

  // protects=a reply claiming a change no call made is asked for once more with the record, and the honest second reply is what the User reads, unflagged; fails_when=the claim stands, or the model isn't asked again; no_claim=that a real model corrects itself.
  test("is asked for once more, and the honest reply stands", async () => {
    let note = "";
    const model = scriptedModel(
      (call): ScriptedReply => {
        if (!call.prompt.includes(ASKED_AGAIN)) return { text: CLAIM };
        note = asked(call);
        return { text: HONEST };
      },
      { generate: (call) => claimCheckReply(call, [{ sentence: CLAIM, kind: "added" }]) },
    );
    const { core, mind, client } = await setUp(model);

    const answer = await askAssistant(core, { text: "add risks", mindId: mind.id });

    expect(model.doStreamCalls).toHaveLength(2);
    expect(note).toContain("<tool-record>");
    expect(note).toContain("- No Tool was called.");
    expect(note).toContain("Your reply says you added text to a Note, but no Tool did that.");
    expect(answer.text).toBe(HONEST);
    expect(answer.steps?.unbackedClaims).toBeUndefined();
    expect(pendingProposals(client.blocks)).toEqual([]);
  });

  // protects=a change that takes out most of the User's text reads as waiting to the claim check, so its claim is flagged and the model is asked again; fails_when=the record marks it applied (a `return true` in appliedAsAsked) and the claim stands; no_claim=how a real model words it.
  test("a held change isn't read as applied when its claim is checked", async () => {
    const claim = "I've shortened the summary in “Q3 review”.";
    const waiting = "The shortened summary waits for you to apply it.";
    let askedAgain = false;
    let sawWaiting = false;
    const model = scriptedModel(
      (call): ScriptedReply => {
        const passage = editPassage(call);
        if (passage !== null) return { text: "## Summary\n\nThe quarter was good." };
        if (call.prompt.includes(ASKED_AGAIN)) {
          askedAgain = true;
          return { text: waiting };
        }
        if (called(call, "edit_mind")) return { text: claim };
        return {
          calls: [{ tool: "edit_mind", input: { part: "Summary", instruction: "Shorten it" } }],
        };
      },
      {
        generate: (call) => {
          if (call.prompt.includes('"state": null')) sawWaiting = true;
          return claimCheckReply(call, (prompt) =>
            prompt.includes('"applied": true') ? [] : [{ sentence: claim, kind: "changed" }],
          );
        },
      },
    );
    const { core, mind } = await setUp(model);

    const answer = await askAssistant(core, { text: "shorten the summary", mindId: mind.id });

    expect(sawWaiting).toBe(true);
    expect(askedAgain).toBe(true);
    expect(answer.text).toBe(waiting);
    expect(answer.steps?.unbackedClaims).toBeUndefined();
  });

  // protects=the judge the core asks is sent the instructions that decide what counts and what it calls a Note, and the honest second reply is what the User reads; fails_when=the core stops sending one of those rules, or the claim stands; no_claim=how a real model judges.
  test("the judge is sent the instructions, through the core", async () => {
    let instructions = "";
    const model = scriptedModel(
      (call): ScriptedReply =>
        call.prompt.includes(ASKED_AGAIN) ? { text: HONEST } : { text: CLAIM },
      {
        generate: (call) => {
          if (call.prompt.includes("<tool-record>")) instructions = call.system;
          return claimCheckReply(call, [{ sentence: CLAIM, kind: "added" }]);
        },
      },
    );
    const { core, mind } = await setUp(model);

    const answer = await askAssistant(core, { text: "add risks", mindId: mind.id });

    expect(instructions).toContain("For every claim, about says what the sentence is about");
    expect(instructions).toContain(
      "Only a claim about a mind, the app, local_mode, keys, spending_cap, approval_rules or deleted_for_good counts.",
    );
    expect(instructions).toContain("The record's Tool names and fields say mind for a Note.");
    expect(instructions).not.toContain("A Note is called a Mind in the record.");
    expect(instructions).toContain(
      "A revision of text the assistant wrote into a Note earlier is a change",
    );
    expect(instructions).not.toContain("A revision of the assistant's own text is a change");
    expect(answer.text).toBe(HONEST);
    expect(answer.steps?.unbackedClaims).toBeUndefined();
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
      if (call.prompt.includes("Your reply is empty")) nudge = call.prompt;
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
      `- create_mind: made the Note “${PAGE}” and proposed 2 changes, waiting for the User`,
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

describe("Text the User turned down twice stays gone", { timeout: 30_000 }, () => {
  interface Words {
    mind: string;
    user: string;
    summary: string;
    section: string;
    risks: string;
    longer: string;
    adding: string;
    sayMore: string;
    nothing: string;
  }

  const WORDS: Record<"en" | "zh-CN", Words> = {
    en: {
      mind: "Q3 review",
      user: "The quarter was very good, and sales were really strong.",
      summary: "Summary",
      section: "Risks",
      risks: "## Risks\n\nLegal review may take longer.",
      longer: "## Risks\n\nLegal review may take longer than planned.",
      adding: "Add the risks to the Q3 review",
      sayMore: "Say more",
      nothing: "It is all there.",
    },
    "zh-CN": {
      mind: "第三季度复盘",
      user: "本季度表现很好，销售很强劲。",
      summary: "概述",
      section: "风险",
      risks: "## 风险\n\n法务审核可能更久。",
      longer: "## 风险\n\n法务审核可能比计划更久。",
      adding: "把风险加到第三季度复盘里",
      sayMore: "再详细一点",
      nothing: "都已经写好了。",
    },
  };

  // protects=a rejected revision whose earlier text the User then rejects too stays gone when its Answer is written again: the Mind is as it was after the second reject and nothing waits (#1903); fails_when=the rejected text comes back waiting; no_claim=what a real model writes again.
  for (const language of ["en", "zh-CN"] as const) {
    test(`after the revision and that text are rejected, writing it again changes nothing (${language})`, async () => {
      const { page, words, firstRequest, revisionRequest, regenerate } = await started(language);
      const beforeRejecting = exactly(page);
      const editor = boundEditor(page);

      const reject = async (request: string) => {
        const ids = new Set(
          pendingProposals(page.blocks)
            .filter((ref) => ref.request === request)
            .map((ref) => ref.id),
        );
        resolveInEditor(editor, ids, "reject");
        await page.settled();
      };
      const undo = async () => {
        editor.commands.undo();
        await page.settled();
      };
      const redo = async () => {
        editor.commands.redo();
        await page.settled();
      };

      // Reject all on the revising Answer's card: the first Answer's text comes back waiting.
      await reject(revisionRequest);
      expect(pendingProposals(page.blocks).some((ref) => ref.request === firstRequest)).toBe(true);
      expect(shownWithChanges(page)).toContain(`+ ${words.section}`);
      const restored = exactly(page);
      await undo();
      expect(exactly(page)).toEqual(beforeRejecting);
      // Reject all again after the Undo, as the User does: the earlier text comes back again.
      await reject(revisionRequest);
      expect(exactly(page)).toEqual(restored);
      await undo();
      expect(exactly(page)).toEqual(beforeRejecting);
      await redo();
      expect(exactly(page)).toEqual(restored);

      // Reject all on the first Answer's card: the risks are gone.
      await reject(firstRequest);
      expect(pendingProposals(page.blocks)).toEqual([]);
      expect(shownWithChanges(page)).not.toContain(`+ ${words.section}`);
      const gone = exactly(page);
      await undo();
      expect(exactly(page)).toEqual(restored);
      // Reject all again after the Undo: they are gone again.
      await reject(firstRequest);
      expect(exactly(page)).toEqual(gone);
      await undo();
      expect(exactly(page)).toEqual(restored);
      await redo();
      expect(exactly(page)).toEqual(gone);

      await regenerate();

      expect(pendingProposals(page.blocks)).toEqual([]);
      expect(exactly(page)).toEqual(gone);
    });
  }

  // protects=a revision rejected one change at a time keeps its record until its last change, so what it replaced is back afterwards, waiting; fails_when=the first rejection forgets the record and the earlier text is lost; no_claim=none beyond protects.
  test("rejecting the revision one change at a time still brings the earlier text back", async () => {
    const { page, words, firstRequest, revisionRequest, firstWaiting } = await started("en");
    const editor = boundEditor(page);
    const ids = pendingProposals(page.blocks)
      .filter((ref) => ref.request === revisionRequest)
      .map((ref) => ref.id);
    expect(ids.length).toBeGreaterThan(1);
    const [first, ...rest] = ids;
    if (!first) throw new Error("The revision has no changes.");
    resolveInEditor(editor, new Set([first]), "reject");
    await page.settled();
    // Another change of the revision still waits, so nothing of the text it replaced comes back yet.
    expect(pendingProposals(page.blocks).some((ref) => ref.request === revisionRequest)).toBe(true);
    expect(pendingProposals(page.blocks).some((ref) => ref.request === firstRequest)).toBe(false);
    for (const id of rest) {
      resolveInEditor(editor, new Set([id]), "reject");
      await page.settled();
    }
    expect(pendingProposals(page.blocks).some((ref) => ref.request === revisionRequest)).toBe(
      false,
    );
    expect(
      pendingProposals(page.blocks).filter((ref) => ref.request === firstRequest),
    ).toHaveLength(firstWaiting);
    expect(shownWithChanges(page)).toContain(`+ ${words.section}`);
  });

  /** The episode the issue names: an Answer adds waiting text to the User's Mind, and the same conversation's next Answer revises it. */
  async function started(language: "en" | "zh-CN") {
    const words = WORDS[language];
    let regenerating = false;
    const model = scriptedModel((call): ScriptedReply => {
      if (regenerating) return { text: words.nothing };
      if (asked(call).endsWith(words.adding)) {
        return called(call, "add_to_mind")
          ? { text: "Added them." }
          : {
              calls: [{ tool: "add_to_mind", input: { mind: words.mind, content: words.risks } }],
            };
      }
      return called(call, "edit_mind")
        ? { text: "Said more." }
        : {
            calls: [
              {
                tool: "edit_mind",
                input: { mind: words.mind, part: words.section, content: words.longer },
              },
            ],
          };
    });
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(model).createChatModel,
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    await core.updateSettings({ user: { language } });
    const mind = await core.createMind({ title: words.mind });
    const page = await connectToMind(core, mind.id);
    writeMind(page, [heading(2, words.summary), note(words.user)]);
    await page.settled();

    const first = await askAssistant(core, { text: words.adding, mindId: mind.id });
    const firstRequest = changesIn(first)[0]?.request ?? "";
    await page.settled();
    const firstWaiting = pendingProposals(page.blocks).filter(
      (ref) => ref.request === firstRequest,
    ).length;
    expect(firstWaiting).toBeGreaterThan(0);
    const second = await askAssistant(core, {
      text: words.sayMore,
      mindId: mind.id,
      conversationId: first.conversationId,
    });
    const revision = changesIn(second)[0];
    expect(revision).toMatchObject({ mindId: mind.id, revised: true });
    await page.settled();
    return {
      core,
      page,
      words,
      firstRequest,
      firstWaiting,
      revisionRequest: revision?.request ?? "",
      regenerate: async () => {
        regenerating = true;
        const result = await core.regenerateConversationAnswer({
          conversationId: second.conversationId,
          answerId: second.id,
        });
        if (!result.asked) throw new Error("Not asked again.");
        expect((await answerEnded(core, result.answerId)).event).toBe("finished");
        await page.settled();
      },
    };
  }
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
      expect(lastResult(model)).toContain("applies in the Note at once");
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
      // Its new words cite nothing, which is refused once (#1385): the model gives them again.
      const refused = call.results.some((each) => each.text.includes("cites nothing"));
      if (call.results.length > (refused ? 1 : 0)) return { text: "Done." };
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

describe("Reading the Note again in the turn that changed it", { timeout: 30_000 }, () => {
  const CASES = [
    {
      language: "English",
      title: "Q3 review",
      section: "Summary",
      ask: "Tidy the summary",
      text: "The quarter was very good, and sales were really strong.",
      applied: "The quarter was good, and sales were strong.",
      gone: ["very", "really"],
      held: "Strong.",
    },
    {
      language: "Chinese",
      title: "季度回顾",
      section: "摘要",
      ask: "整理摘要",
      text: "第三季度表现很好，销售额非常强劲。",
      applied: "第三季度表现好，销售额强劲。",
      gone: ["很好", "非常"],
      held: "强劲。",
    },
  ];

  /** One turn that changes the section to `rewritten` and reads the Note again in it. */
  async function readAgain(c: (typeof CASES)[number], rewritten: string) {
    const seen: string[] = [];
    const model = scriptedModel((call): ScriptedReply => {
      if (editPassage(call) !== null) return { text: `¶2 ${rewritten}\n<why>Shorter.</why>` };
      if (!called(call, "edit_mind")) {
        return {
          calls: [
            { tool: "edit_mind", input: { mind: c.title, part: c.section, instruction: c.ask } },
          ],
        };
      }
      if (!called(call, "read_mind")) {
        return { calls: [{ tool: "read_mind", input: { mind: c.title } }] };
      }
      seen.push(call.results.find((each) => each.tool === "read_mind")?.text ?? "");
      return { text: c.language === "Chinese" ? "已改好。" : "Done." };
    });
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(model).createChatModel,
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const mind = await core.createMind({ title: c.title });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [heading(2, c.section), note(c.text)]);
    await client.settled();
    await askAssistant(core, { text: c.ask, mindId: mind.id });
    await client.settled();
    return { client, seen };
  }

  // protects=read again in the turn that made it, a change the window applies at once reads as applied, its words as text and its removed words gone, though its marks are still there; fails_when=the read says the change waits, as if the window hadn't taken it in yet; no_claim=how a real model words its reply.
  test.each(CASES)("a change that applies at once reads as applied: $language", async (c) => {
    const { client, seen } = await readAgain(c, c.applied);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(c.applied);
    expect(seen[0]).not.toContain("waiting change");
    for (const words of c.gone) expect(seen[0]).not.toContain(words);
    // The window may not have taken it in: its marks are still in the Note as it reads.
    expect(pendingProposals(client.blocks).length).toBeGreaterThan(0);
  });

  // protects=a change the window holds for the User still reads as waiting in the turn that made it, in English and Chinese; fails_when=the read shows it as applied before they accept it; no_claim=none.
  test.each(CASES)("a change held for the User still reads as waiting: $language", async (c) => {
    const { client, seen } = await readAgain(c, c.held);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("[waiting change, removes:");
    expect(seen[0]).toContain("[waiting change, adds:");
    expect(seen[0]).toContain(c.held);
    expect(pendingProposals(client.blocks).length).toBeGreaterThan(0);
  });
});

describe("New text coming in over the assistant's own text (#1635)", { timeout: 30_000 }, () => {
  const paragraphs = (count: number, say: string) =>
    Array.from({ length: count }, (_, index) => `${say} ${index + 1}.`);
  const OLD = paragraphs(3, "The quarter went to plan, as paragraph");
  const NEW = paragraphs(4, "The quarter went to plan and then some, as paragraph");
  const CONTENT = `## Tide notes\n\n${NEW.join("\n\n")}`;

  /** The Note as it reads once every change in it is accepted: what the window draws of changes it applies at once. */
  const applied = (client: MindClient): string[] => {
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(client.doc));
    const blocks = copy.getXmlFragment(MIND_CONTENT_FIELD);
    copy.transact(() => resolveProposals(blocks, () => true, "accept"));
    const lines = shownWithChanges({ blocks });
    copy.destroy();
    return lines;
  };

  /**
   * "Make the summary longer." over a summary added from an Answer, its new text held once its
   * third paragraph has begun (or `holdAt` characters of its input are out) until `release`, or
   * `fail`, or given whole with `streamed` false; `prepare` runs before it is asked.
   */
  async function longer({
    streamed = true,
    input = { part: "Tide notes", content: CONTENT } as Record<string, unknown>,
    holdAt = JSON.stringify(input).indexOf(NEW[2] as string) + 4,
    prepare = async (_core: Core, _client: MindClient): Promise<void> => {},
  } = {}) {
    let release = () => {};
    let fail = (_error: Error) => {};
    const held = new Promise<void>((resolve, reject) => {
      release = resolve;
      fail = reject;
    });
    const model = scriptedModel((call): ScriptedReply => {
      if (call.results.length > 0) return { text: "Done." };
      if (!streamed) return { calls: [{ tool: "edit_mind", input }] };
      return {
        calls: [{ tool: "edit_mind", input, streamInput: true }],
        pause: { after: holdAt, until: held },
      };
    });
    const { core, mind, client } = await setUp(model);
    await core.addToNote({
      mindId: mind.id,
      blocks: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Tide notes" }] },
        ...OLD.map((words) => ({ type: "paragraph", content: [{ type: "text", text: words }] })),
      ],
      origin: null,
      model: null,
    });
    await client.settled();
    await prepare(core, client);
    const before = exactly(client);
    const seen: string[][] = [];
    client.blocks.observeDeep(() => seen.push(applied(client)));
    const asked = await core.askInConversation({
      text: "Make the summary longer.",
      mindId: mind.id,
    });
    if (!asked.asked) throw new Error("Not asked.");
    return { core, model, client, before, seen, asked, release, fail };
  }

  // protects=each paragraph of edit_mind's new text over the summary added from an Answer takes the place of the next old one as the model writes it, so the Note as the window draws it never holds both versions, and the call ends exactly as the same call made whole, in one step (#1635); fails_when=nothing changes until the call is whole, the new text shows below the old, the Note grows past its longer version, or the old summary shows again between the last paragraph and the end; no_claim=how a real model orders its input.
  test("each finished paragraph takes the place of the next old one, and the end is the whole call's", async () => {
    const whole = await longer({ streamed: false });
    whole.release();
    await answerEnded(whole.core, whole.asked.answerId);
    await whole.client.settled();
    const { core, client, seen, asked, release } = await longer();

    await expect
      .poll(() => applied(client).slice(-4))
      .toEqual(["Tide notes", NEW[0], NEW[1], OLD[2]]);
    release();
    expect((await answerEnded(core, asked.answerId)).event).toBe("finished");
    await client.settled();

    expect(shownWithChanges(client)).toEqual(shownWithChanges(whole.client));
    expect(applied(client).slice(-5)).toEqual(["Tide notes", ...NEW]);
    const lengths = seen.map((lines) => lines.length);
    expect(Math.max(...lengths)).toBe(applied(client).length);
    const first = seen.findIndex((lines) => lines.includes(NEW[0] as string));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(seen.slice(first).some((lines) => lines.includes(OLD[0] as string))).toBe(false);
  });

  // protects=a model that names the part after the content, as Claude and DeepSeek often do: the content waits for the part, then all that has come goes in its place, and the call ends as the same call made whole (#1635); fails_when=nothing comes in until the call has all of its input, its last paragraph waits for the call, or text comes in before the part says where; no_claim=how often a model orders its input so.
  test("named after the content, the part is waited for, then what came in takes the old text's place", async () => {
    const input = { content: CONTENT, part: "Tide notes", removes_only: false };
    const whole = await longer({ streamed: false, input });
    whole.release();
    await answerEnded(whole.core, whole.asked.answerId);
    await whole.client.settled();
    const { core, client, seen, asked, release } = await longer({
      input,
      holdAt: JSON.stringify(input).indexOf('"removes_only"'),
    });

    await expect.poll(() => applied(client).slice(-5)).toEqual(["Tide notes", ...NEW]);
    release();
    expect((await answerEnded(core, asked.answerId)).event).toBe("finished");
    await client.settled();

    expect(
      seen.some((lines) => lines.includes(NEW[0] as string) && lines.includes(OLD[2] as string)),
    ).toBe(false);
    expect(shownWithChanges(client)).toEqual(shownWithChanges(whole.client));
  });

  /** A second Note, "Harbour log", holding the same summary added from an Answer. */
  async function harbourLog(core: Core) {
    const other = await core.createMind({ title: "Harbour log" });
    await core.addToNote({
      mindId: other.id,
      blocks: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Tide notes" }] },
        ...OLD.map((words) => ({ type: "paragraph", content: [{ type: "text", text: words }] })),
      ],
      origin: null,
      model: null,
    });
    const client = await connectToMind(core, other.id);
    await client.settled();
    return { id: other.id, client };
  }

  // protects=a Note named after the text has come, when it isn't the Note in focus the text went into, takes that text back at once, before the call runs, and the call writes the whole text in the Note it names (#1635); fails_when=the text stays in the Note in focus until the call runs, or the Note named is never written; no_claim=that a model names the Note so late, which none measured did.
  test("a Note named after the text came in, as another, takes it back at once, and the call writes the Note it names", async () => {
    const input = {
      part: "Tide notes",
      content: CONTENT,
      mind: "Harbour log",
      removes_only: false,
    };
    let other: { id: string; client: MindClient } | null = null;
    const { core, client, before, seen, asked, release } = await longer({
      input,
      holdAt: JSON.stringify(input).indexOf('"removes_only"'),
      prepare: async (core) => {
        other = await harbourLog(core);
      },
    });
    if (!other) throw new Error("No Harbour log.");
    const { id: logId, client: log }: { id: string; client: MindClient } = other;

    await expect.poll(() => seen.some((lines) => lines.includes(NEW[0] as string))).toBe(true);
    await expect.poll(() => exactly(client)).toEqual(before);
    release();
    expect((await answerEnded(core, asked.answerId)).event).toBe("finished");
    await client.settled();
    await log.settled();

    expect(exactly(client)).toEqual(before);
    expect(applied(log).slice(-5)).toEqual(["Tide notes", ...NEW]);
    const [call] = mindCalls(await answerJudged(core, asked.conversation.id, asked.answerId));
    expect(call?.mindChange).toMatchObject({ mindId: logId });
    expect(call?.mindProblem).toBeUndefined();
  });

  // protects=two edit_mind calls in one step, each over its own text, each come in and end as their calls made whole: neither takes the other's text back, and neither card says it was stopped (#1635); fails_when=one call's new text goes back to the old while the other's comes in or runs, or a call that changed its text also reports a stop; no_claim=how often a model makes two such calls at once.
  test("two calls in one step each come in over their own text, and neither takes the other's back", async () => {
    const HARBOUR = paragraphs(3, "The harbour stayed calm, as paragraph");
    const HARBOUR_NEW = paragraphs(4, "The harbour stayed calm all season, as paragraph");
    const first = { part: "Tide notes", content: CONTENT };
    const second = {
      part: "Harbour notes",
      content: `## Harbour notes\n\n${HARBOUR_NEW.join("\n\n")}`,
    };
    const model = scriptedModel((call): ScriptedReply => {
      if (call.results.length > 0) return { text: "Done." };
      return {
        calls: [
          { tool: "edit_mind", input: first, streamInput: true },
          { tool: "edit_mind", input: second, streamInput: true },
        ],
      };
    });
    const { core, mind, client } = await setUp(model);
    for (const [title, words] of [
      ["Tide notes", OLD],
      ["Harbour notes", HARBOUR],
    ] as const) {
      await core.addToNote({
        mindId: mind.id,
        blocks: [
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: title }] },
          ...words.map((each) => ({ type: "paragraph", content: [{ type: "text", text: each }] })),
        ],
        origin: null,
        model: null,
      });
    }
    await client.settled();
    const seen: string[][] = [];
    client.blocks.observeDeep(() => seen.push(applied(client)));

    const answer = await askAssistant(core, {
      text: "Make both summaries longer.",
      mindId: mind.id,
    });
    await client.settled();

    const calls = mindCalls(answer);
    expect(calls).toHaveLength(2);
    for (const each of calls) {
      expect(each.mindProblem).toBeUndefined();
      expect(each.mindChange).toMatchObject({ request: expect.any(String) });
    }
    expect(applied(client)).toEqual(expect.arrayContaining([...NEW, ...HARBOUR_NEW]));
    const came = seen.findIndex((lines) => lines.includes(NEW[0] as string));
    expect(came).toBeGreaterThanOrEqual(0);
    expect(seen.slice(came).some((lines) => lines.includes(OLD[0] as string))).toBe(false);
  });

  // protects=an edit_mind call whose input is refused, so never runs, takes back what it streamed in as its step ends: the Answer that then replies with nothing ends as the same Answer would with no streaming, and the Note is as it was (#1635); fails_when=the text that came in still counts as a change when the Answer decides how it ended; no_claim=what the reply says.
  test("a call that never ran counts as no change when the Answer replies with nothing", async () => {
    const ended = async (streamInput: boolean) => {
      const model = scriptedModel((call): ScriptedReply => {
        if (call.results.length > 0) return { text: "" };
        return {
          calls: [
            {
              tool: "edit_mind",
              input: { part: "Tide notes", content: CONTENT, unknown: true },
              streamInput,
            },
          ],
        };
      });
      const { core, mind, client } = await setUp(model);
      await core.addToNote({
        mindId: mind.id,
        blocks: [
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Tide notes" }] },
          ...OLD.map((words) => ({ type: "paragraph", content: [{ type: "text", text: words }] })),
        ],
        origin: null,
        model: null,
      });
      await client.settled();
      const before = exactly(client);
      const seen: string[][] = [];
      client.blocks.observeDeep(() => seen.push(applied(client)));
      const asked = await core.askInConversation({
        text: "Make the summary longer.",
        mindId: mind.id,
      });
      if (!asked.asked) throw new Error("Not asked.");
      const { event } = await answerEnded(core, asked.answerId);
      await client.settled();
      return {
        event,
        same: JSON.stringify(exactly(client)) === JSON.stringify(before),
        came: seen.some((lines) => lines.includes(NEW[0] as string)),
      };
    };

    const whole = await ended(false);
    const streamed = await ended(true);

    expect(streamed.came).toBe(true);
    expect(streamed).toEqual({ ...whole, came: true });
    expect(streamed.same).toBe(true);
  });

  // protects=new text for a Note out of focus whose title is close to another's doesn't come in before the User is asked which Note they meant, and goes into the one they pick (#1635, #1865); fails_when=the text shows in the Note the model named before the User picks; no_claim=the question's words.
  test("over a Note the User is asked about first, nothing comes in before they pick", async () => {
    const input = { mind: "Tide log", part: "Tide notes", content: CONTENT };
    const model = scriptedModel((call): ScriptedReply => {
      if (call.results.length > 0) return { text: "Done." };
      return { calls: [{ tool: "edit_mind", input, streamInput: true }] };
    });
    const { core } = await setUp(model);
    const log = await core.createMind({ title: "Tide log" });
    await core.createMind({ title: "Tide log (draft)" });
    await core.addToNote({
      mindId: log.id,
      blocks: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Tide notes" }] },
        ...OLD.map((words) => ({ type: "paragraph", content: [{ type: "text", text: words }] })),
      ],
      origin: null,
      model: null,
    });
    const client = await connectToMind(core, log.id);
    await client.settled();
    const before = JSON.stringify(exactly(client));
    const changedWhenAsked: boolean[] = [];
    core.on("question.asked", (request) => {
      changedWhenAsked.push(JSON.stringify(exactly(client)) !== before);
      void core.answerUserQuestion(request.requestId, {
        skipped: false,
        chosen: ["Tide log"],
        wrote: null,
      });
    });

    await askAssistant(core, { text: "Make the summary in my Tide log longer." });
    await client.settled();

    expect(changedWhenAsked).toEqual([false]);
    expect(applied(client).slice(-5)).toEqual(["Tide notes", ...NEW]);
  });

  // protects=an instruction given beside the content doesn't stop it coming in: the call writes the content, so its paragraphs take the old ones' places as they are written, and the end is the same call's made whole (#1635); fails_when=the content waits for the whole call because an instruction is there too; no_claim=what a model means by giving both.
  test("with an instruction beside it, the content still comes in as it is written", async () => {
    const input = { part: "Tide notes", instruction: "Make it longer.", content: CONTENT };
    const whole = await longer({ streamed: false, input });
    whole.release();
    await answerEnded(whole.core, whole.asked.answerId);
    await whole.client.settled();
    const { core, client, asked, release } = await longer({ input });

    await expect
      .poll(() => applied(client).slice(-4))
      .toEqual(["Tide notes", NEW[0], NEW[1], OLD[2]]);
    release();
    expect((await answerEnded(core, asked.answerId)).event).toBe("finished");
    await client.settled();

    expect(shownWithChanges(client)).toEqual(shownWithChanges(whole.client));
  });

  // protects=new text over the assistant's own text still waiting from an earlier Answer takes its place paragraph by paragraph too, and ends as one revision, its Checkpoint saved once (#1635); fails_when=the old waiting text stays below the new until the end, the end differs from the whole call's, or each paragraph saves a Checkpoint; no_claim=none beyond protects.
  test("over its own waiting text, each paragraph takes the next old one's place, with one Checkpoint", async () => {
    const page = `## Summary\n\n${OLD.join("\n\n")}`;
    const input = {
      mind: "Tide notes",
      part: "Summary",
      content: `## Summary\n\n${NEW.join("\n\n")}`,
    };
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = scriptedModel((call): ScriptedReply => {
      if (asked(call).endsWith("write a summary page")) {
        return called(call, "create_mind")
          ? { text: "It covers the quarter." }
          : { calls: [{ tool: "create_mind", input: { title: "Tide notes", content: page } }] };
      }
      if (called(call, "edit_mind")) return { text: "It says more now." };
      return {
        calls: [{ tool: "edit_mind", input, streamInput: true }],
        pause: { after: JSON.stringify(input).indexOf(NEW[2] as string) + 4, until: held },
      };
    });
    const { core, mind } = await setUp(model);
    const first = await askAssistant(core, { text: "write a summary page", mindId: mind.id });
    const made = await madeBy(core, first);
    const pageId = changesIn(first)[0]?.mindId ?? "";
    const checkpoints = (await core.listCheckpoints(pageId)).checkpoints.length;

    const second = askAssistant(core, {
      text: "make it longer",
      mindId: mind.id,
      conversationId: first.conversationId,
    });
    await expect
      .poll(() => shownWithChanges(made))
      .toEqual(["+ Summary", `+ ${NEW[0]}`, `+ ${NEW[1]}`, `+ ${OLD[2]}`]);
    release();
    const answer = await second;

    await made.settled();
    expect(shownWithChanges(made)).toEqual(["+ Summary", ...NEW.map((each) => `+ ${each}`)]);
    expect(changesIn(answer)).toEqual([expect.objectContaining({ revised: true, proposals: 5 })]);
    expect((await core.listCheckpoints(pageId)).checkpoints).toHaveLength(checkpoints + 1);
  });

  // protects=Stop while edit_mind's new text comes in over the assistant's own waiting text puts that text back exactly, still waiting as the earlier Answer's (#1635); fails_when=the old waiting text is lost, comes back changed, or part of the new text stays; no_claim=none beyond protects.
  test("Stop while the new text comes in over its own waiting text puts that text back exactly", async () => {
    const page = `## Summary\n\n${OLD.join("\n\n")}`;
    const input = {
      mind: "Tide notes",
      part: "Summary",
      content: `## Summary\n\n${NEW.join("\n\n")}`,
    };
    const model = scriptedModel((call): ScriptedReply => {
      if (asked(call).endsWith("write a summary page")) {
        return called(call, "create_mind")
          ? { text: "It covers the quarter." }
          : { calls: [{ tool: "create_mind", input: { title: "Tide notes", content: page } }] };
      }
      return {
        calls: [{ tool: "edit_mind", input, streamInput: true }],
        pause: {
          after: JSON.stringify(input).indexOf(NEW[2] as string) + 4,
          until: new Promise(() => undefined),
        },
      };
    });
    const { core, mind } = await setUp(model);
    const first = await askAssistant(core, { text: "write a summary page", mindId: mind.id });
    const made = await madeBy(core, first);
    await made.settled();
    const before = exactly(made);
    const second = await core.askInConversation({
      text: "make it longer",
      mindId: mind.id,
      conversationId: first.conversationId,
    });
    if (!second.asked) throw new Error("Not asked.");
    await expect.poll(() => shownWithChanges(made)).toContain(`+ ${NEW[1]}`);

    const ended = answerEnded(core, second.answerId);
    await core.stopConversationAnswer({
      conversationId: second.conversation.id,
      answerId: second.answerId,
    });
    await ended;
    await made.settled();

    expect(exactly(made)).toEqual(before);
  });

  // protects=new text that came in and is refused once whole (here, off the length asked for) is taken back, and the Note is exactly as it was (#1635); fails_when=the paragraphs that came in stay; no_claim=the refusal's words.
  test("refused once whole, what came in is taken back", async () => {
    const { core, client, before, asked, release } = await longer({
      input: { part: "Tide notes", content: CONTENT, times_as_long: 3 },
    });
    await expect.poll(() => applied(client)).toContain(NEW[1]);
    release();
    await answerEnded(core, asked.answerId);
    await client.settled();

    const answer = await answerJudged(core, asked.conversation.id, asked.answerId);
    expect(mindCalls(answer)[0]?.mindProblem).toMatchObject({ kind: "length" });
    expect(exactly(client)).toEqual(before);
  });

  // protects=an edit_mind call whose input is refused never runs: what it streamed in is taken back before the model's next call reads the Note, so the call it tries again works on the text as it was (#1635); fails_when=the half-new text stays, so the next call is refused or measures the wrong text; no_claim=which inputs a provider refuses.
  test("a call whose input is refused never runs, and what it streamed in goes before the next call", async () => {
    const valid = { part: "Tide notes", content: CONTENT };
    const model = scriptedModel((call): ScriptedReply => {
      if (call.results.length === 0) {
        return {
          calls: [{ tool: "edit_mind", input: { ...valid, unknown: true }, streamInput: true }],
        };
      }
      if (call.results.length === 1) return { calls: [{ tool: "edit_mind", input: valid }] };
      return { text: "Done." };
    });
    const whole = await longer({ streamed: false });
    whole.release();
    await answerEnded(whole.core, whole.asked.answerId);
    await whole.client.settled();
    const { core, mind, client } = await setUp(model);
    await core.addToNote({
      mindId: mind.id,
      blocks: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Tide notes" }] },
        ...OLD.map((words) => ({ type: "paragraph", content: [{ type: "text", text: words }] })),
      ],
      origin: null,
      model: null,
    });
    await client.settled();
    const seen: string[][] = [];
    client.blocks.observeDeep(() => seen.push(applied(client)));

    const answer = await askAssistant(core, { text: "Make the summary longer.", mindId: mind.id });

    await client.settled();
    expect(
      seen.some((lines) => lines.includes(NEW[0] as string) && lines.includes(OLD[2] as string)),
    ).toBe(true);
    const [, retried] = mindCalls(answer);
    expect(retried?.mindProblem).toBeUndefined();
    expect(retried?.mindChange).toMatchObject({ request: expect.any(String) });
    expect(shownWithChanges(client)).toEqual(shownWithChanges(whole.client));
  });

  // protects=what the User types into edit_mind's new text while it comes in stays theirs: nothing more is written over it, the old text after it stays, and the model is told the text changed (#1635); fails_when=the typed words are taken back with the new text, or the rest of the old text is lost; no_claim=how the model then replies.
  test("words the User types into the new text while it comes stay, and nothing more is written", async () => {
    const { core, client, asked, release } = await longer();
    await expect.poll(() => applied(client)).toContain(NEW[1]);
    client.doc.transact(() => {
      const first = client.blocks.get(3);
      const text = first instanceof Y.XmlElement ? first.get(0) : null;
      if (text instanceof Y.XmlText) text.insert(0, "Typed by me. ");
    });
    await client.settled();
    release();
    await answerEnded(core, asked.answerId);
    await client.settled();

    const answer = await answerJudged(core, asked.conversation.id, asked.answerId);
    expect(mindCalls(answer)[0]?.mindProblem).toMatchObject({ kind: "changed" });
    expect(applied(client).slice(-4)).toEqual([
      "Tide notes",
      `Typed by me. ${NEW[0]}`,
      NEW[1],
      OLD[2],
    ]);
  });

  // protects=Stop that comes while a paragraph of the new text is going in, as the Note's change is announced, still finds it and takes it back: the Note is exactly as it was (#1635); fails_when=the paragraph written as Stop came stays in the Note; no_claim=how soon the window's Stop arrives.
  test("Stop as a paragraph goes in still takes it back", async () => {
    let answer: { conversationId: string; answerId: string } | null = null;
    let stopped = false;
    const { core, client, before, asked, release } = await longer({
      prepare: async (core, client) => {
        core.on("answer.started", (event) => {
          answer ??= { conversationId: event.conversationId ?? "", answerId: event.answerId };
        });
        core.on("mind.update", () => {
          if (stopped || !answer || !applied(client).includes(NEW[0] as string)) return;
          stopped = true;
          void core.stopConversationAnswer(answer);
        });
      },
    });
    await answerEnded(core, asked.answerId);
    release();
    await client.settled();

    expect(stopped).toBe(true);
    expect(exactly(client)).toEqual(before);
  });

  // protects=Stop, or a model that fails, while edit_mind's new text is coming takes back what came: the Note is exactly as it was, and the card claims no change for the window to apply (#1635); fails_when=part of the new text stays in place of the old, or a change is claimed; no_claim=the words of the stop or the failure.
  test.each(["stop", "fail"] as const)(
    "%s while the new text comes leaves the Note exactly as it was",
    async (how) => {
      const { core, client, before, asked, release, fail } = await longer();
      await expect.poll(() => applied(client)).toContain(NEW[1]);
      const ended = answerEnded(core, asked.answerId);
      if (how === "stop") {
        await core.stopConversationAnswer({
          conversationId: asked.conversation.id,
          answerId: asked.answerId,
        });
        release();
      } else fail(new Error("The connection dropped."));
      await ended;
      await client.settled();

      expect(exactly(client)).toEqual(before);
      const { messages } = await core.getConversation(asked.conversation.id);
      const answer = messages.find((message) => message.id === asked.answerId);
      expect(answer?.kind === "answer" && changesIn(answer)).toEqual([]);
    },
  );
});
