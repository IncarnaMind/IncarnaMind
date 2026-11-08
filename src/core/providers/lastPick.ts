import { mindModelOf, sameModel, setMindModel } from "../../shared/mindModel";
import type { Logger } from "../adapters";
import type { ChatModelChoice } from "../api";
import { isKnownKind } from "../mindAccess";
import { type MindContent, MindDamagedError } from "../mindContent";
import { isChatModelChoice, type SettingsStore } from "../settings";
import type { Database } from "../storage";

/**
 * The device setting the composer's model chip wrote until a pick held for its Note only (#2836):
 * every Note with no usable pick of its own, and the assistant with no Note in focus, followed it.
 */
const LAST_PICK = "lastChatModel";

interface LastPickOptions {
  db: Database;
  settings: SettingsStore;
  content: Pick<MindContent, "upgradeStoredSettings">;
  saved(providerId: string): boolean;
  log: Logger;
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : "unknown");

/**
 * Once, as the core starts: every Note the old last pick answered keeps that model as its own
 * pick, so nothing changes under the User, then the last pick is forgotten. The last pick answered
 * a Note with no pick of its own, or with one on a provider no longer saved, as `modelInUse` did,
 * while the last pick's provider was saved and it wasn't the Answers model already. Notes in
 * Recently deleted count too. The pick goes into each Note's document, which a migration can't
 * write. A Note whose document can't be read is skipped; any other failure writes nothing, and the
 * next start tries again.
 */
export function keepLastPickInNotes(options: LastPickOptions): void {
  const { db, settings, log } = options;
  const stored = settings.readDeviceValue(LAST_PICK);
  if (stored === undefined) return;
  const last = isChatModelChoice(stored) ? stored : null;
  const kept =
    last !== null &&
    options.saved(last.providerId) &&
    !sameModel(last, settings.get().user.chatModel)
      ? last
      : null;
  try {
    const notes = db.transaction(() => {
      const count = kept ? keepIn(options, kept) : 0;
      settings.deleteDeviceValue(LAST_PICK);
      return count;
    });
    log.info("settings.lastPick.kept", { notes });
  } catch (error) {
    log.error("settings.lastPick.notKept", { reason: reasonOf(error) });
  }
}

/** Gives `pick` to each Note the last pick answered; returns how many took it. */
function keepIn({ db, content, saved, log }: LastPickOptions, pick: ChatModelChoice): number {
  let count = 0;
  const notes = db.all<{ id: string; kind: string; deleted_at: string | null }>(
    "SELECT id, kind, deleted_at FROM minds WHERE purged_at IS NULL",
  );
  for (const note of notes) {
    // A kind a newer version made is never written; the store skips a Note one wrote.
    if (!isKnownKind(note.kind)) continue;
    try {
      content.upgradeStoredSettings(note.id, note.deleted_at, (mindSettings) => {
        const doc = mindSettings.doc;
        if (!doc) return;
        const own = mindModelOf(doc);
        if (own !== null && saved(own.providerId)) return;
        setMindModel(doc, pick);
        count++;
      });
    } catch (error) {
      // Only a document that can't be read is passed over: it can't have been answered either.
      if (!(error instanceof MindDamagedError)) throw error;
      log.error("settings.lastPick.noteUnreadable", {
        mindId: note.id,
        reason: reasonOf(error.cause),
      });
    }
  }
  return count;
}
