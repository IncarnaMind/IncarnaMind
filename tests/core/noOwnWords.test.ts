import { randomUUID } from "node:crypto";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { askAssistant } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import { wholeMind } from "../helpers/editing";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { heading, note, resolveChanges, shownWithChanges, writeMind } from "../helpers/minds";
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
  /** The Note's paragraphs; a heading starts with "## ", as the reply writes it. */
  lines: readonly string[];
  /** The reply's paragraphs, without names; or, `named`, its text. */
  reply: readonly string[] | { named: string };
  asked: string;
  /** The Note once every change is accepted. */
  after: readonly string[];
  /** Its lines in any order: a heading written at another level is written again where the reply puts it. */
  anyOrder?: true;
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
    case: "en, the line between written again in capitals",
    lines: FEES,
    reply: between(FEES, "RATES ARE MONTHLY."),
    asked: "Add the rates line in capitals; keep the existing lines.",
    after: beside(FEES, "RATES ARE MONTHLY."),
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

const FOUR = [
  "Fees are monthly.",
  "Rates are monthly.",
  "Taxes are monthly.",
  "Fees, rates and taxes are monthly.",
] as const;
const FOUR_ZH = [
  "费用按月支付。",
  "税费按月支付。",
  "保险费按月支付。",
  "费用、税费和保险费按月支付。",
] as const;
const DUES = [
  "Fees are monthly.",
  "Rates are monthly.",
  "Dues are monthly.",
  "Fees, rates and dues are monthly.",
] as const;
const PAYMENTS = [
  "The rates are monthly and fixed.",
  "The rates are monthly and payments are yearly.",
  "The yearly payments remain fixed and predictable.",
] as const;
const PAYMENTS_ZH = [
  "税费按月支付，金额固定。",
  "税费按月支付，押金按年支付。",
  "押金按年支付，金额固定可预期。",
] as const;
const twoFor = (lines: readonly string[], one: string, two: string) => ({
  reply: [lines[0] as string, one, two, lines[3] as string],
  after: [lines[0] as string, one, two, lines[1] as string, lines[2] as string, lines[3] as string],
});

