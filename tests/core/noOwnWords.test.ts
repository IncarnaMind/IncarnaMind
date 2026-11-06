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
 * A reply that rewrites three paragraphs without naming them, keeping the first and the last and
 * putting one new line between them. When the middle one has no words of its own, each of them
 * also in another, its words can't say the new line is it: the line takes its place only when it
 * is much like it, and is otherwise added beside it (#2356).
 */

interface Shape {
  case: string;
  lines: readonly [string, string, string];
  between: string;
  asked: string;
  /** The Note once every change is accepted. */
  after: readonly string[];
}

const SHAPES: readonly Shape[] = [
  {
    case: "en, a new line on another subject",
    lines: ["Fees are monthly.", "Rates are monthly.", "Fees and rates are monthly."],
    between: "Gym membership is 30 a month.",
    asked: "Add a line about the gym membership.",
    after: [
      "Fees are monthly.",
      "Gym membership is 30 a month.",
      "Rates are monthly.",
      "Fees and rates are monthly.",
    ],
  },
  {
    case: "zh, a new line on another subject",
    lines: ["费用按月支付。", "税费按月支付。", "费用和税费按月支付。"],
    between: "健身会员每月30元。",
    asked: "加一行健身会员的费用。",
    after: ["费用按月支付。", "健身会员每月30元。", "税费按月支付。", "费用和税费按月支付。"],
  },
  {
    case: "en, a new line where only an amount is the middle one's own",
    lines: ["Fees: 20 monthly.", "Rates: 30 monthly.", "Fees and rates: 50 monthly."],
    between: "Gym membership: 40 a month.",
    asked: "Add a line about the gym membership.",
    after: [
      "Fees: 20 monthly.",
      "Gym membership: 40 a month.",
      "Rates: 30 monthly.",
      "Fees and rates: 50 monthly.",
    ],
  },
  {
    case: "zh, a new line where only an amount is the middle one's own",
    lines: ["费用：每月20元。", "税费：每月30元。", "费用和税费：每月50元。"],
    between: "健身会员：每月40元。",
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
    between: "Summary:",
    asked: "Add a summary line.",
    after: ["Notes are kept monthly.", "Summary:", "Notes:", "Notes and fees are monthly."],
  },
  {
    case: "en, one word changed",
    lines: ["Fees are monthly.", "Rates are monthly.", "Fees and rates are monthly."],
    between: "Taxes are monthly.",
    asked: "Say taxes instead of rates in the second line.",
    after: ["Fees are monthly.", "Taxes are monthly.", "Fees and rates are monthly."],
  },
  {
    case: "en, a few common words changed",
    lines: ["It is cold.", "It is what it is.", "What it is now."],
    between: "It is as it is.",
    asked: "Reword the second line.",
    after: ["It is cold.", "It is as it is.", "What it is now."],
  },
  {
    case: "zh, one word changed",
    lines: ["费用按月支付。", "税费按月支付。", "费用和税费按月支付。"],
    between: "税金按月支付。",
    asked: "把第二行的税费改成税金。",
    after: ["费用按月支付。", "税金按月支付。", "费用和税费按月支付。"],
  },
  {
    case: "en, only the amount changed",
    lines: ["Rent is 900 a month.", "30 a month.", "Water is 30 a month."],
    between: "35 a month.",
    asked: "Make the second line 35.",
    after: ["Rent is 900 a month.", "35 a month.", "30 a month.", "Water is 30 a month."],
  },
];

const rewrite = (shape: Shape) =>
  `${[shape.lines[0], shape.between, shape.lines[2]].join("\n\n")}\n<why>Done.</why>`;

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

describe("A paragraph with no words of its own is written over only by a line much like it (#2356)", {
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
