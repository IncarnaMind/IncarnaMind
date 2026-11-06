import { describe, expect, test } from "vitest";
import { askAssistant } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { note, resolveChanges, shownWithChanges, writeMind } from "../helpers/minds";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

/*
 * A reply that rewrites three paragraphs without naming them, keeping two and putting a new line
 * in the place of the third. When that one has no words of its own, each of them also in another,
 * nothing in the reply can say the new line is it rather than a line added there, whatever it
 * shares with it: between two lines the reply keeps, it is added beside it (#2356). A reply that
 * names the line, or rewrites one with words of its own, still takes its place, and so does the
 * reply's first line in the place of the selection's first (#2333).
 */

interface Shape {
  case: string;
  lines: readonly [string, string, string];
  /** The reply's paragraphs, without names; or, `named`, its text. */
  reply: readonly string[] | { named: string };
  asked: string;
  /** The Note once every change is accepted. */
  after: readonly string[];
}

const FEES = ["Fees are monthly.", "Rates are monthly.", "Fees and rates are monthly."] as const;
const FEES_ZH = ["费用按月支付。", "税费按月支付。", "费用和税费按月支付。"] as const;
const between = (lines: readonly [string, string, string], line: string) => [
  lines[0],
  line,
  lines[2],
];
const beside = (lines: readonly [string, string, string], line: string) => [
  lines[0],
  line,
  lines[1],
  lines[2],
];

const ADDED_BESIDE: readonly Shape[] = [
  {
    case: "en, a new line on another subject",
    lines: FEES,
    reply: between(FEES, "Gym membership is 30 a month."),
    asked: "Add a line about the gym membership.",
    after: beside(FEES, "Gym membership is 30 a month."),
  },
  {
    case: "zh, a new line on another subject",
    lines: FEES_ZH,
    reply: between(FEES_ZH, "健身会员每月30元。"),
    asked: "加一行健身会员的费用。",
    after: beside(FEES_ZH, "健身会员每月30元。"),
  },
  {
    case: "en, a new line in the others' words",
    lines: FEES,
    reply: between(FEES, "Gym fees are monthly."),
    asked: "Add a line about gym fees; keep the existing lines.",
    after: beside(FEES, "Gym fees are monthly."),
  },
  {
    case: "en, a new line much like the one between, asked as an addition",
    lines: FEES,
    reply: between(FEES, "Taxes are monthly."),
    asked: "Add a line saying taxes are monthly; keep the existing lines.",
    after: beside(FEES, "Taxes are monthly."),
  },
  {
    case: "zh, a new line in the others' words, asked as an addition",
    lines: FEES_ZH,
    reply: between(FEES_ZH, "保险费按月支付。"),
    asked: "加一行保险费，原有的各行都保留。",
    after: beside(FEES_ZH, "保险费按月支付。"),
  },
  {
    case: "en, the line between renamed",
    lines: FEES,
    reply: between(FEES, "Taxes are monthly."),
    asked: "Say taxes instead of rates in the second line.",
    after: beside(FEES, "Taxes are monthly."),
  },
  {
    case: "zh, the line between renamed",
    lines: FEES_ZH,
    reply: between(FEES_ZH, "税金按月支付。"),
    asked: "把第二行的税费改成税金。",
    after: beside(FEES_ZH, "税金按月支付。"),
  },
  {
    case: "en, a few common words of the line between changed",
    lines: ["It is cold.", "It is what it is.", "What it is now."],
    reply: ["It is cold.", "It is as it is.", "What it is now."],
    asked: "Reword the second line.",
    after: ["It is cold.", "It is as it is.", "It is what it is.", "What it is now."],
  },
  {
    case: "en, two new lines where the line between was",
    lines: ["It is cold.", "It is what it is.", "What it is now."],
    reply: ["It is cold.", "It is so.", "It is as it is.", "What it is now."],
    asked: "Add two lines after the first.",
    after: ["It is cold.", "It is so.", "It is as it is.", "It is what it is.", "What it is now."],
  },
  {
    case: "zh, two new lines where the line between was",
    lines: FEES_ZH,
    reply: [FEES_ZH[0], "健身费按月支付。", "保险费按月支付。", FEES_ZH[2]],
    asked: "加两行：健身费和保险费，原有的各行都保留。",
    after: [FEES_ZH[0], "健身费按月支付。", "保险费按月支付。", FEES_ZH[1], FEES_ZH[2]],
  },
  {
    case: "en, a new line where only an amount is the one between's own",
    lines: ["Fees: 20 monthly.", "Rates: 30 monthly.", "Fees and rates: 50 monthly."],
    reply: ["Fees: 20 monthly.", "Gym membership: 40 a month.", "Fees and rates: 50 monthly."],
    asked: "Add a line about the gym membership.",
    after: [
      "Fees: 20 monthly.",
      "Gym membership: 40 a month.",
      "Rates: 30 monthly.",
      "Fees and rates: 50 monthly.",
    ],
  },
  {
    case: "zh, a new line where only an amount is the one between's own",
    lines: ["费用：每月20元。", "税费：每月30元。", "费用和税费：每月50元。"],
    reply: ["费用：每月20元。", "健身会员：每月40元。", "费用和税费：每月50元。"],
    asked: "加一行健身会员的费用。",
    after: [
      "费用：每月20元。",
      "健身会员：每月40元。",
      "税费：每月30元。",
      "费用和税费：每月50元。",
    ],
  },
  {
    case: "en, a heading-like line of other words",
    lines: ["Notes are kept monthly.", "Notes:", "Notes and fees are monthly."],
    reply: ["Notes are kept monthly.", "Summary:", "Notes and fees are monthly."],
    asked: "Add a summary line.",
    after: ["Notes are kept monthly.", "Summary:", "Notes:", "Notes and fees are monthly."],
  },
  {
    case: "en, only the amount changed",
    lines: ["Rent is 900 a month.", "30 a month.", "Water is 30 a month."],
    reply: ["Rent is 900 a month.", "35 a month.", "Water is 30 a month."],
    asked: "Make the second line 35.",
    after: ["Rent is 900 a month.", "35 a month.", "30 a month.", "Water is 30 a month."],
  },
];

