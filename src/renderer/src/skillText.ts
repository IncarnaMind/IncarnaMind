/**
 * A Built-in Skill's name, description and one-line summary in the interface's
 * language. Pure, with no bridge, so a unit test reads it without a window.
 */
import type { MessageKey, MessageParams } from "../../shared/i18n";

/** The Built-in Skills described in the interface's language (see `skillDescription`). */
const BUILT_IN_DESCRIPTIONS: Readonly<Record<string, MessageKey>> = {
  chronology: "skills.builtIn.chronology",
  "cim-red-flags": "skills.builtIn.cim-red-flags",
  "covenant-summary": "skills.builtIn.covenant-summary",
  "credit-memo-outline": "skills.builtIn.credit-memo-outline",
  "deposition-summary": "skills.builtIn.deposition-summary",
  "earnings-review": "skills.builtIn.earnings-review",
  "literature-review": "skills.builtIn.literature-review",
  "mind-to-report": "skills.builtIn.mind-to-report",
  "summarise-document": "skills.builtIn.summarise-document",
};

const BUILT_IN_TITLES: Readonly<Record<string, MessageKey>> = {
  chronology: "skills.builtIn.chronology.title",
  "cim-red-flags": "skills.builtIn.cim-red-flags.title",
  "covenant-summary": "skills.builtIn.covenant-summary.title",
  "credit-memo-outline": "skills.builtIn.credit-memo-outline.title",
  "deposition-summary": "skills.builtIn.deposition-summary.title",
  "earnings-review": "skills.builtIn.earnings-review.title",
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
  chronology: "skills.builtIn.chronology.short",
  "cim-red-flags": "skills.builtIn.cim-red-flags.short",
  "covenant-summary": "skills.builtIn.covenant-summary.short",
  "credit-memo-outline": "skills.builtIn.credit-memo-outline.short",
  "deposition-summary": "skills.builtIn.deposition-summary.short",
  "earnings-review": "skills.builtIn.earnings-review.short",
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
