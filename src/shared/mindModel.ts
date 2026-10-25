/**
 * The model a Mind's next Questions are asked with, chosen in its composer and
 * remembered for that Mind (DESIGN.md, Composer › Model). It lives in the
 * Mind's Yjs document (`MIND_SETTINGS_FIELD`), not in its Blocks, so it goes
 * wherever the Mind goes and the Blocks stay as they are. Only a model the
 * User picked in the Mind is stored; a Mind with none follows the one last
 * chosen on the device, else the Answers default (`modelInUse`).
 */
import type * as Y from "yjs";
import { type ChatModelChoice, MIND_SETTINGS_FIELD } from "../core/api";

const MODEL_KEY = "model";

const settingsOf = (doc: Y.Doc): Y.Map<unknown> => doc.getMap(MIND_SETTINGS_FIELD);

export const sameModel = (a: ChatModelChoice | null, b: ChatModelChoice | null): boolean =>
  a !== null && b !== null && a.providerId === b.providerId && a.modelId === b.modelId;

/** The model the User picked in the Mind, or null when it has none. Anything malformed counts as none. */
export function mindModelOf(doc: Y.Doc): ChatModelChoice | null {
  const value = settingsOf(doc).get(MODEL_KEY);
  if (typeof value !== "object" || value === null) return null;
  const { providerId, modelId } = value as Record<string, unknown>;
  return typeof providerId === "string" &&
    providerId !== "" &&
    typeof modelId === "string" &&
    modelId !== ""
    ? { providerId, modelId }
    : null;
}

/** Remembers a model the User picked in the Mind; null forgets it. */
export function setMindModel(doc: Y.Doc, choice: ChatModelChoice | null): void {
  const settings = settingsOf(doc);
  if (choice === null) {
    if (settings.has(MODEL_KEY)) settings.delete(MODEL_KEY);
    return;
  }
  if (sameModel(mindModelOf(doc), choice)) return;
  settings.set(MODEL_KEY, { providerId: choice.providerId, modelId: choice.modelId });
}

/**
 * The model a request is asked with: the Mind's own pick, else the one last chosen on the device
 * (`DeviceSettings.lastChatModel`), else the Answers default (`UserSettings.chatModel`). A pick
 * or last choice on a provider that is no longer `saved` is skipped. Null with no default.
 */
export function modelInUse(
  models: {
    own: ChatModelChoice | null;
    last: ChatModelChoice | null;
    fallback: ChatModelChoice | null;
  },
  saved: (providerId: string) => boolean,
): ChatModelChoice | null {
  const { own, last, fallback } = models;
  for (const choice of [own, last]) {
    if (choice !== null && saved(choice.providerId)) return choice;
  }
  return fallback;
}

/** Calls `listener` whenever the Mind's choice may have changed, here or from elsewhere. Returns how to stop. */
export function observeMindModel(doc: Y.Doc, listener: () => void): () => void {
  const settings = settingsOf(doc);
  settings.observe(listener);
  return () => settings.unobserve(listener);
}
