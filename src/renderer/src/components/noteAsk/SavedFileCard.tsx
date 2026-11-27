import type { AgentSavedFile } from "../../../../core/api";
import { files } from "../../core";
import { KIND_LABELS, showFileLabelKey } from "../../fileInfo";
import { useT } from "../../i18n";
import { SAVED_OPEN_BUTTON, SAVED_SHOW_BUTTON, useSavedFileActions } from "../../outputFiles";
import { DocumentLineIcon } from "../icons";
import { ProblemLine } from "../ProblemLine";

/** A file the AI saved for the User (#3751): opened or shown, as a file Export saved is. */
export function SavedFileCard({ file }: { file: AgentSavedFile }) {
  const t = useT();
  const { problem, run } = useSavedFileActions(t);
  return (
    <div data-testid="note-column-saved" className="note-column-made-card note-column-saved">
      <div className="note-column-saved-row">
        <span className="note-column-made-icon" aria-hidden="true">
          <DocumentLineIcon kind="docx" />
        </span>
        <span className="note-column-saved-what">
          <span className="note-column-made-title" title={file.name}>
            {file.name}
          </span>
          <span data-testid="note-column-saved-kind" className="note-column-made-kind">
            {t(KIND_LABELS.docx)}
          </span>
        </span>
        <span className="note-column-saved-actions">
          <button
            type="button"
            data-testid="note-column-saved-open"
            onClick={() => run(() => files.openSavedFile(file.path), "export.failed.open")}
            className={SAVED_OPEN_BUTTON}
          >
            {t("export.open")}
          </button>
          <button
            type="button"
            data-testid="note-column-saved-show"
            onClick={() => run(() => files.showSavedFile(file.path), "export.failed.show")}
            className={SAVED_SHOW_BUTTON}
          >
            {t(showFileLabelKey(navigator.platform))}
          </button>
        </span>
      </div>
      {problem && (
        <ProblemLine testId="note-column-saved-problem" className="w-full">
          {problem}
        </ProblemLine>
      )}
    </div>
  );
}
