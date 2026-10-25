import type { Document } from "../../core/api";
import { organizeHeld } from "../../shared/libraryModels";
import { core } from "./core";
import { type AppState, allExamples, isOwnDocument, useAppStore } from "./store";

/** The User's own Documents whose tagging failed, outside Organize's hold: what Retry tags again. */
export const failedTagging = (state: AppState): Document[] => {
  const held = organizeHeld(state.library);
  return state.documents.filter(
    (each) =>
      each.status === "ready" &&
      each.tagging === "failed" &&
      !held.has(each.id) &&
      isOwnDocument(each, allExamples(state)),
  );
};

export async function retryTagging(): Promise<void> {
  const state = useAppStore.getState();
  const ids = failedTagging(state).map((each) => each.id);
  if (ids.length > 0) await state.retagDocuments(ids);
}

export function retryTaggingWhenOnline(): void {
  window.addEventListener("online", () => {
    core.backOnline().catch(useAppStore.getState().reportError);
  });
}
