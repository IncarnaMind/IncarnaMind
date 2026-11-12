/**
 * The earlier-call set's cases (#3005), held out: written and committed before any run of the
 * change they gate, and never shown to a prompt. Each case is two calls with the same buyer, each
 * in a Note of its own in one Folder, the way the User's calls with one company pile up: the
 * earlier one recorded and stopped, then the live one, both named for the day. On the live call a
 * button is pressed, or a question typed in the assistant. What the earlier call holds must never
 * be given as said in this call; asked about last time, the reply still gives it, cited to that
 * call. Each pair of calls runs in both orders, so neither call's words are only ever the earlier.
 * Every name, figure and company is made up.
 */
import type { CallTurn } from "./callHelpCases";

/** One call: the buyer's statements and the User's lines, in the order said. */
export interface EarlierCallSide {
  turns: readonly CallTurn[];
  /** What this call's buyer said that the other call's didn't, as a judge reads it. */
  holds: string;
}

export interface EarlierCallCase {
  id: string;
  language: "en" | "zh-CN";
  /** The Folder both calls' Notes are in: the buyer's company. */
  folder: string;
  earlier: EarlierCallSide;
  live: EarlierCallSide;
  /** What the User types in the assistant during the live call to ask about the earlier one. */
  lastTime: string;
}

const EN_A: EarlierCallSide = {
  turns: [
    {
      who: "me",
      text: "Thanks for making time, Ines. Shall we start with what you need from the telemetry?",
    },
    { who: "them", text: "Sure. First, our data has to stay in Europe, that's a board decision." },
    {
      who: "them",
      text: "We'd want to start in January, and the budget is twelve thousand a year.",
    },
    { who: "me", text: "Understood, I'll check the hosting options and come back on price." },
  ],
  holds:
    "The buyer said their data has to stay in Europe, that they want to start in January, and that the budget is twelve thousand a year.",
};

const EN_B: EarlierCallSide = {
  turns: [
    { who: "me", text: "Good to talk again, Ines. Where did we get to on your side?" },
    {
      who: "them",
      text: "Where would our data actually be stored? We need to know before we sign.",
    },
    { who: "them", text: "And we'd start in March now, January slipped on our end." },
    {
      who: "them",
      text: "Could the budget stretch to fifteen thousand if onboarding is included?",
    },
  ],
  holds:
    "The buyer asked where their data would be stored, said they would now start in March, and asked whether the budget could be fifteen thousand with onboarding included.",
};

const ZH_A: EarlierCallSide = {
  turns: [
    { who: "me", text: "顾经理，谢谢抽时间。我们先聊聊你们对车队数据的要求？" },
    { who: "them", text: "好的。首先，我们的数据必须留在欧洲，这是董事会定的。" },
    { who: "them", text: "我们希望一月份开始用，预算是一年十二万。" },
    { who: "me", text: "明白，我回去确认一下托管方案，再给你们报价。" },
  ],
  holds: "对方说数据必须留在欧洲，希望一月份开始用，预算是一年十二万。",
};

const ZH_B: EarlierCallSide = {
  turns: [
    { who: "me", text: "顾经理，又见面了。你们那边进展到哪一步了？" },
    { who: "them", text: "我们的数据到底会存在哪里？签合同之前得弄清楚。" },
    { who: "them", text: "另外我们现在要三月份才开始，一月份赶不上了。" },
    { who: "them", text: "如果包含上线培训，预算能不能放到十五万？" },
  ],
  holds: "对方问数据会存在哪里，说现在要三月份才开始，并问包含上线培训的话预算能否到十五万。",
};

/**
 * The buttons pressed on each live call: the first two of the ask bar, which are sent the Note's
 * Folder's Documents found for the newest lines, an earlier call's Transcript among them. "Sum up
 * so far" and "What do they want?" read this call alone and are sent no Documents.
 */
export const EARLIER_CALL_PRESSES = ["say", "answer"] as const;

const EN_LAST_TIME = "What did they say last time?";
const ZH_LAST_TIME = "上次他们说了什么？";

export const EARLIER_CALL_CASES: readonly EarlierCallCase[] = [
  {
    id: "en-a-then-b",
    language: "en",
    folder: "Tallowmere Freight",
    earlier: EN_A,
    live: EN_B,
    lastTime: EN_LAST_TIME,
  },
  {
    id: "en-b-then-a",
    language: "en",
    folder: "Tallowmere Freight",
    earlier: EN_B,
    live: EN_A,
    lastTime: EN_LAST_TIME,
  },
  {
    id: "zh-a-then-b",
    language: "zh-CN",
    folder: "澜川冷链",
    earlier: ZH_A,
    live: ZH_B,
    lastTime: ZH_LAST_TIME,
  },
  {
    id: "zh-b-then-a",
    language: "zh-CN",
    folder: "澜川冷链",
    earlier: ZH_B,
    live: ZH_A,
    lastTime: ZH_LAST_TIME,
  },
];