/** Lines the reply writes as many in the place of, or says every word of, which nothing else can tell it rewrites. */
const KEPT_WHOLE: readonly Shape[] = [
  {
    case: "en, two new lines where two with none of their own were",
    lines: FOUR,
    ...twoFor(FOUR, "Gym fees are monthly.", "Pool fees are monthly."),
    asked: "Add lines on gym and pool fees; keep the existing lines.",
  },
  {
    case: "zh, two new lines where two with none of their own were",
    lines: FOUR_ZH,
    ...twoFor(FOUR_ZH, "健身费按月支付。", "停车费按月支付。"),
    asked: "加两行：健身费和停车费，原有的各行都保留。",
  },
  {
    case: "en, two new lines that say every word of the two there",
    lines: FOUR,
    ...twoFor(FOUR, "Water rates are monthly.", "Car taxes are monthly."),
    asked: "Add lines on water rates and car taxes; keep the existing lines.",
  },
  {
    case: "zh, two new lines that say every word of the two there",
    lines: FOUR_ZH,
    ...twoFor(FOUR_ZH, "水电税费按月支付。", "车辆保险费按月支付。"),
    asked: "加两行：水电税费和车辆保险费，原有的各行都保留。",
  },
  {
    case: "en, two new lines, each much like one of the two there",
    lines: DUES,
    ...twoFor(DUES, "Gym rates are monthly.", "Gym dues are monthly."),
    asked: "Add lines on gym rates and gym dues; keep the existing lines.",
  },
  {
    case: "zh, two new lines, each much like one of the two there",
    lines: FOUR_ZH,
    ...twoFor(FOUR_ZH, "健身税费按月支付。", "健身保险费按月支付。"),
    asked: "加两行：健身税费和健身保险费，原有的各行都保留。",
  },
  {
    case: "en, a new line made of the line between's words",
    lines: PAYMENTS,
    reply: between(PAYMENTS, "The payments are monthly."),
    asked: "Add that the payments are monthly; keep the existing lines.",
    after: beside(PAYMENTS, "The payments are monthly."),
  },
  {
    case: "zh, a new line made of the line between's words",
    lines: PAYMENTS_ZH,
    reply: between(PAYMENTS_ZH, "押金按月支付。"),
    asked: "加一行押金按月支付，原有的各行都保留。",
    after: beside(PAYMENTS_ZH, "押金按月支付。"),
  },
  {
    case: "en, a new line that reads as the line between without its spaces",
    lines: ["We are now here and ready.", "Now here.", "We are ready now, here at the office."],
    reply: ["We are now here and ready.", "Nowhere.", "We are ready now, here at the office."],
    asked: "Add a line saying nowhere; keep every existing line.",
    after: [
      "We are now here and ready.",
      "Nowhere.",
      "Now here.",
      "We are ready now, here at the office.",
    ],
  },
  {
    case: "en, a new line that reads as the line between with a space more",
    lines: ["We are nowhere near the office.", "Nowhere.", "The office is nowhere near home."],
    reply: ["We are nowhere near the office.", "Now here.", "The office is nowhere near home."],
    asked: "Add a line saying now here; keep every existing line.",
    after: [
      "We are nowhere near the office.",
      "Now here.",
      "Nowhere.",
      "The office is nowhere near home.",
    ],
  },
  {
    case: "en, a line with a line break the reply writes as it was",
    lines: ["Fees are monthly.", "Rates are<br>monthly.", "Fees and rates are monthly."],
    reply: ["Fees are monthly.", "Rates are\nmonthly.", "Fees and rates are monthly, from May."],
    asked: "Say the fees and rates line starts in May.",
    after: [
      "Fees are monthly.",
      "Rates are\uFFFCmonthly.",
      "Fees and rates are monthly, from May.",
    ],
  },
  {
    case: "zh, a line with a line break the reply writes as it was",
    lines: ["费用按月支付。", "税费<br>按月支付。", "费用和税费按月支付。"],
    reply: ["费用按月支付。", "税费\n按月支付。", "费用和税费从五月起按月支付。"],
    asked: "把最后一行改成从五月起。",
    after: ["费用按月支付。", "税费\uFFFC按月支付。", "费用和税费从五月起按月支付。"],
  },
  {
    case: "en, a new line that says every word of the line between",
    lines: FEES,
    reply: between(FEES, "Water rates are monthly."),
    asked: "Add a line on water rates; keep the existing lines.",
    after: beside(FEES, "Water rates are monthly."),
  },
  {
    case: "en, a new line that says every word of the line between and more",
    lines: FEES,
    reply: between(FEES, "Late rates are monthly too."),
    asked: "Add that late rates are monthly too; keep the existing lines.",
    after: beside(FEES, "Late rates are monthly too."),
  },
  {
    case: "zh, a new line that says every word of the line between",
    lines: FEES_ZH,
    reply: between(FEES_ZH, "水电税费按月支付。"),
    asked: "加一行水电税费，原有的各行都保留。",
    after: beside(FEES_ZH, "水电税费按月支付。"),
  },
  {
    case: "en, a new line around the amount the line between is",
    lines: ["Rent: 900 a month.", "30 a month.", "Water: 30 a month."],
    reply: ["Rent: 900 a month.", "Gym: 30 a month.", "Water: 30 a month."],
    asked: "Add the gym at 30 a month; keep the existing lines.",
    after: ["Rent: 900 a month.", "Gym: 30 a month.", "30 a month.", "Water: 30 a month."],
  },
  {
    case: "zh, a new line around the amount the line between is",
    lines: ["房租：每月900元。", "每月30元。", "水费：每月30元。"],
    reply: ["房租：每月900元。", "健身：每月30元。", "水费：每月30元。"],
    asked: "加一行健身每月30元，原有的各行都保留。",
    after: ["房租：每月900元。", "健身：每月30元。", "每月30元。", "水费：每月30元。"],
  },
  {
    case: "en, a new line after a heading the reply writes at another level",
    anyOrder: true,
    lines: ["## Costs", "Rates are monthly.", "Costs and rates are monthly."],
    reply: ["# Costs", "Gym fees are monthly.", "Costs and rates are monthly."],
    asked: "Add a line on gym fees; keep the existing lines.",
    after: ["Costs", "Gym fees are monthly.", "Rates are monthly.", "Costs and rates are monthly."],
  },
  {
    case: "zh, a new line after a heading the reply writes at another level",
    anyOrder: true,
    lines: ["## 费用", "税费按月支付。", "费用和税费按月支付。"],
    reply: ["# 费用", "保险费按月支付。", "费用和税费按月支付。"],
    asked: "加一行保险费，原有的各行都保留。",
    after: ["费用", "保险费按月支付。", "税费按月支付。", "费用和税费按月支付。"],
  },
];

const PARKING = [
  "Rent is due on the first.",
  "Parking spaces are allocated by the landlord.",
  "Deposit is three months.",
] as const;
const PARKING_ZH = [
  "房租每月一号交。",
  "停车位由房东统一分配并登记。",
  "押金为三个月房租。",
] as const;

