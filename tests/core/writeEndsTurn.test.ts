import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { ConversationAnswer, Core } from "../../src/core";
import { CLAIM_CHECK_INSTRUCTIONS } from "../../src/core/answers/claimedChanges";
import { changedMinds } from "../../src/renderer/src/changedMinds";
import { askedFor } from "../../src/shared/askedChanges";
import { INLINE_NODE } from "../../src/shared/sentences";
import { askAssistant, changesIn, mindCalls } from "../helpers/assistant";
import { checkReply, isCheckRun, type Plan } from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { connectToMind } from "../helpers/mindClient";
import { note, writeMind } from "../helpers/minds";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

/**
 * A write that does all the User asked ends the Answer with what it wrote, and no reply after it
 * (#1635): the model says so with `done` on the call, and the call's result has nothing left to
 * tell. Otherwise the model replies as before. Through the core's public interface as the
 * assistant asks, on a scripted model: whether a real model sets `done` rightly is measured by
 * `npm run eval:speed` (eval/speed/README.md).
 */

const MOON = "Spring tides come at new and full moon";
const UNBACKED = "Neap tides are twice as strong";
const TIDES = [{ name: "Tides.md", contents: `# Tides\n\n${MOON}.\n` }];
const PLANS: Record<string, Plan> = {
  [`${MOON} ${INLINE_NODE}.`]: { verdict: "supported", quote: MOON, says: MOON },
  [`${MOON} ${INLINE_NODE}. It also covers neap tides.`]: {
    verdict: "supported",
    quote: MOON,
    says: MOON,
  },
};
const REPLY = "I added the tides line to your notes.";
const WRITES: ReadonlySet<string> = new Set(["add_to_mind", "create_mind", "edit_mind"]);

const called = (call: ModelCall, tool: string) => call.results.some((each) => each.tool === tool);

/** The text of the last user message of a request: the Question it answers. */
const askedIn = ({ options }: ModelCall): string => {
  const last = options.prompt.filter((message) => message.role === "user").at(-1);
  if (!last) return "";
  return typeof last.content === "string"
    ? last.content
    : last.content.map((part) => ("text" in part ? part.text : "")).join("");
};

const citeMoon = (call: ModelCall, marker = 1) => {
  const shown = call.results
    .filter((each) => each.tool === "search_documents")
    .flatMap((each) => shownPassages(each.text));
  return {
    tool: "cite",
    input: { citations: [{ marker, passage: shown[0]?.id ?? "", quote: MOON }] },
  };
};

/**
 * A model that searches, cites the moon line, then makes each step of `writes` in turn (by how
 * many write calls it has made in this Answer), then replies; it checks a sentence as `PLANS` say.
 */
function writing(writes: (question: string) => readonly ScriptedReply[]) {
  const answerCalls: ModelCall[] = [];
  const model = scriptedModel((call): ScriptedReply => {
    if (isCheckRun(call)) return checkReply(call, PLANS);
    answerCalls.push(call);
    if (!called(call, "search_documents")) {
      return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
    }
    if (!called(call, "cite")) return { calls: [citeMoon(call)] };
    const made = call.results.filter((each) => WRITES.has(each.tool)).length;
    return writes(askedIn(call))[made] ?? { text: REPLY };
  });
  return { model, answerCalls };
}

const add = (input: Record<string, unknown>): ScriptedReply => ({
  calls: [{ tool: "add_to_mind", input }],
});

async function notes(model: MockLanguageModelV4) {
  const { core, mind, client } = await setUpWithDocuments(model, TIDES);
  writeMind(client, [note("Notes on the tides.")]);
  await client.settled();
  return { core, mindId: mind.id };
}

const claimChecks = (model: MockLanguageModelV4) =>
  model.doGenerateCalls.filter((call) =>
    call.prompt.some(
      (message) => message.role === "system" && message.content.includes(CLAIM_CHECK_INSTRUCTIONS),
    ),
  ).length;

/** What the step list and the change card read of an Answer: its calls, phases and change. */
const shownOf = (answer: ConversationAnswer) => ({
  calls: mindCalls(answer).map((call) => ({ tool: call.tool, status: call.status })),
  rows: changedMinds(answer).map(({ requests: _requests, mindId: _mindId, ...row }) => row),
});

