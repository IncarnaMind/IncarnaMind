import { useEffect, useState } from "react";
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

/** Opens Settings at the Output location, its Change… focused: a first save's Change folder… (D209). */
export const showOutputLocationSetting = (): void =>
  useAppStore.getState().openSettings("general", "output-location");

/**
 * Which Linked folders the User allows IncarnaMind to add files to, by id: the
 * store of the answers as read, so a row says "read-only" only when the folder
 * is (#1942).
 */
export function useLinkedFolderWriting(): Readonly<Record<string, boolean>> {
  const [writing, setWriting] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let stopped = false;
    // A read asked for before an answer arrived must not put the older answer back.
    let heard = false;
    const set = (settings: OutputSettings) => {
      if (stopped) return;
      setWriting(
        Object.fromEntries(
          settings.linkedFolders.map((each) => [each.linkedFolderId, each.allowed]),
        ),
      );
    };
    core.getOutputSettings().then(
      (loaded) => {
        if (!heard) set(loaded);
      },
      (error: unknown) => console.error("Couldn't read where IncarnaMind may write.", error),
    );
    const stop = core.on("outputSettings.changed", (settings) => {
      heard = true;
      set(settings);
    });
    return () => {
      stopped = true;
      stop();
    };
  }, []);
  return writing;
}
