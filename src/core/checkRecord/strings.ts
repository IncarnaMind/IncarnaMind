import { type MessageKey, translate } from "../../shared/i18n";
import type { Language } from "../language";

const KEYS = {
  "summary.recordCites": "checkRecord.summary.recordCites",
  "recordCites.heading": "checkRecord.recordCites.heading",
  "recordCites.kind": "checkRecord.recordCites.kind",
  "recordCites.result.partly": "checkRecord.recordCites.result.partly",
  "recordCites.result.choose": "checkRecord.recordCites.result.choose",
  "recordCites.column.cite": "checkRecord.recordCites.column.cite",
  "recordCites.column.passage": "checkRecord.recordCites.column.passage",
  "recordCites.column.covered": "checkRecord.recordCites.column.covered",
  "recordCites.column.uncovered": "checkRecord.recordCites.column.uncovered",
  "recordCites.column.candidates": "checkRecord.recordCites.column.candidates",
  "recordCites.column.nearbyLocation": "checkRecord.recordCites.column.nearbyLocation",
  "recordCites.column.nearbyPassage": "checkRecord.recordCites.column.nearbyPassage",
} as const satisfies Record<string, MessageKey>;

export const RECORD_CITE_KEYS = Object.keys(KEYS) as RecordCiteStringKey[];
export type RecordCiteStringKey = keyof typeof KEYS;
export type RecordCiteTranslator = (key: RecordCiteStringKey, count?: string) => string;

export const recordCiteTranslatorFor =
  (language: Language): RecordCiteTranslator =>
  (key, count) =>
    translate(language, KEYS[key], { count: count ?? "" });
