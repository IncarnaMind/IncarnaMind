import type { OutputSettings } from "../../core/api";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { core, files } from "./core";
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

/** Opens Settings at the Output location, its Change… focused: a first save's Change folder…. */
export const showOutputLocationSetting = (): void =>
  useAppStore.getState().openSettings("general", "output-location");
