/**
 * The words of an AI use statement (#739): its counts set into the template of
 * the interface language. The statement states counts and says what they are
 * counts of. It never scores, rates or compares, and never says anything about
 * AI detection: a test keeps those words out of every template.
 */
import type { SentenceResult } from "../../shared/claimChecks";
import { formatDate } from "../../shared/dates";
import { type MessageKey, translate } from "../../shared/i18n";
import { unreadFileText } from "../../shared/unreadFiles";
import type { NodeJSON } from "../answers/blocks";
import type { Language } from "../language";
import {
  type AiUseFigures,
  type CheckedSentence,
  type CitationCounts,
  SENTENCE_WORDS,
  type SectionCount,
  type SentenceCounts,
  totalCitations,
  totalSentences,
  type Use,
  type UseCount,
} from "./figures";

const USE_LABELS: Readonly<Record<Use, MessageKey>> = {
  answer: "aiStatement.use.answer",
  "answer-added": "aiStatement.use.answer-added",
  "edit-with-ai-accepted": "aiStatement.use.edit-with-ai-accepted",
  "assistant-change-accepted": "aiStatement.use.assistant-change-accepted",
  "comparison-table-accepted": "aiStatement.use.comparison-table-accepted",
  "suggestion-accepted": "aiStatement.use.suggestion-accepted",
  "search-documents": "aiStatement.use.search-documents",
  "search-sources": "aiStatement.use.search-sources",
  "search-web": "aiStatement.use.search-web",
  "sentence-checked": "aiStatement.use.sentence-checked",
};

const CITATION_ROWS: readonly [keyof CitationCounts, MessageKey][] = [
  ["found", "aiStatement.citations.found"],
  ["notFound", "aiStatement.citations.notFound"],
  ["cantCheck", "aiStatement.citations.cantCheck"],
  ["unsupported", "aiStatement.citations.unsupported"],
  ["contradicted", "aiStatement.citations.contradicted"],
  ["checking", "aiStatement.citations.checking"],
];

const SENTENCE_LABELS: Readonly<Record<SentenceResult, MessageKey>> = {
  supported: "aiStatement.sentences.supported",
  unsupported: "aiStatement.sentences.unsupported",
  contradicted: "aiStatement.sentences.contradicted",
  needsRecheck: "aiStatement.sentences.recheck",
  notChecked: "aiStatement.sentences.notChecked",
  changed: "aiStatement.sentences.changed",
};

const SENTENCE_ROWS: readonly [keyof SentenceCounts, MessageKey][] = (
  ["supported", "unsupported", "contradicted", "needsRecheck", "notChecked"] as const
).map((key) => [key, SENTENCE_LABELS[key]]);

const text = (value: string): NodeJSON => ({ type: "text", text: value });

const paragraph = (value: string): NodeJSON => ({ type: "paragraph", content: [text(value)] });

const heading = (value: string): NodeJSON => ({
  type: "heading",
  attrs: { level: 2 },
  content: [text(value)],
});

const bulletList = (items: readonly string[]): NodeJSON => ({
  type: "bulletList",
  content: items.map((item) => ({ type: "listItem", content: [paragraph(item)] })),
});

/** A table of text, its first row the heading row; the columns from `numbers` on hold counts, set right. */
function table(head: string[], rows: string[][], numbers: number): NodeJSON {
  const row = (cells: string[], type: "tableHeader" | "tableCell"): NodeJSON => ({
    type: "tableRow",
    content: cells.map((cell, column) => ({
      type,
      attrs: { colspan: 1, rowspan: 1, ...(column >= numbers && { align: "right" }) },
      content: [{ type: "paragraph", content: cell === "" ? [] : [text(cell)] }],
    })),
  });
  return {
    type: "table",
    content: [row(head, "tableHeader"), ...rows.map((cells) => row(cells, "tableCell"))],
  };
}

