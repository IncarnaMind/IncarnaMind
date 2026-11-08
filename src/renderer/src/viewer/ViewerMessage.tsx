import { type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { type ProblemAction, ProblemLine } from "../components/ProblemLine";
import { logCaught } from "../errorLog";
import { errorMessage } from "../errors";
import { useT } from "../i18n";
import { saidInLine } from "../lineNames";
import { useAppStore } from "../store";
import { canOpenExternally, useOpenExternally } from "./openExternally";
import { viewerOpenLimitMs } from "./openLimit";
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
 * "Opening the Document…" while a view opens its file. A view still opening after the limit
 * says it couldn't, with one way on: the Document in its own app, else `retry`; it still shows
 * the Document if the open finishes after all (#2828). `waitingOn` names, for the log, what the
 * view was still waiting for.
 */
export function OpeningDocument({
  retry,
  waitingOn,
}: {
  retry?: () => void;
  waitingOn?: () => string;
}) {
  const t = useT();
  const { document } = useContext(ViewerFrameContext);
  const [late, setLate] = useState(false);
  const external = useOpenExternally(document);
  const kind = document?.kind ?? "unknown";
  const said = useRef(waitingOn);
  useEffect(() => {
    said.current = waitingOn;
  });
  useEffect(() => {
    const limit = viewerOpenLimitMs();
    const timer = setTimeout(() => {
      setLate(true);
      const stage = said.current?.();
      logCaught(
        new Error(
          `A ${kind} Document was still opening after ${limit} ms${stage ? `, waiting for ${stage}` : ""}.`,
        ),
      );
    }, limit);
    return () => clearTimeout(timer);
  }, [kind]);

  if (!late) return <ViewerMessage>{t("viewer.loading")}</ViewerMessage>;
  const action: ProblemAction | undefined =
    document && canOpenExternally(document)
      ? {
          label: t(document.web ? "webPages.openLive" : "documents.copy.open"),
          testId: "viewer-not-opened-open",
          onClick: external.open,
        }
      : retry && {
          label: t("documents.retryAction"),
          testId: "viewer-not-opened-retry",
          onClick: retry,
        };
  return (
    <ViewerMessage tone="error" testId="viewer-not-opened" action={action}>
      {external.problem ? (
        <span title={external.problem.fullMessage}>{external.problem.message}</span>
      ) : (
        t(kind === "pdf" ? "viewer.notOpened.pdf" : "viewer.notOpened")
      )}
    </ViewerMessage>
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
