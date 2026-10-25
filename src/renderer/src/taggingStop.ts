import type { Document, LibraryGroup, LibrarySnapshot } from "../../core/api";
import type { Language } from "../../core/language";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { core } from "./core";
import { languageNow } from "./i18n";
import type { Undoable } from "./objects";
import { useAppStore } from "./store";
import { useUndo } from "./undo";

/** Where Tagging with AI can be stopped: a Folder's id, or null for Not in a Folder. */
export type TaggingPlace = string | null;

type Translate = (key: MessageKey, params?: MessageParams) => string;

// As the core places a Document: a Suggested Folder counts, a deleted Folder doesn't.
export function placeOf(library: LibrarySnapshot | null, documentId: string): TaggingPlace {
  const groupId = library?.assignments.find((each) => each.documentId === documentId)?.groupId;
  return groupId && library?.groups.some((group) => group.id === groupId) ? groupId : null;
}

// Organize may have queued a changed Document whose Tags are otherwise up to date.
export function taggingPlaces(
  documents: readonly Document[],
  library: LibrarySnapshot | null,
): TaggingPlace[] {
  const organizing = new Set(
    (library?.assignments ?? []).flatMap((each) =>
      each.status === "pending" || each.status === "classifying" ? [each.documentId] : [],
    ),
  );
  const tagging = documents.filter(
    (each) =>
      (each.status === "ready" && (each.tagging === "pending" || each.tagging === "tagging")) ||
      organizing.has(each.id),
  );
  return [...new Set(tagging.map((each) => placeOf(library, each.id)))];
}

/** Where Tagging is stopped for these Documents, as the Documents are placed. */
export function stoppedDocumentPlaces(
  documents: readonly Document[],
  library: LibrarySnapshot | null,
): TaggingPlace[] {
  const stopped = documents.filter((each) => each.status === "ready" && each.tagging === "stopped");
  return [...new Set(stopped.map((each) => placeOf(library, each.id)))];
}

export const stoppedPlaces = (library: LibrarySnapshot | null): TaggingPlace[] =>
  (library?.settings.taggingStopped ?? []).filter(
    (place) => place === null || library?.groups.some((group) => group.id === place),
  );

/** The places in words, joined as the language joins a list: in “Contracts” and “Board”, and not in a Folder. */
export function placesText(
  places: readonly TaggingPlace[],
  library: { groups: readonly Pick<LibraryGroup, "id" | "name">[] } | null,
  t: Translate,
  language: Language,
): string {
  const list = (items: string[]) =>
    new Intl.ListFormat(language, { type: "conjunction" }).format(items);
  const names = places.flatMap((place) => {
    const name = place && library?.groups.find((group) => group.id === place)?.name;
    return name ? [`“${name}”`] : [];
  });
  return list([
    ...(names.length > 0 ? [t("tagging.place.folders", { names: list(names) })] : []),
    ...(places.includes(null) ? [t("tagging.place.notInFolder")] : []),
  ]);
}

const placesIn = (places: readonly TaggingPlace[]) => {
  const { library } = useAppStore.getState();
  const named = {
    groups: (library?.groups ?? [])
      .filter((group) => places.includes(group.id))
      .map(({ id, name }) => ({ id, name })),
  };
  return (t: Translate) => placesText(places, named, t, languageNow());
};

const setTagging = (places: readonly TaggingPlace[], on: boolean) => async () => {
  for (const place of places) await core.setTaggingWithAi(place, on);
};

export async function stopTagging(): Promise<Undoable | undefined> {
  const places = await core.stopTagging();
  if (places.length === 0) return undefined;
  const named = placesIn(places);
  return {
    said: (t) =>
      t(places.includes(null) ? "tagging.stopped.notInFolder" : "tagging.stopped", {
        places: named(t),
      }),
    undo: setTagging(places, true),
    redo: setTagging(places, false),
  };
}

export async function tagWithAi(places: readonly TaggingPlace[]): Promise<Undoable> {
  await setTagging(places, true)();
  const named = placesIn(places);
  return {
    said: (t) => t("tagging.restarted", { places: named(t) }),
    undo: setTagging(places, false),
    redo: setTagging(places, true),
  };
}

export const resumeTagging = (places: readonly TaggingPlace[]) =>
  tagWithAi(places).then((change) => useUndo.getState().push(change));
