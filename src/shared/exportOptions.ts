import type { ExportFormat, ExportMindOptions, ExportPreferences } from "../core/api";
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

/** Whether a format has the Include Questions option: Markdown keeps them, and a source pack has none. */
export const hasQuestionsOption = (
  format: ExportFormat,
): format is Exclude<ExportFormat, "markdown" | "source-pack"> =>
  format !== "markdown" && format !== "source-pack";

const placeOf = (preferences: ExportPreferences): Pick<ExportMindOptions, "citationPlace"> =>
  preferences.citationPlace ? { citationPlace: preferences.citationPlace } : {};

export const hasCitationPlace = (format: ExportFormat): format is "docx" | "pdf" =>
  format === "docx" || format === "pdf";

/**
 * What an export of `format` asks the core for, with the User's choices for it; null for Word
 * until the User has said whether to mark the text IncarnaMind wrote, which nothing decides for them.
 */
export const optionsFor = (
  format: ExportFormat,
  preferences: ExportPreferences,
): ExportMindOptions | null => {
  if (format === "docx") {
    const { markAiText, ...choices } = preferences.docx;
    return markAiText === null
      ? null
      : { format, ...choices, markAiText: markAiText === "mark", ...placeOf(preferences) };
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

/** The Word copy offered when quitting: it marks the text IncarnaMind wrote, and lists the Citations at the end, only if the User chose to. */
export const quitCopyOptions = (preferences: ExportPreferences): ExportMindOptions => ({
  format: "docx",
  markAiText: preferences.docx.markAiText === "mark",
  ...placeOf(preferences),
});
