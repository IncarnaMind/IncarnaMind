import { useEffect, useMemo } from "react";
import { create } from "zustand";
import type { Document } from "../../core/api";
import { useExampleDocuments } from "./ownDocuments";
import { useAppStore } from "./store";

const NO_DOCUMENTS: readonly Document[] = [];

const useOpened = create<{ opened: boolean }>(() => ({ opened: false }));

/**
 * The Documents listed under the example Note once the examples are folded to one row (#1944):
 * none until one of them is open in a tab, then its Documents until the next launch. They stay
 * after the tab closes, so the row of a Document the User has been in never comes and goes.
 */
export function useExampleFoldDocuments(): readonly Document[] {
  const documents = useExampleDocuments({ firstOnly: true });
  const ids = useMemo(() => new Set(documents.map((each) => each.id)), [documents]);
  const shown = useAppStore((state) =>
    Boolean(
      state.layout?.groups.some((group) =>
        group.tabs.some((tab) => tab.item.kind === "document" && ids.has(tab.item.documentId)),
      ),
    ),
  );
  const opened = useOpened((state) => state.opened);
  useEffect(() => {
    if (shown) useOpened.setState({ opened: true });
  }, [shown]);
  return opened || shown ? documents : NO_DOCUMENTS;
}
