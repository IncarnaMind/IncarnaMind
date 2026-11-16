/**
 * An AI edit changes only what it says (#2333, #2711): a task that takes no text out never takes a
 * paragraph out on the strength of the reply's quote alone, a reply's own talk never goes into the
 * Note, and Citations that go in after a write never write over a later revision of its Blocks.
 * The model is scripted: no request is paid for.
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import type { EditWithAiInput } from "../../src/core";
import { setUpWithDocuments } from "../helpers/citations";
import { type EditCall, editingModel, wholeMind } from "../helpers/editing";
import type { MindClient } from "../helpers/mindClient";
import { resolveChanges, shownWithChanges, writeMind } from "../helpers/minds";

let ids = 0;
const paragraph = (value: string): JSONContent & { attrs: { id: string } } => ({
  type: "paragraph",
  attrs: { id: `only-${++ids}` },
  content: [{ type: "text", text: value }],
});

const FIVE = {
  en: [
    "The harbour office is open on weekdays and posts the tide tables every Monday morning.",
    "Gauge readings are checked twice a week by the duty officer, who logs any drift in a notebook.",
    "A new pontoon was added at the north quay last spring, and it takes boats up to twelve metres.",
    "Visitors must book a mooring through the office at least two days before they arrive.",
    "Fees are charged per night and are lower between November and March.",
  ],
  zh: [
    "港务办公室工作日开放，每周一上午公布潮汐表。",
    "值班员每周检查两次水位计读数，并在笔记本上记录任何偏差。",
    "去年春天在北码头新增了一个浮桥，可停靠十二米以内的船只。",
    "访客须在抵达前至少两天通过办公室预订泊位。",
    "费用按夜收取，十一月至三月较低。",
  ],
} as const;

/** Each paragraph a little shorter: well under half of the text goes. */
const SHORTER = {
  en: [
    "The harbour office is open on weekdays and posts the tide tables every Monday.",
    "Gauge readings are checked twice a week by the duty officer, who logs any drift.",
    "A new pontoon was added at the north quay last spring and takes boats up to twelve metres.",
    "Visitors must book a mooring through the office two days before they arrive.",
    "Fees are charged per night and are lower between November and March.",
  ],
  zh: [
    "港务办公室工作日开放，每周一公布潮汐表。",
    "值班员每周检查两次水位计读数，并记录任何偏差。",
    "去年春天在北码头新增了一个浮桥，可停靠十二米以内的船只。",
    "访客须在抵达前两天通过办公室预订泊位。",
    "费用按夜收取，十一月至三月较低。",
  ],
} as const;

async function noteOf(lines: readonly string[], reply: (call: EditCall) => string) {
  const calls: EditCall[] = [];
  const set = await setUpWithDocuments(editingModel(reply, calls), []);
  writeMind(set.client, lines.map(paragraph));
  await set.client.settled();
  return { ...set, calls };
}

/** Edit with AI over all of the Mind's text, as a fixed action (Shorten, Improve, Translate). */
function fixed(
  client: MindClient,
  mindId: string,
  action: EditWithAiInput["action"],
  instruction?: string,
): EditWithAiInput {
  const { instruction: _instruction, ...whole } = wholeMind(client, mindId, "");
  return { ...whole, action, ...(instruction !== undefined && { instruction }) };
}

describe.each(["en", "zh"] as const)("A task that takes no text out (%s)", (language) => {
  const lines = FIVE[language];
  const quoted = (...which: number[]) =>
    lines.map((line, index) => (which.includes(index) ? `<removed>${line}</removed>` : line));

  // protects=a Shorten, Improve or Translate whose reply quotes a whole paragraph as taken out waits for the User, whatever share of the text it is: such a task takes none out, so the quote alone doesn't (#2333 part 5); fails_when=the quoted paragraph is taken out at once; no_claim=how often a real model quotes one.
  test.each([
    { action: "shorten" as const, instruction: undefined },
    { action: "improve" as const, instruction: undefined },
    { action: "translate" as const, instruction: "French" },
  ])("$action: a whole paragraph quoted as taken out waits", async ({ action, instruction }) => {
    const { core, mind, client } = await noteOf(lines, () => quoted(0, 1).join("\n\n"));

    const result = await core.editWithAi(fixed(client, mind.id, action, instruction));

    expect(result).toMatchObject({ kind: "proposed", held: true });
  });

  // protects=a Shorten that quotes nothing applies as it did, and Undo-free: the guard is for the quote alone; fails_when=a Shorten with no quote is held; no_claim=none.
  test("a Shorten that quotes nothing is not held", async () => {
    const { core, mind, client } = await noteOf(lines, () => SHORTER[language].join("\n\n"));

    const result = await core.editWithAi(fixed(client, mind.id, "shorten"));

    expect(result).toMatchObject({ kind: "proposed" });
    expect(result).not.toHaveProperty("held");
    await resolveChanges(client, "accept");
    expect(shownWithChanges(client)).toEqual([...SHORTER[language]]);
  });
});

const REASONING = {
  en: "The passage has five paragraphs. Shortening means fewer words, same facts. I'll keep all five paragraphs but tighten each.",
  zh: "这段话有五个自然段。缩短意味着更少的字，同样的事实。我会保留全部五段，但每段都精简。",
} as const;

describe.each(["en", "zh"] as const)("A reply's own talk to a fixed task (%s)", (language) => {
  const lines = FIVE[language];

  // protects=a line of a reply to Shorten or Improve that talks about the task and says none of the passage's words never goes into the Note, however many paragraphs the reply has and wherever the line stands; fails_when=the line is added as a paragraph; no_claim=how often a real model talks first (1 of 3 runs of #2490's probe).
  test.each([
    { action: "shorten" as const, at: "first" },
    { action: "improve" as const, at: "first" },
    { action: "shorten" as const, at: "last" },
  ])("$action: the talk, $at in the reply, stays out of the Note", async ({ action, at }) => {
    const reply =
      at === "first"
        ? [REASONING[language], ...SHORTER[language]]
        : [...SHORTER[language], REASONING[language]];
    const { core, mind, client } = await noteOf(lines, () => reply.join("\n\n"));

    const result = await core.editWithAi(fixed(client, mind.id, action));
    await resolveChanges(client, "accept");

    expect(result).toMatchObject({ kind: "proposed" });
    expect(shownWithChanges(client)).toEqual([...SHORTER[language]]);
  });

  // protects=a paragraph a reply splits in two keeps both halves, as before: the second is the passage's own words, not talk; fails_when=the second half is dropped; no_claim=how often a model splits.
  test("a paragraph split in two is not talk", async () => {
    const [first = "", second = "", ...rest] = lines;
    const half = Math.floor(first.length / 2);
    const cut = first.slice(0, half);
    const tail = first.slice(half);
    const { core, mind, client } = await noteOf(lines, () =>
      [cut, tail, second, ...rest].join("\n\n"),
    );

    await core.editWithAi(fixed(client, mind.id, "improve"));
    await resolveChanges(client, "accept");

    expect(shownWithChanges(client).join("")).toContain(tail);
  });
});
