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
  const unchecked = keysOf(value.unchecked);
  const uncheckedBlocks = keysOf(value.uncheckedBlocks);
  return {
    at: value.at,
    sentences:
      typeof value.sentences === "number" && Number.isInteger(value.sentences)
        ? Math.max(0, value.sentences)
        : 0,
    stop: stopOf(value.stop),
    // A run before #1682 took every sentence the model's reply didn't list for one that makes no
    // claim, so its "makes no claim" may be a sentence nobody decided: each is sorted once more.
    ...("unexamined" in value
      ? { skipped: keysOf(value.skipped), unexamined: keysOf(value.unexamined) }
      : { skipped: [], unexamined: keysOf(value.skipped) }),
    ...(unchecked.length > 0 && { unchecked }),
    ...(uncheckedBlocks.length > 0 && { uncheckedBlocks }),
  };
}

const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];

export const mindCheckOf = (doc: Y.Doc): MindCheckRun | null =>
  readMindCheck(doc.getMap(MIND_SETTINGS_FIELD));

export function writeMindCheck(settings: Y.Map<unknown>, run: MindCheckRun): void {
  const { unchecked, uncheckedBlocks, ...base } = run;
  settings.set(KEY, {
    ...base,
    stop: run.stop && { ...run.stop },
    skipped: [...run.skipped],
    unexamined: [...run.unexamined],
    ...(unchecked && unchecked.length > 0 && { unchecked: [...unchecked] }),
    ...(uncheckedBlocks && uncheckedBlocks.length > 0 && { uncheckedBlocks: [...uncheckedBlocks] }),
  });
}

/**
 * Adds `blockIds` to an existing complete `MindCheckRun`'s `uncheckedBlocks` list without
 * touching brand-new Notes (`readMindCheck === null`) or stopped runs (#3862).
 */
export function markMindCheckUncheckedBlocks(
  settings: Y.Map<unknown>,
  blockIds: Iterable<string>,
): boolean {
  const run = readMindCheck(settings);
  if (!run || run.stop !== null) return false;
  const next = new Set(run.uncheckedBlocks ?? []);
  const before = next.size;
  for (const id of blockIds) {
    if (id !== "") next.add(id);
  }
  if (next.size === before) return false;
  writeMindCheck(settings, { ...run, uncheckedBlocks: [...next] });
  return true;
}

/** Calls `listener` whenever the Mind's last check may have changed. Returns how to stop. */
export function observeMindCheck(doc: Y.Doc, listener: () => void): () => void {
  const settings = doc.getMap(MIND_SETTINGS_FIELD);
  settings.observe(listener);
  return () => settings.unobserve(listener);
}
