import type {
  CitationPlace,
  ExportFormat,
  ExportMindOptions,
  ExportPreferences,
  MarkAiTextChoice,
} from "../core/api";
import type { Translate } from "./locations";

/** The Citations an export applies a choice to, and the Documents they cite. */
export interface CitedCount {
  citations: number;
  documents: number;
}

/** "19 Citations from 1 Document", in the language of `t`. */
export function citedCountText(t: Translate, { citations, documents }: CitedCount): string {
  return t("export.citationPlace.count", {
    citations:
      citations === 1
        ? t("export.citedCitations.one")
        : t("export.citedCitations.other", { count: citations }),
    documents:
      documents === 1
        ? t("export.citedDocuments.one")
        : t("export.citedDocuments.other", { count: documents }),
  });
}

/** What a file was written with, as its Saved line says it: Citations as footnotes or in a list (#1945). */
export interface ChosenPlaces {
  /** The Citations in a list at the end: one entry for each. */
  citations: number;
  /** The footnotes in the file, the User's own included: a source and place once (#1381). */
  footnotes: number;
  place: CitationPlace;
}

/** What a file was written with, for the Saved line in the Mind's export line (#1945). */
export interface ExportChosen {
  /** Null for a format that doesn't place Citations, or a Mind whose style decides for itself. */
  places: ChosenPlaces | null;
  /** Null for a format that doesn't mark the text IncarnaMind wrote. */
  markAiText: boolean | null;
}

/**
 * The parts the Saved line adds to the file's name for what was chosen: "6 footnotes · AI text
 * marked" (已保存“…” · 6 个脚注 · 已标出 AI 文字). Each part comes only when the file has it to say.
 */
export function chosenParts(t: Translate, { places, markAiText }: ExportChosen): string[] {
  const parts: string[] = [];
  if (places) {
    const count = places.place === "list" ? places.citations : places.footnotes;
    if (count > 0) {
      const [one, other] =
        places.place === "list"
          ? (["export.saved.list.one", "export.saved.list.other"] as const)
          : (["export.saved.footnotes.one", "export.saved.footnotes.other"] as const);
      parts.push(count === 1 ? t(one) : t(other, { count }));
    }
  }
  if (markAiText !== null) {
    parts.push(t(markAiText ? "export.saved.marked" : "export.saved.unmarked"));
  }
  return parts;
}

/** Whether a format has the Include Questions option: Markdown keeps them, and a source pack has none. */
export const hasQuestionsOption = (
  format: ExportFormat,
): format is Exclude<ExportFormat, "markdown" | "source-pack"> =>
  format !== "markdown" && format !== "source-pack";

/** Where Word and PDF put Citations when the User hasn't chosen: footnotes, as the first export writes them. */
export const DEFAULT_CITATION_PLACE: CitationPlace = "footnotes";

export const hasCitationPlace = (format: ExportFormat): format is "docx" | "pdf" =>
  format === "docx" || format === "pdf";

const placeOf = (preferences: ExportPreferences): Pick<ExportMindOptions, "citationPlace"> => ({
  citationPlace: preferences.citationPlace ?? DEFAULT_CITATION_PLACE,
});

/**
 * What an export of `format` asks the core for: the User's choices for it, or, for what they
 * haven't chosen, the defaults — Word marks the text IncarnaMind wrote, and Citations are
 * footnotes — so the first export asks nothing (#1945).
 */
export const optionsFor = (
  format: ExportFormat,
  preferences: ExportPreferences,
): ExportMindOptions => {
  if (format === "docx") {
    const { markAiText, ...choices } = preferences.docx;
    return {
      format,
      ...choices,
      markAiText: markAiText !== "leave",
      commentOthersFiles: preferences.commentOthersFiles === true,
      ...placeOf(preferences),
    };
  }
  if (format === "source-pack") return { format };
  if (format === "share-page") {
    return {
      format,
      ...preferences["share-page"],
      theirChanges: preferences.theirChanges ?? "shown",
    };
  }
  const theirChanges = preferences.theirChanges ?? "shown";
  return hasQuestionsOption(format)
    ? {
        format,
        includeQuestions: preferences[format].includeQuestions,
        theirChanges,
        ...(format === "pdf" && placeOf(preferences)),
      }
    : { format, theirChanges };
};

/**
 * `preferences` with one choice changed, and the rest left as they are now, so taking a change
 * back never undoes another one made since (#1945). `place` undefined takes the Citations' place
 * away again: nothing chosen, footnotes by default.
 */
export const withMarking = (
  preferences: ExportPreferences,
  choice: MarkAiTextChoice | null,
): ExportPreferences => ({ ...preferences, docx: { ...preferences.docx, markAiText: choice } });

export const withCitationPlace = (
  preferences: ExportPreferences,
  place: CitationPlace | undefined,
): ExportPreferences => {
  const { citationPlace: _before, ...rest } = preferences;
  return place === undefined ? rest : { ...rest, citationPlace: place };
};

/** The Word copy offered when quitting follows the same choices and defaults as Export. */
export const quitCopyOptions = (preferences: ExportPreferences): ExportMindOptions => ({
  format: "docx",
  markAiText: preferences.docx.markAiText !== "leave",
  ...placeOf(preferences),
});
