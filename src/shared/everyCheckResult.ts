/**
 * Whether a Note shows a mark for every sentence a check covered, or only what needs a look and
 * what wasn't checked (#3358). Off unless the User turns it on for this Note. It lives in the
 * Note's Yjs settings, as its word count's switch does, so it goes wherever the Note goes.
 */
import type * as Y from "yjs";
import { MIND_SETTINGS_FIELD } from "../core/api";

const KEY = "everyCheckResult";

const settingsOf = (doc: Y.Doc): Y.Map<unknown> => doc.getMap(MIND_SETTINGS_FIELD);

export function everyCheckResultOf(doc: Y.Doc): boolean {
  return settingsOf(doc).get(KEY) === true;
}

export function setEveryCheckResult(doc: Y.Doc, shown: boolean): void {
  const settings = settingsOf(doc);
  if (!shown) {
    if (settings.has(KEY)) settings.delete(KEY);
  } else if (settings.get(KEY) !== true) {
    settings.set(KEY, true);
  }
}

/** Calls `listener` whenever the switch may have changed, here or from elsewhere. Returns how to stop. */
export function observeEveryCheckResult(doc: Y.Doc, listener: () => void): () => void {
  const settings = settingsOf(doc);
  settings.observe(listener);
  return () => settings.unobserve(listener);
}
