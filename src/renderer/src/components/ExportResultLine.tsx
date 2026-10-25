import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { displayName } from "../../../shared/documentNames";
import { nameInLine } from "../../../shared/naming";
import { core, files } from "../core";
import { CheckStateIcon } from "../editor/icons";
import { errorMessage } from "../errors";
import { useDismissOnEscape } from "../escapeDismiss";
import { commentedChecks, trackedChanges, unmarkedChecks } from "../exportChecks";
import { useExportDialog } from "../exportDialog";
import {
  COMPARISON_EXCEL,
  type ExportResult,
  exportAgain,
  exportMind,
  FORMAT_LABELS,
  isCheckRecord,
  revealNeedsDetails,
  revealUnverified,
  useExports,
} from "../exports";
import { showFileLabelKey } from "../fileInfo";
import { useLanguage, useT } from "../i18n";
import { saidInLine } from "../lineNames";
import { folderName } from "../linkedFolders";
import { enter } from "../motion";
import {
  chooseOutputLocation,
  defaultFolderLabel,
  showOutputLocationSetting,
} from "../outputFiles";
import { saveFailureReason } from "../problems";
import { useAppStore } from "../store";
import { useHeld } from "../useHeld";
import { ExportAsks } from "./ExportAsks";
import { CloseLineIcon, ExportLineIcon } from "./lineIcons";
import { type ProblemAction, ProblemLine } from "./ProblemLine";
import { WordExportReview } from "./WordExportReview";

/** How long a plain "Saved …" stays, unless the pointer or the focus is on it. */
const SAVED_SHOWN_MS = 10_000;

type SavedResult = Extract<ExportResult, { state: "saved" }>;

type SavedWithFile = readonly { testId: string; text: string }[];

const isPlainSaved = (result: SavedResult, t: ReturnType<typeof useT>): boolean =>
  result.unverified === 0 &&
  result.needsDetails.length === 0 &&
  result.kept.length === 0 &&
  result.failures.length === 0 &&
  unmarkedChecks(result.checks, t) === null;

/**
 * How the last export of this Mind went, floating at the foot of its tab (#100), as problems
 * do (DESIGN.md, Problems): "Exporting…", then "Saved “Tides.pdf” in Documents › IncarnaMind ·
 * Open · Show in Finder", with a second line when quotes weren't found ("1 quote not found,
 * marked unverified · Show"), or the problem and its one fix. A plain "Saved" goes by itself
 * after a while, and not back when the Mind is opened again after that; a problem stays until
 * it is dismissed, or the next export replaces it. Before a Word or PDF export the User hasn't
 * answered for, it holds the question instead, and Esc or ✕ leaves nothing exported.
 */
export function ExportResultLine({ mindId }: { mindId: string }) {
  const t = useT();
  const result = useExports((state) => (state.result?.mindId === mindId ? state.result : null));
  const dismiss = useExports((state) => state.dismiss);
  const line = useRef<HTMLDivElement>(null);
  const expired =
    result?.state === "saved" &&
    isPlainSaved(result, t) &&
    Date.now() - result.at >= SAVED_SHOWN_MS;
  const shown = result !== null && !expired;
  useEffect(() => {
    if (expired) dismiss();
    else if (shown && line.current) enter(line.current, { y: 8 });
  }, [expired, shown, dismiss]);
  if (!result || expired) return null;
  return (
    <div className="pointer-events-none absolute inset-x-6 bottom-6 z-10 flex justify-center">
      <div
        ref={line}
        data-testid="export-result"
        data-state={result.state}
        className="pointer-events-auto flex max-w-full min-w-0 items-start gap-2 rounded-lg bg-sheet py-2 pr-2 pl-3 font-sans shadow-popover"
      >
        <ResultBody result={result} line={line} />
      </div>
    </div>
  );
}

