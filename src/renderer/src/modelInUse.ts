import { useEffect, useState } from "react";
import type * as Y from "yjs";
import type { ChatModelChoice } from "../../core/api";
import { mindModelOf, modelInUse, observeMindModel } from "../../shared/mindModel";
import { isSaved, loadSavedProviders, useSavedProviders } from "./savedProviders";
import { useAppStore } from "./store";

/** The model the User picked in the Mind, kept up to date; null when it has none. */
export function useOwnModel(doc: Y.Doc | null): ChatModelChoice | null {
  const [own, setOwn] = useState(() => (doc ? mindModelOf(doc) : null));
  useEffect(() => {
    setOwn(doc ? mindModelOf(doc) : null);
    if (!doc) return;
    return observeMindModel(doc, () => setOwn(mindModelOf(doc)));
  }, [doc]);
  return own;
}

/**
 * The model a request in the Mind is asked with, kept up to date (`modelInUse`); with no Mind
 * (`doc` null), the one the assistant uses.
 */
export function useModelInUse(doc: Y.Doc | null): ChatModelChoice | null {
  const own = useOwnModel(doc);
  const last = useAppStore((state) => state.settings?.device.lastChatModel ?? null);
  const fallback = useAppStore((state) => state.settings?.user.chatModel ?? null);
  const ids = useSavedProviders((state) => state.ids);
  useEffect(loadSavedProviders, []);
  return modelInUse({ own, last, fallback }, isSaved(ids));
}

/** As `useModelInUse`, for a request about to be sent. */
export function modelInUseOf(doc: Y.Doc | null): ChatModelChoice | null {
  const settings = useAppStore.getState().settings;
  return modelInUse(
    {
      own: doc ? mindModelOf(doc) : null,
      last: settings?.device.lastChatModel ?? null,
      fallback: settings?.user.chatModel ?? null,
    },
    isSaved(useSavedProviders.getState().ids),
  );
}
