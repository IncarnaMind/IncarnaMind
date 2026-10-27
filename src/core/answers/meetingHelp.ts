/**
 * One-click help during a call: the instructions for a button's
 * Question, whose Answer the User reads in a second or two while the call
 * goes on. The floating panel lays each line out by its first character
 * (src/renderer/src/helpReply.ts), so the shape is fixed here.
 */

import { HELP_SHAPE, type HelpShape, type MeetingHelpKind } from "../../shared/meetingHelp";
import type { WindowedPassage } from "../documents/search";
import { LANGUAGE_NAMES, type Language } from "../language";
import { estimateTokens } from "./context";
import type { AnswerMessage } from "./engine";
import { questionLanguage } from "./prompt";

const TASKS: Readonly<Record<MeetingHelpKind, string>> = {
  say: "What could the User say next, given the last thing said?",
  answer: "Answer the newest question the other side asked, from the User's Documents.",
  want: "What does the other side want? Read it from what they said in the last few minutes.",
  sum: "Sum up the call so far: what was said and decided, the most important first.",
  no: "Decline what was just asked of the User, politely, keeping the relationship; the option you recommend keeps things moving.",
  ask: "What should the User ask next, to move the call forward? Each option is a question.",
  check:
    "Check the newest claims in the transcript against the User's Documents: each line is a claim, then whether the Documents support it, contradict it or don't say.",
  objection: "Answer the other side's newest objection.",
  nextStep:
    "Propose a concrete next step that fits where the call is: a meeting, a trial, something to send.",
  facts:
    "The facts from the User's Documents that matter for what is being discussed now: prices, the product, terms. Each line is one fact.",
  followUp:
    "A follow-up question that digs into what the interviewee just said, without suggesting an answer.",
  leading:
    "Is the User's own newest question (their lines in the transcript) leading the interviewee? Start with one short line that says whether it does and why, then give one or two better questions as the options.",
  notCovered:
    "Compare the interview guide in the User's Documents with the transcript: each line is a topic or question from the guide not covered yet, cited to the guide.",
  decisions: "The decisions made so far, each with its owner.",
  disagree: "Where people in the call disagree: each line is one point, and who holds which view.",
};

export const HELP_DOCUMENTS: Readonly<Record<MeetingHelpKind, string | null>> = {
  say: "ground a useful reply in relevant facts or terms",
  answer: "answer the newest question with the User's facts",
  want: null,
  sum: null,
  no: "ground a refusal in relevant policies or terms",
  ask: "identify a relevant gap worth asking about, with a reason",
  check: "compare the newest spoken claims with the Documents",
  objection: "ground an answer to the newest objection in relevant facts",
  nextStep: "suggest a feasible next step from relevant plans or terms",
  facts: "find Document facts relevant to the discussion",
  followUp: null,
  leading: null,
  notCovered: "compare the interview guide with what the call has covered",
  decisions: null,
  disagree: null,
};

const SHAPES: Readonly<Record<HelpShape, readonly string[]>> = {
  options: [
    '- One or two options, never more. The one you recommend comes first, its line starting with "★ ".',
    '- Each option is two lines: what the User could say, as they would say it aloud, one sentence of at most 25 words with no quotation marks around it (the panel shows it as a quote), its Citation markers at its end; then a line starting with "→ " and what saying it leads to, in at most eight words, with no Citation marker.',
  ],
  readings: [
    '- One or two readings, never more. The likeliest comes first, its line starting with "★ ".',
    '- Each reading is three lines: what they want, in one sentence, as a reading of what they said and never as a fact; then the moment of the transcript it rests on: its time and a few words they said in quotation marks, with no punctuation before the closing mark, then its Citation marker; then a line starting with "→ " and the move it suggests, in at most ten words.',
  ],
  lines: [
    '- At most three short lines, each starting with "- ", each one sentence of at most 20 words, its Citation markers at its end.',
  ],
};

/** A reply in each shape, in the call's language where it is Chinese: a model copies an example's language. */
const EXAMPLES: Readonly<Record<"en" | "zh", Readonly<Record<HelpShape, readonly string[]>>>> = {
  en: {
    options: [
      "★ We can't go below list for Enterprise, but we can extend the pilot to 60 days [^1]",
      "→ keeps the deal moving; protects the margin",
      "",
      "Let me check with our team and come back to you by Friday",
      "→ buys time; momentum may drop",
    ],
    readings: [
      "★ They want the total for 40 seats under £10k",
      "12:04 “our budget stops at ten thousand” [^1]",
      "→ give the tiered price, then ask about their budget cycle",
    ],
    lines: ["- The launch moves to 18 November [^1]", "- Dana confirms the date with the provider"],
  },
  zh: {
    options: [
      "★ 企业版价格没法低于标价，但我们可以把试用延长到 60 天 [^1]",
      "→ 推进成交，守住利润",
      "",
      "我跟团队确认一下，周五前给你答复",
      "→ 争取时间，但可能冷场",
    ],
    readings: [
      "★ 对方想要 40 个席位的总价，不超过一万英镑",
      "12:04 “我们的预算上限是一万” [^1]",
      "→ 先给阶梯价，再问他们的预算周期",
    ],
    lines: ["- 上线推迟到 11 月 18 日 [^1]", "- Dana 跟服务商确认日期"],
  },
};

