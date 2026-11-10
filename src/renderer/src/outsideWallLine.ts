import type { Language } from "../../core/language";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { listOf, unitsOf } from "../../shared/i18n/join";

/**
 * What the box says of picked files that are Documents already, outside the Folder its Question
 * is kept to: all the names for up to three files, two and a count past that.
 */
export function outsideWallLine(
  t: (key: MessageKey, params?: MessageParams) => string,
  language: Language,
  { names, folder }: { names: readonly string[]; folder: string },
): string {
  const quoted = names.map((name) => `“${name}”`);
  if (names.length === 1)
    return t("composer.files.outsideWall.one", { name: names[0] ?? "", folder });
  if (names.length <= 3) {
    return t("composer.files.outsideWall", { names: listOf(quoted, language), folder });
  }
  return t("composer.files.outsideWall.many", {
    names: unitsOf(quoted.slice(0, 2), language),
    more: names.length - 2,
    count: names.length,
    folder,
  });
}
