import { useT } from "../i18n";
import { lastRunLine } from "../lastRunLine";
import { useNotices } from "../notices";
import { dismissLost, saveChangesAgain, saveCopies, useUnsavedChanges } from "../unsavedChanges";
import { MetaLine } from "./MetaLine";
import { LineAction, ProblemMark } from "./ProblemLine";
import { buttonStyle } from "./ui";

export const useUnsavedShown = () =>
  useUnsavedChanges(
    (state) => state.unsaved !== null || lastRunLine(state.lost, state.ended) !== null,
  );

/**
 * Among the error notices: while changes storage refused wait in memory, what happened and what
 * to do (#1119), until they are stored. And, once, one line for how the last run or this window's
 * page ended (`lastRunLine`, #2309).
 */
export function UnsavedNotices() {
  const t = useT();
  const unsaved = useUnsavedChanges((state) => state.unsaved);
  const lost = useUnsavedChanges((state) => state.lost);
  const ended = useUnsavedChanges((state) => state.ended);
  const line = lastRunLine(lost, ended);
  return (
    <>
      {unsaved && (
        <div
          role="alert"
          data-testid="unsaved-notice"
          className="flex items-start gap-3 rounded-lg bg-sheet py-2.5 pr-4 pl-4 text-[13px] leading-5 text-ink shadow-popover"
        >
          <ProblemMark className="mt-2 -mr-1.5" />
          <div className="min-w-0 flex-1 py-1">
            <MetaLine
              data-testid="unsaved-notice-line"
              parts={[
                t("unsaved.notice", { reason: t(`unsaved.reason.${unsaved.reason}`) }),
                <LineAction
                  key="again"
                  action={{
                    label: t("unsaved.tryAgain"),
                    testId: "unsaved-try-again",
                    onClick: saveChangesAgain,
                  }}
                />,
                unsaved.mindIds.length > 0 && (
                  <LineAction
                    key="copy"
                    action={{
                      label: t("unsaved.saveCopy"),
                      testId: "unsaved-save-copy",
                      onClick: () => {
                        saveCopies(unsaved.mindIds).catch((error: unknown) =>
                          useNotices.getState().showError(error),
                        );
                      },
                    }}
                  />
                ),
              ]}
            />
            <details data-testid="unsaved-notice-details" className="mt-1 text-ink-meta">
              <summary className="w-fit cursor-default rounded-sm">{t("error.details")}</summary>
              <p className="mt-1 max-h-40 overflow-y-auto font-mono text-[12px] leading-4 break-words whitespace-pre-wrap">
                {unsaved.detail}
              </p>
            </details>
          </div>
        </div>
      )}
      {line && (
        <div
          role="status"
          data-testid={line.key.startsWith("unsaved.lost") ? "unsaved-lost" : "unexpected-end"}
          className="flex items-start gap-3 rounded-lg bg-sheet py-2.5 pr-2.5 pl-4 text-[13px] leading-5 text-ink shadow-popover"
        >
          <ProblemMark className="mt-2 -mr-1.5" />
          <p className="min-w-0 flex-1 py-1">{t(line.key, line.params)}</p>
          <button
            type="button"
            data-testid="unsaved-lost-dismiss"
            onClick={dismissLost}
            className={buttonStyle("ghost", "sm")}
          >
            {t("error.dismiss")}
          </button>
        </div>
      )}
    </>
  );
}
