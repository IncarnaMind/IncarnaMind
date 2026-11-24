/**
 * Changes to Minds storage refused (#1119), on the main process's side: saving
 * a copy of a Mind as a .docx wherever the User chooses, which another drive
 * can take when this one is full; and a quit that would lose them. Quitting
 * tries to store them once more, and only if that fails asks, in one short
 * sheet: save a copy, quit anyway, or keep IncarnaMind open (the default).
 * Lost typing has no Undo, so this one asks first.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, type BrowserWindow, type SaveDialogOptions } from "electron";
import type { Core, UnsavedChanges } from "../core";
import type { DeckUnwritable } from "../core/api";
import { quitCopyOptions } from "../shared/exportOptions";
import { type MessageKey, type MessageParams, translate } from "../shared/i18n";
import { systemReason } from "../shared/systemReasons";
import { settleSummaries, summariesWaiting } from "./meetings/summaryClosing";
import { showMessageBox, showSaveDialog } from "./systemDialogs";

/** `saveCopy`: the Notes' copies, where the User chooses, and the decks' beside their files. */
type Choice = "saveCopy" | "saveDeckCopy" | "quitAnyway" | "keepOpen";

const LABELS: Readonly<Record<Choice, MessageKey>> = {
  saveCopy: "unsaved.saveCopy",
  saveDeckCopy: "viewer.deck.saveCopy",
  quitAnyway: "quit.unsaved.quit",
  keepOpen: "quit.unsaved.keep",
};

/** A file name the file systems take: a Mind's title without what they refuse. */
const fileNameOf = (title: string) => title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Note";

/** How long the quit waits for a hand edit of a deck being written before it asks. */
const DECK_WRITE_WAIT_MS = 10_000;

/** Saves the Mind as a .docx where the User chooses; false when they didn't choose. */
export async function saveMindCopy(
  core: Core,
  window: BrowserWindow | null,
  mindId: string,
): Promise<boolean> {
  const [{ language, user }, minds] = await Promise.all([core.getSettings(), core.listMinds()]);
  const title = minds.find((mind) => mind.id === mindId)?.title ?? "";
  const options: SaveDialogOptions = {
    title: translate(language, "unsaved.saveCopy.title"),
    defaultPath: join(app.getPath("documents"), `${fileNameOf(title)}.docx`),
    filters: [{ name: "Word", extensions: ["docx"] }],
  };
  const { canceled, filePath } = await showSaveDialog(window, options);
  if (canceled || !filePath) return false;
  const { data } = await core.exportMind(mindId, quitCopyOptions(user.exportOptions));
  await writeFile(filePath, data);
  return true;
}

function copyFailedText(t: (key: MessageKey, params?: MessageParams) => string, raw: string) {
  const reason = systemReason(raw);
  return reason
    ? `${t("quit.unsaved.copyFailed", { reason: t(reason) })}\n\n${t("quit.unsaved.copyFailed.details", { raw })}`
    : t("quit.unsaved.copyFailed", { reason: raw });
}

/**
 * Guards quitting; `quit` quits again once the User has answered. Returns `settleQuit`, for what
 * quits by itself (an update's restart): it asks the same question, and says whether quitting is
 * certain, when the next quit goes through unasked.
 */
