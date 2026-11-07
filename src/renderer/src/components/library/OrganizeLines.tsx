import type { ReactNode } from "react";
import { core } from "../../core";
import { estimateText } from "../../cost";
import { useLanguage, useT } from "../../i18n";
import { formatCount } from "../../linkedFolders";
import {
  acceptEstimate,
  dismissEstimate,
  LIBRARY_UNDO_PLACE,
  openReview,
  stopOrganizing,
  useOrganizeReview,
} from "../../organizeReview";
import { useAppStore } from "../../store";
import { ProblemLine } from "../ProblemLine";
import { UndoLineAt } from "../UndoLine";
import { quietButtonClass } from "./LibrarySection";

/** "·" and an action after it, as the line's parts are joined. */
function Action({ label, testId, onClick }: { label: string; testId: string; onClick(): void }) {
  return (
    <>
      <span aria-hidden="true" className="text-ink-meta">
        ·
      </span>
      <button type="button" data-testid={testId} onClick={onClick} className={quietButtonClass}>
        {label}
      </button>
    </>
  );
}

function Line({
  testId,
  children,
  role = "status",
}: {
  testId: string;
  children: ReactNode;
  role?: "status" | "alert";
}) {
  return (
    <div
      role={role}
      data-testid={testId}
      className="mt-2 flex min-h-6 flex-wrap items-center gap-x-1 text-[13px] leading-5 text-ink-secondary"
    >
      {children}
    </div>
  );
}

/**
 * Organize's one state, said once at the Library's top (#1569): "Organizing 12 of 40…" with Stop
 * while it runs; its cost first when that is over $1; after Stop, that nothing moved; while
 * Documents wait to be confirmed, how many with Review; and what Confirm or Discard did, with Undo.
 */
export function OrganizeLines() {
  const t = useT();
  const language = useLanguage();
  const run = useOrganizeReview((state) => state.run);
  const stopped = useOrganizeReview((state) => state.stopped);
  const estimate = useOrganizeReview((state) => state.estimate);
  const counted = useOrganizeReview((state) => state.count);
  const snapshotCount = useAppStore((state) => state.library?.reviewCount ?? 0);
  const count = counted ?? snapshotCount;
  const moved = useAppStore((state) => state.library?.reviewMoved ?? 0);
  const cost =
    estimate?.estimate.billing === "per-token" && estimate.estimate.cost
      ? estimateText(
          estimate.estimate.cost,
          estimate.estimate.upTo?.cost ?? null,
          (key, params) => t(key, params),
          language,
        )
      : null;
  return (
    <>
      <UndoLineAt place={LIBRARY_UNDO_PLACE} className="mt-2 -ml-4 empty:hidden" />
      {run ? (
        <Line testId="organize-running">
          <span className="tabular-nums">
            {t("organizeReview.running", {
              done: formatCount(run.done, language),
              total: formatCount(run.total, language),
            })}
          </span>
          {!run.each && (
            <Action
              label={t("organizeReview.stop")}
              testId="organize-stop"
              onClick={stopOrganizing}
            />
          )}
          <span
            aria-hidden="true"
            className="mt-1 h-1 basis-full overflow-hidden rounded-full bg-rule"
          >
            <span
              className="block h-full bg-accent"
              style={{ width: `${run.total > 0 ? (run.done / run.total) * 100 : 0}%` }}
            />
          </span>
        </Line>
      ) : estimate ? (
        <Line testId="organize-estimate">
          <span>
            {t("organizeReview.estimate", {
              count: formatCount(estimate.count, language),
              cost: cost ?? "",
            })}
          </span>
          <Action
            label={t("library.classify")}
            testId="organize-estimate-go"
            onClick={acceptEstimate}
          />
          <Action
            label={t("organizeReview.notNow")}
            testId="organize-estimate-not-now"
            onClick={dismissEstimate}
          />
        </Line>
      ) : (
        <>
          {stopped !== null && (
            <Line testId="organize-stopped">
              <span>{t("organizeReview.stopped", { count: formatCount(stopped, language) })}</span>
            </Line>
          )}
          {count > 0 && (
            <Line testId="organize-waiting">
              <span className="tabular-nums">
                {t(count === 1 ? "organizeReview.waiting.one" : "organizeReview.waiting", {
                  count: formatCount(count, language),
                })}
              </span>
              <Action
                label={t("library.review")}
                testId="organize-waiting-review"
                onClick={openReview}
              />
            </Line>
          )}
        </>
      )}
      {moved > 0 && <ReviewMovedLine count={moved} />}
    </>
  );
}

/**
 * Said once after the update (#1569): Documents that waited in a Suggested Folder wait to be
 * confirmed now, in no Folder until then.
 */
function ReviewMovedLine({ count }: { count: number }) {
  const t = useT();
  const language = useLanguage();
  const close = () =>
    core.dismissReviewMoved().catch((error: unknown) => useAppStore.getState().reportError(error));
  return (
    <ProblemLine
      role="status"
      testId="organize-moved"
      className="mt-1"
      action={{
        label: t("library.review"),
        testId: "organize-moved-review",
        onClick: () => {
          void close();
          openReview();
        },
      }}
      also={{
        label: t("organizeReview.moved.dismiss"),
        testId: "organize-moved-dismiss",
        onClick: () => void close(),
      }}
    >
      {t(count === 1 ? "organizeReview.moved.one" : "organizeReview.moved", {
        count: formatCount(count, language),
      })}
    </ProblemLine>
  );
}
