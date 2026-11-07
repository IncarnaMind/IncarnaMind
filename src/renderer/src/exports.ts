import { create } from "zustand";
import {
  type CheckRecordFormat,
  type CitationPlace,
  EXPORT_FORMATS,
  type ExportFormat,
  type ExportMindOptions,
  type ExportPreferences,
  type MarkAiTextChoice,
  type SavedCheckRecord,
  type SavedComparisonExport,
  type SavedExport,
  type SavedMindExport,
  type SentenceChecksExported,
  type WordExportReport,
} from "../../core/api";
import {
  type CitedCount,
  DEFAULT_CITATION_PLACE,
  optionsFor,
  withCitationPlace,
  withMarking,
} from "../../shared/exportOptions";
import type { MessageKey } from "../../shared/i18n";
import { core, files } from "./core";
import { describeError, errorMessage } from "./errors";
import { rewrittenLine } from "./exportChecks";
import { ownMindsOf } from "./home";
import { translateNow } from "./i18n";
import { folderName } from "./linkedFolders";
import { useAppStore } from "./store";
import { UndoRefused, useUndo } from "./undo";

/** Each format's name, as the options sheet, the menus and ⌘K say it. */
export const FORMAT_LABELS: Readonly<Record<ExportFormat, MessageKey>> = {
  docx: "export.format.docx",
  pdf: "export.format.pdf",
  "source-pack": "export.format.source-pack",
  html: "export.format.html",
  "share-page": "export.format.share-page",
  markdown: "export.format.markdown",
};

/** Until settings load, as the core's defaults have it. */
const DEFAULT_PREFERENCES: ExportPreferences = {
  format: "docx",
  docx: {
    includeQuestions: false,
    trackChanges: true,
    markAiText: null,
    commentFailedChecks: true,
  },
  pdf: { includeQuestions: false },
  html: { includeQuestions: false },
  "share-page": { includeQuestions: false, citationCards: true, checkedLine: false },
};

/** The formats Export options offers and Export writes: the web page has its own Share sheet (#1258). */
export const EXPORT_OPTIONS_FORMATS = EXPORT_FORMATS.filter((format) => format !== "share-page");

/** The format Export remembers: a web page saved before the Share sheet opens as HTML (#1258). */
export const exportFormatNow = (format: ExportFormat): ExportFormat =>
  format === "share-page" ? "html" : format;

export const exportPreferences = (): ExportPreferences => {
  const saved = useAppStore.getState().settings?.user.exportOptions ?? DEFAULT_PREFERENCES;
  const format = exportFormatNow(saved.format);
  return format === saved.format ? saved : { ...saved, format };
};

export const COMPARISON_EXCEL = "comparison-xlsx";
export const COMPARISON_CSV = "comparison-csv";
export const FIGURE_SCHEDULE_EXCEL = "figure-schedule-xlsx";

export type ExportKind =
  | ExportFormat
  | "check-record"
  | typeof COMPARISON_EXCEL
  | typeof COMPARISON_CSV
  | typeof FIGURE_SCHEDULE_EXCEL;

export const isCheckRecord = (kind: ExportKind): kind is "check-record" => kind === "check-record";

/** The choices that made a Word or PDF file, open under its Saved line: the marking, and where Citations go (#1945). */
export interface ExportChanging {
  format: "docx" | "pdf";
  mark: boolean;
  places: CitedCount | null;
  /** Someone else's Word file: whether it gets check comments (#110). */
  comments: boolean;
}

/**
 * How the last export went, said in the Mind it exported (`ExportResultLine`); `tableId` names
 * the comparison table a workbook was made from.
 */
