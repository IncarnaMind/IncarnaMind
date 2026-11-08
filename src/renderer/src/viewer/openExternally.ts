import { useState } from "react";
import type { Document } from "../../../core/api";
import { files } from "../core";
import { errorMessage } from "../errors";
import { userFile } from "../fileInfo";
import { useT } from "../i18n";
import { type Said, saidInLine } from "../lineNames";

/** Whether the viewer can hand the Document to another app: a web page's live address, or a file of the User's that is there. */
export const canOpenExternally = (document: Document, openable = true): boolean =>
  document.web !== null || (userFile(document) && openable && document.fileStatus === "available");

/**
 * Opens the Document in its own app, as the sidebar's file menu does (a web page at its live
 * address), and keeps why it couldn't, until it is tried again.
 */
export function useOpenExternally(document: Document | undefined): {
  open(): void;
  problem: Said | null;
} {
  const t = useT();
  const [problem, setProblem] = useState<Said | null>(null);
  const open = () => {
    if (!document) return;
    setProblem(null);
    files.openDocumentExternally(document.id).catch((failure: unknown) => {
      setProblem(
        saidInLine(t, (t) =>
          t("viewer.file.openFailed", { name: document.name, reason: errorMessage(failure, t) }),
        ),
      );
    });
  };
  return { open, problem };
}