const ask = (core: Core, mindId: string, text = "Add the spring tides to my notes") =>
  askAssistant(core, { text, mindId });

describe("A write that does all the User asked ends the Answer (#1635)", {
  timeout: 30_000,
}, () => {
  // protects=a clean write the model marks done ends the Answer at once: no closing reply, no change-claim check, a blank Answer with its change; fails_when=the model is called again after the write, the claim check runs, or the Answer fails for having no text; no_claim=that a real model sets done only when it should.
  test("a clean write with done ends the Answer with no reply and no claim check", async () => {
    const { model, answerCalls } = writing(() => [add({ content: `${MOON} [^1].`, done: true })]);
    const { core, mindId } = await notes(model);

    const answer = await ask(core, mindId);

    expect(answerCalls).toHaveLength(3);
    expect(answer.status).toBe("done");
    expect(answer.text).toBe("");
    expect(claimChecks(model)).toBe(0);
    expect(answer.steps?.phases.map((each) => each.phase)).not.toContain("checking-claims");
    const [change] = changesIn(answer);
    expect(change).toMatchObject({ mindId, paragraphs: 1, cited: 1 });
    expect(change?.selfCheck).toMatchObject({ sent: 1, checked: 1, failed: 0 });
    expect(change?.selfCheck?.look).toBeUndefined();
  });

  // protects=a model that leaves done out, or sets it false, gets today's closing reply and its claim check; fails_when=the turn ends without the model asking; no_claim=none beyond protects.
  test.each([
    ["left out", {}],
    ["false", { done: false }],
  ])("done %s: the model replies as before", async (_, done) => {
    const { model, answerCalls } = writing(() => [add({ content: `${MOON} [^1].`, ...done })]);
    const { core, mindId } = await notes(model);

    const answer = await ask(core, mindId);

    expect(answerCalls).toHaveLength(4);
    expect(answer.text).toBe(REPLY);
    expect(claimChecks(model)).toBe(1);
  });

  // protects=a write whose result asks the model to act or to tell the User something goes on to the reply whatever done says: a marker with no Citation, a place that isn't there; fails_when=the turn ends over a note the User needs, or after a refusal; no_claim=none beyond protects.
  test.each([
    ["a marker with no Citation recorded", { content: `${MOON} [^1]. More [^2].`, done: true }],
    [
      "a place that isn't there (refused)",
      { content: `${MOON} [^1].`, after: "Nowhere", done: true },
    ],
  ])("%s: the model is told and replies", async (_, input) => {
    const { model, answerCalls } = writing(() => [add(input)]);
    const { core, mindId } = await notes(model);

    const answer = await ask(core, mindId);

    expect(answerCalls).toHaveLength(4);
    expect(answer.text).toContain("I added the tides line");
  });

  // protects=a write the check found unsupported still ends the Answer: the marks in the page and the count on the change's line say it, and the count is final when the Answer ends; fails_when=a flagged write waits for a reply, or ends on a bare "Wrote 1 paragraph" with no count; no_claim=none beyond protects.
  test("a write the check flags still ends, its line counting what needs a look", async () => {
    const { model, answerCalls } = writing(() => [
      add({ content: `${MOON} [^1]. ${UNBACKED} [^1].`, done: true }),
    ]);
    const { core, mindId } = await notes(model);

    const answer = await ask(core, mindId);

    expect(answerCalls).toHaveLength(3);
    expect(answer.text).toBe("");
    const [change] = changesIn(answer);
    expect(change?.selfCheck).toMatchObject({ sent: 2, checked: 2, look: 1 });
    expect(changedMinds(answer)[0]?.look).toBe(1);
  });

  // protects=create_mind and edit_mind's content end the Answer as add_to_mind does, and the next turn still knows what was written: the record of the blank Answer is in its history, and "add this" can't pick the blank Answer up; fails_when=either write waits for a reply, the next turn reads no record of the first, or offers the blank Answer to put in a page; no_claim=none beyond protects.
  test("create_mind, then edit_mind's content, each end; the next turn keeps the record", async () => {
    const longer = `${MOON} [^1]. It also covers neap tides.`;
    const { model, answerCalls } = writing((question) =>
      question.includes("longer")
        ? [
            {
              calls: [
                {
                  tool: "edit_mind",
                  input: { mind: "Tide notes", part: "Tide notes", content: longer, done: true },
                },
              ],
            },
          ]
        : [
            {
              calls: [
                {
                  tool: "create_mind",
                  input: { title: "Tide notes", content: `${MOON} [^1].`, done: true },
                },
              ],
            },
          ],
    );
    const { core, mindId } = await notes(model);

    const first = await ask(core, mindId, "Write the spring tides into a new note");
    expect(first.text).toBe("");
    expect(answerCalls).toHaveLength(3);
    const [made] = changesIn(first);
    expect(made?.created).toBe(true);

    const second = await askAssistant(core, {
      text: "Make it longer",
      mindId,
      conversationId: first.conversationId,
    });

    const [read] = answerCalls.slice(3);
    expect(read?.prompt).toContain("- create_mind: made the Mind “Tide notes”");
    const offered = read?.options.tools?.find((tool) => tool.name === "add_to_mind");
    expect(JSON.stringify(offered)).not.toContain('"answer"');
    expect(answerCalls).toHaveLength(6);
    expect(second.text).toBe("");
    expect(mindCalls(second).map((call) => call.tool)).toEqual(["edit_mind"]);
    expect(changesIn(second)[0]).toMatchObject({ mindId: made?.mindId });
  });

  // protects=two writes in one Answer end only after the one marked done; a write beside another Tool's call in one step goes on; fails_when=the first write ends the turn, or a step with a search beside the write ends it; no_claim=none beyond protects.
  test.each([
    [
      "a first write not done, a second done",
      [
        add({ content: `${MOON} [^1].` }),
        add({ content: `${MOON} [^1].`, after: "Spring tides", done: true }),
      ],
      4,
      "",
    ],
    [
      "a done write beside a search",
      [
        {
          calls: [
            { tool: "add_to_mind", input: { content: `${MOON} [^1].`, done: true } },
            { tool: "search_documents", input: { query: "neap tides" } },
          ],
        },
      ],
      4,
      REPLY,
    ],
  ])("%s", async (_, writes, requests, text) => {
    const { model, answerCalls } = writing(() => writes);
    const { core, mindId } = await notes(model);

    const answer = await ask(core, mindId);

    expect(answerCalls).toHaveLength(requests);
    expect(answer.text).toBe(text);
  });

  // protects=a write that cites in the same step ends once the records hold; fails_when=it waits for a reply, or ends when cite asked for fixes; no_claim=none beyond protects.
  test("a write made beside its cite ends once the records hold", async () => {
    const answerCalls: ModelCall[] = [];
    const model = scriptedModel((call): ScriptedReply => {
      if (isCheckRun(call)) return checkReply(call, PLANS);
      answerCalls.push(call);
      if (!called(call, "search_documents")) {
        return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
      }
      if (!called(call, "add_to_mind")) {
        return {
          calls: [
            citeMoon(call),
            { tool: "add_to_mind", input: { content: `${MOON} [^1].`, done: true } },
          ],
        };
      }
      return { text: REPLY };
    });
    const { core, mindId } = await notes(model);

    const answer = await ask(core, mindId);

    expect(answer.text).toBe("");
    expect(answerCalls).toHaveLength(2);
  });

  // protects=Undo and the step list read the same whether the Answer ended at the write or replied: the same calls and change, one Checkpoint before the write, and the write's changes asked of the assistant, applied as one step; fails_when=ending early changes what the card, the steps or Undo see; no_claim=the built app's own Undo, which the smoke specs cover.
  test("Undo and the step list are the same as with a reply", async () => {
    const runs = await Promise.all(
      [true, false].map(async (done) => {
        const { model } = writing(() => [add({ content: `${MOON} [^1].`, done })]);
        const { core, mindId } = await notes(model);
        const answer = await ask(core, mindId);
        const [change] = changesIn(answer);
        const client = await connectToMind(core, mindId);
        await client.settled();
        const doc = client.blocks.doc;
        return {
          shown: shownOf(answer),
          checkpoints: (await core.listCheckpoints(mindId)).checkpoints.map((each) => each.reason),
          asked: doc && change ? askedFor(doc, change.request) : null,
        };
      }),
    );

    expect(runs[0]).toEqual(runs[1]);
    expect(runs[0]?.asked).toBe(true);
  });
});
