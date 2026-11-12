import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import type {
  ExportFormat,
  ExportPreferences,
  Mind,
  MindCitationStyle,
  OutputSettings,
  TheirChangesShown,
  WordExportPreferences,
} from "../../../core/api";
import {
  type ExportMarks,
  MAX_WATERMARK_WORDS,
  settledMarks,
  WATERMARK_CHOICES,
  type WatermarkChoice,
} from "../../../shared/exportMarks";
import { hasCitationPlace, hasQuestionsOption } from "../../../shared/exportOptions";
import type { MessageKey } from "../../../shared/i18n";
import { useCitationStylePicker, useStyleLabel } from "../citationStylePicker";
import { shortcutLabel } from "../commands/keymap";
import { core } from "../core";
import { errorMessage } from "../errors";
import { commentsHint } from "../exportChecks";
import { EXPORT_OPTIONS_FORMATS, exportPreferences, FORMAT_LABELS } from "../exports";
import { useT } from "../i18n";
import { chooseOutputLocation, outputFolderLabel } from "../outputFiles";
import { useAppStore } from "../store";
import { CitationPlaceRow } from "./CitationPlace";
import { ChevronDownLineIcon, CloseLineIcon } from "./lineIcons";
import { MarkAiTextRow } from "./MarkAiText";
import { ProblemLine } from "./ProblemLine";
import { SwitchRow } from "./SwitchRow";
import {
  buttonClass,
  dialogActionsClass,
  dialogTitleClass,
  hintClass,
  primaryButtonClass,
  ruledListClass,
  tabSheetClass,
} from "./ui";
import { useModal } from "./useModal";

/** What each format does with Citations and Questions, under the format. */
const FORMAT_NOTES: Readonly<Record<ExportFormat, MessageKey>> = {
  docx: "export.options.docx",
  pdf: "export.options.pdf",
  "source-pack": "export.options.source-pack",
  html: "export.options.html",
  "share-page": "export.options.share-page",
  markdown: "export.options.markdown",
};

/** A ruled row of the sheet: its words on the left, its control on the right. */
const rowClass = "flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2";

/** The hint of the tracked-changes switch, with the name a link to where it is changed. */
function TrackedAsHint({ name }: { name: string }) {
  const t = useT();
  const openSettings = useAppStore((state) => state.openSettings);
  // The name sits in the sentence wherever the language puts it, so the sentence is cut at it.
  const mark = "\u0000";
  const [before = "", after = ""] = t("export.trackChanges.hint", { name: mark }).split(mark);
  return (
    <>
      {before}
      <button
        type="button"
        data-testid="export-author-name"
        onClick={() => openSettings("general", "author-name")}
        className="underline"
      >
        {name}
      </button>
      {after}
    </>
  );
}

/**
 * A Word file's review choices (#107): the User's edits as tracked changes,
 * for a Mind imported from a Word file, and IncarnaMind's comments on AI
 * text and on Citations whose check failed.
 */
function WordReviewRows({
  draft,
  fromWord,
  othersFile,
  myComments,
  myCommentsOptional,
  includeMine,
  onChange,
  onOthersChange,
  onIncludeMine,
}: {
  draft: WordExportPreferences;
  fromWord: boolean;
  /** A Note made by Verify from someone else's file: this Note's own comment switch (#110); null for the User's own. */
  othersFile: { checked: boolean } | null;
  /** The User's own comments and replies in the Note (#328). */
  myComments: number;
  /** The file came from someone else: its export offers "Include my comments" (#328). */
  myCommentsOptional: boolean;
  /** This Note's own choice, if it was made here: another Note's choice doesn't show. */
  includeMine: boolean;
  onChange(next: WordExportPreferences): void;
  onOthersChange(checked: boolean): void;
  onIncludeMine(checked: boolean): void;
}) {
  const t = useT();
  const author = useAppStore((state) => state.settings?.author ?? "");
  return (
    <>
      {fromWord && (
        <SwitchRow
          label={t("export.trackChanges")}
          hint={<TrackedAsHint name={author} />}
          checked={draft.trackChanges}
          onChange={(trackChanges) => onChange({ ...draft, trackChanges })}
          testId="export-track-changes"
        />
      )}
      <MarkAiTextRow
        value={draft.markAiText}
        onChange={(markAiText) => onChange({ ...draft, markAiText })}
      />
      {othersFile ? (
        <SwitchRow
          label={t("export.commentFailedChecks")}
          hint={t(commentsHint(othersFile.checked))}
          checked={othersFile.checked}
          onChange={onOthersChange}
          testId="export-comment-failed-checks"
        />
      ) : (
        <SwitchRow
          label={t("export.commentFailedChecks")}
          hint={t(commentsHint(null))}
          checked={draft.commentFailedChecks}
          onChange={(commentFailedChecks) => onChange({ ...draft, commentFailedChecks })}
          testId="export-comment-failed-checks"
        />
      )}
      {myCommentsOptional && myComments > 0 && (
        <SwitchRow
          label={t("export.includeMyComments")}
          checked={includeMine}
          onChange={onIncludeMine}
          testId="export-include-my-comments"
        />
      )}
    </>
  );
}

