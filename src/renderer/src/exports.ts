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
import { type CitedCount, hasCitationPlace, optionsFor } from "../../shared/exportOptions";
import type { MessageKey } from "../../shared/i18n";
import { core } from "./core";
import { describeError, errorMessage } from "./errors";
import { translateNow } from "./i18n";
import { folderName } from "./linkedFolders";
import { useAppStore } from "./store";

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

export type ExportKind = ExportFormat | "check-record" | typeof COMPARISON_EXCEL;

export const isCheckRecord = (kind: ExportKind): kind is "check-record" => kind === "check-record";

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
      /** The sentences whose check isn't good: how many, and whether they went in as comments. */
      checks: SentenceChecksExported;
      /** The changes waiting that went into a Word file as tracked changes. */
      tracked: number;
      /** The header and footer kept in a Word file though deleted from the Mind (#105). */
      kept: ("header" | "footer")[];
      /** The Documents whose entries are too thin to cite, marked so in the file. */
      needsDetails: string[];
      /** The first save, which took Documents › IncarnaMind: the line says where (D209). */
      defaulted: boolean;
    }
  /** Not saved yet: what a Word file can't keep, for the User to see first (#105). */
  | { mindId: string; state: "review"; format: ExportFormat; word: WordExportReport }
  /**
   * Not started yet: the export waits for what the User hasn't said, whether Word marks the text
   * IncarnaMind wrote (`mark`) and where Word or PDF puts the Citations (`places`, with how many).
   */
  | {
      mindId: string;
      state: "ask";
      format: "docx" | "pdf";
      mark: boolean;
      places: CitedCount | null;
    }
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

function ask(mindId: string, format: "docx" | "pdf", mark: boolean, places: CitedCount | null) {
  const { result } = useExports.getState();
  if (result?.mindId === mindId && result.state === "saving") return;
  useExports.setState({ result: { mindId, state: "ask", format, mark, places } });
}

/** Mind ids whose export is looking for what to ask, so a held ⇧⌘E asks once. */
const looking = new Set<string>();

async function toAsk(
  mindId: string,
  format: "docx" | "pdf",
  preferences: ExportPreferences,
): Promise<{ mark: boolean; places: CitedCount | null } | null> {
  const mark = format === "docx" && preferences.docx.markAiText === null;
  let places: CitedCount | null = null;
  if (preferences.citationPlace === undefined) {
    const preview = await core.previewMindExport(mindId, { format });
    if (preview.numbered && preview.citations > 0) {
      places = { citations: preview.citations, documents: preview.citedDocuments };
    }
  }
  return mark || places ? { mark, places } : null;
}

async function keep(update: (preferences: ExportPreferences) => ExportPreferences) {
  await useAppStore.getState().updateSettings({
    user: { exportOptions: update(exportPreferences()) },
  });
}

/** Keeps the User's answer to the question the Word export asked, then exports as they asked. */
export async function answerMarkAiText(
  mindId: string,
  format: ExportFormat,
  answer: MarkAiTextChoice,
): Promise<void> {
  await keep((preferences) => ({
    ...preferences,
    docx: { ...preferences.docx, markAiText: answer },
  }));
  // A refusal is already said in a notice, and the question stays for another try.
  if (exportPreferences().docx.markAiText === answer) await exportMind(mindId, format);
}

/** Keeps the User's answer to where Citations go, then exports as they asked. */
export async function answerCitationPlace(
  mindId: string,
  format: ExportFormat,
  answer: CitationPlace,
): Promise<void> {
  await keep((preferences) => ({ ...preferences, citationPlace: answer }));
  if (exportPreferences().citationPlace === answer) await exportMind(mindId, format);
}

/** What a failed export says: a PDF that couldn't be laid out is tried again, anything else says why. */
function failedResult(mindId: string, format: ExportKind, failure: unknown): ExportResult {
  return describeError(failure).wording?.key === "error.pdf.notLaidOut"
    ? { mindId, state: "not-laid-out", format }
    : { mindId, state: "failed", format, message: errorMessage(failure, translateNow) };
}

const NO_CHECKS: SentenceChecksExported = {
  contradicted: 0,
  unsupported: 0,
  needsRecheck: 0,
  commented: false,
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
      checks: "sentenceChecks" in saved ? saved.sentenceChecks : NO_CHECKS,
      tracked: "trackedChanges" in saved ? saved.trackedChanges : 0,
      kept: "word" in saved ? (saved.word?.keptFurniture ?? []) : [],
      needsDetails: "needsDetails" in saved ? saved.needsDetails : [],
      defaulted: saved.file.defaulted,
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
 * Until the User has said whether Word marks the text IncarnaMind wrote, and where Word and PDF
 * put the Citations of a Mind that has some, an export asks that first, in the result line, and
 * exports once it is answered (`answerMarkAiText`, `answerCitationPlace`).
 */
export async function exportMind(
  mindId: string,
  format?: ExportFormat,
  first?: () => Promise<boolean>,
  accept?: readonly string[],
): Promise<void> {
  const preferences = exportPreferences();
  const chosen = format ?? preferences.format;
  if (hasCitationPlace(chosen)) {
    if (looking.has(mindId)) return;
    looking.add(mindId);
    try {
      const asks = await toAsk(mindId, chosen, preferences);
      if (asks) {
        ask(mindId, chosen, asks.mark, asks.places);
        return;
      }
    } catch (failure) {
      const { result } = useExports.getState();
      if (result?.mindId === mindId && result.state === "saving") {
        console.error(`What the export of Mind ${mindId} asks couldn't be worked out.`, failure);
      } else {
        useExports.setState({
          result: {
            mindId,
            state: "failed",
            format: chosen,
            message: errorMessage(failure, translateNow),
          },
        });
      }
      return;
    } finally {
      looking.delete(mindId);
    }
  }
  const options = optionsFor(chosen, preferences);
  if (!options) return;
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

export function exportAgain(
  result: Pick<ExportResult, "mindId" | "format" | "tableId">,
  first: () => Promise<boolean>,
): Promise<void> {
  const { mindId, format: kind } = result;
  if (kind === COMPARISON_EXCEL) return exportComparison(mindId, result.tableId ?? "", first);
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
