/**
 * The Search scope the User set for a Mind, in its composer (#1623): its Questions search there,
 * and its checks look there. It lives in the Mind's Yjs document (`MIND_SETTINGS_FIELD`), as its
 * model does, so it goes wherever the Mind goes. None: the Mind's own, its Folder while that
 * holds a Document, else every Document (`mindSearchScope`). An empty scope is every Document,
 * chosen.
 *
 * A narrowed scope (one that names something) remembers the wide scope it narrowed, the Mind's
 * own or every Document chosen, so one click goes back there (`scopeBeforeOf`). Both are one value
 * under one key: when two devices set it at once, one device's wins whole.
 */
import type * as Y from "yjs";
import { MIND_SETTINGS_FIELD, type SearchScope } from "../core/api";
import { chosenScope, hasSearchScope, NO_SCOPE, sameScope, storedSearchScope } from "./searchScope";

const SCOPE_KEY = "scope";
// A narrowed scope's `before` when it narrowed every Document chosen; none: the Mind's own.
const BEFORE_ALL = "all";

const settingsOf = (doc: Y.Doc): Y.Map<unknown> => doc.getMap(MIND_SETTINGS_FIELD);

export const mindScopeIn = (settings: Y.Map<unknown>): SearchScope | null =>
  storedSearchScope(settings.get(SCOPE_KEY));

export const mindScopeOf = (doc: Y.Doc): SearchScope | null => mindScopeIn(settingsOf(doc));

function beforeIn(settings: Y.Map<unknown>): SearchScope | null {
  const value = settings.get(SCOPE_KEY);
  return typeof value === "object" &&
    value !== null &&
    "before" in value &&
    value.before === BEFORE_ALL
    ? NO_SCOPE
    : null;
}

/**
 * Where one click takes a narrowed scope back to: null, the Mind's own, or every Document
 * (`NO_SCOPE`) when the User had chosen that before narrowing it.
 */
export const scopeBeforeOf = (doc: Y.Doc): SearchScope | null => beforeIn(settingsOf(doc));

function keep(settings: Y.Map<unknown>, scope: SearchScope | null): void {
  const kept = mindScopeIn(settings);
  if (scope === null) {
    if (settings.has(SCOPE_KEY)) settings.delete(SCOPE_KEY);
    return;
  }
  if (kept && sameScope(kept, scope)) return;
  const before = kept === null || !hasSearchScope(kept) ? kept : beforeIn(settings);
  settings.set(SCOPE_KEY, {
    folderIds: [...scope.folderIds],
    tagIds: [...scope.tagIds],
    documentIds: [...scope.documentIds],
    ...(hasSearchScope(scope) && before !== null && { before: BEFORE_ALL }),
  });
}

/** Keeps the scope the User set for the Mind; null forgets it. */
export const setMindScope = (doc: Y.Doc, scope: SearchScope | null): void =>
  keep(settingsOf(doc), scope);

/**
 * Text added from an Answer brings the scope its Question was asked with, when the Mind has
 * none of its own, so a summary of one Document is checked against that Document. A Question
 * that searched everything, or the Mind's own Folder, leaves the Mind as it is. Returns the
 * scope it kept, for Undo; null when it kept none.
 */
export function carryAnswerScope(
  doc: Y.Doc,
  asked: SearchScope | null,
  folderId: string | null,
): SearchScope | null {
  const settings = settingsOf(doc);
  if (mindScopeIn(settings) !== null || asked === null || !hasSearchScope(asked)) return null;
  const kept = chosenScope(asked, folderId);
  keep(settings, kept);
  return kept;
}

/** Takes back a scope `carryAnswerScope` kept, unless the Mind's scope has changed since. */
export function uncarryAnswerScope(doc: Y.Doc, carried: SearchScope): void {
  const settings = settingsOf(doc);
  const kept = mindScopeIn(settings);
  if (kept && sameScope(kept, carried)) keep(settings, null);
}

/** Calls `listener` whenever the Mind's scope may have changed, here or from elsewhere. Returns how to stop. */
export function observeMindScope(doc: Y.Doc, listener: () => void): () => void {
  const settings = settingsOf(doc);
  const heard = (event: Y.YMapEvent<unknown>) => {
    if (event.keysChanged.has(SCOPE_KEY)) listener();
  };
  settings.observe(heard);
  return () => settings.unobserve(heard);
}
