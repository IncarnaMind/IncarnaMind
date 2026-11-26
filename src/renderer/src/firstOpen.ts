import { stepsShownOf } from "./nudges";
import { type AppState, allExamples, isOwnDocument, useAppStore } from "./store";

/**
 * The first open (#1027, #3791): while its example is there and the User has done nothing of their
 * own yet, the sidebar's status line, the Library row, the Documents section and the example's
 * count stay quiet; its Check button shows from the start (#3794). It ends with the User's first ask of any AI, the built-in
 * assistant's or their own, and while a file of their own is there (taken back with Undo, the
 * shell is quiet again); a Mind deleted on its own can't leave it quiet. The assistant comes on by
 * its own trigger (`useQuietAssistant`).
 */
export const firstOpenNow = (
  state: Pick<AppState, "examples" | "otherExamples" | "settings" | "documents">,
): boolean => {
  const progress = state.settings?.device.gettingStarted;
  if (!state.examples?.mindId || !stepsShownOf(progress)) return false;
  if (progress?.askedOwn) return false;
  const examples = allExamples(state);
  return !state.documents.some((each) => isOwnDocument(each, examples));
};

export const useFirstOpen = (): boolean => useAppStore(firstOpenNow);