export type ExportResult = { tableId?: string } & (
  | { mindId: string; state: "saving"; format: ExportKind }
  | {
      mindId: string;
      state: "saved";
      format: ExportKind;
      path: string;
      name: string;
      /** The check record's CSV, saved beside the PDF named. */
      withCsv: boolean;
      /** The check record's files that couldn't be saved, each with why: the other was kept. */
      failures: { format: CheckRecordFormat; reason: string }[];
      /** The folder it is in, which the line names. */
      folder: string;
      inDefaultFolder: boolean;
      /** When it was saved, in ms, so a line the User left behind doesn't come back long after. */
      at: number;
      unverified: number;
      /** The comparison-table columns the file leaves out, for the line to say. */
      hiddenColumns: number;
      /** Made by Verify from someone else's file: its comments have their own choice (#110). */
      othersFile: boolean;
      /** Written again beside this file, which the User had changed (#110); null otherwise. */
      changedFile: string | null;
      /** The sentences whose check isn’t good, whether they went in as comments, and the check comments in the file. */
      checks: SentenceChecksExported;
      /** The changes waiting that went into a Word file as tracked changes. */
      tracked: number;
      /** The header and footer kept in a Word file though deleted from the Mind (#105). */
      kept: ("header" | "footer")[];
      /** The Documents whose entries are too thin to cite, marked so in the file. */
      needsDetails: string[];
      /** Whether History kept the Note as it was sent (#1933): false says it couldn't. */
      sentKept: boolean;
      /** The first save, which took Documents › IncarnaMind: the line says where. */
      defaulted: boolean;
      /** The Citations in the file, and the Documents they cite. */
      citations: number;
      citedDocuments: number;
      /** The footnotes in the file, the User's own included, as its writer counted them (#2193). */
      footnotes: number;
      /** Whether the note's style is Numbered, the one whose Citations the User places. */
      numbered: boolean;
      /** Where the file puts its Citations; null when nothing placed them (#1945). */
      citationPlace: CitationPlace | null;
      /** Whether a Word file marks the text IncarnaMind wrote; null for a format that can't (#1945). */
      markAiText: boolean | null;
      /** The User's own comments and replies in the Note (#328), and whether the file holds them. */
      myComments: number;
      myCommentsShown: boolean;
      /** Open: the choices that made this file, to change and export again (#1945). */
      changing?: ExportChanging;
    }
  /** Not saved yet: what a Word file can't keep, for the User to see first (#105). */
  | { mindId: string; state: "review"; format: ExportFormat; word: WordExportReport }
  | { mindId: string; state: "failed"; format: ExportKind; message: string }
  /** A PDF that couldn't be laid out: nothing was saved, and the Output location is fine. */
  | { mindId: string; state: "not-laid-out"; format: ExportKind }
  /** A source pack of a Mind with no Citations: nothing to make, and nothing went wrong. */
  | { mindId: string; state: "empty"; format: ExportFormat }
  | {
      mindId: string;
      state: "not-allowed";
      format: ExportKind;
      linkedFolderId: string;
      folder: string;
    }
);

export const useExports = create<{
  result: ExportResult | null;
  dismiss(): void;
}>()((set) => ({
  result: null,
  dismiss: () => set({ result: null }),
}));

// Null while the same Mind is still exporting, so a held ⇧⌘E makes one file; a newer export or a
// dismissal wins over a late answer.
function begin(
  mindId: string,
  kind: ExportKind,
  tableId?: string,
): ((next: ExportResult | null) => void) | null {
  const { result } = useExports.getState();
  if (result?.mindId === mindId && result.state === "saving") return null;
  useExports.setState({
    result: { mindId, state: "saving", format: kind, ...(tableId && { tableId }) },
  });
  return (next) => {
    const current = useExports.getState().result;
    if (current?.mindId === mindId && current.state === "saving") {
      useExports.setState({ result: next });
    }
  };
}

async function keep(update: (preferences: ExportPreferences) => ExportPreferences) {
  await useAppStore.getState().updateSettings({
    user: { exportOptions: update(exportPreferences()) },
  });
}

/**
 * Says a choice the Saved line's Change made, in the undo line: Word files mark the text
 * IncarnaMind wrote, or leave it unmarked; Citations go in footnotes, or in a list at the end.
 * Undo puts that one choice back and Redo makes it again, each against the choices as they are
 * then, so neither takes back a format or an option the User changed since (#1945).
 */
function changed(
  which: "mark" | "leave" | "footnotes" | "list",
  undo: () => Promise<void>,
  redo: () => Promise<void>,
): void {
  useUndo.getState().push({ said: (t) => t(`export.changed.${which}`), undo, redo });
}

/**
 * Change, in the Saved line: the choices that made this file open again, under it (#1945). It
 * opens them from what the file itself says, with no work done until one is picked.
 */
/** Whether Change has a choice to open for `format`: only Word and PDF place Citations and mark AI text. */
export const canChangeExport = (format: ExportKind): format is "docx" | "pdf" =>
  format === "docx" || format === "pdf";

