/**
 * The sentences of an Answer that say what its search didn't find, or what the other Documents
 * don't say, and whether each carries a Citation marker (#3019). Nothing can be quoted for a gap,
 * so a marker on such a sentence joins a quote to it, and the check gives that sentence no ✓. A
 * phrase rule: a first pass, which the reader of a run's report checks by hand.
 */
import { INLINE_NODE, sentenceSpans } from "../../src/shared/sentences";
import { declines } from "../lib/declines";

export interface NotFoundSentence {
  sentence: string;
  /** It carries a Citation marker. */
  marked: boolean;
  /** It says what the other Documents don't: "Only this one covers it", "其他文档没有提到". */
  otherDocuments: boolean;
}

const MARKER = /\[\^\d+\]/g;
const FOOTNOTE_LINE = /^\s*\[\^\d+\]:/;
const BLOCK_MARKUP = /^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/;

const DOCUMENTS = "(?:documents?|papers?|reports?|sources?|files?)";
const DOCUMENTS_ZH = "(?:文档|文件|论文|报告|资料)";

const OTHER_DOCUMENTS = [
  new RegExp(`\\bonly (?:one of the )?${DOCUMENTS}\\b|\\bthe only (?:one|${DOCUMENTS})\\b`, "i"),
  new RegExp(`\\bnone of the other\\b|\\bno other ${DOCUMENTS}\\b`, "i"),
  new RegExp(
    `\\b(?:in|from) the other ${DOCUMENTS}\\b|\\bthe other ${DOCUMENTS} (?:do(?:n't| not)|never)\\b`,
    "i",
  ),
  new RegExp(
    `(?:其他|其余|别的)${DOCUMENTS_ZH}|唯一(?:一[篇份个])?的?${DOCUMENTS_ZH}|(?:只有|仅有|只在|仅在)《`,
  ),
];

/** Chinese that says the Passages or the search don't give something, past the Answer's opening. */
const NOT_GIVEN_ZH = new RegExp(
  `(?:段落|${DOCUMENTS_ZH})[^。！？!?\\n]{0,12}(?:没有|未|并未|并没有)(?:给出|提供|提到|提及|说明|写明|列出|找到)|(?:段落|${DOCUMENTS_ZH})(?:里|中|内)?都?(?:没有|并没有|未|并未)|(?:没有|未)(?:找到|读到|查到)`,
);

/** The Answer's sentences that say what wasn't found, each with whether it is marked. */
export function notFoundSentences(reply: string): NotFoundSentence[] {
  const found: NotFoundSentence[] = [];
  for (const line of reply.split("\n")) {
    if (FOOTNOTE_LINE.test(line)) continue;
    const marked = line
      .replace(BLOCK_MARKUP, "")
      .replace(MARKER, INLINE_NODE)
      .replace(/[*_`|]/g, " ");
    for (const { from, to } of sentenceSpans(marked)) {
      const span = marked.slice(from, to);
      const sentence = span.replaceAll(INLINE_NODE, "").replace(/\s+/g, " ").trim();
      const otherDocuments = OTHER_DOCUMENTS.some((rule) => rule.test(sentence));
      if (!otherDocuments && !declines(sentence) && !NOT_GIVEN_ZH.test(sentence)) continue;
      found.push({ sentence, marked: span.includes(INLINE_NODE), otherDocuments });
    }
  }
  return found;
}

/**
 * Per model and language: the Answers that say what wasn't found, such sentences, those joined to
 * a quote by a marker, and those about the other Documents; then each sentence, to read by hand.
 */
export function notFoundLines(
  answers: readonly {
    id: string;
    model: string;
    language: string;
    notFound?: NotFoundSentence[];
  }[],
): string[] {
  if (answers.length === 0) return [];
  const groups = [...new Set(answers.map((each) => `${each.model}\n${each.language}`))];
  const sentences = answers.flatMap((each) =>
    (each.notFound ?? []).map((sentence) => ({ ...each, ...sentence })),
  );
  return [
    "The sentences that say what wasn't found, by the phrase rule: the marked ones join a quote to it.",
    "",
    "| Model | Language | Answers | Answers that say what wasn't found | Such sentences | Marked | About the other Documents | Of them marked |",
    "|---|---|---|---|---|---|---|---|",
    ...groups.map((key) => {
      const [model = "", language = ""] = key.split("\n");
      const some = answers.filter((each) => each.model === model && each.language === language);
      const said = some.flatMap((each) => each.notFound ?? []);
      const others = said.filter((each) => each.otherDocuments);
      return `| ${model} | ${language} | ${some.length} | ${some.filter((each) => (each.notFound ?? []).length > 0).length} | ${said.length} | ${said.filter((each) => each.marked && !each.otherDocuments).length} | ${others.length} | ${others.filter((each) => each.marked).length} |`;
    }),
    "",
    ...sentences.map(
      (each) =>
        `- ${each.id} (${each.model})${each.marked ? " **marked**" : ""}${each.otherDocuments ? ", about the other Documents" : ""}: ${each.sentence}`,
    ),
    ...(sentences.length > 0 ? [""] : []),
  ];
}
