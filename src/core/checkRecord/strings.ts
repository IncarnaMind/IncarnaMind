import type { Language } from "../language";

const en = {
  "summary.recordCites": "Record cites",
  "recordCites.heading": "Record cites ({count})",
  "recordCites.kind": "Record cite",
  "recordCites.result.partly": "Partly",
  "recordCites.result.choose": "Choose a Document",
  "recordCites.column.cite": "Record cite",
  "recordCites.column.passage": "Passage",
  "recordCites.column.covered": "Covered",
  "recordCites.column.uncovered": "Uncovered",
  "recordCites.column.candidates": "Documents to choose from",
  "recordCites.column.nearbyLocation": "Nearby Location",
  "recordCites.column.nearbyPassage": "Nearby passage",
} as const;

export type RecordCiteStringKey = keyof typeof en;

const zhCN: Record<RecordCiteStringKey, string> = {
  "summary.recordCites": "记录引用",
  "recordCites.heading": "记录引用（{count}）",
  "recordCites.kind": "记录引用",
  "recordCites.result.partly": "部分有依据",
  "recordCites.result.choose": "选择文档",
  "recordCites.column.cite": "记录引用",
  "recordCites.column.passage": "段落",
  "recordCites.column.covered": "有依据的部分",
  "recordCites.column.uncovered": "无依据的部分",
  "recordCites.column.candidates": "可选文档",
  "recordCites.column.nearbyLocation": "附近位置",
  "recordCites.column.nearbyPassage": "附近段落",
};

export const RECORD_CITE_STRINGS = { en, "zh-CN": zhCN } as const;

export type RecordCiteTranslator = (key: RecordCiteStringKey, count?: string) => string;

export const recordCiteTranslatorFor =
  (language: Language): RecordCiteTranslator =>
  (key, count) =>
    RECORD_CITE_STRINGS[language][key].replaceAll("{count}", count ?? "");