export function changeExportChoices(mindId: string): void {
  const { result } = useExports.getState();
  if (result?.mindId !== mindId || result.state !== "saved") return;
  const { format } = result;
  if (!canChangeExport(format)) return;
  // The line is where the User sees the choice: a Word file always has the marking, and a
  // Numbered PDF the place of its Citations, whether or not this file placed any.
  const mark = format === "docx";
  const places =
    result.citationPlace !== null || (format === "pdf" && result.numbered)
      ? { citations: result.citations, documents: result.citedDocuments }
      : null;
  if (!mark && places === null) return;
  const comments = format === "docx" && result.othersFile;
  useExports.setState({ result: { ...result, changing: { format, mark, places, comments } } });
}

/** Closes Change without a choice: the Saved line as it was. */
export function cancelChange(): void {
  const { result } = useExports.getState();
  if (result?.state === "saved")
    useExports.setState({ result: { ...result, changing: undefined } });
}

/** Whether Word marks the text IncarnaMind wrote, as the choices have it when nothing is saved yet. */
const markingNow = (preferences: ExportPreferences): MarkAiTextChoice =>
  preferences.docx.markAiText ?? "mark";

/** Picks the marking in Change: keeps it, exports this file again with it, and offers Undo (#1945). */
export async function answerMarkAiText(
  mindId: string,
  format: ExportFormat,
  answer: MarkAiTextChoice,
): Promise<void> {
  const before = exportPreferences();
  if (markingNow(before) === answer) return;
  const was = before.docx.markAiText;
  await keep((now) => withMarking(now, answer));
  // A refusal is already said in a notice, and the choice stays as it was.
  if (markingNow(exportPreferences()) !== answer) return;
  await exportMind(mindId, format);
  changed(
    answer,
    () => keep((now) => withMarking(now, was)),
    () => keep((now) => withMarking(now, answer)),
  );
}

/**
 * What a Word export of this Note asks for: its own comments choice when it made one (#328),
 * so a rewrite can't leave the comments it had in the file out.
 */
function wordOptions(mindId: string, preferences = exportPreferences()): ExportMindOptions {
  const mine =
    preferences.docx.myCommentsFile === mindId ? preferences.docx.includeMyComments : undefined;
  return {
    ...optionsFor("docx", preferences),
    ...(mine !== undefined && { includeMyComments: mine }),
  };
}

/** A refusal Undo can try again once the file is back or free; any other never can (#110). */
const RETRIED_UNDO: readonly MessageKey[] = [
  "error.export.rewrite.gone",
  "error.export.rewrite.locked",
];

/**
 * Picks in Change whether this Note's file, from someone else, gets check comments (#110): the
 * choice is this Note's alone, and the same file is written again, so no second copy sits
 * beside it that could be sent instead. Undo puts both the choice and the file back, by the step
 * the core gave this Change, and Redo writes it again as a new one.
 */
export async function answerCheckComments(mindId: string, answer: boolean): Promise<void> {
  const { result } = useExports.getState();
  if (result?.mindId !== mindId || result.state !== "saved" || result.format !== "docx") return;
  if (result.checks.commented === answer) return;
  const previous: ExportResult = { ...result, changing: undefined };
  // The core keeps the choice once the file holds it; a file the User changed gets one beside it.
  const write = async () => {
    const saved = await core.rewriteMindExport(mindId, wordOptions(mindId), result.path, answer);
    useExports.setState({
      result:
        saved.status === "review"
          ? { mindId, state: "review", format: "docx", word: saved.word }
          : savedResult(mindId, "docx", saved),
    });
    return saved.status === "saved" ? saved : null;
  };
  try {
    const first = await write();
    if (!first) return;
    let written = first;
    useUndo.getState().push({
      said: (t) =>
        rewrittenLine(
          t,
          answer,
          written.sentenceChecks.comments,
          written.file.name,
          written.changedFile ?? null,
        ),
      ...(first.changedFile && {
        also: {
          label: (t) => t("export.open"),
          testId: "undo-open-copy",
          run: () =>
            void files.openSavedFile(written.file.path).catch((error: unknown) => {
              useAppStore.getState().reportError(error);
            }),
        },
      }),
      undo: async () => {
        try {
          await core.restoreMindExport(written.file.path, written.step);
        } catch (error) {
          const { wording } = describeError(error);
          if (!wording || !RETRIED_UNDO.includes(wording.key)) throw error;
          throw new UndoRefused((t) => t(wording.key, wording.values), {
            label: (t) => t("undo.tryAgain"),
            run: async () => undefined,
          });
        }
        if (useExports.getState().result?.mindId === mindId) {
          useExports.setState({ result: { ...previous, at: Date.now() } });
        }
      },
      redo: async () => {
        written = (await write()) ?? written;
      },
    });
  } catch (failure) {
    useAppStore.getState().reportError(failure);
  }
}