/**
 * How a PDF, an HTML file or Markdown shows someone's changes from a Word file
 * still waiting (#734): marked as changes, as Word prints them, or as if each
 * were accepted. Only for a Mind that has some.
 */
function TheirChangesRow({
  count,
  value,
  onChange,
}: {
  count: number;
  value: TheirChangesShown;
  onChange(next: TheirChangesShown): void;
}) {
  const t = useT();
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <label htmlFor={id} className="text-ui text-ink">
          {t("export.theirChanges")}
        </label>
        <span id={`${id}-hint`} className={hintClass}>
          {count === 1
            ? t("export.theirChanges.hint.one")
            : t("export.theirChanges.hint.other", { count })}
        </span>
      </div>
      <span className="relative flex shrink-0">
        <select
          id={id}
          data-testid="export-their-changes"
          value={value}
          aria-describedby={`${id}-hint`}
          onChange={(event) => {
            const chosen = event.target.value;
            if (chosen === "shown" || chosen === "accepted") onChange(chosen);
          }}
          className="h-8 w-44 appearance-none rounded-sm border border-rule-strong bg-sheet pr-8 pl-2.5 text-ui text-ink focus:border-accent"
        >
          <option value="shown">{t("export.theirChanges.shown")}</option>
          <option value="accepted">{t("export.theirChanges.accepted")}</option>
        </select>
        <ChevronDownLineIcon className="pointer-events-none absolute top-2.5 right-2.5 size-3.5 text-ink-meta" />
      </span>
    </div>
  );
}

const WATERMARK_LABELS: Readonly<Record<WatermarkChoice, MessageKey>> = {
  none: "export.watermark.none",
  draft: "export.watermark.draft",
  confidential: "export.watermark.confidential",
  words: "export.watermark.words",
};

/**
 * What the pages of a Word file or a PDF carry (#1258): page numbers, and a watermark of its own,
 * a preset word or the User's. A Note made from a Word file says that its file's own numbers
 * stay, so the switch off isn't read as no numbers (#1741).
 */
function MarksRows({
  marks,
  fromWord,
  onChange,
}: {
  marks: ExportMarks;
  fromWord: boolean;
  onChange(next: ExportMarks): void;
}) {
  const t = useT();
  const id = useId();
  const words = useRef<HTMLInputElement>(null);
  const before = useRef(marks.watermark);
  // Choosing the User's own word puts the cursor in it; a Note that already had one keeps focus elsewhere.
  useEffect(() => {
    if (marks.watermark === "words" && before.current !== "words") words.current?.focus();
    before.current = marks.watermark;
  }, [marks.watermark]);
  return (
    <>
      <SwitchRow
        label={t("export.pageNumbers")}
        hint={t(fromWord ? "export.pageNumbers.wordHint" : "export.pageNumbers.hint")}
        checked={marks.pageNumbers}
        onChange={(pageNumbers) => onChange({ ...marks, pageNumbers })}
        testId="export-page-numbers"
      />
      <div className="flex flex-col py-2">
        <div className={rowClass}>
          <label htmlFor={id} className="text-ui text-ink">
            {t("export.watermark")}
          </label>
          <span className="relative flex shrink-0">
            <select
              id={id}
              data-testid="export-watermark"
              value={marks.watermark}
              aria-describedby={`${id}-hint`}
              onChange={(event) => {
                const chosen = WATERMARK_CHOICES.find((each) => each === event.target.value);
                if (chosen) onChange({ ...marks, watermark: chosen });
              }}
              className="h-8 w-52 max-w-full appearance-none rounded-sm border border-rule-strong bg-sheet pr-8 pl-2.5 text-ui text-ink focus:border-accent"
            >
              {WATERMARK_CHOICES.map((each) => (
                <option key={each} value={each}>
                  {t(WATERMARK_LABELS[each])}
                </option>
              ))}
            </select>
            <ChevronDownLineIcon className="pointer-events-none absolute top-2.5 right-2.5 size-3.5 text-ink-meta" />
          </span>
        </div>
        <span id={`${id}-hint`} className={hintClass}>
          {t("export.watermark.hint")}
        </span>
        {marks.watermark === "words" && (
          <input
            ref={words}
            type="text"
            data-testid="export-watermark-words"
            aria-label={t("export.watermark.wordsLabel")}
            placeholder={t("export.watermark.wordsLabel")}
            value={marks.words ?? ""}
            maxLength={MAX_WATERMARK_WORDS}
            onChange={(event) => onChange({ ...marks, words: event.target.value })}
            className="mt-2 h-8 w-full rounded-sm border border-rule-strong bg-sheet px-2.5 text-ui text-ink focus:border-accent"
          />
        )}
      </div>
    </>
  );
}

