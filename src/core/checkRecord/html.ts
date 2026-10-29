import { citedLocation } from "../../shared/citations";
import { differenceText, figurePlaceText, sourceValueText } from "../../shared/figureSchedule";
import { translate } from "../../shared/i18n";
import { unreadRecordLines } from "../../shared/unreadFiles";
import type { FigureScheduleRow } from "../api";
import { figureReason, statusWord } from "../exports/figureScheduleBook";
import { escapeHtml } from "../exports/printHtml";
import type { Language } from "../language";
import type { CheckRecord } from "./index";
import {
  checkedBy,
  KIND_LABELS,
  ORIGIN_LABELS,
  recordTime,
  resultKey,
  type Translator,
  translatorFor,
} from "./labels";
import type { RecordItem } from "./read";
import { shapeOf } from "./shapes";

const shortHash = (sha256: string) => `${sha256.slice(0, 4)}…${sha256.slice(-4)}`;

/**
 * A record as HTML to print as a PDF (see `renderPrintHtml`): the summary, then each checked
 * sentence and each Citation as a block that stays whole on its page. Everything from the Mind
 * and its Documents is escaped: the page shows text, never markup it was given.
 */
export function renderRecordHtml(record: CheckRecord): string {
  const { language } = record;
  const t = translatorFor(language);
  const number = new Intl.NumberFormat(language === "zh-CN" ? "zh-CN" : "en").format;
  const none = t("checkRecord.summary.none");

  const count = (items: readonly RecordItem[]) => {
    const counts = new Map<string, number>();
    for (const item of items) {
      const label = t(resultKey(item));
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts].map(([label, total]) => `${label} ${number(total)}`).join(" · ") || none;
  };
  const lines = (values: readonly string[]) => (values.length > 0 ? values : [none]);
  const summary: [string, readonly string[]][] = [
    [t("checkRecord.summary.mind"), [record.mind]],
    [t("checkRecord.summary.exported"), [recordTime(record.exportedAt, language, t)]],
    [t("checkRecord.summary.folder"), lines(record.searched)],
    [
      t("checkRecord.summary.localMode"),
      [t(record.localMode ? "checkRecord.summary.on" : "checkRecord.summary.off")],
    ],
    [t("checkRecord.summary.models"), lines(record.models)],
    ...(record.unread.length === 0
      ? []
      : [
          [t("unread.heading"), unreadRecordLines(record.unread, t)] as [string, readonly string[]],
        ]),
    [t("checkRecord.summary.sentences"), [count(record.sentences)]],
    [t("checkRecord.summary.citations"), [count(record.citations)]],
  ];

  const item = (each: RecordItem) => renderItem(each, { t, number, language });

  const section = (heading: string, items: readonly RecordItem[], empty: string) =>
    [
      `<h2>${escapeHtml(heading)}</h2>`,
      ...(items.length === 0 ? [`<p>${escapeHtml(empty)}</p>`] : items.map(item)),
    ].join("");

  return [
    `<h1 class="mind-title">${escapeHtml(t("checkRecord.title", { name: record.mind }))}</h1>`,
    `<table class="record-summary">${summary
      .map(
        ([label, values]) =>
          `<tr><th scope="row">${escapeHtml(label)}</th><td>${values
            .map((value) => `<div>${escapeHtml(value)}</div>`)
            .join("")}</td></tr>`,
      )
      .join("")}</table>`,
    `<p class="record-note">${escapeHtml(t("checkRecord.modelNote"))}</p>`,
    section(
      t("checkRecord.sentences.heading", { count: number(record.sentences.length) }),
      record.sentences,
      t("checkRecord.sentences.none"),
    ),
    section(
      t("checkRecord.citations.heading", { count: number(record.citations.length) }),
      record.citations,
      t("checkRecord.citations.none"),
    ),
    ...(record.figures.length > 0 ? [renderFigures(record.figures, language)] : []),
  ].join("");
}

const FIGURE_SHAPES: Readonly<Record<string, RecordItem["result"]>> = {
  supported: "found",
  "not-checked": "notChecked",
  checking: "notChecked",
  "needs-recheck": "needsRecheck",
  contradicted: "contradicted",
};

