import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { chosenParts } from "../../../shared/exportOptions";
import { nameInLine } from "../../../shared/naming";
import { core, files } from "../core";
import { CheckStateIcon } from "../editor/icons";
import { errorMessage } from "../errors";
import { useDismissOnEscape } from "../escapeDismiss";
import { commentedChecks, trackedChanges, unmarkedChecks } from "../exportChecks";
import { useExportDialog } from "../exportDialog";
import {
  COMPARISON_EXCEL,
  canChangeExport,
  cancelChange,
  changeExportChoices,
  type ExportResult,
  exportAgain,
  exportMind,
  FIGURE_SCHEDULE_EXCEL,
  FORMAT_LABELS,
  isCheckRecord,
  revealNeedsDetails,
  revealUnverified,
  useExports,
} from "../exports";
import { showFileLabelKey } from "../fileInfo";
import { useMindNoteStates } from "../home";
import { useLanguage, useT } from "../i18n";
import { folderName } from "../linkedFolders";
import { enter } from "../motion";
import { type NoteState, noteStateParts } from "../noteState";
import {
  chooseOutputLocation,
  defaultFolderLabel,
  showOutputLocationSetting,
} from "../outputFiles";
import { saveFailureReason } from "../problems";
import { useAppStore } from "../store";
import { useHeld } from "../useHeld";
import { ExportChange } from "./ExportChange";
import { CloseLineIcon, ExportLineIcon } from "./lineIcons";
import { type ProblemAction, ProblemLine } from "./ProblemLine";
import { WordExportReview } from "./WordExportReview";

/** How long a plain "Saved …" stays, unless the pointer or the focus is on it. */
const SAVED_SHOWN_MS = 10_000;

type SavedResult = Extract<ExportResult, { state: "saved" }>;

type SavedWithFile = readonly { testId: string; text: string }[];

const isPlainSaved = (result: SavedResult, t: ReturnType<typeof useT>): boolean =>
  result.changing === undefined &&
  result.unverified === 0 &&
  result.needsDetails.length === 0 &&
  result.kept.length === 0 &&
  result.failures.length === 0 &&
  result.sentKept &&
  unmarkedChecks(result.checks, t) === null;

/**
 * How the last export of this Mind went, floating at the foot of its tab (#100), as problems
 * do (DESIGN.md, Problems): "Exporting…", then "Saved “Tides.pdf” in Documents › IncarnaMind ·
 * Open · Show in Finder", with a second line when quotes weren't found ("1 quote not found,
 * marked unverified · Show"), or the problem and its one fix. A plain "Saved" goes by itself
 * after a while, and not back when the Mind is opened again after that; a problem stays until
 * it is dismissed, or the next export replaces it. The line also says what the file was written
 * with, and the note's standing, each part after a "·" (#1945); Change there opens the choices
 * that made it, and Esc or ✕ closes them without writing another file.
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
  const changing = result.state === "saved" && result.changing !== undefined;
  useDismissOnEscape(result.state !== "saving", changing ? cancelChange : dismiss);

  useEffect(() => {
    if (!plain || held) return;
    const timer = setTimeout(dismiss, SAVED_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [plain, held, dismiss]);

  const saving = isWorkbook(result.format)
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
            {result.changing && (
              <ExportChange
                mindId={result.mindId}
                format={result.changing.format}
                changing={result.changing}
              />
            )}
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
            {!result.sentKept && (
              <ProblemLine role="status" testId="export-sent-not-kept">
                {t("export.sentNotKept")}
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

/**
 * The Documents whose reference records lack authors or a date, as one count and the way to fill
 * them in: "2 Documents lack authors or dates · Add details", which opens the first one's
 * "Cite as" in the Mind's References, at its first gap.
 */
function NeedsDetailsLine({ mindId, documentIds }: { mindId: string; documentIds: string[] }) {
  const t = useT();
  if (documentIds.length === 0) return null;
  return (
    <ProblemLine
      role="status"
      testId="export-needs-details"
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
      {documentIds.length === 1
        ? t("export.needsDetails.line.one")
        : t("export.needsDetails.line.other", { count: documentIds.length })}
    </ProblemLine>
  );
}

