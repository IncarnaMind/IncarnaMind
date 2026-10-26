import type { MessageKey } from "../../shared/i18n";
import { unreadRecordLines } from "../../shared/unreadFiles";
import type { CheckRecord } from "./index";
import {
  checkedBy,
  KIND_LABELS,
  ORIGIN_LABELS,
  resultKey,
  type Translator,
  translatorFor,
} from "./labels";
import type { RecordItem } from "./read";

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

/**
 * A record as CSV, for the User's own records: the summary, then one row for each checked
 * sentence and each Citation. UTF-8 with a byte order mark so spreadsheets read Chinese, and
 * times in ISO 8601 UTC, which no setting changes.
 */
export function renderCsv(record: CheckRecord): string {
  const t = translatorFor(record.language);
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
    [t("checkRecord.modelNote")],
    [t("checkRecord.note")],
  ];
  const items = [...record.sentences, ...record.citations].map((item) => itemRow(item, t));
  const lines = [...summary.map(row), "", row(COLUMNS.map((key) => t(key))), ...items.map(row)];
  return `${BYTE_ORDER_MARK}${lines.join("\r\n")}\r\n`;
}
