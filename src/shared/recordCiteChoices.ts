import type * as Y from "yjs";
import type { CitationLocation } from "../core/api";
import { MIND_SETTINGS_FIELD } from "../core/api";
import { parseLocation } from "./locations";

export interface RecordCitePlace {
  blockId: string;
  from: number;
  /** The record item's UTF-16 start within its sentence, when locating it in Note history. */
  citeFrom?: number;
}

export interface RecordCiteSentence {
  place: RecordCitePlace;
  text: string;
}

export interface RecordCiteChoice {
  documentId: string;
  contentHash: string;
  location: CitationLocation;
}

export interface RecordCiteChoices {
  previous: RecordCiteChoice | null;
  choices: Record<string, RecordCiteChoice>;
}

const KEY_PREFIX = "recordCites:";

function choiceOf(value: unknown): RecordCiteChoice | null {
  if (typeof value !== "object" || value === null) return null;
  const { documentId, contentHash, location } = value as {
    documentId?: unknown;
    contentHash?: unknown;
    location?: unknown;
  };
  if (typeof documentId !== "string" || documentId === "") return null;
  if (typeof contentHash !== "string" || contentHash === "") return null;
  const parsed = parseLocation(location);
  return parsed ? { documentId, contentHash, location: parsed } : null;
}

export function readRecordCiteChoices(settings: Y.Map<unknown>): RecordCiteChoices {
  const choices: Record<string, RecordCiteChoice> = {};
  settings.forEach((value, key) => {
    if (!key.startsWith(KEY_PREFIX)) return;
    const choice = choiceOf(value);
    if (choice) choices[key.slice(KEY_PREFIX.length)] = choice;
  });
  return { previous: null, choices };
}

export function writeRecordCiteChoice(
  settings: Y.Map<unknown>,
  alias: string,
  choice: RecordCiteChoice | null,
): void {
  const key = `${KEY_PREFIX}${alias}`;
  if (choice) settings.set(key, choice);
  else settings.delete(key);
}

export const recordCiteSettingsOf = (doc: Y.Doc): Y.Map<unknown> => doc.getMap(MIND_SETTINGS_FIELD);
