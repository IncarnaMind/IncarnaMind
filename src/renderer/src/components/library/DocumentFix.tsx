import type { Document } from "../../../../core/api";
import { commands } from "../../commands/registry";
import { documentFix } from "../../documentFix";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { quietButtonClass } from "./LibrarySection";

/**
 * Under a Document that needs attention: why, in plain words, and its next
 * step as buttons (#763): open the file in its own app, and read it again.
 */
export function DocumentFix({ doc }: { doc: Document }) {
  const t = useT();
  const fix = documentFix(doc);
  if (!fix) return null;
  const open = () =>
    void commands
      .run("document.openExternally", {
        focus: { kind: "document", id: doc.id },
        surface: "library",
      })
      .catch(useAppStore.getState().reportError);
  const retry = () => {
    if (fix.retry === "print") {
      open();
      return;
    }
    void useAppStore.getState().retryDocument(doc.id);
  };
  return (
    <div data-testid="library-fix" className="pl-6 text-[13px] leading-5 text-ink-meta">
      <p data-testid="library-fix-reason">{t(fix.reason)}</p>
      {(fix.open || fix.retry) && (
        <p className="flex flex-wrap gap-x-4">
          {fix.open && (
            <button
              type="button"
              data-testid="library-fix-open"
              onClick={open}
              className={quietButtonClass}
            >
              {t("library.fix.open")}
            </button>
          )}
          {fix.retry && (
            <button
              type="button"
              data-testid={fix.retry === "print" ? "library-fix-print" : "library-fix-retry"}
              onClick={retry}
              className={quietButtonClass}
            >
              {t(
                fix.retry === "readAgain"
                  ? "library.fix.readAgain"
                  : fix.retry === "print"
                    ? "documents.printToPdfAction"
                    : "library.fix.retry",
              )}
            </button>
          )}
        </p>
      )}
    </div>
  );
}