export function guardQuit(
  core: Core,
  focusedWindow: () => BrowserWindow | null,
  quit: () => void,
): () => Promise<boolean> {
  let unsaved: UnsavedChanges | null = null;
  core.on("minds.unsaved", (state) => {
    unsaved = state;
  });
  let leaving = false;
  /**
   * Asks what to do with what still waits: Notes not stored and hand edits of decks (#149), each
   * deck's with why it isn't saved; a copy that couldn't be saved asks again, saying why.
   */
  const ask = async (
    notes: UnsavedChanges | null,
    decks: readonly DeckUnwritable[],
    writing: boolean,
    copyFailed: string | null,
  ) => {
    const { language } = await core.getSettings();
    const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
    const window = focusedWindow();
    // Only a Mind not deleted can be copied: a deleted one comes back with Restore (#1202).
    const copies: Choice[] =
      notes && notes.mindIds.length > 0 ? ["saveCopy"] : decks.length > 0 ? ["saveDeckCopy"] : [];
    const choices: Choice[] = [...copies, "quitAnyway", "keepOpen"];
    const deckCount = decks.length + (writing ? 1 : 0);
    const count = (notes?.count ?? 0) + deckCount;
    const message = !notes
      ? deckCount === 1
        ? t("quit.unsaved.decks.one")
        : t("quit.unsaved.decks", { count: deckCount })
      : count === 1
        ? t("quit.unsaved.title.one")
        : t("quit.unsaved.title", { count });
    const details = [
      ...(copyFailed !== null ? [copyFailedText(t, copyFailed)] : []),
      ...decks.map((deck) => t(`quit.unsaved.deck.${deck.why}`, { name: deck.name })),
      ...(writing ? [t("quit.unsaved.deck.writing")] : []),
    ];
    const options = {
      type: "warning" as const,
      message,
      ...(details.length > 0 && { detail: details.join("\n") }),
      buttons: choices.map((choice) => t(LABELS[choice])),
      defaultId: choices.indexOf("keepOpen"),
      cancelId: choices.indexOf("keepOpen"),
      noLink: true,
    };
    const { response } = await showMessageBox(window, options);
    return { choice: choices[response] ?? "keepOpen", window };
  };
  /**
   * True once nothing waits, or the User chose to quit anyway; false if they keep the app open. Save
   * a copy saves the Notes' copies and each deck's beside its file, then asks again about anything
   * still waiting: nothing quits while a deck's change waits unless the User chose to.
   */
  const settle = async (): Promise<boolean> => {
    // A deck being written by hand finishes first, so the gesture isn't lost half way, but a write
    // that never settles (a stalled share) doesn't hold the quit: it is asked about.
    const pending = core.writingDecks();
    if (pending)
      await Promise.race([pending, new Promise((done) => setTimeout(done, DECK_WRITE_WAIT_MS))]);
    if (!(await settleSummaries())) return false;
    let copyFailed: string | null = null;
    let notesCopied = false;
    for (;;) {
      const notes = notesCopied ? null : await core.saveChangesAgain();
      const decks = core.deckChangesWaiting();
      const writing = core.writingDecks() !== null;
      if (!notes && decks.length === 0 && !writing) return true;
      const { choice, window } = await ask(notes, decks, writing, copyFailed);
      if (choice === "quitAnyway") return true;
      if (choice !== "saveCopy" && choice !== "saveDeckCopy") return false;
      try {
        if (choice === "saveCopy" && notes) {
          for (const mindId of notes.mindIds) {
            if (!(await saveMindCopy(core, window, mindId))) return false;
          }
          notesCopied = true;
        }
        // The same copy the deck's own line saves: beside its file, else in the Output location.
        for (const deck of decks) await core.saveDeckCopy(deck.sittingId);
        copyFailed = null;
      } catch (error) {
        console.error("quit: a copy of a Note or a deck couldn't be saved", error);
        copyFailed = error instanceof Error ? error.message : String(error);
      }
    }
  };
  const decide = async () => {
    if (!(await settle())) return;
    leaving = true;
    quit();
  };
  app.on("before-quit", (event) => {
    if (
      leaving ||
      (!unsaved &&
        !summariesWaiting() &&
        !core.writingDecks() &&
        core.deckChangesWaiting().length === 0)
    ) {
      return;
    }
    event.preventDefault();
    // Whatever goes wrong here, IncarnaMind stays open: quitting would lose what waits.
    decide().catch((error: unknown) => {
      console.error("quit: the changes waiting couldn't be dealt with", error);
    });
  });
  return async () => {
    if (!(await settle())) return false;
    leaving = true;
    return true;
  };
}