/** The Mind's citation style, read again once the picker closes, since the User may have chosen another. */
function useMindCitationStyle(mindId: string): MindCitationStyle | null {
  const [style, setStyle] = useState<MindCitationStyle | null>(null);
  const picking = useCitationStylePicker((state) => state.open?.mindId === mindId);
  useEffect(() => {
    if (picking) return;
    let current = true;
    core.getMindCitationStyle(mindId).then(
      (found) => {
        if (current) setStyle(found);
      },
      (error: unknown) => useAppStore.getState().reportError(error),
    );
    return () => {
      current = false;
    };
  }, [mindId, picking]);
  return style;
}

/**
 * The Mind's citation style (#289), which its export is written in, with the button that
 * changes it: the same picker as the References block's. It changes at once, not on Save.
 * A Mind that hasn't chosen and isn't Numbered follows the Chinese default (GB/T 7714), which the
 * row says.
 */
function CitationStyleRow({ mindId }: { mindId: string }) {
  const t = useT();
  const style = useMindCitationStyle(mindId);
  const byDefault = style !== null && !style.chosen && style.style !== "numbered";
  const label = useStyleLabel(style?.style);
  return (
    <div className={rowClass}>
      <div className="flex min-w-0 flex-col">
        <span id="export-citation-style" className="text-ui text-ink">
          {t("export.citationStyle")}
        </span>
        {byDefault && (
          <span
            data-testid="export-citation-style-default"
            className="text-[13px] leading-5 text-ink-meta"
          >
            {t("export.citationStyle.default")}
          </span>
        )}
      </div>
      <button
        type="button"
        data-testid="export-citation-style"
        aria-labelledby="export-citation-style export-citation-style-value"
        aria-haspopup="dialog"
        onClick={(event) => useCitationStylePicker.getState().show(mindId, event.currentTarget)}
        className={`${buttonClass} min-w-0 gap-1`}
      >
        <span id="export-citation-style-value" className="truncate">
          {label ?? "…"}
        </span>
        <ChevronDownLineIcon className="size-3.5 shrink-0 text-ink-meta" />
      </button>
    </div>
  );
}

/** Where exports go: the Output location, Documents › IncarnaMind until the User picks another, and how to change it. */
function SaveToRow() {
  const t = useT();
  const [output, setOutput] = useState<OutputSettings | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    core.getOutputSettings().then(
      (found) => {
        if (current) setOutput(found);
      },
      (error: unknown) => useAppStore.getState().reportError(error),
    );
    return () => {
      current = false;
    };
  }, []);
  const change = async () => {
    setProblem(null);
    try {
      const next = await chooseOutputLocation();
      if (next) setOutput(next);
    } catch (failure) {
      setProblem(errorMessage(failure, t));
    }
  };
  const location = output ? (output.location ?? output.suggested) : null;
  return (
    <div className="flex flex-col gap-1 py-2">
      <div className={rowClass}>
        <div className="flex min-w-0 flex-col">
          <span className="text-ui text-ink">{t("export.saveTo")}</span>
          <span
            data-testid="export-save-to"
            title={location ?? undefined}
            className="truncate text-[13px] leading-5 text-ink-meta"
          >
            {output === null || location === null
              ? "…"
              : outputFolderLabel(location, output.suggested, t)}
          </span>
        </div>
        <button
          type="button"
          data-testid="export-save-to-change"
          onClick={() => void change()}
          className={buttonClass}
        >
          {t("outputLocation.change")}
        </button>
      </div>
      {problem && (
        <ProblemLine testId="export-save-to-problem">
          {t("outputLocation.failed", { reason: problem })}
        </ProblemLine>
      )}
    </div>
  );
}

/**
 * The Export options sheet (#100): the format Export and ⇧⌘E use, each format's own options,
 * the Mind's citation style and where exports go. It remembers what was last saved; Cancel,
 * Esc and ✕ leave the options as they were. Open while `mind` is set.
 */
