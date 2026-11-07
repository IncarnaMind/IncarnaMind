import type { Language } from "../../../core/language";
import type { Translate } from "../../../shared/locations";

/**
 * "2 opinions and 1 sentence about this note left out": each part a check left out counts once,
 * an opinion or a sentence about the note itself (#2525), each named as what it is.
 */
export function leftOutWords(
  opinions: number,
  itself: number,
  t: Translate,
  language: Language,
): string {
  const count = (value: number) => new Intl.NumberFormat(language).format(value);
  const many = (value: number) => (value === 1 ? "one" : "other");
  if (itself === 0)
    return t(opinions === 1 ? "opinions.one" : "opinions.count", { count: count(opinions) });
  if (opinions === 0)
    return t(itself === 1 ? "opinions.itself.one" : "opinions.itself", { count: count(itself) });
  return t(`opinions.both.${many(opinions)}.${many(itself)}`, {
    opinions: count(opinions),
    itself: count(itself),
  });
}
