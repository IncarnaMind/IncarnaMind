/**
 * A plan read by the ruling on #2737: each readable Document is right, wrong, rightly left out or
 * missed, from its areas and the areas its plan's Folders' names cover. A Folder arranged by
 * something else, or covering part of an area, needs a per-Document answer; until it has one, the
 * Document is waiting.
 */
import { type Area, areasOf, type DocumentAreas } from "./areas";
import type { FolderReading } from "./folderReader";

export type Outcome = "right" | "wrong" | "rightlyLeftOut" | "missed" | "waiting";
export const OUTCOMES: readonly Outcome[] = [
  "right",
  "wrong",
  "rightlyLeftOut",
  "missed",
  "waiting",
];

export interface ReadDocument {
  id: string;
  readable: boolean;
  /** The key of the plan's Folder it is in, or null when left out. */
  folder: string | null;
  areas: DocumentAreas;
}

export interface ReadFolder {
  key: string;
  reading: FolderReading;
}

/** Whether a person would look for the Document in the Folder, by its key (`askKey`). */
export type LookHere = ReadonlyMap<string, boolean>;

export const askKey = (document: string, folder: string) => `${document} ${folder}`;

export interface DocumentOutcome {
  id: string;
  outcome: Outcome;
  /** The Folders a waiting Document needs an answer for. */
  asks: string[];
}

export interface PlanReading {
  documents: DocumentOutcome[];
  counts: Record<Outcome, number>;
  /** Unreadable Documents, counted apart: how many, and how many the plan filed. */
  scans: { count: number; filed: number };
}

const covers = (folder: ReadFolder, areas: readonly Area[]) =>
  areas.some((area) => folder.reading.areas[area] === "yes");

const needsAsking = (folder: ReadFolder, areas: readonly Area[]) =>
  folder.reading.arrangedBy !== "" || areas.some((area) => folder.reading.areas[area] === "part");

export function readPlan(
  documents: readonly ReadDocument[],
  folders: readonly ReadFolder[],
  answers: LookHere = new Map(),
): PlanReading {
  const readable = documents.filter((each) => each.readable);
  const folderOf = new Map(folders.map((folder) => [folder.key, folder]));
  const othersOfArea = (document: ReadDocument, area: Area) =>
    readable.filter((other) => other !== document && areasOf(other.areas).includes(area)).length;

  const outcomeOf = (document: ReadDocument): DocumentOutcome => {
    const areas = areasOf(document.areas);
    const done = (outcome: Outcome): DocumentOutcome => ({ id: document.id, outcome, asks: [] });
    if (document.folder !== null) {
      const folder = folderOf.get(document.folder);
      if (!folder) throw new Error(`${document.id} is in a Folder the plan doesn't have.`);
      if (areas.length === 0) return done("wrong");
      if (covers(folder, areas)) return done("right");
      if (!needsAsking(folder, areas)) return done("wrong");
      const answer = answers.get(askKey(document.id, folder.key));
      if (answer === undefined) return { id: document.id, outcome: "waiting", asks: [folder.key] };
      return done(answer ? "right" : "wrong");
    }
    if (areas.length === 0) return done("rightlyLeftOut");
    if (folders.some((folder) => covers(folder, areas))) return done("missed");
    const asked = folders.filter((folder) => needsAsking(folder, areas));
    const given = asked.map((folder) => answers.get(askKey(document.id, folder.key)));
    if (given.includes(true)) return done("missed");
    if (given.includes(undefined))
      return {
        id: document.id,
        outcome: "waiting",
        asks: asked.filter((_, at) => given[at] === undefined).map((folder) => folder.key),
      };
    const kind = Math.max(...areas.map((area) => othersOfArea(document, area)));
    return done(kind >= 2 ? "missed" : "rightlyLeftOut");
  };

  const read = readable.map(outcomeOf);
  const counts: Record<Outcome, number> = {
    right: 0,
    wrong: 0,
    rightlyLeftOut: 0,
    missed: 0,
    waiting: 0,
  };
  for (const each of read) counts[each.outcome] += 1;
  const scans = documents.filter((each) => !each.readable);
  return {
    documents: read,
    counts,
    scans: { count: scans.length, filed: scans.filter((each) => each.folder !== null).length },
  };
}

/** The per-Document questions a plan needs before every Document has an outcome. */
export function asksOf(documents: readonly ReadDocument[], folders: readonly ReadFolder[]) {
  return readPlan(documents, folders).documents.flatMap((each) =>
    each.asks.map((folder) => ({ document: each.id, folder })),
  );
}
