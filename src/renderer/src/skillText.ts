/**
 * A Built-in Skill's name, description and one-line summary in the interface's
 * language. Pure, with no bridge, so a unit test reads it without a window.
 */
import type { Language } from "../../core/language";
import { BUILT_IN_SKILL_NAMES } from "../../core/usageEvents";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { unitsOf } from "../../shared/i18n/join";

const builtInName = (name: string) => BUILT_IN_SKILL_NAMES.find((known) => known === name);

/** A Built-in Skill is called by its title in the interface's language; any other by its name. */
export function skillTitle(
  name: string,
  t: (key: MessageKey, params?: MessageParams) => string,
): string {
  const known = builtInName(name);
  return known ? t(`skills.builtIn.${known}.title`) : name;
}

/** The Built-in Skills the User removed, by title, as the button that restores them lists them. */
export const removedBuiltInsLine = (
  names: readonly string[],
  t: (key: MessageKey, params?: MessageParams) => string,
  language: Language,
): string =>
  t("skills.settings.restoreBuiltIns.hint", {
    names: unitsOf(
      names.map((name) => skillTitle(name, t)),
      language,
    ),
  });

export function skillShortLine(
  skill: { name: string; builtIn: boolean },
  t: (key: MessageKey, params?: MessageParams) => string,
): string | null {
  const known = skill.builtIn && builtInName(skill.name);
  return known ? t(`skills.builtIn.${known}.short`) : null;
}

/**
 * What a Skill does, for people: a Built-in Skill's in the interface's
 * language, any other's as its SKILL.md says (which is also what Answers read).
 */
export function skillDescription(
  skill: { name: string; description: string; builtIn: boolean },
  t: (key: MessageKey, params?: MessageParams) => string,
): string {
  const known = skill.builtIn && builtInName(skill.name);
  return known ? t(`skills.builtIn.${known}`) : skill.description;
}

/** The User's own Skills first, then the built-in ones, as Settings lists them: the order "/" and the + menu offer them in. */
export function skillsInListOrder<T extends { builtIn: boolean }>(skills: readonly T[]): T[] {
  return [...skills].sort((a, b) => Number(a.builtIn) - Number(b.builtIn));
}
