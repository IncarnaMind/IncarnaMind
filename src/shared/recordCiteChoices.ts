import type * as Y from "yjs";
import type { CitationLocation } from "../core/api";
import { MIND_SETTINGS_FIELD } from "../core/api";
import { parseLocation } from "./locations";

export interface RecordCitePlace {
  blockId: string;
  from: number;
}

export interface RecordCiteChoice {
  documentId: string;
  location: CitationLocation;
  /** The record item's position in the Note, for `Id.`/`supra` only. */
  place?: RecordCitePlace;
}

export interface RecordCiteChoices {
  previous: RecordCiteChoice | null;
  choices: Record<string, RecordCiteChoice>;
}

const KEY = "recordCites";

function choiceOf(value: unknown): RecordCiteChoice | null {
  if (typeof value !== "object" || value === null) return null;
  const { documentId, location } = value as { documentId?: unknown; location?: unknown };
  if (typeof documentId !== "string" || documentId === "") return null;
  const parsed = parseLocation(location);
  if (!parsed) return null;
  const candidate = value as { place?: { blockId?: unknown; from?: unknown } };
  const place = candidate.place;
  const blockId = place?.blockId;
  const from = place?.from;
  const validPlace =
    typeof blockId === "string" &&
    blockId !== "" &&
    typeof from === "number" &&
    Number.isInteger(from) &&
    from >= 0;
  return {
    documentId,
    location: parsed,
    ...(validPlace ? { place: { blockId, from } } : {}),
  };
}

export function readRecordCiteChoices(settings: Y.Map<unknown>): RecordCiteChoices {
  const stored = settings.get(KEY);
  if (typeof stored !== "object" || stored === null) return { previous: null, choices: {} };
  const previous = choiceOf((stored as { previous?: unknown }).previous);
  const choices: Record<string, RecordCiteChoice> = {};
  const aliases = (stored as { choices?: unknown }).choices;
  if (typeof aliases === "object" && aliases !== null) {
    for (const [alias, value] of Object.entries(aliases)) {
      const choice = choiceOf(value);
      if (choice) choices[alias] = choice;
    }
  }
  return { previous, choices };
}

export function writeRecordCiteChoice(
  settings: Y.Map<unknown>,
  alias: string,
  choice: RecordCiteChoice | null,
): void {
  const current = readRecordCiteChoices(settings);
  if (choice) current.choices[alias] = choice;
  else delete current.choices[alias];
  settings.set(KEY, { previous: current.previous, choices: current.choices });
}

export function writePreviousRecordCite(
  settings: Y.Map<unknown>,
  choice: RecordCiteChoice | null,
): void {
  const current = readRecordCiteChoices(settings);
  settings.set(KEY, { previous: choice, choices: current.choices });
}

export const recordCiteSettingsOf = (doc: Y.Doc): Y.Map<unknown> => doc.getMap(MIND_SETTINGS_FIELD);
