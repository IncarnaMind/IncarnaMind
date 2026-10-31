/**
 * Changes to Minds storage refused (#1119), as the User hears of them: how
 * many wait in memory and why, and, for a run that closed without quitting
 * (a crash, a force-quit), how many were lost. That count is kept in a small
 * file outside the data folder, in the temporary folder, so it can still be
 * written when the data folder's disk is full. It is there all the time, 0
 * while nothing waits (#2309): when a count can't be written the file is
 * removed, which a full disk allows, so the next run knows it doesn't know,
 * rather than read an old 0 as "nothing was lost".
 */
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SaveFailureReason, UnsavedAtEnd, UnsavedChanges } from "./api";
import { isRecord } from "./errors";

/** SQLite's primary result codes for a write the disk or another program refused. */
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_READONLY = 8;
const SQLITE_IOERR = 10;
const SQLITE_FULL = 13;

export function unsavedReason(failure: unknown): SaveFailureReason {
  const code =
    isRecord(failure) && typeof failure.errcode === "number" ? failure.errcode & 0xff : null;
  const text = failure instanceof Error ? failure.message : String(failure);
  if (code === SQLITE_FULL || /database or disk is full|\bENOSPC\b/i.test(text)) return "full";
  if (code === SQLITE_IOERR || /disk I\/O error|\bEIO\b/i.test(text)) return "io";
  if (code === SQLITE_READONLY || /readonly database|\b(?:EROFS|EACCES|EPERM)\b/i.test(text)) {
    return "readOnly";
  }
  if (code === SQLITE_BUSY || code === SQLITE_LOCKED || /database is (?:locked|busy)/i.test(text)) {
    return "busy";
  }
  return "other";
}

export function createUnsavedChanges({
  dataDir,
  tempDir,
  changed,
}: {
  dataDir: string;
  tempDir: string;
  changed(unsaved: UnsavedChanges | null): void;
}) {
  const marker = join(
    tempDir,
    `incarnamind-unsaved-${createHash("sha256").update(dataDir).digest("hex").slice(0, 16)}.json`,
  );
  let lost = readLost(marker);
  const record = (count: number) => {
    try {
      writeFileSync(marker, JSON.stringify({ count }));
    } catch (error) {
      console.error("unsaved: the count of changes waiting couldn't be written", error);
      forget(marker);
    }
  };
  record(0);
  const waiting = new Map<string, { count: number; failure: unknown; deleted: boolean }>();

  const summary = (): UnsavedChanges | null => {
    const minds = [...waiting];
    const last = minds.at(-1)?.[1];
    if (!last) return null;
    return {
      count: minds.reduce((sum, [, each]) => sum + each.count, 0),
      // A deleted Mind's changes count, but no copy of it is offered: Restore brings it back.
      mindIds: minds.flatMap(([mindId, each]) => (each.deleted ? [] : [mindId])),
      reason: unsavedReason(last.failure),
      detail: last.failure instanceof Error ? last.failure.message : String(last.failure),
    };
  };

  return {
    /** What `MindContentOptions.unsaved` hears. */
    mindUnsaved(
      mindId: string,
      state: { count: number; failure: unknown; deleted: boolean } | null,
    ): void {
      if (state) waiting.set(mindId, state);
      else waiting.delete(mindId);
      const now = summary();
      record(now?.count ?? 0);
      changed(now);
    },

    summary,

    /** What waits, by Mind, deleted ones left out: what the session's end records (`Core.sessionEnding`). */
    atEnd(): UnsavedAtEnd {
      return {
        count: summary()?.count ?? 0,
        minds: [...waiting].flatMap(([mindId, each]) =>
          each.deleted ? [] : [{ mindId, count: each.count }],
        ),
      };
    },

    takeLost(): number | null {
      const count = lost;
      lost = null;
      return count;
    },

    /** The app quits: whatever still waits, the User has been told, so the next run says nothing. */
    quit(): void {
      record(0);
    },
  };
}

/** The last run's count: 0 when it lost nothing, null when it couldn't say (or there was none). */
function readLost(marker: string): number | null {
  try {
    const read: unknown = JSON.parse(readFileSync(marker, "utf8"));
    return isRecord(read) && Number.isSafeInteger(read.count) && Number(read.count) >= 0
      ? Number(read.count)
      : null;
  } catch {
    // No file: the first run here, or the last couldn't write its count.
    return null;
  }
}

function forget(marker: string): void {
  try {
    rmSync(marker, { force: true });
  } catch (error) {
    console.error("unsaved: the count of changes waiting couldn't be removed", error);
  }
}
