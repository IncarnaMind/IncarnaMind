import { type ReactNode, useContext, useState } from "react";
import { type ProblemAction, ProblemLine } from "../components/ProblemLine";
import { errorMessage } from "../errors";
import { useT } from "../i18n";
import { saidInLine } from "../lineNames";
import { useAppStore } from "../store";
import { ViewerFrameContext } from "./ViewerHeader";

/**
 * A short message under the viewer's header. Loading and empty fill the view
 * in the middle; a failure is a problem line at the top, where the page would be.
 */
export function ViewerMessage({
  children,
  testId,
  tone = "muted",
  action,
  also,
}: {
  children: ReactNode;
  testId?: string;
  tone?: "muted" | "error";
  action?: ProblemAction | undefined;
  /** A second choice, after the first, as ProblemLine's. */
  also?: ProblemAction | undefined;
}) {
  if (tone === "error") {
    return (
      <div data-testid={testId} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <ProblemLine testId="viewer-problem" action={action} also={also}>
          {children}
        </ProblemLine>
      </div>
    );
  }
  return (
    <div
      data-testid={testId}
      role="status"
      className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-ui"
    >
      <p className="max-w-sm break-words text-ink-meta">{children}</p>
    </div>
  );
}

/**
 * Why a Document can't be shown: it was deleted, it went with its unlinked
 * Linked folder (the text its Citations quote was kept), or it is still there
 * but its file is missing or can't be reached.
 */
type GoneReason = "deleted" | "unlinked" | "missing" | "unavailable";

const GONE_TEXT = {
  deleted: "viewer.removed.body",
  unlinked: "viewer.removed.unlinked",
  missing: "viewer.file.missing",
  unavailable: "viewer.file.unavailable",
} as const;

/**
 * Shown instead of a Document that can't be shown (e.g. a Citation's), with
 * the quoted text when there is one, so the quote can still be read.
 * `unlinked`: the Citation's Document went with its Linked folder, and the
 * text it quotes was kept, so it says that instead of "deleted".
 */
export function DocumentRemoved({
  quote,
  unlinked = false,
}: {
  quote?: string | undefined;
  unlinked?: boolean;
}) {
  return <DocumentGone quote={quote} reason={unlinked ? "unlinked" : "deleted"} />;
}

/**
 * Shown instead of a Document whose file couldn't be read: it says whether
 * the file is missing or can't be reached, as the Document does. The viewer
 * shows the file again once it is back.
 */
export function FileGone({ quote }: { quote?: string | undefined }) {
  const { document } = useContext(ViewerFrameContext);
  return (
    <DocumentGone
      quote={quote}
      reason={document?.fileStatus === "unavailable" ? "unavailable" : "missing"}
    />
  );
}

/** What came of "Locate file…", when it didn't bring the file back. */
type Located = { kind: "other" } | { kind: "failed"; reason: string };

function DocumentGone({ quote, reason }: { quote?: string | undefined; reason: GoneReason }) {
  const t = useT();
  const { document } = useContext(ViewerFrameContext);
  const locate = useAppStore((state) => state.locateDocumentFile);
  const [located, setLocated] = useState<Located | null>(null);
  const [locating, setLocating] = useState(false);
  const name = document?.name ?? "";
  const gone = saidInLine(t, (t) => t(GONE_TEXT[reason], { name }));
  const other = saidInLine(t, (t) => t("viewer.file.notThis", { name }));

  const locateFile = async () => {
    if (!document) return;
    setLocating(true);
    try {
      const outcome = await locate(document.id);
      setLocated(outcome === "other" ? { kind: "other" } : null);
    } catch (failure) {
      setLocated({ kind: "failed", reason: errorMessage(failure, t) });
    } finally {
      setLocating(false);
    }
  };

  // A file that moved can be pointed to; one that can't be reached comes back by itself.
  const action =
    reason === "missing" && document
      ? {
          label: t("viewer.file.locate"),
          onClick: () => void locateFile(),
          testId: "viewer-locate-file",
          disabled: locating,
        }
      : undefined;

  return (
    <div
      data-testid="viewer-removed"
      data-reason={reason}
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3"
    >
      <ProblemLine role="status" testId="viewer-problem" action={action} title={gone.fullMessage}>
        {gone.message}
      </ProblemLine>
      {located && (
        <ProblemLine testId="viewer-locate-result" title={other.fullMessage}>
          {located.kind === "other"
            ? other.message
            : t("viewer.file.locateFailed", { reason: located.reason })}
        </ProblemLine>
      )}
      {quote && (
        <figure className="w-full max-w-sm">
          <figcaption className="text-label text-ink-meta">{t("viewer.removed.quote")}</figcaption>
          <blockquote className="mt-2 rounded-lg bg-frame px-4 py-3 font-serif text-[15px] leading-6 break-words whitespace-pre-wrap text-ink-answer">
            {quote}
          </blockquote>
        </figure>
      )}
    </div>
  );
}
