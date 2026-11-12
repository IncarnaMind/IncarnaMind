import { useEffect, useState } from "react";
import type * as Y from "yjs";
import type { ChatModelChoice } from "../../core/api";
import {
  mindModelOf,
  modelInUse,
  observeMindModel,
  removedModel,
  setMindModel,
} from "../../shared/mindModel";
import { conversationModel, pickForConversation, useConversationModel } from "./conversationModel";
import { isSaved, loadSavedProviders, useSavedProviders } from "./savedProviders";
import { useAppStore } from "./store";

/**
 * The model the User picked in the Mind, kept up to date; with no Mind, the one the assistant's
 * conversation goes on with (`conversationModel`).
 */
export function useOwnModel(doc: Y.Doc | null): ChatModelChoice | null {
  const [own, setOwn] = useState(() => (doc ? mindModelOf(doc) : null));
  const noNote = useConversationModel(conversationModel);
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
      own: doc ? mindModelOf(doc) : conversationModel(useConversationModel.getState()),
      fallback: useAppStore.getState().settings?.user.chatModel ?? null,
    },
    isSaved(useSavedProviders.getState().ids),
  );
}

/** As `removedModel` for the Mind in view, kept up to date; never for the assistant's conversation. */
export function useRemovedModel(doc: Y.Doc | null) {
  const own = useOwnModel(doc);
  const fallback = useAnswersModel();
  const ids = useSavedProviders((state) => state.ids);
  useEffect(loadSavedProviders, []);
  return doc ? removedModel({ own, fallback }, isSaved(ids)) : null;
}

/** The Mind in view now, as `useRemovedModel` would read it. */
export function removedModelNow(doc: Y.Doc | null) {
  return doc
    ? removedModel(
        {
          own: mindModelOf(doc),
          fallback: useAppStore.getState().settings?.user.chatModel ?? null,
        },
        isSaved(useSavedProviders.getState().ids),
      )
    : null;
}

/**
 * A model picked in a composer's chip: for its Mind only, or with none, for the conversation the
 * assistant shows, whose next Question keeps it.
 */
export function chooseModel(doc: Y.Doc | null, choice: ChatModelChoice): void {
  if (doc) setMindModel(doc, choice);
  else pickForConversation(choice);
}

/** Makes `choice` the Answers default, which new Notes start on (Settings › AI, the chip). */
export function setAnswersModel(choice: ChatModelChoice): Promise<void> {
  // Quick tasks and reading images go back to following it.
  return useAppStore
    .getState()
    .updateSettings({ user: { chatModel: choice, quickTasksModel: null, imageModel: null } });
}