/**
 * A first line, or a line between two kept ones, that nothing in the reply says it rewrites. With
 * nothing written yet, what is added goes after the selection's first, never in its place.
 */
const NO_EVIDENCE: readonly Shape[] = [
  {
    case: "en, the selection's first line renamed while the line after is kept",
    lines: ["Rates are monthly.", "Fees and rates are monthly.", "Fees are monthly."],
    reply: ["Taxes are monthly.", "Fees and rates are monthly.", "Fees are monthly."],
    asked: "Say taxes instead of rates in the first line.",
    after: [
      "Rates are monthly.",
      "Taxes are monthly.",
      "Fees and rates are monthly.",
      "Fees are monthly.",
    ],
  },
  {
    case: "zh, the selection's first line renamed while the line after is kept",
    lines: ["税费按月支付。", "费用和税费按月支付。", "费用按月支付。"],
    reply: ["税金按月支付。", "费用和税费按月支付。", "费用按月支付。"],
    asked: "把第一行的税费改成税金。",
    after: ["税费按月支付。", "税金按月支付。", "费用和税费按月支付。", "费用按月支付。"],
  },
  {
    case: "en, a new first line before a kept one",
    lines: ["Rates are monthly.", "Fees are monthly.", "Fees and rates are monthly."],
    reply: ["Gym fees are monthly.", "Fees are monthly.", "Fees and rates are monthly."],
    asked: "Add a line on gym fees at the top; keep the existing lines.",
    after: [
      "Rates are monthly.",
      "Gym fees are monthly.",
      "Fees are monthly.",
      "Fees and rates are monthly.",
    ],
  },
  {
    case: "zh, a new first line before a kept one",
    lines: ["税费按月支付。", "费用按月支付。", "费用和税费按月支付。"],
    reply: ["保险费按月支付。", "费用按月支付。", "费用和税费按月支付。"],
    asked: "在最上面加一行保险费，原有的各行都保留。",
    after: ["税费按月支付。", "保险费按月支付。", "费用按月支付。", "费用和税费按月支付。"],
  },
  {
    case: "en, a new line between two kept ones that says half of the line's own words",
    lines: PARKING,
    reply: between(PARKING, "Parking spaces are free on Sundays."),
    asked: "Add that parking spaces are free on Sundays; keep the existing lines.",
    after: beside(PARKING, "Parking spaces are free on Sundays."),
  },
  {
    case: "zh, a new line between two kept ones that says half of the line's own words",
    lines: PARKING_ZH,
    reply: between(PARKING_ZH, "停车位由房东周日开放。"),
    asked: "加一行：停车位由房东周日开放，原有的各行都保留。",
    after: beside(PARKING_ZH, "停车位由房东周日开放。"),
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
    case: "en, the selection's first line with words of its own rewritten, the rest kept",
    lines: ["The harbour office opens early.", "Boats leave at high water.", "Both close at dusk."],
    reply: ["The harbour office opens late.", "Boats leave at high water.", "Both close at dusk."],
    asked: "Say late instead of early in the first line.",
    after: ["The harbour office opens late.", "Boats leave at high water.", "Both close at dusk."],
  },
  {
    case: "zh, the selection's first line with words of its own rewritten, the rest kept",
    lines: ["港务办公室早上开门。", "船只在涨潮时出港。", "两处都在傍晚关门。"],
    reply: ["港务办公室上午开门。", "船只在涨潮时出港。", "两处都在傍晚关门。"],
    asked: "把第一行的早上改成上午。",
    after: ["港务办公室上午开门。", "船只在涨潮时出港。", "两处都在傍晚关门。"],
  },
  {
    case: "en, a line with words of its own between two kept ones, most of them said",
    lines: PARKING,
    reply: between(PARKING, "Parking spaces are assigned by the landlord."),
    asked: "Say assigned instead of allocated in the parking line.",
    after: between(PARKING, "Parking spaces are assigned by the landlord."),
  },
  {
    case: "zh, a line with words of its own between two kept ones, most of them said",
    lines: PARKING_ZH,
    reply: between(PARKING_ZH, "停车位由房东统一分配并编号。"),
    asked: "把停车那行的登记改成编号。",
    after: between(PARKING_ZH, "停车位由房东统一分配并编号。"),
  },
];

const SHORT_PARKING = [
  "Rent is due on the first.",
  "Parking spaces are allocated.",
  "Deposit is three months.",
] as const;
const SHORT_PARKING_ZH = ["房租每月一号交。", "停车位由房东分配。", "押金为三个月房租。"] as const;