/** The most of the User's Documents a button's Question takes, found ahead for the newest lines. */
export const FOUND_TOKEN_LIMIT = 2_000;

/** What the newest lines say, to search the Documents for: the last two Passages of the transcript. */
export const newestSaid = (heard: readonly WindowedPassage[]): string =>
  heard
    .slice(-2)
    .map((passage) => passage.text)
    .join("\n");

/** The most relevant Passages found that fit in `tokens`, in the order found. */
export function foundWithin(found: readonly WindowedPassage[], tokens: number): WindowedPassage[] {
  const kept: WindowedPassage[] = [];
  let left = tokens;
  for (const passage of [...found].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))) {
    const cost = estimateTokens(passage.text);
    if (cost > left) break;
    kept.push(passage);
    left -= cost;
  }
  return found.filter((passage) => kept.includes(passage));
}

/** The Passages found ahead (`shown`), right after the live transcript in the Question's message. */
export function withFound(messages: readonly AnswerMessage[], shown: string): AnswerMessage[] {
  const last = messages.at(-1);
  if (last?.role !== "user") return [...messages];
  const found = `<found-in-documents>\n${shown}\n</found-in-documents>`;
  const end = "</live-transcript>";
  const at = last.content.indexOf(end);
  const content =
    at === -1
      ? `${found}\n\n${last.content}`
      : `${last.content.slice(0, at + end.length)}\n\n${found}${last.content.slice(at + end.length)}`;
  return [...messages.slice(0, -1), { ...last, content }];
}

/** The button's instructions (`meetingHelpInstructions`) after its Question, in its message. */
export function withHelp(
  messages: readonly AnswerMessage[],
  instructions: string,
): AnswerMessage[] {
  const last = messages.at(-1);
  if (last?.role !== "user") return [...messages];
  return [
    ...messages.slice(0, -1),
    { ...last, content: `${last.content}\n\n<help>\n${instructions}\n</help>` },
  ];
}

/** The language the newest lines of a live transcript are in, without their times and speakers. */
export const languageSaid = (heard: readonly WindowedPassage[]): string | null =>
  questionLanguage(
    heard
      .slice(-3)
      .map((passage) => passage.text.replace(/\[[^\]]*\]/g, " "))
      .join("\n"),
  );

/**
 * A button's Question while the live text is behind but has lines (#1366). The reply starts with a
 * line saying so, written for it: the model neither repeats it nor adds another before its form.
 */
export const LIVE_TEXT_BEHIND_NOTE =
  "- The live text fell behind: <live-transcript> holds the lines written so far, and what was said since isn't in it. A line saying so already starts the reply: don't repeat it, and answer from these lines.";

/**
 * What the model is told for a button's Question during a call. `found`: Passages of the User's
 * Documents were found ahead for the newest lines. `callLanguage`: the language the call's newest
 * lines are in, which the reply is written in; `language`, the interface's, when it can't be told.
 */
export function meetingHelpInstructions(
  kind: MeetingHelpKind,
  {
    found,
    language,
    callLanguage,
  }: { found: boolean; language: Language; callLanguage: string | null },
): string {
  const shape = HELP_SHAPE[kind];
  const task = TASKS[kind];
  const documents = HELP_DOCUMENTS[kind];
  return [
    "The User is in a call and pressed a button for help: the Question is the button's name. They will read your reply in a second or two while the call goes on.",
    `What they need: ${task}`,
    "Reply in exactly this form, with nothing before or after it: start with its first line, and add no heading, introduction, plan, remark on the transcript or closing line.",
    ...SHAPES[shape],
    "For example:",
    ...EXAMPLES[callLanguage === "Chinese" ? "zh" : "en"][shape],
    "- Base it on the newest lines of <live-transcript>: what was said last matters most.",
    "- Never say what you can't read or which button this is.",
    "- When the other side names a price or a figure, it is what they ask for, never the User's: don't repeat it as the User's price or offer.",
    ...(documents === null
      ? [
          "- Use only <live-transcript> for facts, with its Citation markers. Do not use Library Documents or written notes. If there is no call text yet, say there is not enough call content to answer; never substitute other facts.",
        ]
      : [
          `- Use the User's Documents only to ${documents}. A Document fact was not said in this call: distinguish it from the transcript, cite it, and never invent one. When giving a suggestion, explain its relevance in the → line.`,
        ]),
    ...(documents !== null && found
      ? [
          "- <found-in-documents> holds Passages of the User's Documents already found for the newest lines: cite them by id, and search only if they don't answer.",
        ]
      : []),
    callLanguage
      ? `- The call is in ${callLanguage}: write all of it in ${callLanguage}, the "→" lines too, though the Question and the User's interface may be in another language. This overrides every other rule on the language to write in.`
      : `- Write in ${LANGUAGE_NAMES[language]}.`,
  ].join("\n");
}
