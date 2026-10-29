/**
 * How the sidebar and the link dialog put a Linked folder into words: its
 * state on its row, the size and time a link would take, and the name of
 * the system's file manager. Pure: no store, no bridge, so the tests import it.
 */

import type { DocumentFileStatus, LinkedFolder } from "../../core/api";
import type { Language } from "../../core/language";
import type { MessageKey, MessageParams } from "../../shared/i18n";

type Translate = (key: MessageKey, params?: MessageParams) => string;

/**
 * What a Linked folder's row says at its end, the most pressing first:
 * - "unavailable": it can't be reached (an unplugged drive).
 * - "paused": the User paused its indexing.
 * - "downloading": its online-only files are being downloaded to be indexed.
 * - "indexing": some of its files aren't processed to the end yet.
 * - "checking": it is being compared with the disk, with nothing new so far.
 * - "online-only": all indexed, but cloud placeholders were skipped.
 * - "empty": nothing in it to show.
 * - "idle": up to date; the row says nothing.
 */
export type LinkedFolderRowState =
  | { kind: "unavailable" }
  | { kind: "paused"; indexed: number; files: number }
  | { kind: "downloading"; files: number }
  | { kind: "indexing"; indexed: number; files: number }
  | { kind: "checking" }
  | { kind: "online-only"; files: number }
  | { kind: "empty" }
  | { kind: "idle" };

/**
 * The state a Linked folder's row shows. `hasContents`: whether the sidebar
 * has anything to list inside it (sub-Folders or Documents).
 */
export function linkedFolderRowState(
  linked: Pick<LinkedFolder, "status" | "progress" | "onlineOnly">,
  hasContents: boolean,
): LinkedFolderRowState {
  const { status, progress, onlineOnly } = linked;
  if (status === "unavailable") return { kind: "unavailable" };
  if (status === "paused") return { kind: "paused", ...progress };
  if (onlineOnly.downloading) return { kind: "downloading", files: onlineOnly.files };
  if (progress.indexed < progress.files) return { kind: "indexing", ...progress };
  if (status === "scanning") return { kind: "checking" };
  if (onlineOnly.files > 0) return { kind: "online-only", files: onlineOnly.files };
  if (!hasContents) return { kind: "empty" };
  return { kind: "idle" };
}

/**
 * How far its indexing is, from 0 to 1, for the thin bar under its row: only
 * while some files are still to be indexed (or paused part way). Null otherwise.
 */
export function indexingShare(state: LinkedFolderRowState): number | null {
  if (state.kind !== "indexing" && state.kind !== "paused") return null;
  if (state.files <= 0 || state.indexed >= state.files) return null;
  return Math.max(0, state.indexed / state.files);
}

/**
 * The Linked folder to say where it went, while the first open keeps the sidebar's
 * Folders away until the User's first Document (#763): the newest of the User's own
 * with nothing to read in it. One still scanning may not have counted its files, and
 * one with files brings Documents, whose section and rows the sidebar then shows.
 */
export function folderWithNothingToRead(
  linkedFolders: readonly LinkedFolder[],
  exampleIds: ReadonlySet<string>,
  hasOwnDocuments: boolean,
): LinkedFolder | null {
  if (hasOwnDocuments) return null;
  let latest: LinkedFolder | null = null;
  for (const linked of linkedFolders) {
    if (exampleIds.has(linked.id)) continue;
    if (linked.status !== "watching" || linked.progress.files > 0) continue;
    if (latest === null || linked.createdAt > latest.createdAt) latest = linked;
  }
  return latest;
}

/** A whole number with the language's digit grouping: "3,214". */
export function formatCount(count: number, language: Language): string {
  return new Intl.NumberFormat(language).format(count);
}

/**
 * What the row says at its end (`short`, on one line), and in full (`full`:
 * its tooltip, and what a screen reader reads). `compact` is `short` for a
 * narrow sidebar. Null when there is nothing to say.
 */