/** Where the note's checks stand (#1915), read as the corner badge reads it; null for a line that isn't the note's own export, or until its Mind is known. */
/** A workbook the app writes from a note, the comparison or the figure schedule: not the note's own file. */
const isWorkbook = (
  format: SavedResult["format"],
): format is typeof COMPARISON_EXCEL | typeof FIGURE_SCHEDULE_EXCEL =>
  format === COMPARISON_EXCEL || format === FIGURE_SCHEDULE_EXCEL;

function useExportNoteState(mindId: string | null): NoteState | null {
  const mind = useAppStore((state) =>
    mindId === null ? null : (state.minds.find((each) => each.id === mindId) ?? null),
  );
  const states = useMindNoteStates(mind ? [mind] : []);
  return mind ? (states.get(mind.id)?.state ?? null) : null;
}

/**
 * What the file was written with (#1945), and how far the note's checks reach (#1915): the parts
 * after its name in the Saved line, in that order, then Change when either choice can still be
 * made. Everything after the name is one part after another, each after a "·".
 */
function SavedSentence({ result, withFile }: { result: SavedResult; withFile: SavedWithFile }) {
  const t = useT();
  const language = useLanguage();
  const folder = result.inDefaultFolder ? defaultFolderLabel(t) : folderName(result.folder);
  const name = nameInLine(result.name);
  // The check record and the workbooks aren't the note's file: their lines say what they are, not how the note stands.
  const noteExport = !isCheckRecord(result.format) && !isWorkbook(result.format);
  const state = useExportNoteState(noteExport ? result.mindId : null);
  const chosen = chosenParts(t, {
    places:
      result.citationPlace === null
        ? null
        : { citations: result.citations, place: result.citationPlace },
    markAiText: result.markAiText,
  });
  const unchecked =
    state === null || (state.kind === "checked" && state.unread === 0)
      ? []
      : noteStateParts(state, t, language);
  const parts: SavedWithFile = [
    ...chosen.map((text) => ({ testId: "export-chosen", text })),
    ...withFile,
    ...unchecked.map((text) => ({ testId: "export-unchecked", text })),
  ];
  // Only Word and PDF have a choice to change: a Word file always has the marking, a Numbered PDF
  // the place of its Citations. Markdown, HTML, a share page and a source pack have neither.
  const canChange =
    canChangeExport(result.format) &&
    (result.markAiText !== null || result.citationPlace !== null || result.numbered);
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
        parts.length > 0 ? "grow basis-75" : ""
      }`}
    >
      <CheckIcon />
      <SavedName name={name} withCsv={result.withCsv} folder={folder} withFile={parts}>
        {canChange && result.changing === undefined && <ChangePart mindId={result.mindId} />}
      </SavedName>
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
  children,
}: {
  name: string;
  withCsv: boolean;
  folder: string;
  withFile: SavedWithFile;
  children?: ReactNode;
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
  if (withFile.length === 0 && !children) return saved;
  return (
    <span className="block min-w-0 grow overflow-hidden">
      <span className="-ml-4 flex flex-wrap">
        <span className="block max-w-full pl-4">{saved}</span>
        {withFile.map(({ testId, text }) => (
          <FilePart key={`${testId}:${text}`} testId={testId}>
            {text}
          </FilePart>
        ))}
        {children && <FilePart>{children}</FilePart>}
      </span>
    </span>
  );
}

/** Change, after what the file was written with: opens the choices that made it, to export again (#1945). */
function ChangePart({ mindId }: { mindId: string }) {
  const t = useT();
  return (
    <button
      type="button"
      data-testid="export-change"
      onClick={() => changeExportChoices(mindId)}
      className="font-semibold text-ink-secondary hover:text-ink hover:underline"
    >
      {t("export.saved.change")}
    </button>
  );
}

function FilePart({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">
      <span aria-hidden="true" className="inline-block w-4 text-center text-ink-placeholder">
        ·
      </span>
      <span data-testid={testId}>{children}</span>
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
