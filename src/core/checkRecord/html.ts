import { unreadRecordLines } from "../../shared/unreadFiles";
import { escapeHtml } from "../exports/printHtml";
import type { Language } from "../language";
import type { CheckRecord } from "./index";
import {
  checkedBy,
  KIND_LABELS,
  ORIGIN_LABELS,
  recordCiteResultLabel,
  recordTime,
  resultKey,
  type Translator,
  translatorFor,
} from "./labels";
import type { RecordCiteItem, RecordDocument, RecordItem } from "./read";
import { shapeOf } from "./shapes";
import { recordCiteTranslatorFor } from "./strings";

const shortHash = (sha256: string) => `${sha256.slice(0, 4)}…${sha256.slice(-4)}`;

interface RenderContext {
  t: Translator;
  number: (value: number) => string;
  language: Language;
}

const detail = (label: string, html: string) =>
  `<p class="record-detail"><span class="record-label">${escapeHtml(label)}</span> ${html}</p>`;

function evidenceDetails(
  evidence: RecordDocument | null,
  passageLabel: string,
  fullHash: boolean,
  { t, number }: RenderContext,
): { document: string | null; passage: string | null; file: string | null } {
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
    ? [
        `SHA-256 <code class="record-hash">${escapeHtml(fullHash ? evidence.sha256 : shortHash(evidence.sha256))}</code>`,
      ]
    : [];
  return {
    document: evidence
      ? detail(
          t("checkRecord.column.document"),
          escapeHtml(where.join(t("export.citation.separator"))),
        )
      : null,
    passage: evidence?.quote ? detail(passageLabel, `“${escapeHtml(evidence.quote)}”`) : null,
    file:
      file.length + hash.length > 0
        ? detail(t("checkRecord.column.file"), [...file, ...hash].join(" · "))
        : null,
  };
}

function checkerDetails(
  item: RecordItem | RecordCiteItem,
  { t, language }: RenderContext,
): string | null {
  const by = checkedBy(item, t);
  if (!by) return null;
  const at = item.kind === "citation" ? null : item.check?.at;
  const checker = [
    escapeHtml(
      by.place === null ? by.name : t("checkRecord.modelAt", { name: by.name, place: by.place }),
    ),
    ...(at ? [escapeHtml(recordTime(at, language, t))] : []),
  ];
  return detail(t("checkRecord.checkedBy"), checker.join(" · "));
}

const present = (values: readonly (string | null)[]): string[] =>
  values.filter((value) => value !== null);

/**
 * A record as HTML to print as a PDF (see `renderPrintHtml`): the summary, then each checked
 * sentence, Citation and record cite as a block that stays whole on its page. Everything from
 * the Mind and its Documents is escaped: the page shows text, never markup it was given.
 */
export function renderRecordHtml(record: CheckRecord): string {
  const { language } = record;
  const t = translatorFor(language);
  const rt = recordCiteTranslatorFor(language);
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
  const recordCiteCount = (items: readonly RecordCiteItem[]) => {
    const counts = new Map<string, number>();
    for (const item of items) {
      const label = recordCiteResultLabel(item.outcome, language, t);
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
    ...(record.recordCites.length === 0
      ? []
      : [
          [rt("summary.recordCites"), [recordCiteCount(record.recordCites)]] as [
            string,
            readonly string[],
          ],
        ]),
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
    ...(record.recordCites.length === 0
      ? []
      : [
          `<h2>${escapeHtml(rt("recordCites.heading", number(record.recordCites.length)))}</h2>`,
          ...record.recordCites.map((each) => renderRecordCiteItem(each, { t, number, language })),
        ]),
  ].join("");
}

function renderItem(each: RecordItem, context: RenderContext): string {
  const { t } = context;
  const source = evidenceDetails(each.evidence, t("checkRecord.column.quote"), false, context);
  return [
    '<div class="record-item">',
    `<p class="record-text">${escapeHtml(each.text)}</p>`,
    `<p class="record-result"><span class="record-shape">${shapeOf(each.result)}</span><b>${escapeHtml(t(resultKey(each)))}</b> · ${escapeHtml(t(KIND_LABELS[each.kind]))} · ${escapeHtml(t(ORIGIN_LABELS[each.origin]))}</p>`,
    ...present([
      source.document,
      source.passage,
      each.says ? detail(t("checkRecord.column.says"), escapeHtml(each.says)) : null,
      source.file,
      checkerDetails(each, context),
    ]),
    "</div>",
  ].join("");
}

function renderRecordCiteItem(each: RecordCiteItem, context: RenderContext): string {
  const { t, language } = context;
  const rt = recordCiteTranslatorFor(language);
  const source = evidenceDetails(each.evidence, rt("recordCites.column.passage"), true, context);
  const candidates =
    each.candidates.length === 0
      ? null
      : detail(
          rt("recordCites.column.candidates"),
          escapeHtml(
            each.candidates.map((candidate) => candidate.name).join(t("export.parts.separator")),
          ),
        );
  return [
    '<div class="record-item record-cite">',
    `<p class="record-text">${escapeHtml(each.raw)}</p>`,
    `<p class="record-result"><span class="record-shape">${shapeOf(each.outcome)}</span><b>${escapeHtml(recordCiteResultLabel(each.outcome, language, t))}</b> · ${escapeHtml(rt("recordCites.kind"))} · ${escapeHtml(t(ORIGIN_LABELS[each.origin]))}</p>`,
    ...present([
      detail(t("checkRecord.column.sentence"), escapeHtml(each.sentence)),
      source.document,
      source.passage,
      each.covered === null
        ? null
        : detail(rt("recordCites.column.covered"), escapeHtml(each.covered)),
      each.uncovered === null
        ? null
        : detail(rt("recordCites.column.uncovered"), escapeHtml(each.uncovered)),
      candidates,
      source.file,
      each.nearby?.location
        ? detail(rt("recordCites.column.nearbyLocation"), escapeHtml(each.nearby.location))
        : null,
      each.nearby
        ? detail(rt("recordCites.column.nearbyPassage"), `“${escapeHtml(each.nearby.passage)}”`)
        : null,
      checkerDetails(each, context),
    ]),
    "</div>",
  ].join("");
}
