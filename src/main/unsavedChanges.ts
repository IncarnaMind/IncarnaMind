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
import { quitCopyOptions } from "../shared/exportOptions";
import { type MessageKey, type MessageParams, translate } from "../shared/i18n";
import { systemReason } from "../shared/systemReasons";
import { showMessageBox, showSaveDialog } from "./systemDialogs";

type Choice = "saveCopy" | "quitAnyway" | "keepOpen";

const LABELS: Readonly<Record<Choice, MessageKey>> = {
  saveCopy: "unsaved.saveCopy",
  quitAnyway: "quit.unsaved.quit",
  keepOpen: "quit.unsaved.keep",
};

/** A file name the file systems take: a Mind's title without what they refuse. */
const fileNameOf = (title: string) => title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Mind";

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
 * Guards quitting. Returns `settleQuit`, for what quits by itself (an update's restart): it asks
 * the same question, and says whether quitting is certain, when the next quit goes through unasked.
 */
export function guardQuit(
  core: Core,
  focusedWindow: () => BrowserWindow | null,
): () => Promise<boolean> {
  let unsaved: UnsavedChanges | null = null;
  core.on("minds.unsaved", (state) => {
    unsaved = state;
  });
  let leaving = false;
  /** Asks what to do with what still waits; a copy that couldn't be saved asks again, saying why. */
  const ask = async (left: UnsavedChanges, copyFailed: string | null) => {
    const { language } = await core.getSettings();
    const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
    const window = focusedWindow();
    // Only a Mind not deleted can be copied: a deleted one comes back with Restore (#1202).
    const choices: Choice[] = [
      ...(left.mindIds.length > 0 ? (["saveCopy"] as const) : []),
      "quitAnyway",
      "keepOpen",
    ];
    const options = {
      type: "warning" as const,
      message:
        left.count === 1
          ? t("quit.unsaved.title.one")
          : t("quit.unsaved.title", { count: left.count }),
      ...(copyFailed !== null && { detail: copyFailedText(t, copyFailed) }),
      buttons: choices.map((choice) => t(LABELS[choice])),
      defaultId: choices.indexOf("keepOpen"),
      cancelId: choices.indexOf("keepOpen"),
      noLink: true,
    };
    const { response } = await showMessageBox(window, options);
    return { choice: choices[response] ?? "keepOpen", window };
  };
  /** True once nothing waits, or the User chose to quit anyway or saved copies; false if they keep the app open. */
  const settle = async (): Promise<boolean> => {
    let copyFailed: string | null = null;
    for (;;) {
      const left = await core.saveChangesAgain();
      if (!left) return true;
      const { choice, window } = await ask(left, copyFailed);
      if (choice === "quitAnyway") return true;
      if (choice !== "saveCopy") return false;
      try {
        for (const mindId of left.mindIds) {
          if (!(await saveMindCopy(core, window, mindId))) return false;
        }
        return true;
      } catch (error) {
        console.error("quit: a copy of a Mind couldn't be saved", error);
        copyFailed = error instanceof Error ? error.message : String(error);
      }
    }
  };
  const decide = async () => {
    if (!(await settle())) return;
    leaving = true;
    app.quit();
  };
  app.on("before-quit", (event) => {
    if (leaving || !unsaved) return;
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
