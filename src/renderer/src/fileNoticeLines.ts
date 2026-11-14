import type { Language } from "../../core/language";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { unitsOf } from "../../shared/i18n/join";

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** The files an add skipped, as the sidebar's status names them: "a.pages, b.key"; "a.pages、b.key". */
export const skippedNamesLine = (files: readonly { name: string }[], language: Language): string =>
  unitsOf(
    files.map((file) => file.name),
    language,
  );

/** What the sidebar says of files that were Documents already. */
export const alreadyAddedLine = (
  t: Translate,
  language: Language,
  names: readonly string[],
): string => t("documents.alreadyAdded", { names: unitsOf(names, language) });

/** What the sidebar says of pages saved outside the Folder the User chose, each with the Folder it went to. */
export function savedOutsideLine(
  t: Translate,
  language: Language,
  saved: readonly { name: string; folder: string }[],
): string {
  const names = saved.map((each) =>
    each.folder === ""
      ? each.name
      : t("documents.savedOutside.each", { name: each.name, folder: each.folder }),
  );
  return t("documents.savedOutside", { names: unitsOf(names, language) });
}