/** The statement's Blocks, in the language, as of `date` (ISO 8601). */
export function statementBlocks(
  figures: AiUseFigures,
  language: Language,
  date: string,
): NodeJSON[] {
  const t = (key: MessageKey, params?: Record<string, string | number>) =>
    translate(language, key, params);
  const number = new Intl.NumberFormat(language === "zh-CN" ? "zh-CN" : "en").format;
  const { uses, sections, removed, citations, sentences, checked, unread, unreadNames } = figures;
  const citationTotal = totalCitations(citations);
  const sentenceTotal = totalSentences(sentences);
  const intro = paragraph(t("aiStatement.intro", { date: formatDate(date, language) }));
  const note = paragraph(t("aiStatement.note"));

  if (
    uses.length === 0 &&
    sections.length === 0 &&
    removed === 0 &&
    citationTotal === 0 &&
    sentenceTotal === 0
  ) {
    return [intro, paragraph(t("aiStatement.empty")), note];
  }

  const useRow = ({ use, model, times }: UseCount) => [
    t(USE_LABELS[use]),
    model ?? t("aiStatement.uses.modelUnknown"),
    number(times),
  ];
  const usesPart =
    uses.length === 0
      ? [paragraph(t("aiStatement.uses.none"))]
      : [
          table(
            [
              t("aiStatement.uses.column.use"),
              t("aiStatement.uses.column.model"),
              t("aiStatement.uses.column.times"),
            ],
            uses.map(useRow),
            2,
          ),
        ];

  const sectionRow = (section: SectionCount) => [
    section.title ?? t(figures.headings ? "aiStatement.text.start" : "aiStatement.text.whole"),
    number(section.kept),
    number(section.rewritten),
    number(section.words),
  ];
  const add = (key: "kept" | "rewritten" | "words") =>
    number(sections.reduce((total, section) => total + section[key], 0));
  const textPart =
    sections.length === 0 && removed === 0
      ? [paragraph(t("aiStatement.text.none"))]
      : [
          paragraph(t("aiStatement.text.intro")),
          ...(sections.length === 0
            ? []
            : [
                table(
                  [
                    t("aiStatement.text.column.section"),
                    t("aiStatement.text.column.kept"),
                    t("aiStatement.text.column.rewritten"),
                    t("aiStatement.text.column.words"),
                  ],
                  [
                    ...sections.map(sectionRow),
                    ...(sections.length > 1
                      ? [[t("aiStatement.text.total"), add("kept"), add("rewritten"), add("words")]]
                      : []),
                  ],
                  1,
                ),
              ]),
          ...(removed > 0 ? [paragraph(t("aiStatement.text.removed", { count: removed }))] : []),
        ];

  const checkedRow = ({ sentence, result, model, checkedAt }: CheckedSentence) => [
    sentence,
    t(SENTENCE_LABELS[result]),
    checkedAt === null ? "" : (model ?? t("aiStatement.uses.modelUnknown")),
    checkedAt === null ? "" : formatDate(checkedAt, language),
  ];

  const resultRows = <K extends string>(
    counts: Record<K, number>,
    rows: readonly [K, MessageKey][],
    always: readonly K[],
  ) =>
    rows
      .filter(([key]) => counts[key] > 0 || always.includes(key))
      .map(([key, label]) => [t(label), number(counts[key])]);
  const unreadPart =
    unread.length === 0
      ? []
      : [
          paragraph(
            unread.length === 1
              ? t("aiStatement.unread.one")
              : t("aiStatement.unread", { count: number(unread.length) }),
          ),
          ...(unreadNames ? [bulletList(unread.map((file) => unreadFileText(file, t)))] : []),
        ];
  const checksPart =
    citationTotal === 0 && sentenceTotal === 0
      ? [paragraph(t("aiStatement.checks.none"))]
      : [
          ...(citationTotal === 0
            ? []
            : [
                paragraph(t("aiStatement.citations.intro")),
                table(
                  [
                    t("aiStatement.citations.column.result"),
                    t("aiStatement.citations.column.count"),
                  ],
                  // A quote not found is stated even at none, so its absence isn't left to be inferred.
                  resultRows(citations, CITATION_ROWS, ["found", "notFound"]),
                  1,
                ),
              ]),
          ...(sentenceTotal === 0
            ? []
            : [
                paragraph(t("aiStatement.sentences.intro")),
                table(
                  [
                    t("aiStatement.citations.column.result"),
                    t("aiStatement.sentences.column.count"),
                  ],
                  resultRows(sentences, SENTENCE_ROWS, []),
                  1,
                ),
                paragraph(t("aiStatement.sentences.list.intro", { count: SENTENCE_WORDS })),
                table(
                  [
                    t("aiStatement.sentences.column.sentence"),
                    t("aiStatement.citations.column.result"),
                    t("aiStatement.uses.column.model"),
                    t("aiStatement.sentences.column.checked"),
                  ],
                  checked.map(checkedRow),
                  4,
                ),
                ...unreadPart,
              ]),
        ];

  return [
    intro,
    heading(t("aiStatement.uses.heading")),
    ...usesPart,
    heading(t("aiStatement.text.heading")),
    ...textPart,
    heading(t("aiStatement.checks.heading")),
    ...checksPart,
    note,
  ];
}
