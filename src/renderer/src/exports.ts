import { create } from "zustand";
import type {
  CheckRecordFormat,
  CitationPlace,
  ExportFormat,
  ExportPreferences,
  MarkAiTextChoice,
  SavedCheckRecord,
  SavedComparisonExport,
  SavedExport,
  SavedMindExport,
  SentenceChecksExported,
  WordExportReport,
} from "../../core/api";
import {
  type CitedCount,
  DEFAULT_CITATION_PLACE,
  optionsFor,
  withCitationPlace,
  withMarking,
} from "../../shared/exportOptions";
import type { MessageKey } from "../../shared/i18n";
import { core } from "./core";
import { errorMessage } from "./errors";
import { rewrittenLine } from "./exportChecks";
import { ownMindsOf } from "./home";
import { translateNow } from "./i18n";
import { folderName } from "./linkedFolders";
import { useAppStore } from "./store";
import { useUndo } from "./undo";

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

export const exportPreferences = (): ExportPreferences =>
  useAppStore.getState().settings?.user.exportOptions ?? DEFAULT_PREFERENCES;

export const COMPARISON_EXCEL = "comparison-xlsx";
export const FIGURE_SCHEDULE_EXCEL = "figure-schedule-xlsx";

export type ExportKind =
  | ExportFormat
  | "check-record"
  | typeof COMPARISON_EXCEL
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
      /** Open: the choices that made this file, to change and export again (#1945). */
      changing?: ExportChanging;
    }
  /** Not saved yet: what a Word file can't keep, for the User to see first (#105). */
  | { mindId: string; state: "review"; format: ExportFormat; word: WordExportReport }
  | { mindId: string; state: "failed"; format: ExportKind; message: string }
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
 * Picks in Change whether this Note's file, from someone else, gets check comments (#110): the
 * choice is this Note's alone, and the same file is written again, so no second copy sits
 * beside it that could be sent instead. Undo puts both the choice and the file back.
 */
export async function answerCheckComments(mindId: string, answer: boolean): Promise<void> {
  const { result } = useExports.getState();
  if (result?.mindId !== mindId || result.state !== "saved" || result.format !== "docx") return;
  if (result.checks.commented === answer) return;
  const previous: ExportResult = { ...result, changing: undefined };
  const write = async () => {
    await core.setCheckComments(mindId, answer);
    const saved = await core.rewriteMindExport(
      mindId,
      optionsFor("docx", exportPreferences()),
      result.path,
    );
    useExports.setState({
      result:
        saved.status === "review"
          ? { mindId, state: "review", format: "docx", word: saved.word }
          : savedResult(mindId, "docx", saved),
    });
    return saved.status === "saved" ? saved : null;
  };
  try {
    const saved = await write();
    if (!saved) return;
    const count = saved.sentenceChecks.comments;
    useUndo.getState().push({
      said: (t) => rewrittenLine(t, answer, count, saved.file.name),
      undo: async () => {
        await core.setCheckComments(mindId, !answer);
        await core.restoreMindExport(result.path);
        useExports.setState({ result: { ...previous, at: Date.now() } });
      },
      redo: async () => {
        await write();
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
  const options = optionsFor(chosen, preferences);
  const settle = begin(mindId, chosen);
  if (!settle) return;
  if (chosen !== preferences.format) {
    void useAppStore
      .getState()
      .updateSettings({ user: { exportOptions: { ...preferences, format: chosen } } });
  }
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
    settle({
      mindId,
      state: "failed",
      format: chosen,
      message: errorMessage(failure, translateNow),
    });
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
    settle({
      mindId,
      state: "failed",
      format: "check-record",
      message: errorMessage(failure, translateNow),
    });
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
