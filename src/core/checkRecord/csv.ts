import type { MessageKey } from "../../shared/i18n";
import { unreadRecordLines } from "../../shared/unreadFiles";
import type { Language } from "../language";
import type { CheckRecord } from "./index";
import {
  checkedBy,
  KIND_LABELS,
  ORIGIN_LABELS,
  recordCiteResultLabel,
  resultKey,
  type Translator,
  translatorFor,
} from "./labels";
import type { RecordCiteItem, RecordItem } from "./read";
import { type RecordCiteTranslator, recordCiteTranslatorFor } from "./strings";

const COLUMNS: readonly MessageKey[] = [
  "checkRecord.column.kind",
  "checkRecord.column.sentence",
  "checkRecord.column.result",
  "checkRecord.column.text",
  "checkRecord.column.document",
  "checkRecord.column.file",
  "checkRecord.column.size",
  "checkRecord.column.sha256",
  "checkRecord.column.location",
  "checkRecord.column.quote",
  "checkRecord.column.says",
  "checkRecord.column.model",
  "checkRecord.column.service",
  "checkRecord.column.checked",
];

const BYTE_ORDER_MARK = "﻿";

const cell = (value: string | number | null): string => {
  if (value === null) return "";
  const text = typeof value === "number" ? String(value) : value;
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

const row = (cells: readonly (string | number | null)[]) => cells.map(cell).join(",");

function counts(items: readonly RecordItem[], t: Translator): string {
  const byResult = new Map<string, number>();
  for (const item of items) {
    const label = t(resultKey(item));
    byResult.set(label, (byResult.get(label) ?? 0) + 1);
  }
  return [...byResult].map(([label, number]) => `${label} ${number}`).join("; ");
}

function recordCiteCounts(
  items: readonly RecordCiteItem[],
  language: Language,
  t: Translator,
): string {
  const byResult = new Map<string, number>();
  for (const item of items) {
    const label = recordCiteResultLabel(item.outcome, language, t);
    byResult.set(label, (byResult.get(label) ?? 0) + 1);
  }
  return [...byResult].map(([label, number]) => `${label} ${number}`).join("; ");
}

function itemRow(item: RecordItem, t: Translator): (string | number | null)[] {
  const by = checkedBy(item, t);
  const { evidence } = item;
  return [
    t(KIND_LABELS[item.kind]),
    item.text,
    t(resultKey(item)),
    t(ORIGIN_LABELS[item.origin]),
    evidence?.name ?? null,
    evidence?.deleted ? t("checkRecord.documentDeleted") : (evidence?.file ?? null),
    evidence?.size ?? null,
    evidence?.sha256 ?? null,
    evidence?.location ?? null,
    evidence?.quote ?? null,
    item.says,
    by?.name ?? null,
    by?.place ?? null,
    item.kind === "sentence" ? (item.check?.at ?? null) : null,
  ];
}

function recordCiteColumns(t: Translator, rt: RecordCiteTranslator): string[] {
  return [
    rt("recordCites.column.cite"),
    t("checkRecord.column.sentence"),
    t("checkRecord.column.result"),
    t("checkRecord.column.text"),
    t("checkRecord.column.document"),
    t("checkRecord.column.file"),
    t("checkRecord.column.size"),
    t("checkRecord.column.sha256"),
    t("checkRecord.column.location"),
    rt("recordCites.column.passage"),
    rt("recordCites.column.covered"),
    rt("recordCites.column.uncovered"),
    rt("recordCites.column.candidates"),
    rt("recordCites.column.nearbyLocation"),
    rt("recordCites.column.nearbyPassage"),
    t("checkRecord.column.model"),
    t("checkRecord.column.service"),
    t("checkRecord.column.checked"),
  ];
}

function recordCiteRow(
  item: RecordCiteItem,
  language: Language,
  t: Translator,
): (string | number | null)[] {
  const by = checkedBy(item, t);
  const { evidence, nearby } = item;
  return [
    item.raw,
    item.sentence,
    recordCiteResultLabel(item.outcome, language, t),
    t(ORIGIN_LABELS[item.origin]),
    evidence?.name ?? null,
    evidence?.deleted ? t("checkRecord.documentDeleted") : (evidence?.file ?? null),
    evidence?.size ?? null,
    evidence?.sha256 ?? null,
    evidence?.location ?? null,
    evidence?.quote ?? null,
    item.covered,
    item.uncovered,
    item.candidates.length > 0
      ? item.candidates.map((candidate) => candidate.name).join("; ")
      : null,
    nearby?.location ?? null,
    nearby?.passage ?? null,
    by?.name ?? null,
    by?.place ?? null,
    item.check?.at ?? null,
  ];
}

/**
 * A record as CSV, for the User's own records: the summary, one row for each checked sentence
 * and Citation, then a separate table of record cites when it has any. UTF-8 with a byte order
 * mark so spreadsheets read Chinese, and times in ISO 8601 UTC, which no setting changes.
 */
export function renderCsv(record: CheckRecord): string {
  const t = translatorFor(record.language);
  const rt = recordCiteTranslatorFor(record.language);
  const none = t("checkRecord.summary.none");
  const summary = [
    [t("checkRecord.title", { name: record.mind })],
    [t("checkRecord.summary.exportedUtc"), record.exportedAt],
    [t("checkRecord.summary.folder"), record.searched.join("; ") || none],
    [
      t("checkRecord.summary.localMode"),
      t(record.localMode ? "checkRecord.summary.on" : "checkRecord.summary.off"),
    ],
    [t("checkRecord.summary.models"), record.models.join("; ") || none],
    ...(record.unread.length === 0
      ? []
      : [[t("unread.heading"), unreadRecordLines(record.unread, t).join("; ")]]),
    [t("checkRecord.summary.sentences"), counts(record.sentences, t) || none],
    [t("checkRecord.summary.citations"), counts(record.citations, t) || none],
    ...(record.recordCites.length === 0
      ? []
      : [[rt("summary.recordCites"), recordCiteCounts(record.recordCites, record.language, t)]]),
    [t("checkRecord.modelNote")],
    [t("checkRecord.note")],
  ];
  const items = [...record.sentences, ...record.citations].map((item) => itemRow(item, t));
  const recordCiteLines =
    record.recordCites.length === 0
      ? []
      : [
          "",
          row([rt("recordCites.heading", String(record.recordCites.length))]),
          row(recordCiteColumns(t, rt)),
          ...record.recordCites.map((item) => row(recordCiteRow(item, record.language, t))),
        ];
  const lines = [
    ...summary.map(row),
    "",
    row(COLUMNS.map((key) => t(key))),
    ...items.map(row),
    ...recordCiteLines,
  ];
  return `${BYTE_ORDER_MARK}${lines.join("\r\n")}\r\n`;
}
