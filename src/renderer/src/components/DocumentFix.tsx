import type { ReactNode } from "react";
import type { Document } from "../../../core/api";
import { commands } from "../commands/registry";
import { canOpenFix, documentFix } from "../documentFix";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import { ViewerMessage } from "../viewer/ViewerMessage";
import { quietButtonClass } from "./library/LibrarySection";
import type { ProblemAction } from "./ProblemLine";

/**
 * A Document that needs attention, in one place (#763): why in plain words,
 * then its next step. The Library row and the viewer both show this, so their
 * words and buttons cannot disagree; `fallback` shows when it has no fix.
 */
export function DocumentFix({
  document,
  fallback = null,
  view = false,
  message,
  reload,
}: {
  document: Document;
  fallback?: ReactNode;
  /** The viewer's line, with the reader's own message on hover: not the Library's row. */
  view?: boolean;
  message?: string;
  /** Opens the file again in place, for a view that keeps its own copy of it. */
  reload?: () => void;
}) {
  const t = useT();
  const fix = documentFix(document);
  if (!fix) return <>{fallback}</>;
  const open = () =>
    void commands
      .run("document.openExternally", {
        focus: { kind: "document", id: document.id },
        surface: view ? "viewer" : "library",
      })
      .catch(useAppStore.getState().reportError);
  const retry = () => {
    if (fix.retry === "print") {
      open();
      return;
    }
    reload?.();
    void useAppStore.getState().retryDocument(document.id);
  };
  const actions: ProblemAction[] = [];
  if (canOpenFix(document)) {
    actions.push({
      label: t("library.fix.open"),
      testId: view ? "viewer-fix-open" : "library-fix-open",
      onClick: open,
    });
  }
  if (fix.retry) {
    actions.push({
      label: t(
        fix.retry === "readAgain"
          ? "library.fix.readAgain"
          : fix.retry === "print"
            ? "documents.printToPdfAction"
            : "library.fix.retry",
      ),
      testId: view
        ? fix.retry === "print"
          ? "viewer-fix-print"
          : "viewer-retry"
        : fix.retry === "print"
          ? "library-fix-print"
          : "library-fix-retry",
      onClick: retry,
    });
  }
  if (view) {
    return (
      <ViewerMessage tone="error" action={actions[0]} also={actions[1]}>
        <span title={message || undefined}>{t(fix.reason)}</span>
      </ViewerMessage>
    );
  }
  return (
    <div data-testid="library-fix" className="pl-6 text-[13px] leading-5 text-ink-meta">
      <p data-testid="library-fix-reason">{t(fix.reason)}</p>
      {actions.length > 0 && (
        <p className="flex flex-wrap gap-x-4">
          {actions.map((action) => (
            <button
              key={action.testId}
              type="button"
              data-testid={action.testId}
              onClick={action.onClick}
              className={quietButtonClass}
            >
              {action.label}
            </button>
          ))}
        </p>
      )}
    </div>
  );
}