const REPLACED: readonly Shape[] = [
  {
    case: "en, a line with words of its own rewritten",
    lines: ["Fees are monthly.", "Parking costs 80 a month.", "Fees and rates are monthly."],
    reply: ["Fees are monthly.", "Parking costs 80 every month.", "Fees and rates are monthly."],
    asked: "Say every month in the parking line.",
    after: ["Fees are monthly.", "Parking costs 80 every month.", "Fees and rates are monthly."],
  },
  {
    case: "zh, a line with words of its own rewritten",
    lines: ["费用按月支付。", "停车每月80元。", "费用和税费按月支付。"],
    reply: ["费用按月支付。", "停车费每月80元。", "费用和税费按月支付。"],
    asked: "把停车那行改成停车费。",
    after: ["费用按月支付。", "停车费每月80元。", "费用和税费按月支付。"],
  },
  {
    case: "en, the line between renamed by its name",
    lines: FEES,
    reply: { named: "¶2 Taxes are monthly." },
    asked: "Say taxes instead of rates in the second line.",
    after: between(FEES, "Taxes are monthly."),
  },
  {
    case: "zh, the line between renamed by its name",
    lines: FEES_ZH,
    reply: { named: "¶2 税金按月支付。" },
    asked: "把第二行的税费改成税金。",
    after: between(FEES_ZH, "税金按月支付。"),
  },
  {
    case: "en, the selection's first line, which takes the reply's first",
    lines: ["Rates are monthly.", "Fees and rates are monthly.", "Fees are monthly."],
    reply: ["Taxes are monthly.", "Fees and rates are monthly.", "Fees are monthly."],
    asked: "Say taxes instead of rates in the first line.",
    after: ["Taxes are monthly.", "Fees and rates are monthly.", "Fees are monthly."],
  },
  {
    case: "zh, the selection's first line, which takes the reply's first",
    lines: ["税费按月支付。", "费用和税费按月支付。", "费用按月支付。"],
    reply: ["税金按月支付。", "费用和税费按月支付。", "费用按月支付。"],
    asked: "把第一行的税费改成税金。",
    after: ["税金按月支付。", "费用和税费按月支付。", "费用按月支付。"],
  },
];

const SHAPES = [...ADDED_BESIDE, ...REPLACED];

const rewrite = (shape: Shape) =>
  `${"named" in shape.reply ? shape.reply.named : shape.reply.join("\n\n")}\n<why>Done.</why>`;

async function onNote(shape: Shape, reply: (call: ModelCall) => ScriptedReply) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(scriptedModel(reply)).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const mind = await core.createMind({ title: "Fees" });
  const client = await connectToMind(core, mind.id);
  const blocks = shape.lines.map((line) => note(line));
  writeMind(client, blocks);
  await client.settled();
  return { core, mind, client, blocks };
}

async function accepted(client: MindClient) {
  await client.settled();
  await resolveChanges(client, "accept");
  return shownWithChanges(client);
}

describe("A paragraph with no words of its own is never written over by a nameless line between two kept ones (#2356)", {
  timeout: 30_000,
}, () => {
  test.each(SHAPES)("$case, from the assistant", async (shape) => {
    const { core, mind, client } = await onNote(shape, (call) => {
      if (/<passage>\n/.test(call.prompt)) return { text: rewrite(shape) };
      return call.results.length === 0
        ? { calls: [{ tool: "edit_mind", input: { instruction: shape.asked } }] }
        : { text: "Done." };
    });

    await askAssistant(core, { text: shape.asked, mindId: mind.id });

    expect(await accepted(client)).toEqual(shape.after);
  });

  test.each(SHAPES)("$case, from Edit with AI", async (shape) => {
    const { core, mind, client, blocks } = await onNote(shape, (call) =>
      /<passage>\n/.test(call.prompt) ? { text: rewrite(shape) } : { text: "Done." },
    );

    const edited = await core.editWithAi({
      requestId: "edit-1",
      mindId: mind.id,
      from: { blockId: blocks[0]?.attrs?.id as string, offset: 0 },
      to: { blockId: blocks[2]?.attrs?.id as string, offset: shape.lines[2].length },
      text: shape.lines.join("\n"),
      action: "instruction",
      instruction: shape.asked,
    });

    expect(edited.kind).toBe("proposed");
    expect(await accepted(client)).toEqual(shape.after);
  });
});
