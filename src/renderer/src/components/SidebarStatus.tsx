import {
  type ReactNode,
  type ToggleEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import type { DocumentStatus, EmbeddingModelError } from "../../../core/api";
import { formatDateTime } from "../../../shared/dates";
import type { MessageKey } from "../../../shared/i18n";
import { organizeHeld, organizes, organizesNewDocuments } from "../../../shared/libraryModels";
import { commands } from "../commands/registry";
import { core } from "../core";
import { useLanguage, useT } from "../i18n";
import { useKeyRefusals } from "../keyRefusals";
import { saidInLine } from "../lineNames";
import { useCapturing, useMeetings } from "../meetings";
import { downloadProgress } from "../modelDownload";
import { enterFrom, exitToward } from "../motion";
import { organizeStateOf } from "../organizeOutcome";
import { rerankingModelStatus } from "../rerankStatus";
import { openSandboxHelp, useRunsWithoutSandbox } from "../sandbox";
import { useSettled } from "../settling";
import { allExamples, isOwnDocument, useAppStore } from "../store";
import { useTaggingAlert } from "../taggingAlert";
import { useTaggingExplained } from "../taggingExplained";
import { planLimitLine, taggingProblem } from "../taggingProblem";
import { failedTagging, retryTagging } from "../taggingRetry";
import { placesText, resumeTagging, stoppedDocumentPlaces, taggingPlaces } from "../taggingStop";
import { textRecognitionStatus, useTextRecognition } from "../textRecognition";
import {
  canTryAgain,
  heldInLocalMode,
  outsideDialog,
  reasonKey,
  siteOf,
  useWebPages,
} from "../webPages";
import { failedEverySource, useDownloadSources } from "./DownloadSources";
import { CloseLineIcon } from "./lineIcons";
import { embeddingProviderLabel } from "./providers/EmbeddingSettings";
import { testErrorKey } from "./providers/shared";
import { rowActionButtonClass } from "./sidebarRows";
import { useTaggingService } from "./useTaggingService";

/** The status row's button: a small ghost one, inside the 28px row. */
const statusActionClass =
  "inline-flex h-6 shrink-0 items-center rounded-md px-2 text-[12px] font-semibold text-ink-secondary hover:bg-rule hover:text-ink focus-visible:outline-offset-0 aria-expanded:bg-rule aria-expanded:text-ink";

/** The gap between the "+N" button and the list of the other statuses above it. */
const GAP_PX = 4;

const modelFailures: Record<Exclude<EmbeddingModelError["kind"], "load">, MessageKey> = {
  network: "embedding.model.failure.network",
  integrity: "embedding.model.failure.integrity",
  storage: "embedding.model.failure.storage",
};

const PROCESSING: ReadonlySet<DocumentStatus> = new Set([
  "queued",
  "extracting",
  "waiting-for-model",
  "embedding",
]);

/** In progress (a blue dot), waiting for the User or failed (amber), or for information (grey). */
type Tone = "progress" | "waiting" | "error" | "info";

const dotTones: Record<Tone, string> = {
  progress: "bg-accent",
  waiting: "bg-attention",
  error: "bg-attention",
  info: "bg-ink-placeholder",
};

interface Status {
  testId: string;
  tone: Tone;
  /** What the row shows: short enough for one line. It gives way to `figure`. */
  short: string;
  /** How far along it is ("3/22 MB"): shown after `short`, never cut. */
  figure?: string;
  /** All of it: the tooltip, and what a screen reader reads. */
  full: string;
  action?: { label: string; testId?: string; title?: string; run(): void };
  dismiss?: () => void;
  /** What the dismissing control says, where "Dismiss" isn't what it does. */
  dismissLabel?: string;
  /** It may take two lines, its action said after it, so nothing it names is cut off. */
  wraps?: boolean;
  /** A failed model download's Details (./DownloadSources): their toggle in the line, their panel under it. */
  details?: { toggle: ReactNode; panel: ReactNode };
  /** It asks the User's consent, which is never hidden (ADR-0022). */
  asks?: true;
  /** The User's own Documents wait for them to act, so the quiet first open shows it too. */
  needsYou?: true;
  /** Tagging needs the User: a hidden sidebar's toggle shows a dot for it. Progress never does. */
  alerts?: true;
}

/**
 * The sidebar footer's status row, above Settings: what the app is doing
 * with the Documents (processing, tagging, fetching web pages, the search
 * model's download or a rebuild) or what needs the User (tagging waits for a
 * model, a failure to retry, a web page that couldn't be added, skipped
 * files, files that were in IncarnaMind already). One line:
 * the most pressing status, and "+N" for the others, which lists them above
 * the row. Its 28px are kept even when there is nothing to say, so the tree
 * above moves only for a status that takes two lines. A status that is only
 * progress shows after it has lasted 300 ms and stays at least 500 ms once shown,
 * so none flashes; a failure or a question shows at once.
 */
export function SidebarStatus({ problemsOnly = false }: { problemsOnly?: boolean }) {
  const statuses = useStatuses();
  const shown = useSettled(
    statuses.filter((status) => !isProblem(status)).map((status) => status.testId),
  );
  // A status the work has left stays its last 500 ms as it was.
  const seen = useRef(new Map<string, Status>());
  for (const status of statuses) seen.current.set(status.testId, status);
  const alerting = statuses.some((status) => status.alerts === true);
  useEffect(() => {
    useTaggingAlert.setState({ needsYou: alerting });
  }, [alerting]);
  useEffect(
    () => () => {
      useTaggingAlert.setState({ needsYou: false });
    },
    [],
  );
  const kept = [...shown]
    .filter((id) => !statuses.some((status) => status.testId === id))
    .flatMap((id) => seen.current.get(id) ?? []);
  const [first, ...others] = [
    ...statuses.filter((status) =>
      problemsOnly ? isProblem(status) : isProblem(status) || shown.has(status.testId),
    ),
    ...(problemsOnly ? [] : kept),
  ];
  if (problemsOnly && !first) return null;
  return (
    <div data-testid="sidebar-status" className="flex min-h-7 shrink-0 flex-col">
      {first && (
        <StatusRow status={first}>
          {others.length > 0 && <MoreStatuses others={others} />}
        </StatusRow>
      )}
    </div>
  );
}

// A failure, a one-off the User dismisses (skipped files, a web page not added), a consent
// question, or the User's own files waiting for a model: the quiet first open hides the footer's
// other news, never these (DESIGN.md, Problems).
const isProblem = (status: Status) =>
  status.tone === "error" ||
  status.dismiss !== undefined ||
  status.asks === true ||
  status.needsYou === true;

function StatusRow({ status, children }: { status: Status; children?: ReactNode }) {
  const t = useT();
  const { tone, short, figure, full, action, dismiss, details } = status;
  const wraps = status.wraps === true || details !== undefined;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      data-testid={status.testId}
      title={full}
      className={`flex shrink-0 gap-2 pr-1 pl-2 text-[13px] leading-5 text-ink-meta ${
        wraps ? "min-h-7 items-start py-1" : "h-7 items-center"
      }`}
    >
      <span aria-hidden="true" className="flex h-5 w-4 shrink-0 items-center justify-center">
        <span
          className={`size-1.5 rounded-full ${dotTones[tone]} ${
            tone === "progress" ? "motion-safe:animate-pulse" : ""
          }`}
        />
      </span>
      {wraps ? (
        <span className="min-w-0 flex-1">
          <span aria-hidden="true" data-testid="status-label">
            {short}
          </span>
          {action && (
            <span className="whitespace-nowrap">
              <span aria-hidden="true"> · </span>
              <button
                type="button"
                data-testid={action.testId}
                title={action.title}
                onClick={action.run}
                className="rounded-sm px-0.5 font-semibold text-accent hover:text-accent-strong"
              >
                {action.label}
              </button>
            </span>
          )}
          {details && (
            <span className="whitespace-nowrap">
              <span aria-hidden="true"> · </span>
              {details.toggle}
            </span>
          )}
          {details?.panel}
        </span>
      ) : (
        <span aria-hidden="true" className="flex min-w-0 flex-1 items-center gap-1">
          <span data-testid="status-label" className="min-w-0 truncate">
            {figure ? `${short} ·` : short}
          </span>
          {figure && (
            <span data-testid="status-figure" className="shrink-0 tabular-nums">
              {figure}
            </span>
          )}
        </span>
      )}
      <span className="sr-only">{full}</span>
      {children}
      {action && !wraps && (
        <button
          type="button"
          data-testid={action.testId}
          title={action.title}
          onClick={action.run}
          className={statusActionClass}
        >
          {action.label}
        </button>
      )}
      {dismiss && (
        <button
          type="button"
          aria-label={status.dismissLabel ?? t("error.dismiss")}
          title={status.dismissLabel ?? t("error.dismiss")}
          onClick={dismiss}
          className={rowActionButtonClass}
        >
          <CloseLineIcon className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/**
 * "+N": the statuses the row has no room for, listed (each with its own
 * action) in a popover above it, so none is out of reach.
 */
function MoreStatuses({ others }: { others: Status[] }) {
  const t = useT();
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const label = t("status.more.label", { count: others.length });

  /** Above the button, its left edge on the row's. */
  const place = (list: HTMLElement) => {
    const anchor = button.current
      ?.closest('[data-testid="sidebar-status"]')
      ?.getBoundingClientRect();
    if (!anchor) return;
    list.style.left = `${anchor.left}px`;
    list.style.width = `${anchor.width}px`;
    list.style.bottom = `${window.innerHeight - anchor.top + GAP_PX}px`;
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        data-testid="status-more"
        popoverTarget={id}
        aria-expanded={open}
        aria-label={label}
        title={label}
        className={statusActionClass}
      >
        {t("status.more", { count: others.length })}
      </button>
      <div
        id={id}
        popover="auto"
        role="dialog"
        aria-label={label}
        data-testid="status-others"
        onBeforeToggle={(event: ToggleEvent<HTMLDivElement>) => {
          const list = event.currentTarget;
          if (event.newState === "open") {
            place(list);
            // Once it shows, before that frame paints: it grows from the button.
            requestAnimationFrame(() => enterFrom(list, button.current));
          } else exitToward(list, button.current);
          setOpen(event.newState === "open");
        }}
        className="inset-auto m-0 rounded-lg border-0 bg-sheet p-1 font-normal shadow-popover [&>*+*]:border-t [&>*+*]:border-rule"
      >
        {/* Only while open, so a closed list adds nothing for screen readers to announce. */}
        {open && others.map((status) => <StatusRow key={status.testId} status={status} />)}
      </div>
    </>
  );
}

/** Every status worth showing, the most pressing first. Empty when there is nothing to say. */
function useStatuses(): Status[] {
  const t = useT();
  const language = useLanguage();
  const skipped = useAppStore((state) => state.skippedFiles);
  const cantRecord = useMeetings((state) => state.cantRecord);
  const alreadyAdded = useAppStore((state) => state.alreadyAdded);
  const model = useAppStore((state) => state.embeddingModel);
  const embedding = useAppStore((state) => state.embedding);
  const library = useAppStore((state) => state.library);
  const allDocuments = useAppStore((state) => state.documents);
  const liveAssignments = useMemo(() => {
    const held = new Map((library?.assignments ?? []).map((item) => [item.documentId, item]));
    return allDocuments.flatMap((doc) => {
      const item = held.get(doc.id);
      return item ? [[doc, item] as const] : [];
    });
  }, [allDocuments, library]);
  const organizing = organizes(library);
  const organizesNew = organizesNewDocuments(library);
  const capturing = useCapturing();
  const counts = useAppStore(
    useShallow((state) => {
      let processing = 0;
      // Scans being read (#397), and those found, waiting their turn beside the others (#1502).
      let scansReading = 0;
      let scansWaiting = 0;
      let tagging = 0;
      // Only the User's own Documents: the examples need no model, so they alone don't ask for one.
      let waitingForTagger = 0;
      let waitingForPlan = 0;
      let organizeWaitsForPlan = false;
      let planResetsAt: string | null = null;
      let rateLimited = 0;
      let keyRefused = 0;
      let rateLimitEnds: string | null = null;
      let failedTagging = 0;
      let unreached = 0;
      const heldByOrganize = organizeHeld(state.library);
      // A paused Linked folder's Documents wait for the User: its row says so, not the footer.
      const paused = new Set(
        state.linkedFolders.filter((each) => each.status === "paused").map((each) => each.id),
      );
      for (const item of state.documents) {
        if (PROCESSING.has(item.status)) {
          if (item.linkedFolderId === null || !paused.has(item.linkedFolderId)) {
            processing++;
            if (item.scan?.of === "scanned-pages") {
              if (item.status === "extracting") scansReading++;
              else scansWaiting++;
            }
          }
        } else if (item.status === "ready") {
          const held = heldByOrganize.has(item.id);
          if (item.tagging === "pending" || item.tagging === "tagging") {
            if (!held) tagging++;
          } else if (
            item.tagging === "waiting-for-provider" &&
            isOwnDocument(item, allExamples(state))
          ) {
            if (item.taggingError?.kind === "rate-limit") {
              rateLimited++;
              const ends = item.taggingError.resetsAt ?? null;
              if (ends !== null && (rateLimitEnds === null || ends > rateLimitEnds)) {
                rateLimitEnds = ends;
              }
            } else if (item.taggingError?.kind === "auth") {
              keyRefused++;
            } else {
              if (!held) waitingForTagger++;
              if (item.taggingError?.kind === "plan-limit") {
                waitingForPlan++;
                if (held) organizeWaitsForPlan = true;
                const resets = item.taggingError.resetsAt ?? null;
                if (resets !== null && (planResetsAt === null || resets > planResetsAt)) {
                  planResetsAt = resets;
                }
              }
            }
          } else if (
            item.tagging === "failed" &&
            !held &&
            isOwnDocument(item, allExamples(state))
          ) {
            failedTagging++;
            if (item.taggingError?.kind === "network") unreached++;
          }
        }
      }
      return {
        processing,
        scansReading,
        scansWaiting,
        tagging,
        waitingForTagger,
        waitingForPlan,
        organizeWaitsForPlan,
        planResetsAt,
        rateLimited,
        keyRefused,
        rateLimitEnds,
        failedTagging,
        unreached,
      };
    }),
  );
  const retryDownload = useAppStore((state) => state.downloadEmbeddingModel);
  const rerank = useAppStore((state) => state.rerank);
  const retryRerankingDownload = useAppStore((state) => state.downloadRerankingModel);
  const textRecognition = textRecognitionStatus(
    useTextRecognition((state) => state.status),
    t,
  );
  const retryTextRecognition = useTextRecognition((state) => state.download);
  const textRecognitionModel = useTextRecognition((state) => state.status);
  const embeddingSources = useDownloadSources(
    model?.state === "failed" ? model.error : null,
    () => void retryDownload(),
    "embedding-model",
  );
  const rerankingSources = useDownloadSources(
    rerank?.model?.state === "failed" ? rerank.model.error : null,
    () => void retryRerankingDownload(),
    "reranking-model",
  );
  const textRecognitionSources = useDownloadSources(
    textRecognitionModel?.state === "failed" ? textRecognitionModel.error : null,
    () => void retryTextRecognition(),
    "text-recognition",
  );
  const retryEmbedding = useAppStore((state) => state.retryEmbedding);
  const dismissSkipped = useAppStore((state) => state.dismissSkippedFiles);
  const dismissAlreadyAdded = useAppStore((state) => state.dismissAlreadyAdded);
  const openSettings = useAppStore((state) => state.openSettings);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const sandboxOff = useRunsWithoutSandbox();
  const sandboxNoticeDismissed = useAppStore(
    (state) => state.settings?.device.sandboxNoticeDismissed === true,
  );
  const taggingWaits = counts.waitingForTagger > 0;
  const tagging = !organizesNew && counts.tagging > 0;
  const organizingNow =
    organizing &&
    liveAssignments.some(([, item]) => item.status === "pending" || item.status === "classifying");
  const taggingService = useTaggingService(
    organizingNow ? "classification" : "tagging",
    taggingWaits || tagging || organizingNow,
  );
  const taggingNeedsOk =
    taggingWaits && taggingService && !taggingService.allowed ? taggingService.service : null;
  const refusedService = useTaggingService(
    organizesNew ? "classification" : "tagging",
    counts.keyRefused > 0,
  );
  // The plan the waiting work sends to: while tagging is Automatic, Organize has a model of its own.
  const planService = useTaggingService(
    counts.organizeWaitsForPlan ? "classification" : "tagging",
    counts.waitingForPlan > 0,
  );
  const places = useAppStore(
    useShallow((state) =>
      tagging || organizingNow ? taggingPlaces(state.documents, state.library) : [],
    ),
  );
  const stoppedPlaces = useAppStore(
    useShallow((state) =>
      stoppedDocumentPlaces(
        state.documents.filter((each) => isOwnDocument(each, allExamples(state))),
        state.library,
      ),
    ),
  );
  const service = taggingService?.service.name;
  const running = tagging || organizingNow;
  // A scan without text goes to Organize as pictures of its pages.
  const scans = useAppStore(
    (state) =>
      organizingNow &&
      state.documents.some(
        (each) =>
          each.status === "no-text" &&
          state.library?.assignments.some(
            (item) =>
              item.documentId === each.id &&
              (item.status === "pending" || item.status === "classifying"),
          ),
      ),
  );
  const explained = useTaggingExplained();
  const saysWhatIsSent = running && service !== undefined && explained.says(places);
  useEffect(() => {
    if (saysWhatIsSent) useTaggingExplained.getState().shown(places);
    else if (!running) useTaggingExplained.getState().ended();
  }, [saysWhatIsSent, running, places]);
  const whatIsSent = scans ? t("status.sendsScans") : "";
  const stop = {
    label: t("tagging.stop"),
    testId: "tagging-stop",
    title: t("tagging.stop.title", { places: placesText(places, library, t, language) }),
    run: () =>
      void commands
        .run("tagging.stop")
        .catch((error: unknown) => useAppStore.getState().reportError(error)),
  };
  // The dialog shows how the pages typed in it go; the rest are said here.
  const fetchingPages = useWebPages(
    (state) => state.fetching.filter((key) => outsideDialog(state, key)).length,
  );
  const pageProblems = useWebPages(
    useShallow((state) => state.problems.filter((each) => outsideDialog(state, each.key))),
  );
  const statuses: Status[] = [];
  // The built-in reranking model, on by default, downloads once there are Documents to search.
  const rerankingStatus = rerankingModelStatus(rerank, t);
  const reranking: Status | null = rerankingStatus && {
    testId: rerankingStatus.testId,
    tone: rerankingStatus.tone,
    short: rerankingStatus.short,
    figure: rerankingStatus.figure,
    full: rerankingStatus.full,
    ...(rerankingStatus.retry && {
      action: {
        label: t(rerankingSources.toggle ? "modelSource.tryAgain" : "status.retry"),
        testId: "reranking-model-retry",
        run: () => void retryRerankingDownload(),
      },
    }),
    ...(rerankingSources.toggle && { details: rerankingSources }),
  };

  if (model?.state === "failed" && model.error) {
    const { kind, message } = model.error;
    const full =
      kind === "load"
        ? t("embedding.model.loadFailed")
        : t("embedding.model.failed", { reason: t(modelFailures[kind]) });
    statuses.push({
      testId: "embedding-model-failed",
      tone: "error",
      short: failedEverySource(model.error)
        ? t("status.downloadFailed.everySource")
        : t(kind === "load" ? "status.modelFailed" : "status.downloadFailed"),
      full: `${full}\n${message}`,
      action: {
        label: t(embeddingSources.toggle ? "modelSource.tryAgain" : "status.retry"),
        testId: "embedding-model-retry",
        run: () => void retryDownload(),
      },
      ...(embeddingSources.toggle && { details: embeddingSources }),
    });
  }

  if (reranking?.tone === "error") statuses.push(reranking);

  if (textRecognition?.tone === "error") {
    statuses.push({
      ...textRecognition,
      ...(textRecognitionSources.toggle && { details: textRecognitionSources }),
      action: {
        label: t(textRecognitionSources.toggle ? "modelSource.tryAgain" : "status.retry"),
        testId: "text-recognition-retry",
        run: () => void retryTextRecognition(),
      },
    });
  }

  if (embedding?.error) {
    const provider = embeddingProviderLabel(embedding.provider, t);
    statuses.push({
      testId: "embedding-provider-error",
      tone: "error",
      short: t("status.searchError", { provider }),
      full: `${t("embeddingProviders.error.notice", {
        provider,
        reason: t(testErrorKey(embedding.error.kind)),
      })}\n${embedding.error.message}`,
      action: { label: t("status.retry"), run: () => void retryEmbedding() },
    });
  }

  if (counts.failedTagging > 0) {
    const reasons = failedTagging(useAppStore.getState()).flatMap((each) =>
      each.taggingError && each.taggingError.kind !== "network"
        ? [taggingProblem(each.taggingError, t)]
        : [],
    );
    statuses.push({
      testId: "tagging-failed",
      tone: "error",
      alerts: true,
      short:
        counts.failedTagging === 1
          ? t("status.taggingFailed.one")
          : t("status.taggingFailed.other", { count: counts.failedTagging }),
      full: [
        t(
          counts.unreached === counts.failedTagging
            ? "status.taggingFailed.offline"
            : "status.taggingFailed.full",
        ),
        ...new Set(reasons),
      ].join("\n"),
      action: {
        label: t("status.retry"),
        testId: "tagging-failed-retry",
        run: () => void retryTagging(),
      },
    });
  }

  for (const problem of pageProblems) {
    const refused = !canTryAgain(problem);
    const reason = t(reasonKey(problem.reason));
    const held = heldInLocalMode(problem);
    const { message: short, fullMessage = short } = saidInLine(t, (t) =>
      held
        ? t("webPages.localMode", { site: siteOf(problem.address) })
        : problem.document
          ? t("webPages.fetchAgainFailed", { name: problem.document.name, reason })
          : t(refused ? "webPages.notAdded" : "webPages.couldNotFetch", { reason }),
    );
    const { tryAgain, dismiss } = useWebPages.getState();
    statuses.push({
      testId: `web-page-problem:${problem.key}`,
      tone: refused ? "waiting" : "error",
      short,
      full: held
        ? `${fullMessage}\n${problem.address}`
        : `${fullMessage}\n${problem.address}\n${problem.message}`,
      ...(refused
        ? {}
        : {
            action: {
              label: t(held ? "webPages.localMode.once" : "webPages.tryAgain"),
              testId: held ? "web-page-fetch-once" : "web-page-try-again",
              run: () => void tryAgain(problem, held ? true : undefined),
            },
          }),
      dismiss: () => dismiss(problem),
      ...(held && { dismissLabel: t("webPages.localMode.keep") }),
    });
  }

  if (cantRecord) {
    const text = t("meetings.settings.cantRecord");
    statuses.push({
      testId: "cant-record",
      tone: "waiting",
      short: text,
      full: text,
      wraps: true,
      action: {
        label: t("meetings.cantRecord.notes"),
        testId: "cant-record-notes",
        run() {
          useMeetings.getState().clearCantRecord();
          void useAppStore.getState().createMind({ titled: true });
        },
      },
      dismiss: () => useMeetings.getState().clearCantRecord(),
    });
  }

  if (skipped.length > 0) {
    statuses.push({
      testId: "skipped-files",
      tone: "waiting",
      short:
        skipped.length === 1
          ? t("status.skipped.one")
          : t("status.skipped.other", { count: skipped.length }),
      full: t("documents.skipped", { names: skipped.join(", ") }),
      dismiss: dismissSkipped,
    });
  }

  if (alreadyAdded.length > 0) {
    statuses.push({
      testId: "already-added",
      tone: "info",
      short:
        alreadyAdded.length === 1
          ? t("status.alreadyAdded.one")
          : t("status.alreadyAdded.other", { count: alreadyAdded.length }),
      full: t("documents.alreadyAdded", { names: alreadyAdded.join(", ") }),
      dismiss: dismissAlreadyAdded,
    });
  }

  if (sandboxOff && !sandboxNoticeDismissed) {
    statuses.push({
      testId: "no-sandbox",
      tone: "waiting",
      short: t("sandbox.off"),
      full: t("sandbox.off"),
      wraps: true,
      action: { label: t("sandbox.off.fix"), testId: "no-sandbox-fix", run: openSandboxHelp },
      dismiss: () => void updateSettings({ device: { sandboxNoticeDismissed: true } }),
    });
  }

  if (counts.rateLimited > 0) {
    const time = counts.rateLimitEnds ? formatDateTime(counts.rateLimitEnds, language) : "";
    const limited = useAppStore
      .getState()
      .documents.filter(
        (each) =>
          each.status === "ready" &&
          each.tagging === "waiting-for-provider" &&
          each.taggingError?.kind === "rate-limit",
      );
    statuses.push({
      testId: "tagging-rate-limited",
      tone: "waiting",
      short: t("status.taggingRateLimited", { time }),
      full: t("status.taggingRateLimited.full", { time }),
      wraps: true,
      needsYou: true,
      action: {
        label: t("status.retry"),
        testId: "tagging-rate-limited-retry",
        run: () => void useAppStore.getState().retagDocuments(limited.map((each) => each.id)),
      },
    });
  }

  if (counts.keyRefused > 0) {
    statuses.push({
      testId: "tagging-key-refused",
      tone: "waiting",
      short: t("status.taggingKeyRefused"),
      full: t("status.taggingKeyRefused.full"),
      wraps: true,
      needsYou: true,
      alerts: true,
      action: {
        label: t("answer.error.checkKey"),
        testId: "tagging-key-refused-check",
        run: () => void useKeyRefusals.getState().checkService(refusedService?.service.id ?? null),
      },
    });
  }

  if (counts.waitingForPlan > 0) {
    const line = planLimitLine(planService?.service ?? null, counts.planResetsAt, t, language);
    statuses.push({
      testId: "tagging-paused",
      tone: "waiting",
      short: line,
      full: t("status.planLimit.full", { line }),
      wraps: true,
      needsYou: true,
      action: {
        label: t("signInRoute.wayBack.pasteApiKey"),
        testId: "tagging-paused-use-key",
        run: () => openSettings("models"),
      },
    });
  } else if (taggingWaits && taggingNeedsOk) {
    statuses.push({
      testId: "tagging-waiting",
      tone: "waiting",
      short: t("status.taggingPermission"),
      full: t("jev.waiting.permission", { service: taggingNeedsOk.name }),
      asks: true,
      alerts: true,
      action: {
        label: t("privacy.flows.allow"),
        testId: "tagging-waiting-allow",
        run: () =>
          void core
            .allowDataFlow("tagging", taggingNeedsOk.id)
            .catch((error: unknown) => useAppStore.getState().reportError(error)),
      },
    });
  } else if (taggingWaits) {
    statuses.push({
      testId: "tagging-waiting",
      tone: "waiting",
      short: t("status.taggingWaiting"),
      full: t("jev.waiting.notice"),
      needsYou: true,
      alerts: true,
      action: {
        label: t("status.choose"),
        testId: "tagging-waiting-setup",
        run: () => openSettings("models", "tagging"),
      },
    });
  }

  if (stoppedPlaces.length > 0) {
    statuses.push({
      testId: "tagging-stopped",
      tone: "waiting",
      short: t("status.taggingStopped"),
      full: t("tagging.stoppedIn", { places: placesText(stoppedPlaces, library, t, language) }),
      needsYou: true,
      action: {
        label: t("tagging.resume"),
        testId: "tagging-resume",
        run: () =>
          void resumeTagging(stoppedPlaces).catch((error: unknown) =>
            useAppStore.getState().reportError(error),
          ),
      },
    });
  }

  if (model?.state === "downloading") {
    const { downloaded, total, figure } = downloadProgress(model, t);
    statuses.push({
      testId: "embedding-model-download",
      tone: "progress",
      short: t("status.downloading"),
      figure,
      full: `${t("embedding.model.downloading", { downloaded, total })}\n${t("embedding.model.note")}`,
    });
  }

  if (reranking?.tone === "progress") statuses.push(reranking);
  if (textRecognition?.tone === "progress") statuses.push(textRecognition);

  const rebuild = embedding?.rebuild;
  if (rebuild) {
    const title = t("embeddingProviders.rebuild.title", {
      done: rebuild.done,
      total: rebuild.total,
    });
    const reason =
      rebuild.reason === "local-mode" ? `${t("embeddingProviders.rebuild.localMode")}\n` : "";
    statuses.push({
      testId: "embedding-rebuild-notice",
      tone: "progress",
      short: t("status.rebuilding"),
      figure: `${rebuild.done}/${rebuild.total}`,
      full: `${reason}${title}\n${t("embeddingProviders.rebuild.note")}`,
    });
  }

  if (fetchingPages > 0) {
    const text =
      fetchingPages === 1
        ? t("webPages.fetching.one")
        : t("webPages.fetching.other", { count: fetchingPages });
    statuses.push({ testId: "web-pages-fetching", tone: "progress", short: text, full: text });
  }

  // While a Meeting records, Documents wait to be read, and tagging waits too (#135).
  if (capturing && (counts.processing > 0 || counts.tagging > 0)) {
    statuses.push({
      testId: "reading-paused",
      tone: "info",
      short: t("status.readingPaused"),
      full: t("status.readingPaused.full"),
    });
  } else if (counts.processing > 0) {
    // While scans are read, they are what takes the time: the row says so, and how many wait.
    const { scansReading: reading, scansWaiting: waiting } = counts;
    const text =
      reading > 0
        ? waiting > 0
          ? reading === 1
            ? t("status.scansWaiting.one", { waiting })
            : t("status.scansWaiting.other", { count: reading, waiting })
          : reading === 1
            ? t("status.scans.one")
            : t("status.scans.other", { count: reading })
        : counts.processing === 1
          ? t("status.processing.one")
          : t("status.processing.other", { count: counts.processing });
    statuses.push({ testId: "processing-status", tone: "progress", short: text, full: text });
  }

  if (!capturing && tagging) {
    const text = service
      ? saysWhatIsSent
        ? counts.tagging === 1
          ? t("status.taggingSends.one", { service })
          : t("status.taggingSends.other", { count: counts.tagging, service })
        : counts.tagging === 1
          ? t("status.taggingWith.one", { service })
          : t("status.taggingWith.other", { count: counts.tagging, service })
      : counts.tagging === 1
        ? t("status.tagging.one")
        : t("status.tagging.other", { count: counts.tagging });
    const short = service && saysWhatIsSent ? text + whatIsSent : text;
    const full =
      service && saysWhatIsSent
        ? (counts.tagging === 1
            ? t("status.taggingSends.full.one", { service })
            : t("status.taggingSends.full.other", { count: counts.tagging, service })) + whatIsSent
        : text;
    statuses.push({
      testId: "tagging-status",
      tone: "progress",
      short,
      full,
      wraps: true,
      action: stop,
    });
  }

  if (organizing && library) {
    const pending = liveAssignments.filter(
      ([, item]) => item.status === "pending" || item.status === "classifying",
    ).length;
    const attention = liveAssignments.filter(
      ([doc, item]) =>
        organizeStateOf(doc, item) !== "sorted" &&
        ((item.status === "waiting" &&
          item.error?.kind !== "rate-limit" &&
          item.error?.kind !== "auth" &&
          item.error?.kind !== "plan-limit") ||
          item.status === "failed"),
    ).length;
    if (attention)
      statuses.push({
        testId: "organization-attention",
        tone: "waiting",
        alerts: true,
        short: t("library.needsAttention"),
        full: t("library.waiting", { count: attention }),
        action: { label: t("library.review"), run: () => useAppStore.getState().openLibrary() },
      });
    if (pending) {
      const text = service
        ? saysWhatIsSent
          ? pending === 1
            ? t("library.progressSends.one", { service })
            : t("library.progressSends.other", { count: pending, service })
          : pending === 1
            ? t("library.progressWith.one", { service })
            : t("library.progressWith.other", { count: pending, service })
        : pending === 1
          ? t("library.progress.one")
          : t("library.progress.other", { count: pending });
      const short = service && saysWhatIsSent ? text + whatIsSent : text;
      const full =
        service && saysWhatIsSent
          ? (pending === 1
              ? t("library.progressSends.full.one", { service })
              : t("library.progressSends.full.other", { count: pending, service })) + whatIsSent
          : text;
      statuses.push({
        testId: "organization-progress",
        tone: "progress",
        short,
        full,
        wraps: true,
        action: stop,
      });
    }
  }
  return statuses;
}