/** The Figure schedule's rows, as its workbook has them (#1932). */
function renderFigures(rows: readonly FigureScheduleRow[], language: Language): string {
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate(language, key, params);
  const cell = (main: string, under = "") =>
    `<td><div>${escapeHtml(main || "—")}</div>${under ? `<div class="record-label">${escapeHtml(under)}</div>` : ""}</td>`;
  const body = rows
    .map((row) => {
      const unchecked = row.shown.state === "not-checked" || row.shown.state === "checking";
      const citation = unchecked ? null : (row.sourceInput?.citation ?? row.source ?? null);
      const shape = shapeOf(FIGURE_SHAPES[row.shown.state] ?? "unsupported");
      return `<tr>${[
        `<td>${row.number}</td>`,
        cell(`${row.calculated ? "= " : ""}${row.reading.chars}`, figurePlaceText(row, language)),
        cell(unchecked ? "" : (sourceValueText(row) ?? "")),
        cell(citation?.documentName ?? "", citation ? (citedLocation(citation, t) ?? "") : ""),
        cell(unchecked ? "" : (differenceText(row, language) ?? "")),
        `<td><div><span class="record-shape">${shape}</span><b>${escapeHtml(t(statusWord(row)))}</b></div>${
          unchecked
            ? ""
            : `<div class="record-label">${escapeHtml(figureReason(row, language))}</div>`
        }</td>`,
      ].join("")}</tr>`;
    })
    .join("");
  const head = [
    "№",
    t("figures.figure"),
    t("figures.sourceValue"),
    t("figures.export.documentPlace"),
    t("figures.difference"),
    t("figures.status"),
  ];
  return [
    `<h2>${escapeHtml(t("figures.export.recordHeading"))}</h2>`,
    `<table class="record-figures"><thead><tr>${head.map((label) => `<th scope="col">${escapeHtml(label)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table>`,
  ].join("");
}

function renderItem(
  each: RecordItem,
  { t, number, language }: { t: Translator; number: (value: number) => string; language: Language },
): string {
  const detail = (label: string, html: string) =>
    `<p class="record-detail"><span class="record-label">${escapeHtml(label)}</span> ${html}</p>`;
  const { evidence } = each;
  const by = checkedBy(each, t);
  const at = each.kind === "sentence" ? each.check?.at : null;
  const where = evidence
    ? [evidence.name, evidence.location].filter((part) => part !== null && part !== "")
    : [];
  const file = evidence
    ? [
        evidence.deleted ? t("checkRecord.documentDeleted") : evidence.file,
        evidence.size === null ? null : t("checkRecord.bytes", { count: number(evidence.size) }),
      ]
        .filter((part) => part !== null)
        .map(escapeHtml)
    : [];
  const hash = evidence?.sha256
    ? [`SHA-256 <code class="record-hash">${escapeHtml(shortHash(evidence.sha256))}</code>`]
    : [];
  const checker = by && [
    escapeHtml(
      by.place === null ? by.name : t("checkRecord.modelAt", { name: by.name, place: by.place }),
    ),
    ...(at ? [escapeHtml(recordTime(at, language, t))] : []),
  ];
  return [
    '<div class="record-item">',
    `<p class="record-text">${escapeHtml(each.text)}</p>`,
    `<p class="record-result"><span class="record-shape">${shapeOf(each.result)}</span><b>${escapeHtml(t(resultKey(each)))}</b> · ${escapeHtml(t(KIND_LABELS[each.kind]))} · ${escapeHtml(t(ORIGIN_LABELS[each.origin]))}</p>`,
    ...(evidence
      ? [
          detail(
            t("checkRecord.column.document"),
            escapeHtml(where.join(t("export.citation.separator"))),
          ),
        ]
      : []),
    ...(evidence?.quote
      ? [detail(t("checkRecord.column.quote"), `“${escapeHtml(evidence.quote)}”`)]
      : []),
    ...(each.says ? [detail(t("checkRecord.column.says"), escapeHtml(each.says))] : []),
    ...(file.length + hash.length > 0
      ? [detail(t("checkRecord.column.file"), [...file, ...hash].join(" · "))]
      : []),
    ...(checker ? [detail(t("checkRecord.checkedBy"), checker.join(" · "))] : []),
    "</div>",
  ].join("");
}
