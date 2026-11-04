/**
 * A Document's highlights and comments, saved: DESIGN.md's export result line as
 * it is ("Saved “{name}” in {folder}") with Open and Show in Finder, over the
 * page's foot (#327).
 */
import { useEffect } from "react";
import { useAnnotations } from "../annotations";
import { files } from "../core";
import { showFileLabelKey } from "../fileInfo";
import { useT } from "../i18n";
import { savedFolderLabel } from "../outputFiles";
import { useAppStore } from "../store";

const SHOWN_MS = 10_000;

export function AnnotationExportLine({ documentId }: { documentId: string }) {
  const t = useT();
  const exported = useAnnotations((state) => state.exported);
  const showExport = useAnnotations((state) => state.showExport);
  const shown = exported?.documentId === documentId ? exported : null;
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => showExport(null), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [shown, showExport]);
  if (!shown) return null;
  const said = t("export.doneIn", {
    name: "\u0000",
    folder: savedFolderLabel(shown, t),
  });
  const [before = "", after = ""] = said.split("\u0000");
  return (
    <p role="status" data-testid="annotation-export-line" className="annotation-export-line">
      <span className="min-w-0 break-words">
        {before}
        <span className="font-semibold text-ink">{shown.name}</span>
        {after}
      </span>
      <span className="flex shrink-0 gap-1">
        <button
          type="button"
          data-testid="annotation-export-open"
          onClick={() =>
            void files
              .openSavedFile(shown.path)
              .catch((error: unknown) => useAppStore.getState().reportError(error))
          }
          className="annotation-action annotation-action--primary"
        >
          {t("export.open")}
        </button>
        <button
          type="button"
          data-testid="annotation-export-show"
          onClick={() =>
            void files
              .showSavedFile(shown.path)
              .catch((error: unknown) => useAppStore.getState().reportError(error))
          }
          className="annotation-action"
        >
          {t(showFileLabelKey(navigator.platform))}
        </button>
      </span>
    </p>
  );
}
