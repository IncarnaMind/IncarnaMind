/**
 * A Document's highlights and comments, saved: DESIGN.md's export result line as
 * it is ("Saved “{name}” in {folder}") with Open and Show in Finder, over the
 * page's foot (#327).
 */
import { useCallback, useEffect, useRef } from "react";
import { type AnnotationExport, useAnnotations } from "../annotations";
import { files } from "../core";
import { useDismissOnEscape } from "../escapeDismiss";
import { showFileLabelKey } from "../fileInfo";
import { useT } from "../i18n";
import { enter } from "../motion";
import { savedFolderLabel } from "../outputFiles";
import { useAppStore } from "../store";
import { useHeld } from "../useHeld";

const SHOWN_MS = 10_000;

export function AnnotationExportLine({ documentId }: { documentId: string }) {
  const exported = useAnnotations((state) => state.exported);
  const shown = exported?.documentId === documentId ? exported : null;
  if (!shown) return null;
  return <ExportLine shown={shown} />;
}

/** The line itself, mounted with its ref: it is held and entered from its first frame. */
function ExportLine({ shown }: { shown: AnnotationExport }) {
  const t = useT();
  const showExport = useAnnotations((state) => state.showExport);
  const line = useRef<HTMLParagraphElement>(null);
  const held = useHeld(line, { focusHolds: true });
  const dismiss = useCallback(() => showExport(null), [showExport]);
  useDismissOnEscape(true, dismiss);
  useEffect(() => {
    if (line.current) enter(line.current, { y: 8 });
  }, []);
  useEffect(() => {
    if (held) return;
    const timer = setTimeout(dismiss, SHOWN_MS);
    return () => clearTimeout(timer);
  }, [held, dismiss]);
  const said = t("export.doneIn", {
    name: "\u0000",
    folder: savedFolderLabel(shown, t),
  });
  const [before = "", after = ""] = said.split("\u0000");
  return (
    <p
      ref={line}
      role="status"
      data-testid="annotation-export-line"
      className="annotation-export-line"
    >
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