export function rowStateLabel(
  state: LinkedFolderRowState,
  t: Translate,
  language: Language,
): { short: string; compact: string; full: string } | null {
  const n = (count: number) => formatCount(count, language);
  const same = (short: string, full: string) => ({ short, compact: short, full });
  switch (state.kind) {
    case "unavailable":
      return same(t("linkedFolders.state.unavailable"), t("linkedFolders.state.unavailable.full"));
    case "paused":
      return same(
        t("linkedFolders.state.paused"),
        state.indexed < state.files
          ? t("linkedFolders.state.paused.progress", {
              indexed: n(state.indexed),
              files: n(state.files),
            })
          : t("linkedFolders.state.paused.full"),
      );
    case "downloading":
      return same(
        t("linkedFolders.state.downloading"),
        t(
          state.files === 1
            ? "linkedFolders.state.downloading.full.one"
            : "linkedFolders.state.downloading.full.other",
          { count: n(state.files) },
        ),
      );
    case "indexing": {
      const params = { indexed: n(state.indexed), files: n(state.files) };
      return {
        short: t("linkedFolders.state.indexing", params),
        compact: t("linkedFolders.state.indexing.compact", params),
        full: t("linkedFolders.state.indexing.full", params),
      };
    }
    case "checking":
      return same(t("linkedFolders.state.checking"), t("linkedFolders.state.checking.full"));
    case "online-only":
      return same(
        t("linkedFolders.state.onlineOnly", { count: n(state.files) }),
        t(
          state.files === 1
            ? "linkedFolders.state.onlineOnly.full.one"
            : "linkedFolders.state.onlineOnly.full.other",
          { count: n(state.files) },
        ),
      );
    case "empty":
      return {
        short: t("linkedFolders.state.empty"),
        compact: t("linkedFolders.state.empty.compact"),
        full: t("linkedFolders.state.empty.full"),
      };
    case "idle":
      return null;
  }
}

const KILOBYTE = 1000;
const MEGABYTE = 1000 * KILOBYTE;
const GIGABYTE = 1000 * MEGABYTE;

/**
 * A size in decimal units, as file managers on macOS show them: "640 KB",
 * "3.4 MB", "12 MB", "1.2 GB". Under a kilobyte counts as 1 KB, so nothing
 * reads "0".
 */
export function formatBytes(bytes: number, t: Translate): string {
  const scaled = (value: number) => (value < 10 ? Math.round(value * 10) / 10 : Math.round(value));
  if (bytes >= GIGABYTE) return t("units.gb", { size: scaled(bytes / GIGABYTE) });
  if (bytes >= MEGABYTE) return t("units.mb", { size: scaled(bytes / MEGABYTE) });
  return t("units.kb", { size: Math.max(1, Math.round(bytes / KILOBYTE)) });
}

/**
 * A rough duration, as the link dialog's estimate puts it: "under a minute",
 * "about 4 minutes", "about 2 hours". Hours round to the nearest one; an
 * estimate is never precise, so it doesn't pretend to be.
 */
export function formatDuration(seconds: number, t: Translate): string {
  if (seconds < 60) return t("duration.underMinute");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return minutes === 1
      ? t("duration.minutes.one")
      : t("duration.minutes.other", { count: minutes });
  }
  const hours = Math.round(seconds / 3600);
  return hours === 1 ? t("duration.hours.one") : t("duration.hours.other", { count: hours });
}

/** A folder's name: the last part of its path. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== "");
  return parts.at(-1) ?? path;
}

/**
 * What a Document's row says at its end about its file, and why its file
 * can't be opened or shown: nothing for a file that is where it was.
 */
export function fileStatusLabel(
  fileStatus: DocumentFileStatus,
): { short: MessageKey; full: MessageKey; reason: MessageKey } | null {
  switch (fileStatus) {
    case "missing":
      return {
        short: "documents.fileShort.missing",
        full: "documents.file.missing",
        reason: "documents.file.missingReason",
      };
    case "unavailable":
      return {
        short: "documents.fileShort.unavailable",
        full: "documents.file.unavailable",
        reason: "documents.file.unavailableReason",
      };
    case "available":
      return null;
  }
}