/**
 * "Include them" in the Saved line (#328): someone else's file, written again with the User's
 * own comments and replies, under Undo. The export option stays as it was for the next export.
 */
export async function includeMyComments(mindId: string): Promise<void> {
  const { result } = useExports.getState();
  if (result?.mindId !== mindId || result.state !== "saved" || result.format !== "docx") return;
  if (result.myCommentsShown || result.myComments === 0) return;
  const previous: ExportResult = { ...result, changing: undefined };
  const options: ExportMindOptions = { ...wordOptions(mindId), includeMyComments: true };
  const write = async () => {
    const saved = await core.rewriteMindExport(mindId, options, result.path);
    useExports.setState({
      result:
        saved.status === "review"
          ? { mindId, state: "review", format: "docx", word: saved.word }
          : savedResult(mindId, "docx", saved),
    });
    return saved.status === "saved" ? saved : null;
  };
  try {
    const first = await write();
    if (!first) return;
    let written = first;
    useUndo.getState().push({
      said: (t) =>
        t(written.myComments === 1 ? "undo.includedMyComments.one" : "undo.includedMyComments", {
          count: written.myComments,
        }),
      undo: async () => {
        await core.restoreMindExport(written.file.path, written.step);
        if (useExports.getState().result?.mindId === mindId) {
          useExports.setState({ result: { ...previous, at: Date.now() } });
        }
      },
      redo: async () => {
        written = (await write()) ?? written;
      },
    });
  } catch (failure) {
    useAppStore.getState().reportError(failure);
  }
}

/** Picks where Citations go in Change: keeps it, exports this file again with it, and offers Undo (#1945). */
export async function answerCitationPlace(
  mindId: string,
  format: ExportFormat,
  answer: CitationPlace,
): Promise<void> {
  const before = exportPreferences();
  if ((before.citationPlace ?? DEFAULT_CITATION_PLACE) === answer) return;
  const was = before.citationPlace;
  await keep((now) => withCitationPlace(now, answer));
  if (exportPreferences().citationPlace !== answer) return;
  await exportMind(mindId, format);
  changed(
    answer,
    () => keep((now) => withCitationPlace(now, was)),
    () => keep((now) => withCitationPlace(now, answer)),
  );
}

/** What a failed export says: a PDF that couldn't be laid out is tried again, anything else says why. */
function failedResult(mindId: string, format: ExportKind, failure: unknown): ExportResult {
  return describeError(failure).wording?.key === "error.pdf.notLaidOut"
    ? { mindId, state: "not-laid-out", format }
    : { mindId, state: "failed", format, message: errorMessage(failure, translateNow) };
}

const NO_CHECKS: SentenceChecksExported = {
  contradicted: 0,
  notFound: 0,
  unsupported: 0,
  needsRecheck: 0,
  commented: false,
  comments: 0,
};

