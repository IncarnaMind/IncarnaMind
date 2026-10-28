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

/** Opens Settings at the Output location, its Change… focused: a first save's Change folder…. */
export const showOutputLocationSetting = (): void =>
  useAppStore.getState().openSettings("general", "output-location");

/** What is known about where IncarnaMind may add files, and whether that is known at all. */
export interface LinkedFolderWriting {
  /** By Linked folder id: true where the User allowed it. */
  allowed: Readonly<Record<string, boolean>>;
  /** The answer hasn't been read yet: a row says nothing about read-only until it is. */
  reading: boolean;
  /** The answer couldn't be read: a row says so, with the way to the setting. */
  problem: boolean;
}

/**
 * Which Linked folders the User allows IncarnaMind to add files to, by id. A
 * row says read-only only for a folder it knows the User hasn't allowed, and
 * says a problem where the answer couldn't be read (#1942).
 */
export function useLinkedFolderWriting(): LinkedFolderWriting {
  const [writing, setWriting] = useState<LinkedFolderWriting>({
    allowed: {},
    reading: true,
    problem: false,
  });
  useEffect(() => {
    let stopped = false;
    // A read asked for before an answer arrived must not put the older answer back.
    let heard = false;
    const set = (settings: OutputSettings) => {
      if (stopped) return;
      setWriting({
        allowed: Object.fromEntries(
          settings.linkedFolders.map((each) => [each.linkedFolderId, each.allowed]),
        ),
        reading: false,
        problem: false,
      });
    };
    core.getOutputSettings().then(
      (loaded) => {
        if (!heard) set(loaded);
      },
      (error: unknown) => {
        console.error("Couldn't read where IncarnaMind may write.", error);
        if (!stopped && !heard) setWriting({ allowed: {}, reading: false, problem: true });
      },
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
