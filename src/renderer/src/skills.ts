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

/** The Built-in Skills described in the interface's language (see `skillDescription`). */
const BUILT_IN_DESCRIPTIONS: Readonly<Record<string, MessageKey>> = {
  "literature-review": "skills.builtIn.literature-review",
  "mind-to-report": "skills.builtIn.mind-to-report",
  "summarise-document": "skills.builtIn.summarise-document",
};

const BUILT_IN_TITLES: Readonly<Record<string, MessageKey>> = {
  "literature-review": "skills.builtIn.literature-review.title",
  "mind-to-report": "skills.builtIn.mind-to-report.title",
  "summarise-document": "skills.builtIn.summarise-document.title",
};

/** A Built-in Skill is called by its title in the interface's language; any other by its name. */
export function skillTitle(
  name: string,
  t: (key: MessageKey, params?: MessageParams) => string,
): string {
  const key = BUILT_IN_TITLES[name];
  return key ? t(key) : name;
}

const BUILT_IN_SHORT_LINES: Readonly<Record<string, MessageKey>> = {
  "literature-review": "skills.builtIn.literature-review.short",
  "mind-to-report": "skills.builtIn.mind-to-report.short",
  "summarise-document": "skills.builtIn.summarise-document.short",
};

export function skillShortLine(
  skill: { name: string; builtIn: boolean },
  t: (key: MessageKey, params?: MessageParams) => string,
): string | null {
  const key = skill.builtIn ? BUILT_IN_SHORT_LINES[skill.name] : undefined;
  return key ? t(key) : null;
}

/**
 * What a Skill does, for people: a Built-in Skill's in the interface's
 * language, any other's as its SKILL.md says (which is also what Answers read).
 */
export function skillDescription(
  skill: { name: string; description: string; builtIn: boolean },
  t: (key: MessageKey, params?: MessageParams) => string,
): string {
  const key = skill.builtIn ? BUILT_IN_DESCRIPTIONS[skill.name] : undefined;
  return key ? t(key) : skill.description;
}