function savedResult(
  mindId: string,
  format: ExportKind,
  saved:
    | Exclude<SavedMindExport, { status: "review" }>
    | SavedExport
    | SavedCheckRecord
    | SavedComparisonExport,
): ExportResult | null {
  if (saved.status === "saved") {
    return {
      mindId,
      state: "saved",
      format,
      path: saved.file.path,
      name: saved.file.name,
      withCsv: "withCsv" in saved && saved.withCsv,
      failures:
        "failures" in saved
          ? saved.failures.map(({ format, message, wording }) => ({
              format,
              reason: wording ? translateNow(wording.key, wording.values) : message,
            }))
          : [],
      folder: saved.file.folder,
      inDefaultFolder: saved.file.inDefaultFolder,
      at: Date.now(),
      unverified: "unverifiedCitations" in saved ? saved.unverifiedCitations : 0,
      hiddenColumns: "hiddenColumns" in saved ? saved.hiddenColumns : 0,
      othersFile: "othersFile" in saved && saved.othersFile,
      changedFile: ("changedFile" in saved && saved.changedFile) || null,
      checks: "sentenceChecks" in saved ? saved.sentenceChecks : NO_CHECKS,
      tracked: "trackedChanges" in saved ? saved.trackedChanges : 0,
      kept: "word" in saved ? (saved.word?.keptFurniture ?? []) : [],
      needsDetails: "needsDetails" in saved ? saved.needsDetails : [],
      sentKept: "sentKept" in saved ? saved.sentKept : true,
      defaulted: saved.file.defaulted,
      citations: "citations" in saved ? saved.citations : 0,
      citedDocuments: "citedDocuments" in saved ? saved.citedDocuments : 0,
      footnotes: "footnotes" in saved ? saved.footnotes : 0,
      numbered: "numbered" in saved ? saved.numbered : false,
      citationPlace: "citationPlace" in saved ? saved.citationPlace : null,
      markAiText: "markAiText" in saved ? saved.markAiText : null,
      myComments: "myComments" in saved ? saved.myComments : 0,
      myCommentsShown: !("myCommentsShown" in saved) || saved.myCommentsShown,
    };
  }
  if (saved.status === "not-allowed") {
    return {
      mindId,
      state: "not-allowed",
      format,
      linkedFolderId: saved.linkedFolderId,
      folder: folderName(saved.linkedFolderPath),
    };
  }
  // The User didn't choose where new files go: nothing was saved, and nothing went wrong.
  return null;
}

/**
 * Exports a Mind into the Output location (the first save asks where that is), in `format` or
 * the last one, which it becomes; the result line says how it went. `first` fixes what stopped
 * the last try (another Output location, allowing a Linked folder), unless it returns false.
 * `accept` is what a Word file can't keep that the User has seen and exports anyway (#105).
 * It asks nothing first (#1945): Word marks the text IncarnaMind wrote and Citations are
 * footnotes until the User changes either, in Export options or in the Saved line's Change.
 */
export async function exportMind(
  mindId: string,
  format?: ExportFormat,
  first?: () => Promise<boolean>,
  accept?: readonly string[],
): Promise<void> {
  const preferences = exportPreferences();
  const chosen = format ?? preferences.format;
  // "Include my comments" is one Note's choice: another Note's export never takes it (#328).
  const options: ExportMindOptions =
    chosen === "docx" ? wordOptions(mindId, preferences) : optionsFor(chosen, preferences);
  const settle = begin(mindId, chosen);
  // The Share sheet saves a web page without making it the format Export options offers (#1258).
  if (chosen !== preferences.format && chosen !== "share-page") {
    void useAppStore
      .getState()
      .updateSettings({ user: { exportOptions: { ...preferences, format: chosen } } });
  }
  if (!settle) return;
  try {
    if (chosen === "source-pack") {
      const { citations } = await core.previewMindExport(mindId, { format: chosen });
      if (citations === 0) {
        settle({ mindId, state: "empty", format: chosen });
        return;
      }
    }
    if (first && !(await first())) {
      settle(null);
      return;
    }
    const saved = await core.saveMindExport(mindId, {
      ...options,
      ...(accept && { accept: [...accept] }),
    });
    settle(
      saved.status === "review"
        ? { mindId, state: "review", format: chosen, word: saved.word }
        : savedResult(mindId, chosen, saved),
    );
    const store = useAppStore.getState();
    if (saved.status === "saved" && ownMindsOf(store).some((mind) => mind.id === mindId)) {
      store.updateGettingStarted({ exported: true });
    }
  } catch (failure) {
    settle(failedResult(mindId, chosen, failure));
  }
}

export async function exportCheckRecord(
  mindId: string,
  first?: () => Promise<boolean>,
): Promise<void> {
  const settle = begin(mindId, "check-record");
  if (!settle) return;
  try {
    if (first && !(await first())) {
      settle(null);
      return;
    }
    settle(savedResult(mindId, "check-record", await core.saveCheckRecord(mindId)));
  } catch (failure) {
    settle(failedResult(mindId, "check-record", failure));
  }
}

/**
 * Saves a comparison table as an Excel workbook (#132) into the Output location, as an export
 * does; the result line says how it went.
 */
