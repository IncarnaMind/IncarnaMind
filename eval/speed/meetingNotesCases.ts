/**
 * The meeting-notes set's cases (#1624), written and committed before any paired run of the notes
 * filled in after Stop. Each is a long call of the call-help set (`callHelpCases.ts`) heard whole
 * and stopped, with what its notes must give: the case's own lines (an offer, a worry, a date, an
 * owner, a request) and two lines of the rollout talk every long call has in its middle (the trial
 * workspace, and the onboarding contact put in writing). No prompt has seen them. Every name,
 * figure and Document is made up.
 */
import { CALL_HELP_CASES, type CallHelpCase, callOf, TRANSCRIPT } from "./callHelpCases";

/** A line said in the call, which a found Citation in the notes must quote. */
export interface SaidLine {
  in: typeof TRANSCRIPT;
  line: string;
}

export interface MeetingNotesCase {
  id: string;
  language: "en" | "zh-CN";
  /** The call heard, with the Library of its Documents. */
  call: CallHelpCase;
  /** What right notes give, for the judge. */
  facts: string;
  /** The lines they rest on: each group cited when a found Citation quotes any one of its lines. */
  rests: readonly (readonly SaidLine[])[];
}

/** The line of `call` that holds `words`, as a Citation of the Transcript must quote it. */
function said(call: CallHelpCase, words: string): SaidLine {
  const found = callOf(call).find((turn) => turn.text.includes(words));
  if (!found) throw new Error(`${call.id} says nothing with “${words}”.`);
  return { in: TRANSCRIPT, line: found.text };
}

/** The rollout talk's trial workspace and onboarding contact, as every long call says them (`rolloutOf`). */
const ROLLOUT_FACTS = {
  en: {
    words: ["It's a separate workspace.", "You'd have a named onboarding contact"],
    facts:
      "The trial import runs in a separate workspace that never reaches their live system; they get a named onboarding contact for the first three months, and the User will put in writing who picks up when.",
  },
  "zh-CN": {
    words: ["是单独的工作区", "头三个月你们会有一位专门的实施对接人"],
    facts:
      "试导入在单独的工作区进行，不会进入对方的正式系统；头三个月有专门的实施对接人，用户会书面写清楚谁在什么时间接。",
  },
} as const;

const CASE_FACTS: readonly { id: string; facts: string; words: readonly string[][] }[] = [
  {
    id: "en-answer-earlier",
    facts:
      "The User offered to keep a twelve percent discount for an early renewal signed by the end of March.",
    words: [["I can keep a twelve percent discount"]],
  },
  {
    id: "en-say-records",
    facts: "Their main worry is moving eight years of shipment records without losing anything.",
    words: [["Our main worry is moving eight years"]],
  },
  {
    id: "en-want",
    facts:
      "They need it running before their audit in June, and their budget is fixed at eight thousand dollars a month.",
    words: [["before our audit in June"], ["eight thousand dollars a month"]],
  },
  {
    id: "en-sum",
    facts:
      "The pilot starts on the third of March; Jonah owns the data export on their side; the User sends the mapping sheet by Friday.",
    words: [
      ["the pilot starts on the third of March"],
      ["Jonah on our side"],
      ["mapping sheet by Friday"],
    ],
  },
  {
    id: "en-say-competitor",
    facts: "Another vendor quoted them twenty percent below the Enterprise price.",
    words: [["another vendor quoted us twenty percent"]],
  },
  {
    id: "en-no-price",
    facts: "They asked whether Enterprise could be thirty-five dollars a seat.",
    words: [["thirty-five dollars a seat"]],
  },
  {
    id: "zh-answer-earlier",
    facts: "用户提出：三月底前签约提前续约，可以保留百分之十二的折扣。",
    words: [["我可以给你们保留百分之十二的折扣"]],
  },
  {
    id: "zh-say-records",
    facts: "对方最担心的是把八年的运单记录迁过去，一条都不能丢。",
    words: [["我们最担心的是把八年的运单记录迁过去"]],
  },
  {
    id: "zh-want",
    facts: "对方必须在六月审计之前上线，预算定死为每月最多五万。",
    words: [["六月审计之前上线"], ["每月最多五万"]],
  },
  {
    id: "zh-sum",
    facts: "试点三月三号开始；对方由李铭负责数据导出；用户这边周五前发字段对应表。",
    words: [["试点就定在三月三号开始"], ["数据导出由李铭负责"], ["字段对应表我们周五前发过去"]],
  },
  {
    id: "zh-say-competitor",
    facts: "另一家给对方的报价比企业版低百分之二十。",
    words: [["另一家给我们的报价比你们企业版低百分之二十"]],
  },
  {
    id: "zh-no-price",
    facts: "对方问企业版能不能做到每个席位两百五十元。",
    words: [["每个席位两百五"]],
  },
];

export const MEETING_NOTES_CASES: readonly MeetingNotesCase[] = CASE_FACTS.map((each) => {
  const call = CALL_HELP_CASES.find((one) => one.id === each.id);
  if (!call?.long) throw new Error(`No long call ${each.id}.`);
  const rollout = ROLLOUT_FACTS[call.language];
  return {
    id: `notes-${call.id}`,
    language: call.language,
    call,
    facts: `${each.facts} ${rollout.facts}`,
    rests: [...each.words, ...rollout.words.map((words) => [words])].map((group) =>
      group.map((words) => said(call, words)),
    ),
  };
});
