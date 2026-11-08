import { useEffect, useState } from "react";
import type * as Y from "yjs";
import { create } from "zustand";
import type { ChatModelChoice } from "../../core/api";
import { mindModelOf, modelInUse, observeMindModel, setMindModel } from "../../shared/mindModel";
import { isSaved, loadSavedProviders, useSavedProviders } from "./savedProviders";
import { useAppStore } from "./store";

/**
 * The model picked in the assistant's chip while no Note is in focus: it holds for this window
 * until it closes, and is never what a Note or a new Note uses (#2836).
 */
const useNoNotePick = create<{ choice: ChatModelChoice | null }>(() => ({ choice: null }));

/** The model the User picked in the Mind, kept up to date; with no Mind, the assistant's pick here. */
export function useOwnModel(doc: Y.Doc | null): ChatModelChoice | null {
  const [own, setOwn] = useState(() => (doc ? mindModelOf(doc) : null));
  const noNote = useNoNotePick((state) => state.choice);
  useEffect(() => {
    setOwn(doc ? mindModelOf(doc) : null);
    if (!doc) return;
    return observeMindModel(doc, () => setOwn(mindModelOf(doc)));
  }, [doc]);
  return doc ? own : noNote;
}

/** The Answers default: what a new Note, and a Note with no pick of its own, are asked with. */
export function useAnswersModel(): ChatModelChoice | null {
  return useAppStore((state) => state.settings?.user.chatModel ?? null);
}

/**
 * The model a request in the Mind is asked with, kept up to date (`modelInUse`); with no Mind
 * (`doc` null), the one the assistant uses.
 */
export function useModelInUse(doc: Y.Doc | null): ChatModelChoice | null {
  const own = useOwnModel(doc);
  const fallback = useAnswersModel();
  const ids = useSavedProviders((state) => state.ids);
  useEffect(loadSavedProviders, []);
  return modelInUse({ own, fallback }, isSaved(ids));
}

/** As `useModelInUse`, for a request about to be sent. */
export function modelInUseOf(doc: Y.Doc | null): ChatModelChoice | null {
  return modelInUse(
    {
      own: doc ? mindModelOf(doc) : useNoNotePick.getState().choice,
      fallback: useAppStore.getState().settings?.user.chatModel ?? null,
    },
    isSaved(useSavedProviders.getState().ids),
  );
}

/** A model picked in a composer's chip: for its Mind only, or with none, for the assistant here. */
export function chooseModel(doc: Y.Doc | null, choice: ChatModelChoice): void {
  if (doc) setMindModel(doc, choice);
  else useNoNotePick.setState({ choice });
}

/** Makes `choice` the Answers default, which new Notes start on (Settings › Models, the chip). */
export function setAnswersModel(choice: ChatModelChoice): Promise<void> {
  // Quick tasks and reading images are automatic, with no row of their own (#1922).
  return useAppStore
    .getState()
    .updateSettings({ user: { chatModel: choice, quickTasksModel: null, imageModel: null } });
}