export async function exportComparison(
  mindId: string,
  tableId: string,
  first?: () => Promise<boolean>,
): Promise<void> {
  const settle = begin(mindId, COMPARISON_EXCEL, tableId);
  if (!settle) return;
  try {
    if (first && !(await first())) {
      settle(null);
      return;
    }
    const saved = savedResult(
      mindId,
      COMPARISON_EXCEL,
      await core.saveComparisonExport({ mindId, tableId }),
    );
    settle(saved && { ...saved, tableId });
  } catch (failure) {
    settle({
      mindId,
      state: "failed",
      format: COMPARISON_EXCEL,
      tableId,
      message: errorMessage(failure, translateNow),
    });
  }
}

/**
 * Saves a comparison table as CSV (#1839) beside Export to Excel, the rows `documentIds` names
 * when a filter hides some; the result line says how it went.
 */
export async function exportComparisonCsv(
  mindId: string,
  tableId: string,
  documentIds?: readonly string[],
  first?: () => Promise<boolean>,
): Promise<void> {
  const settle = begin(mindId, COMPARISON_CSV, tableId);
  if (!settle) return;
  try {
    if (first && !(await first())) {
      settle(null);
      return;
    }
    const saved = savedResult(
      mindId,
      COMPARISON_CSV,
      await core.saveComparisonCsvExport({
        mindId,
        tableId,
        ...(documentIds && { documentIds }),
      }),
    );
    settle(saved && { ...saved, tableId });
  } catch (failure) {
    settle({
      mindId,
      state: "failed",
      format: COMPARISON_CSV,
      tableId,
      message: errorMessage(failure, translateNow),
    });
  }
}

export async function exportFigureSchedule(
  mindId: string,
  first?: () => Promise<boolean>,
): Promise<void> {
  const settle = begin(mindId, FIGURE_SCHEDULE_EXCEL);
  if (!settle) return;
  try {
    if (first && !(await first())) {
      settle(null);
      return;
    }
    settle(savedResult(mindId, FIGURE_SCHEDULE_EXCEL, await core.saveFigureScheduleExport(mindId)));
  } catch (error) {
    settle({
      mindId,
      format: FIGURE_SCHEDULE_EXCEL,
      state: "failed",
      message: errorMessage(error, translateNow),
    });
  }
}

export function exportAgain(
  result: Pick<ExportResult, "mindId" | "format" | "tableId">,
  first: () => Promise<boolean>,
): Promise<void> {
  const { mindId, format: kind } = result;
  // A CSV exported again keeps every row: the filter it followed may be gone.
  if (kind === COMPARISON_CSV)
    return exportComparisonCsv(mindId, result.tableId ?? "", undefined, first);
  if (kind === COMPARISON_EXCEL) return exportComparison(mindId, result.tableId ?? "", first);
  if (kind === FIGURE_SCHEDULE_EXCEL) return exportFigureSchedule(mindId, first);
  if (!isCheckRecord(kind)) return exportMind(mindId, kind, first);
  return exportCheckRecord(mindId, first);
}

/**
 * Adds the first entry of the Mind's References too thin to cite, as the result line's Add
 * details does: scrolled to the middle, its "Needs details" clicked, which opens its "Cite as"
 * at the first gap.
 */
export function revealNeedsDetails(mindId: string): boolean {
  const needs = document.querySelector<HTMLElement>(
    `article[data-mind-id="${CSS.escape(mindId)}"] [data-testid="reference-entry"][data-needs-details] [data-testid="reference-needs-details"]`,
  );
  if (!needs) return false;
  needs.scrollIntoView({ block: "center" });
  needs.click();
  return true;
}

/**
 * Shows the first Citation of the Mind whose quote wasn't found, as the result line's Show does:
 * scrolled to the middle and focused, so its card opens and the focus ring marks it.
 */
export function revealUnverified(mindId: string): boolean {
  const citation = document.querySelector<HTMLElement>(
    `article[data-mind-id="${CSS.escape(mindId)}"] [data-testid="citation"]:not([data-check="found"])`,
  );
  if (!citation) return false;
  citation.scrollIntoView({ block: "center" });
  const chip = citation.querySelector<HTMLElement>('[data-testid="citation-chip"]') ?? citation;
  chip.focus();
  return true;
}
