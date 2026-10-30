/**
 * In the assistant, with `ask_user` (#1374): "Summarise the main documents" (总结主要的文档), with
 * more than two Documents, asks which ones, the two newest ticked, then writes a summary of those
 * chosen into the Mind in focus. Skipped, it goes on with the two newest and says so.
 * "Summarise the main ones" asks as Claude Haiku 5.5 did: one choice, one ticked, Other… allowed.
 * "Summarise the two main documents" (总结两份主要文档), when the Answer can use fewer than two
 * of the Library's Documents, asks which two and says the Library's count (#1333); once the
 * Library is the User's own one, it sums that one up instead (#1942).
 */
import { lastResult, type Prompt, type Reply, systemOf } from "./prompt";

const MAIN_DOCUMENTS =
  /\bsummari[sz]e the (?:main|key|important) documents\b|总结.*(?:主要|重要).*文档/i;
const MAIN_ONES = /\bsummari[sz]e the main ones\b/i;
const TWO_MAIN =
  /\bsummari[sz]e (?:the )?two (?:main|key|important) documents\b|总结(?:一下)?(?:两份|两个)主要(?:的)?(?:文档|文件)/i;
const FOR_THE_BOARD = /\bfor the board\b|董事会/i;

// Each option says why it may be chosen, as the Tool asks and Claude Sonnet 5.5 does.
const DESCRIPTIONS = [
  "The newest in your Library, with this quarter's figures.",
  "Added just before it, and signed by both parties.",
  "An older one, still a draft, with last year's terms.",
  "The oldest here: it hasn't changed this year.",
];
const DESCRIPTIONS_ZH = [
  "资料库里最新的一份，有本季度的数据。",
  "在它之前添加，双方都已签署。",
  "较早的一份，仍是草稿，用的是去年的条款。",
  "这里最早的一份，今年没有改动。",
];

const LISTED =
  /^(?:Its name|Their names, newest first|The names of the \d+ added most recently):\n((?:- .+\n?)+)/m;
export const namesIn = (system: string): string[] => {
  const list = LISTED.exec(system)?.[1] ?? "";
  return [...list.matchAll(/^- (.+)$/gm)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((name) => !name.startsWith("…"));
};

/** The Library's count, as the instructions give it when it holds more Documents than the scope (#1333). */
const LIBRARY_COUNT = /The User's Library holds (\d+) Documents?\b/;
const libraryIn = (system: string): number | null => {
  const found = LIBRARY_COUNT.exec(system)?.[1];
  return found === undefined ? null : Number(found);
};

const chosenIn = (result: string): string[] =>
  [...result.matchAll(/“([^”]+)”/g)].map((match) => match[1] ?? "");

export function asksReply(
  prompt: Prompt,
  question: string,
  names: readonly string[],
): Reply | null {
  if (TWO_MAIN.test(question)) {
    const documents = namesIn(systemOf(prompt));
    const library = libraryIn(systemOf(prompt));
    // Fewer than the two it names can be used: ask which, and give the Library's own count.
    if (documents.length < 2 && library !== null && library > documents.length) {
      const [only] = documents;
      return {
        text: /\p{Script=Han}/u.test(question)
          ? `你指的是哪两份文档？资料库里有 ${library} 份${only ? `，这里只能搜索“${only}”` : ""}。`
          : `Which two Documents do you mean? Your Library has ${library}, and ${only ? `“${only}” is the only one I can search here` : "none of them can be searched here"}.`,
      };
    }
    if (documents.length === 1 && library === null) {
      const [only] = documents;
      return {
        text: /\p{Script=Han}/u.test(question)
          ? `资料库里只有“${only}”这一份文档，我按它来总结。`
          : `Your Library has one Document, “${only}”, so this is a summary of it.`,
      };
    }
    return null;
  }
  const single = MAIN_ONES.test(question);
  if (!names.includes("ask_user") || !(single || MAIN_DOCUMENTS.test(question))) return null;
  const documents = namesIn(systemOf(prompt));
  const chinese = /\p{Script=Han}/u.test(question);
  const answered = lastResult(prompt, "ask_user");
  if (single) {
    if (answered !== undefined) return { text: "Going on with that." };
    return {
      tool: "ask_user",
      input: {
        question: "Which documents should I summarise as the “main” ones?",
        multiple: false,
        other: true,
        options: [
          {
            label: "The two newest",
            description: "The two added last, which most likely hold what changed.",
            recommended: true,
            preselected: true,
          },
          {
            label: `All ${documents.length} Documents`,
            description: "Every Document in the Library: the longest summary.",
          },
          { label: "Only the leases", description: "The two leases, side by side." },
        ],
      },
    };
  }
  if (answered === undefined) {
    if (documents.length <= 2) return null;
    return {
      tool: "ask_user",
      input: {
        question: chinese
          ? FOR_THE_BOARD.test(question)
            ? "要为董事会总结哪几份文档？其中有些还是草稿，有些已经签署，而会议纪要只记下了决定了什么，却没有记下为什么这样决定，也没有写明谁提出了反对意见。"
            : "要总结哪几份文档？"
          : FOR_THE_BOARD.test(question)
            ? "Which Documents should I summarise for the board, given that some of them are drafts, some are signed, and the minutes only record what was decided rather than why it was decided?"
            : "Which Documents should I summarise?",
        detail: chinese
          ? FOR_THE_BOARD.test(question)
            ? `资料库里有 ${documents.length} 份，已选中最新的两份，因为董事会通常关心最近的变化，而较早的那份租约今年没有改动。`
            : `资料库里有 ${documents.length} 份，已选中最新的两份。`
          : FOR_THE_BOARD.test(question)
            ? `Your Library has ${documents.length}. The two newest are picked, since the board asks about what changed most recently, and the older lease hasn't changed this year.`
            : `Your Library has ${documents.length}. The two newest are picked.`,
        multiple: true,
        other: true,
        options: documents.slice(0, 4).map((name, index) => ({
          label: name,
          description: (chinese ? DESCRIPTIONS_ZH : DESCRIPTIONS)[index],
          recommended: index === 0,
          preselected: index < 2,
        })),
      },
    };
  }
  const skipped = answered.includes("skipped");
  const chosen = skipped ? documents.slice(0, 2) : chosenIn(answered);
  const added = lastResult(prompt, "add_to_mind");
  if (added === undefined) {
    const content = [
      chinese ? "## 摘要" : "## Summary",
      ...chosen.map((name) => (chinese ? `“${name}”的要点。` : `The main points of “${name}”.`)),
    ].join("\n\n");
    return { tool: "add_to_mind", input: { content } };
  }
  return {
    text: skipped
      ? chinese
        ? "你没有选择，先总结了最新的两份文档。"
        : "Summarised the two newest Documents, as you didn't choose."
      : chinese
        ? "已写好你选的文档的摘要。"
        : "Summarised the Documents you chose.",
  };
}