/**
 * The known residue (#2589): a new line that says more than half of a line's own words takes its
 * place, so a short line, or a Chinese one, can be written over by an addition that repeats most of
 * it; so can the selection's first line, which keeps fix 6's test. Words alone can't tell these
 * from a rewrite such as "assigned by the landlord"; names in the reply, or a decline, can. These
 * rows pin what happens today, so a change to it shows.
 */
const RESIDUE: readonly Shape[] = [
  {
    case: "en, the known residue: a short line between two kept ones, most of its words repeated",
    lines: SHORT_PARKING,
    reply: between(SHORT_PARKING, "Parking spaces are free on Sundays."),
    asked: "Add that parking spaces are free on Sundays; keep the existing lines.",
    after: between(SHORT_PARKING, "Parking spaces are free on Sundays."),
  },
  {
    case: "zh, the known residue: a short line between two kept ones, most of its words repeated",
    lines: SHORT_PARKING_ZH,
    reply: between(SHORT_PARKING_ZH, "停车位由房东周日开放。"),
    asked: "加一行：停车位由房东周日开放，原有的各行都保留。",
    after: between(SHORT_PARKING_ZH, "停车位由房东周日开放。"),
  },
  {
    case: "zh, the known residue: a longer line between two kept ones, most of its words repeated",
    lines: PARKING_ZH,
    reply: between(PARKING_ZH, "停车位由房东统一周日开放。"),
    asked: "加一行：停车位由房东统一周日开放，原有的各行都保留。",
    after: between(PARKING_ZH, "停车位由房东统一周日开放。"),
  },
  {
    case: "en, the known residue: the selection's first line, half of its words repeated",
    lines: [
      "Parking spaces are allocated by the landlord.",
      "Rent is due on the first.",
      "Deposit is three months.",
    ],
    reply: [
      "Parking spaces are free on Sundays.",
      "Rent is due on the first.",
      "Deposit is three months.",
    ],
    asked: "Add that parking spaces are free on Sundays; keep the existing lines.",
    after: [
      "Parking spaces are free on Sundays.",
      "Rent is due on the first.",
      "Deposit is three months.",
    ],
  },
  {
    case: "zh, the known residue: the selection's first line, half of its words repeated",
    lines: ["停车位由房东统一分配。", "房租每月一号交。", "押金为三个月房租。"],
    reply: ["停车位由房东周日开放。", "房租每月一号交。", "押金为三个月房租。"],
    asked: "加一行：停车位由房东周日开放，原有的各行都保留。",
    after: ["停车位由房东周日开放。", "房租每月一号交。", "押金为三个月房租。"],
  },
];

const SHAPES = [...ADDED_BESIDE, ...KEPT_WHOLE, ...NO_EVIDENCE, ...REPLACED, ...RESIDUE];

const rewrite = (shape: Shape) =>
  `${"named" in shape.reply ? shape.reply.named : shape.reply.join("\n\n")}\n<why>Done.</why>`;

/** A paragraph with a line break where the line has `<br>`, as the reply writes one. */
function withBreak(line: string): JSONContent {
  const [before, after] = line.split("<br>");
  return {
    type: "paragraph",
    attrs: { id: randomUUID() },
    content: [{ type: "text", text: before }, { type: "hardBreak" }, { type: "text", text: after }],
  };
}

async function onNote(shape: Shape, reply: (call: ModelCall) => ScriptedReply) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(scriptedModel(reply)).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const mind = await core.createMind({ title: "Fees" });
  const client = await connectToMind(core, mind.id);
  const blocks = shape.lines.map((line) =>
    line.startsWith("## ")
      ? heading(2, line.slice(3))
      : line.includes("<br>")
        ? withBreak(line)
        : note(line),
  );
  writeMind(client, blocks);
  await client.settled();
  return { core, mind, client, blocks };
}

async function accepted(client: MindClient, shape: Shape) {
  await client.settled();
  await resolveChanges(client, "accept");
  const after = shownWithChanges(client);
  return shape.anyOrder ? [...after].sort() : after;
}

const expected = (shape: Shape) => (shape.anyOrder ? [...shape.after].sort() : shape.after);

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

    expect(await accepted(client, shape)).toEqual(expected(shape));
  });

  test.each(SHAPES)("$case, from Edit with AI", async (shape) => {
    const { core, mind, client } = await onNote(shape, (call) =>
      /<passage>\n/.test(call.prompt) ? { text: rewrite(shape) } : { text: "Done." },
    );

    const edited = await core.editWithAi(wholeMind(client, mind.id, shape.asked));

    expect(edited.kind).toBe("proposed");
    expect(await accepted(client, shape)).toEqual(expected(shape));
  });
});