function ResultBody({
  result,
  line,
}: {
  result: ExportResult;
  line: RefObject<HTMLDivElement | null>;
}) {
  const t = useT();
  const dismiss = useExports((state) => state.dismiss);
  const [error, setError] = useState<string | null>(null);
  const held = useHeld(line);
  const unmarked = result.state === "saved" ? unmarkedChecks(result.checks, t) : null;
  const withFile =
    result.state === "saved"
      ? [
          { testId: "export-comments", text: commentedChecks(result.checks, t) },
          { testId: "export-tracked", text: trackedChanges(result.tracked, t) },
        ].flatMap(({ testId, text }) => (text ? [{ testId, text }] : []))
      : [];
  const plain = result.state === "saved" && isPlainSaved(result, t) && error === null;
  useDismissOnEscape(result.state !== "saving", dismiss);

  useEffect(() => {
    if (!plain || held) return;
    const timer = setTimeout(dismiss, SAVED_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [plain, held, dismiss]);

  const saving =
    result.format === COMPARISON_EXCEL
      ? t("export.excel.saving")
      : isCheckRecord(result.format)
        ? t("checkRecord.saving")
        : t("export.saving.line", { format: t(FORMAT_LABELS[result.format]) });
  const fix = (): ProblemAction | undefined => {
    if (result.state === "failed") {
      return {
        label: t("export.changeLocation"),
        testId: "export-change-location",
        onClick: () =>
          void exportAgain(result, async () => (await chooseOutputLocation()) !== null),
      };
    }
    if (result.state === "not-laid-out") {
      return {
        label: t("export.tryAgain"),
        testId: "export-try-again",
        onClick: () => void exportAgain(result, async () => true),
      };
    }
    if (result.state === "not-allowed") {
      const { linkedFolderId } = result;
      return {
        label: t("export.allow"),
        testId: "export-allow",
        onClick: () =>
          void exportAgain(result, async () => {
            await core.setLinkedFolderWriting(linkedFolderId, true);
            return true;
          }),
      };
    }
    return undefined;
  };

  const run = (act: () => Promise<void>, failed: "export.failed.open" | "export.failed.show") => {
    setError(null);
    act().catch((failure: unknown) =>
      setError(t(failed, { reason: reasonOf(errorMessage(failure, t), t) })),
    );
  };

  return (
    <>
      <div className="flex min-w-0 flex-col gap-0.5">
        {result.state === "saving" ? (
          <p
            role="status"
            data-testid="export-saving"
            className="flex items-center gap-2 py-1 text-[13px] leading-5 text-ink-meta"
          >
            <ExportLineIcon className="size-4 shrink-0" />
            {saving}
          </p>
        ) : result.state === "saved" ? (
          <>
            <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
              <SavedSentence result={result} withFile={withFile} />
              <span className="flex shrink-0 gap-1">
                <button
                  type="button"
                  data-testid="export-open"
                  onClick={() => run(() => files.openSavedFile(result.path), "export.failed.open")}
                  className="h-7 rounded-md bg-sheet px-3 text-[13px] leading-5 font-semibold text-ink shadow-[inset_0_0_0_1px_var(--color-rule-strong)] hover:bg-hover"
                >
                  {t("export.open")}
                </button>
                <button
                  type="button"
                  data-testid="export-show"
                  onClick={() => run(() => files.showSavedFile(result.path), "export.failed.show")}
                  className="h-7 rounded-md px-2.5 text-[13px] leading-5 font-semibold text-ink-secondary hover:bg-hover hover:text-ink"
                >
                  {t(showFileLabelKey(navigator.platform))}
                </button>
                {result.defaulted && (
                  <button
                    type="button"
                    data-testid="export-change-folder"
                    onClick={showOutputLocationSetting}
                    className="h-7 rounded-md px-2.5 text-[13px] leading-5 font-semibold text-ink-secondary hover:bg-hover hover:text-ink"
                  >
                    {t("export.changeFolder")}
                  </button>
                )}
              </span>
            </div>
            {result.unverified > 0 && (
              <ProblemLine
                role="status"
                testId="export-unverified"
                action={{
                  label: t("export.unverified.show"),
                  testId: "export-unverified-show",
                  onClick: () => revealUnverified(result.mindId),
                }}
              >
                {/* Not found is a Citation check: its icon, in its colour. */}
                <CheckStateIcon
                  check="not-found"
                  className="mr-2 inline size-4 align-[-3px] text-warning"
                />
                {result.unverified === 1
                  ? t("export.unverified.line.one")
                  : t("export.unverified.line.other", { count: result.unverified })}
              </ProblemLine>
            )}
            {result.needsDetails.length > 0 && (
              <NeedsDetailsLine mindId={result.mindId} documentIds={result.needsDetails} />
            )}
            {unmarked && (
              <ProblemLine
                role="status"
                testId="export-unmarked"
                action={
                  result.format === "docx"
                    ? {
                        label: t("export.options"),
                        testId: "export-unmarked-options",
                        onClick: () => useExportDialog.getState().open(result.mindId),
                      }
                    : {
                        label: t("export.unmarked.word"),
                        testId: "export-unmarked-word",
                        onClick: () => void exportMind(result.mindId, "docx"),
                      }
                }
              >
                <CheckStateIcon
                  check="unsupported"
                  className="mr-2 inline size-4 align-[-3px] text-warning"
                />
                {unmarked}
              </ProblemLine>
            )}
            {result.kept.length > 0 && (
              <ProblemLine role="status" testId="export-kept">
                {result.kept.length > 1
                  ? t("export.word.kept.both")
                  : t(
                      result.kept[0] === "header"
                        ? "export.word.kept.header"
                        : "export.word.kept.footer",
                    )}
              </ProblemLine>
            )}
            {result.failures.map(({ format, reason }) => (
              <ProblemLine key={format} role="status" testId={`export-failed-${format}`}>
                {t(`checkRecord.failed.${format}`, { reason: reasonOf(reason, t) })}
              </ProblemLine>
            ))}
            {error && <ProblemLine testId="export-problem">{error}</ProblemLine>}
          </>
        ) : result.state === "empty" ? (
          <ProblemLine testId="export-problem" className="py-1">
            {t("export.pack.empty")}
          </ProblemLine>
        ) : result.state === "review" ? (
          <WordExportReview result={result} />
        ) : result.state === "ask" ? (
          <ExportAsks result={result} />
        ) : result.state === "not-laid-out" ? (
          <ProblemLine testId="export-problem" action={fix()} className="py-1">
            {t("export.notLaidOut")}
          </ProblemLine>
        ) : (
          <ProblemLine testId="export-problem" action={fix()} className="py-1">
            {t("export.failed.save", {
              reason:
                result.state === "not-allowed"
                  ? t("export.failed.notAllowed", { folder: result.folder })
                  : reasonOf(result.message, t),
            })}
          </ProblemLine>
        )}
      </div>
      {result.state !== "saving" && (
        <button
          type="button"
          data-testid="export-dismiss"
          aria-label={t("export.dismiss")}
          title={t("export.dismiss")}
          onClick={dismiss}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-ink-meta hover:bg-hover hover:text-ink"
        >
          <CloseLineIcon className="size-3.5" />
        </button>
      )}
    </>
  );
}

const NAMED_BEFORE_MORE = 3;

/**
 * The Documents whose entries went into the file marked "[needs details]", by name, and Show,
 * which goes to the first in the Mind's References, where "Needs details" fills it in.
 */
function NeedsDetailsLine({ mindId, documentIds }: { mindId: string; documentIds: string[] }) {
  const t = useT();
  const language = useLanguage();
  const documents = useAppStore((state) => state.documents);
  const names = documentIds.flatMap((id) => {
    const document = documents.find((each) => each.id === id);
    return document ? [displayName(document)] : [];
  });
  if (names.length === 0) return null;
  const separator = language === "zh-CN" ? "、" : ", ";
  const said = saidInLine(t, (t, cut) =>
    names.length === 1
      ? t("export.needsDetails.line.one", { name: names[0] ?? "" })
      : t("export.needsDetails.line.other", {
          count: names.length,
          names: `${names
            .slice(0, NAMED_BEFORE_MORE)
            .map((name) => `“${cut(name)}”`)
            .join(separator)}${names.length > NAMED_BEFORE_MORE ? "…" : ""}`,
        }),
  );
  return (
    <ProblemLine
      role="status"
      testId="export-needs-details"
      title={said.fullMessage}
      action={{
        label: t("export.needsDetails.show"),
        testId: "export-needs-details-show",
        onClick: () => revealNeedsDetails(mindId),
      }}
    >
      <span
        aria-hidden="true"
        className="mr-2 inline-block size-1.5 rounded-full bg-attention align-[2px]"
      />
      {said.message}
    </ProblemLine>
  );
}

function SavedSentence({ result, withFile }: { result: SavedResult; withFile: SavedWithFile }) {
  const t = useT();
  const folder = result.inDefaultFolder ? defaultFolderLabel(t) : folderName(result.folder);
  const name = nameInLine(result.name);
  return (
    <p
      role="status"
      data-testid="export-done"
      title={result.path}
      aria-label={
        name === result.name
          ? undefined
          : t(result.withCsv ? "export.record.doneIn" : "export.doneIn", {
              name: result.name,
              folder,
            })
      }
      className={`flex min-w-0 items-start gap-2 text-[14px] leading-5 text-ink-secondary ${
        withFile.length > 0 ? "grow basis-75" : ""
      }`}
    >
      <CheckIcon />
      <SavedName name={name} withCsv={result.withCsv} folder={folder} withFile={withFile} />
    </p>
  );
}

/**
 * "Saved “Tides.pdf” in Documents › IncarnaMind", the file's name in the ink; then what went
 * into the file, each part after a "·" that a wrapped line leaves off its start:
 * "Saved “Tides.docx” in Exports · 2 Contradicted, as comments". The first part has no "·" and
 * the room for it instead, so none of its wrapped lines starts in the clipped margin.
 */
function SavedName({
  name,
  withCsv,
  folder,
  withFile,
}: {
  name: string;
  withCsv: boolean;
  folder: string;
  withFile: SavedWithFile;
}) {
  const t = useT();
  const said = t(withCsv ? "export.record.doneIn" : "export.doneIn", { name: "\u0000", folder });
  const [before = "", after = ""] = said.split("\u0000");
  const saved = (
    <span data-testid="export-saved" className="min-w-0 break-words">
      {before}
      <span className="font-semibold text-ink">{name}</span>
      {after}
    </span>
  );
  if (withFile.length === 0) return saved;
  return (
    <span className="block min-w-0 grow overflow-hidden">
      <span className="-ml-4 flex flex-wrap">
        <span className="block max-w-full pl-4">{saved}</span>
        {withFile.map(({ testId, text }) => (
          <FilePart key={testId} testId={testId}>
            {text}
          </FilePart>
        ))}
      </span>
    </span>
  );
}

function FilePart({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <span
      data-testid={testId}
      className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap"
    >
      <span aria-hidden="true" className="inline-block w-4 text-center text-ink-placeholder">
        ·
      </span>
      {children}
    </span>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="mt-0.5 size-4 shrink-0 text-ink"
    >
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}

/** Why a file couldn't be written or opened, in a few words: ours when we know, else the system's. */
function reasonOf(message: string, t: ReturnType<typeof useT>): string {
  const key = saveFailureReason(message);
  return key ? t(key) : message;
}