export function ExportDialog({ mind, onClose }: { mind: Mind | null; onClose(): void }) {
  const dialog = useModal(mind !== null);
  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      data-testid="export-dialog"
      aria-labelledby="export-title"
      className={tabSheetClass}
    >
      {/* Mounted only while open, so each opening starts from the options last saved. */}
      {mind && <ExportOptionsForm mind={mind} onDone={onClose} />}
    </dialog>
  );
}

function ExportOptionsForm({ mind, onDone }: { mind: Mind; onDone(): void }) {
  const t = useT();
  const formatId = useId();
  const questionsId = useId();
  const hintId = useId();
  const hint = t("export.options.saveHint", { shortcut: shortcutLabel("mind.export") });
  const [draft, setDraft] = useState<ExportPreferences>(exportPreferences);
  const [counts, setCounts] = useState<{
    questions: number;
    packCitations: number;
    fromWord: boolean;
    othersFile: boolean;
    othersComments: boolean;
    myComments: number;
    myCommentsOptional: boolean;
    theirChanges: number;
    hiddenColumns: number;
  } | null>(null);
  /** This Note's own comment choice, for someone else's file (#110); null until changed here. */
  const [othersComments, setOthersComments] = useState<boolean | null>(null);
  /** This Note's page numbers and watermark (#1258); null until the core has said. */
  const [marks, setMarks] = useState<ExportMarks | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { format } = draft;
  const citationStyle = useMindCitationStyle(mind.id);

  // How many Questions the Mind has, which a deliverable leaves out unless asked: said under its
  // switch; and how many Citations a source pack would hold, since with none it says so.
  useEffect(() => {
    let current = true;
    core.previewMindExport(mind.id, { format: "source-pack" }).then(
      (preview) => {
        if (!current) return;
        setCounts({
          questions: preview.questions,
          packCitations: preview.citations,
          fromWord: preview.fromWord,
          othersFile: preview.othersFile,
          othersComments: preview.othersComments,
          myComments: preview.myComments,
          myCommentsOptional: preview.myCommentsOptional,
          theirChanges: preview.theirChanges,
          hiddenColumns: preview.hiddenColumns,
        });
      },
      (error: unknown) => useAppStore.getState().reportError(error),
    );
    return () => {
      current = false;
    };
  }, [mind.id]);

  useEffect(() => {
    let current = true;
    core.getExportMarks(mind.id).then(
      (found) => {
        if (current) setMarks(found);
      },
      (error: unknown) => useAppStore.getState().reportError(error),
    );
    return () => {
      current = false;
    };
  }, [mind.id]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setProblem(null);
    try {
      const settings = await core.updateSettings({ user: { exportOptions: draft } });
      useAppStore.setState({ settings });
      if (marks) await core.setExportMarks(mind.id, settledMarks(marks));
      if (othersComments !== null && othersComments !== counts?.othersComments) {
        await core.setCheckComments(mind.id, othersComments);
      }
      onDone();
    } catch (failure) {
      setProblem(errorMessage(failure, t));
    } finally {
      setSaving(false);
    }
  };

  const leftOut =
    hasQuestionsOption(format) && !draft[format].includeQuestions ? (counts?.questions ?? 0) : 0;
  const emptyPack = format === "source-pack" && counts?.packCitations === 0;
  const wordsMissing = marks?.watermark === "words" && (marks.words ?? "").trim() === "";

  return (
    <form onSubmit={(event) => void save(event)} className="flex min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 pt-4 pr-4 pb-2.5 pl-6">
        <h2 id="export-title" className={dialogTitleClass}>
          {t("export.options.title")}
        </h2>
        <button
          type="button"
          data-testid="export-options-close"
          aria-label={t("export.options.close")}
          title={t("export.options.close")}
          onClick={onDone}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-hover hover:text-ink"
        >
          <CloseLineIcon className="size-4" />
        </button>
      </header>

      <div
        data-testid="export-options-body"
        className={`mx-6 min-h-0 overflow-y-auto ${ruledListClass}`}
      >
        <div className={rowClass}>
          <label htmlFor={formatId} className="text-ui text-ink">
            {t("export.format")}
          </label>
          <span className="relative flex shrink-0">
            <select
              id={formatId}
              data-testid="export-format"
              value={format}
              onChange={(event) =>
                setDraft({ ...draft, format: event.target.value as ExportFormat })
              }
              className="h-8 w-52 max-w-full appearance-none rounded-sm border border-rule-strong bg-sheet pr-8 pl-2.5 text-ui text-ink focus:border-accent"
            >
              {EXPORT_OPTIONS_FORMATS.map((each) => (
                <option key={each} value={each}>
                  {t(FORMAT_LABELS[each])}
                </option>
              ))}
            </select>
            <ChevronDownLineIcon className="pointer-events-none absolute top-2.5 right-2.5 size-3.5 text-ink-meta" />
          </span>
        </div>

        <div className="flex flex-col py-3 text-[13px] leading-5 text-ink-meta">
          <p data-testid="export-format-note">{t(FORMAT_NOTES[format])}</p>
          {format === "docx" && (
            <p data-testid="export-pending-note">{t("export.options.docx.pending")}</p>
          )}
        </div>
        {emptyPack && (
          <p data-testid="export-pack-empty" className={`-mt-1 pb-2 ${hintClass}`}>
            {t("export.pack.empty")}
          </p>
        )}
        {(counts?.hiddenColumns ?? 0) > 0 && (
          <p data-testid="export-hidden-columns" className={`-mt-1 pb-2 ${hintClass}`}>
            {(counts?.hiddenColumns ?? 0) === 1
              ? t("export.hiddenColumns.one")
              : t("export.hiddenColumns.other", { count: counts?.hiddenColumns ?? 0 })}
          </p>
        )}

        {hasQuestionsOption(format) && (
          <div>
            <div className={rowClass}>
              <label htmlFor={questionsId} className="text-ui text-ink">
                {t("export.includeQuestions")}
              </label>
              <input
                id={questionsId}
                type="checkbox"
                role="switch"
                data-testid="export-include-questions"
                checked={draft[format].includeQuestions}
                aria-checked={draft[format].includeQuestions}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    [format]: { ...draft[format], includeQuestions: event.target.checked },
                  })
                }
                className="switch"
              />
            </div>
            {leftOut > 0 && (
              <p className={`-mt-2 pb-2 ${hintClass}`}>
                {leftOut === 1
                  ? t("export.questionsLeftOut.one")
                  : t("export.questionsLeftOut.other", { count: leftOut })}
              </p>
            )}
          </div>
        )}

        {(format === "pdf" || format === "html" || format === "markdown") &&
          (counts?.theirChanges ?? 0) > 0 && (
            <TheirChangesRow
              count={counts?.theirChanges ?? 0}
              value={draft.theirChanges ?? "shown"}
              onChange={(theirChanges) => setDraft({ ...draft, theirChanges })}
            />
          )}

        {format === "docx" && (
          <WordReviewRows
            draft={draft.docx}
            fromWord={counts?.fromWord ?? false}
            othersFile={
              counts?.othersFile ? { checked: othersComments ?? counts.othersComments } : null
            }
            myComments={counts?.myComments ?? 0}
            myCommentsOptional={counts?.myCommentsOptional ?? false}
            includeMine={
              draft.docx.myCommentsFile === mind.id && (draft.docx.includeMyComments ?? false)
            }
            onChange={(docx) => setDraft({ ...draft, docx })}
            onOthersChange={setOthersComments}
            onIncludeMine={(includeMyComments) =>
              setDraft({
                ...draft,
                docx: { ...draft.docx, includeMyComments, myCommentsFile: mind.id },
              })
            }
          />
        )}

        {marks && counts && (format === "docx" || format === "pdf") && (
          <MarksRows marks={marks} fromWord={counts.fromWord} onChange={setMarks} />
        )}

        {hasCitationPlace(format) && citationStyle && (
          <CitationPlaceRow
            value={draft.citationPlace}
            byStyle={citationStyle.style !== "numbered"}
            onChange={(citationPlace) => setDraft({ ...draft, citationPlace })}
          />
        )}

        <CitationStyleRow mindId={mind.id} />
        <SaveToRow />
      </div>

      {problem && (
        <ProblemLine testId="export-problem" className="mx-6 mt-3 shrink-0">
          {t("export.failed.options", { reason: problem })}
        </ProblemLine>
      )}

      <div className={`${dialogActionsClass} shrink-0 px-6 pt-5 pb-6`}>
        <button type="button" onClick={onDone} className={buttonClass}>
          {t("export.cancel")}
        </button>
        <button
          type="submit"
          data-testid="export-save"
          disabled={saving || wordsMissing}
          aria-describedby={hintId}
          title={hint}
          className={primaryButtonClass}
        >
          {t("export.options.save")}
        </button>
      </div>
      <span id={hintId} className="sr-only">
        {hint}
      </span>
    </form>
  );
}
