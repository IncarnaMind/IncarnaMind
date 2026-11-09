import { type ReactNode, useId, useState } from "react";
import { estimateText } from "../../cost";
import { useLanguage, useT } from "../../i18n";
import { formatCount } from "../../linkedFolders";
import {
  acceptEstimate,
  dismissEstimate,
  dismissFailed,
  dismissTaggingFailed,
  LIBRARY_UNDO_PLACE,
  openReview,
  retryFailed,
  stopOrganizing,
  useOrganizeReview,
} from "../../organizeReview";
import { useAppStore } from "../../store";
import { ProblemLine } from "../ProblemLine";
import { UndoLineAt } from "../UndoLine";
import { useTaggingService } from "../useTaggingService";
import { quietButtonClass } from "./LibrarySection";
import { OrganizeAsk } from "./OrganizeAsk";

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
 * Organize's one state, said once at the Library's top (#1569): what it asks before it runs;
 * "Organizing 12 of 40…" with Stop while it runs; its cost first when that is over $1; after Stop,
 * that nothing moved; while Documents wait to be confirmed, how many with Review, in the update's
 * own words until the Review is first opened; and what Confirm or Discard did, with Undo.
 */
export function OrganizeLines() {
  const t = useT();
  const language = useLanguage();
  const run = useOrganizeReview((state) => state.run);
  const stopped = useOrganizeReview((state) => state.stopped);
  const stoppedTagging = useOrganizeReview((state) => state.stoppedTagging);
  const apart = useOrganizeReview((state) => state.apart);
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
      {!run && <OrganizeAsk />}
      {run ? (
        <Line testId="organize-running">
          <span className="tabular-nums">
            {t(run.tags ? "organizeReview.tagging" : "organizeReview.running", {
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
              <span>
                {t(stoppedTagging ? "organizeReview.stoppedTagging" : "organizeReview.stopped", {
                  count: formatCount(stopped, language),
                })}
              </span>
            </Line>
          )}
          {apart !== null && (
            <Line testId="organize-apart">
              <span>
                {apart.count === 1
                  ? t(apart.tags ? "organizeReview.noTagFits.one" : "organizeReview.apart.one")
                  : t(apart.tags ? "organizeReview.noTagFits" : "organizeReview.apart", {
                      count: formatCount(apart.count, language),
                    })}
              </span>
            </Line>
          )}
          {count > 0 && (
            <Line testId="organize-waiting">
              <span className="tabular-nums">
                {moved > 0
                  ? t(
                      moved === 1
                        ? "organizeReview.waiting.migrated.one"
                        : "organizeReview.waiting.migrated",
                      { count: formatCount(moved, language) },
                    )
                  : t(count === 1 ? "organizeReview.waiting.one" : "organizeReview.waiting", {
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
      {!run && <FailedLine />}
      {!run && <TaggingFailedLine />}
    </>
  );
}

/**
 * The last Organize proposed its Folders but its tagging failed (#2339): one line says so, with
 * the provider's sentence under Details, until dismissed. The next run tries the Tags again.
 */
function TaggingFailedLine() {
  const t = useT();
  const failed = useOrganizeReview((state) => state.taggingFailed);
  const [open, setOpen] = useState(false);
  const panel = useId();
  if (!failed) return null;
  return (
    <ProblemLine
      role="alert"
      testId="organize-tagging-failed"
      className="mt-2"
      action={{
        label: t("organizeReview.dismiss"),
        testId: "organize-tagging-failed-dismiss",
        onClick: dismissTaggingFailed,
      }}
      disclosure={{
        toggle: (
          <button
            type="button"
            data-testid="organize-tagging-failed-details"
            aria-expanded={open}
            aria-controls={panel}
            onClick={() => setOpen(!open)}
            className="rounded-sm font-semibold text-accent underline-offset-2 hover:underline"
          >
            {t("error.details")}
          </button>
        ),
        panel: open ? (
          <p id={panel} className="mt-1 break-words text-ink-secondary">
            {failed.details}
          </p>
        ) : null,
      }}
    >
      {t("organizeReview.taggingFailed")}
    </ProblemLine>
  );
}

/**
 * The last run reached no model, so there was nothing to review (#1569): the app's own words
 * name the service, with Try again, the provider's sentence under Details, until dismissed.
 */
function FailedLine() {
  const t = useT();
  const failed = useOrganizeReview((state) => state.failed);
  const [open, setOpen] = useState(false);
  const panel = useId();
  const service = useTaggingService("classification", failed !== null);
  if (!failed) return null;
  const said =
    service.route.where === "cloud"
      ? t("organizeReview.leftOut.unreachable", { service: service.route.service.name })
      : t("organizeReview.failed.model");
  return (
    <ProblemLine
      role="alert"
      testId="organize-failed"
      className="mt-2"
      action={{
        label: t("answer.error.retry"),
        testId: "organize-failed-retry",
        onClick: retryFailed,
      }}
      also={{
        label: t("organizeReview.dismiss"),
        testId: "organize-failed-dismiss",
        onClick: dismissFailed,
      }}
      disclosure={{
        toggle: (
          <button
            type="button"
            data-testid="organize-failed-details"
            aria-expanded={open}
            aria-controls={panel}
            onClick={() => setOpen(!open)}
            className="rounded-sm font-semibold text-accent underline-offset-2 hover:underline"
          >
            {t("error.details")}
          </button>
        ),
        panel: open ? (
          <p id={panel} className="mt-1 break-words text-ink-secondary">
            {failed.details}
          </p>
        ) : null,
      }}
    >
      {said}
    </ProblemLine>
  );
}
