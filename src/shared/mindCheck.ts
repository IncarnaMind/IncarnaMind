/**
 * The last whole-Mind check (#737), in the Mind's Yjs settings, as
 * contradiction watch keeps its run (`contradictionWatch.ts`), so the line
 * under its title can say when it was and how many sentences it checked,
 * wherever the Mind is open. Not content: an older version leaves it as it is.
 */
import type * as Y from "yjs";
import { MIND_SETTINGS_FIELD, type MindCheckRun } from "../core/api";
import { stopOf } from "./contradictionWatch";
import { comparableSentence } from "./sentences";

const KEY = "mindCheck";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A sentence's key, from its words as checks compare them: the same in the
 * core and the window, and short, so a long Mind's run stays small.
 */
export function sentenceKey(text: string): string {
  let hash = 0x811c9dc5;
  for (const unit of comparableSentence(text)) {
    hash ^= unit.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** The last whole-Mind check, or null for none (or one this version can't read). */
export function readMindCheck(settings: Y.Map<unknown>): MindCheckRun | null {
  const value = settings.get(KEY);
  if (!isRecord(value) || typeof value.at !== "string") return null;
  return {
    at: value.at,
    sentences:
      typeof value.sentences === "number" && Number.isInteger(value.sentences)
        ? Math.max(0, value.sentences)
        : 0,
    stop: stopOf(value.stop),
    skipped: keysOf(value.skipped),
    unexamined: keysOf(value.unexamined),
  };
}

const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];

export const mindCheckOf = (doc: Y.Doc): MindCheckRun | null =>
  readMindCheck(doc.getMap(MIND_SETTINGS_FIELD));

export function writeMindCheck(settings: Y.Map<unknown>, run: MindCheckRun): void {
  settings.set(KEY, {
    ...run,
    stop: run.stop && { ...run.stop },
    skipped: [...run.skipped],
    unexamined: [...run.unexamined],
  });
}

/** Calls `listener` whenever the Mind's last check may have changed. Returns how to stop. */
export function observeMindCheck(doc: Y.Doc, listener: () => void): () => void {
  const settings = doc.getMap(MIND_SETTINGS_FIELD);
  settings.observe(listener);
  return () => settings.unobserve(listener);
}
