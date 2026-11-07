import { createPortal } from "react-dom";
import { errorDetails } from "../errorDetails";
import { useDismissOnEscape } from "../escapeDismiss";
import { useLanguage, useT } from "../i18n";
import { type ErrorNotice as ErrorNoticeState, useNotices } from "../notices";
import { ProblemMark } from "./ProblemLine";
import { UnsavedNotices, useUnsavedShown } from "./UnsavedNotice";
import { buttonStyle } from "./ui";
import { useTopModal } from "./useModal";

/**
 * What failed where the action had no line of its own, in plain words, bottom right (DESIGN.md,
 * Problems). Each stays until the User dismisses it, with its button or Esc: it never goes by
 * itself, as an error the User didn't read would be lost. What was said, what was being done and
 * what to do are one click away under Details, in plain words. Nothing here shows Electron's
 * wrapping, a stack, or the name of a method or class.
 *
 * With a modal dialog open (Settings, say), they are drawn inside it: it makes all else inert, so
 * a notice outside would be hidden or unclickable (#754).
 */
export function ErrorNotices() {
  const errors = useNotices((state) => state.errors);
  const unsaved = useUnsavedShown();
  const modal = useTopModal();
  if (errors.length === 0 && !unsaved) return null;
  const list = (
    <div className="fixed right-4 bottom-4 z-20 flex max-w-sm flex-col gap-2">
      <UnsavedNotices />
      {errors.map((notice) => (
        <Notice key={notice.id} notice={notice} />
      ))}
    </div>
  );
  return modal ? createPortal(list, modal) : list;
}

function Notice({ notice }: { notice: ErrorNoticeState }) {
  const t = useT();
  const language = useLanguage();
  const dismiss = () => useNotices.getState().dismissError(notice.id);
  useDismissOnEscape(true, dismiss);
  const said = notice.wording
    ? t(notice.wording.key, notice.wording.values)
    : notice.reason
      ? t(notice.reason)
      : notice.message;
  const line = t("error.action", { message: said });
  return (
    <div
      role="alert"
      data-testid="error-notice"
      className="flex items-start gap-3 rounded-lg bg-sheet py-2.5 pr-2.5 pl-4 text-[13px] leading-5 text-ink shadow-popover"
    >
      <ProblemMark className="mt-2 -mr-1.5" />
      <div className="min-w-0 flex-1 py-1">
        {/* A long one is cut here and kept whole under Details. */}
        <p data-testid="error-notice-message" title={line} className="line-clamp-4 break-words">
          {line}
        </p>
        <details data-testid="error-notice-details" className="mt-1 text-ink-meta">
          <summary className="w-fit cursor-default rounded-sm">{t("error.details")}</summary>
          <p className="mt-1 max-h-40 overflow-y-auto break-words whitespace-pre-wrap">
            {errorDetails(t, language, notice).join("\n")}
          </p>
        </details>
      </div>
      {notice.action && (
        <button
          type="button"
          data-testid="error-notice-action"
          onClick={() => {
            const { action } = notice;
            dismiss();
            Promise.resolve(action?.run()).catch((error: unknown) =>
              useNotices.getState().showError(error),
            );
          }}
          className={buttonStyle("secondary", "sm")}
        >
          {notice.action.label(t)}
        </button>
      )}
      <button
        type="button"
        data-testid="error-notice-dismiss"
        onClick={dismiss}
        className={buttonStyle("ghost", "sm")}
      >
        {t("error.dismiss")}
      </button>
    </div>
  );
}
