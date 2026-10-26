import { DataFromNewerVersionError } from "../core/errors";
import type { Language } from "../core/language";
import { translate } from "../shared/i18n";

export const RELEASES_PAGE = "https://github.com/IncarnaMind/IncarnaMind/releases";

/** Index of "Download the latest version" in the buttons of a newer-data dialog. */
export const DOWNLOAD_BUTTON = 0;

export interface StartupDialog {
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
}

/** What the User sees when start-up fails. Only a data folder from a newer version gets buttons. */
export function startupDialog(error: unknown, language: Language): StartupDialog {
  if (error instanceof DataFromNewerVersionError) {
    return {
      title: translate(language, "error.startup.newer.title"),
      message: translate(language, "error.startup.newer.title"),
      detail: translate(language, "error.startup.newer.body"),
      buttons: [
        translate(language, "error.startup.newer.download"),
        translate(language, "error.startup.newer.quit"),
      ],
      defaultId: DOWNLOAD_BUTTON,
      cancelId: 1,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    title: translate(language, "error.startup.title"),
    message: translate(language, "error.startup.title"),
    detail: translate(language, "error.startup.body", { message }),
    buttons: [],
    defaultId: 0,
    cancelId: 0,
  };
}

/**
 * What the User sees when nothing starts: another copy may still be starting on their data folder
 * (`busy`, #1352), or this copy couldn't open its window, twice, while another was quitting
 * (`stalled`, #1448).
 */
export function startupProblem(
  language: Language,
  reason: "busy" | "starting" | "quitting" | "installing" | "stalled",
): { title: string; detail: string } {
  return {
    title: translate(language, "error.startup.title"),
    detail: translate(language, `error.startup.${reason}`),
  };
}
