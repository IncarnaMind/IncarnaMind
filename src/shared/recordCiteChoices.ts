import type * as Y from "yjs";
import { MIND_SETTINGS_FIELD } from "../core/api";

/** The Document the User chose for a record cite's source, as it was when they chose it. */
export interface RecordCiteChoice {
  documentId: string;
  contentHash: string;
}

/**
 * One settings key for each source, so two people choosing for two sources at once both keep
 * their choice when the Note syncs (#1709).
 */
const KEY_PREFIX = "recordCites:";

function choiceOf(value: unknown): RecordCiteChoice | null {
  if (typeof value !== "object" || value === null) return null;
  const { documentId, contentHash } = value as { documentId?: unknown; contentHash?: unknown };
  if (typeof documentId !== "string" || documentId === "") return null;
  if (typeof contentHash !== "string" || contentHash === "") return null;
  return { documentId, contentHash };
}

/** The Note's source choices, by the canonical alias of the source each is for. */
export function readRecordCiteChoices(settings: Y.Map<unknown>): Record<string, RecordCiteChoice> {
  const choices: Record<string, RecordCiteChoice> = {};
  settings.forEach((value, key) => {
    if (!key.startsWith(KEY_PREFIX)) return;
    const choice = choiceOf(value);
    if (choice) choices[key.slice(KEY_PREFIX.length)] = choice;
  });
  return choices;
}

export function writeRecordCiteChoice(
  settings: Y.Map<unknown>,
  alias: string,
  choice: RecordCiteChoice,
): void {
  settings.set(`${KEY_PREFIX}${alias}`, { ...choice });
}

export const recordCiteSettingsOf = (doc: Y.Doc): Y.Map<unknown> => doc.getMap(MIND_SETTINGS_FIELD);
