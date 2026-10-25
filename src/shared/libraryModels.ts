import type { LibrarySettings, TaggingClassifier } from "../core/api";

export const LIBRARY_DEFAULTS = {
  classifier: { kind: "automatic" },
  organizeWith: null,
  taggingStopped: [],
} satisfies Omit<LibrarySettings, "automatic">;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export const changedFromDefaults = (
  settings: LibrarySettings,
  automaticDefault: boolean,
): boolean =>
  !same(settings.classifier, LIBRARY_DEFAULTS.classifier) ||
  !same(settings.organizeWith, LIBRARY_DEFAULTS.organizeWith) ||
  settings.automatic !== automaticDefault ||
  !same(settings.taggingStopped, LIBRARY_DEFAULTS.taggingStopped);

/** Only this verified local decision-model family receives PDF page images. */
export const supportsLibraryImages = (model: string) => /^clef-flash(?::|$)/i.test(model.trim());

/** The model Organize uses: the one picked by hand, else the one allowed in the Library; null for none yet. */
export const organizeModelOf = (settings: LibrarySettings): TaggingClassifier | null =>
  settings.classifier.kind === "automatic" ? settings.organizeWith : settings.classifier;

/** Whether Organize can tag and file Documents: once it has a model and there are Folders. */
export const organizes = (
  library: { groups: readonly unknown[]; settings: LibrarySettings } | null,
): boolean => !!library && library.groups.length > 0 && organizeModelOf(library.settings) !== null;

/** Whether Organize tags new Documents rather than automatic tagging: it can, and files them by itself. */
export const organizesNewDocuments = (
  library: { groups: readonly unknown[]; settings: LibrarySettings } | null,
): boolean => organizes(library) && !!library?.settings.automatic;

/**
 * The Documents whose Tags Organize holds, so its rows say how they are going and the tagging rows
 * leave them out: those with an assignment that isn't finished (queued, running, waiting or failed),
 * or, while Organize files new Documents by itself, any assignment.
 */
export const organizeHeld = (
  library: {
    groups: readonly unknown[];
    settings: LibrarySettings;
    assignments: readonly { documentId: string; status: string }[];
  } | null,
): ReadonlySet<string> => {
  if (!library || !organizes(library)) return new Set();
  const everything = library.settings.automatic;
  return new Set(
    library.assignments
      .filter((assignment) => everything || assignment.status !== "classified")
      .map((assignment) => assignment.documentId),
  );
};
