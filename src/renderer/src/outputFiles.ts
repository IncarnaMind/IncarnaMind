import type { OutputSettings } from "../../core/api";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { saveFailureReason } from "../../shared/systemReasons";
import { core, files } from "./core";
import { errorMessage } from "./errors";
import { defaultFolderLabelKey } from "./fileInfo";
import { folderName } from "./linkedFolders";
import { useAppStore } from "./store";

/**
 * Asks for a folder in the system's open dialog and makes it the Output
 * location (a save waiting to know where goes on there). Resolves with the
 * settings, or null if the User cancelled.
 */
export async function chooseOutputLocation(): Promise<OutputSettings | null> {
  const picked = await files.pickOutputLocation();
  return picked === null ? null : core.setOutputLocation(picked);
}

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** "Documents › IncarnaMind", the default Output location, as this computer names Documents. */
export const defaultFolderLabel = (t: Translate): string =>
  t(defaultFolderLabelKey(navigator.platform));

/** A folder as the lines about saving name it: the default's label, else its own name. */
export const outputFolderLabel = (folder: string, suggested: string, t: Translate): string =>
  folder === suggested ? defaultFolderLabel(t) : folderName(folder);

/**
 * A folder a file was just saved in, as its line names it, from the answer the save worked out
 * with links resolved rather than a guessed path.
 */
export const savedFolderLabel = (
  saved: { folder: string; inDefaultFolder: boolean },
  t: Translate,
): string => (saved.inDefaultFolder ? defaultFolderLabel(t) : folderName(saved.folder));

/** Opens Settings at the Output location, its Change… focused: a first save's Change folder…. */
export const showOutputLocationSetting = (): void =>
  useAppStore.getState().openSettings("general", "output-location");

/** Open and Show in Finder on a file IncarnaMind saved: Export's saved line and the conversation's card. */
export const SAVED_OPEN_BUTTON =
  "h-7 rounded-md bg-sheet px-3 text-[13px] leading-5 font-semibold text-ink shadow-[inset_0_0_0_1px_var(--color-rule-strong)] hover:bg-hover";
export const SAVED_SHOW_BUTTON =
  "h-7 rounded-md px-2.5 text-[13px] leading-5 font-semibold text-ink-secondary hover:bg-hover hover:text-ink";

/**
 * Why Open or Show in Finder didn't work on a file IncarnaMind saved, as the line or card that
 * offers them says it: "Couldn't open it: the file is no longer there…" (#3751).
 */
export function savedFileFailure(
  failure: unknown,
  failed: "export.failed.open" | "export.failed.show",
  t: Translate,
): string {
  const message = errorMessage(failure, t);
  const reason = saveFailureReason(message);
  return t(failed, { reason: reason ? t(reason.key, reason.values) : message });
}
