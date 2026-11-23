import { type RefObject, useLayoutEffect } from "react";
import type { LibraryGroup } from "../../../../core/api";
import { useLibraryFolds } from "../../libraryFolds";
import { NOT_IN_A_FOLDER } from "../../libraryPage";
import { useOrganizeReview } from "../../organizeReview";
import { useSelection } from "../../selection";
import { useAppStore } from "../../store";

export function ReviewAttentionTarget({
  page,
  folders,
  folderOf,
  narrowing,
  clearNarrowing,
}: {
  page: RefObject<HTMLElement | null>;
  folders: readonly LibraryGroup[];
  folderOf(id: string): string | null;
  narrowing: boolean;
  clearNarrowing(): void;
}) {
  const id = useAppStore((state) => state.reviewTarget);
  useLayoutEffect(() => {
    if (id === null) return;
    if (narrowing) {
      clearNarrowing();
      return;
    }
    if (useOrganizeReview.getState().open) useOrganizeReview.setState({ open: false });
    const selector = `[data-document-id="${CSS.escape(id)}"]`;
    const reveal = () => {
      const row = page.current?.querySelector<HTMLElement>(selector);
      if (!row) return false;
      row.scrollIntoView({ block: "center" });
      useSelection.getState().choose("library", { kind: "document", id });
      row.querySelector<HTMLElement>("[data-row-main]")?.focus({ preventScroll: true });
      useAppStore.setState({ reviewTarget: null });
      return true;
    };
    const folds = useLibraryFolds.getState();
    let folder = folderOf(id);
    const chain = new Set<string>();
    while (folder !== null && !chain.has(folder)) {
      chain.add(folder);
      folder = folders.find((each) => each.id === folder)?.parentId ?? null;
    }
    const top = [...chain].at(-1) ?? NOT_IN_A_FOLDER;
    folds.setOpen(top, true);
    folds.showAll(top);
    for (const each of chain) {
      folds.setSubOpen(each, true);
      if (each !== top) folds.showAll(each);
    }
    if (reveal()) return;

    let frame: number;
    let attempts = 0;
    const afterRowsChange = () => {
      if (useAppStore.getState().reviewTarget !== id || reveal()) return;
      if (++attempts < 120) frame = requestAnimationFrame(afterRowsChange);
      else useAppStore.setState({ reviewTarget: null });
    };
    frame = requestAnimationFrame(afterRowsChange);
    return () => cancelAnimationFrame(frame);
  }, [id, page, folders, folderOf, narrowing, clearNarrowing]);
  return null;
}
