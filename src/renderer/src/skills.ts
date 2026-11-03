/**
 * Choosing a Skill to import: the system's open dialog, or, in the smoke
 * tests, a path a test hook set (`interceptSkillPicker`), since a test can't
 * drive the system's dialog.
 */

import type { SkillPickKind } from "../../shared/bridge";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { files } from "./core";

/** Set by the test hook: what the next pick gives instead of opening the dialog. */
let intercepted: { path: string | null } | null = null;

/** Test hook: the next pick resolves with `path` (null: cancelled) without showing the dialog. */
export function interceptSkillPicker(path: string | null): void {
  intercepted = { path };
}

/** The absolute path of a Skill folder or zip the User chose, or null if they cancelled. */
export function pickSkill(kind: SkillPickKind): Promise<string | null> {
  if (intercepted) {
    const { path } = intercepted;
    intercepted = null;
    return Promise.resolve(path);
  }
  return files.pickSkill(kind);
}

/** A size in KB (under a megabyte) or MB, e.g. "12 KB" or "3.4 MB". */
export function formatSize(
  bytes: number,
  t: (key: MessageKey, params?: MessageParams) => string,
): string {
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return t("skills.size.kb", { size: Math.max(1, Math.round(kilobytes)) });
  const megabytes = kilobytes / 1024;
  return t("skills.size.mb", {
    size: megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes),
  });
}

export { skillDescription, skillShortLine, skillTitle } from "./skillText";
