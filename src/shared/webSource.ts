import type { Language } from "../core/language";
import { formatDate, formatShortDate } from "./dates";
import type { Translate } from "./locations";
import { shortenMiddle } from "./naming";

const CARD_ADDRESS_LENGTH = 40;

/**
 * Where a saved web page came from, for the source line: "Saved web page · {address} · saved {date}".
 * `compact` (a card): the address cut in the middle, the year left out of this year's date. Otherwise
 * (a record, a CSV): the address whole, the date with its year.
 */
export function savedPageSource(
  page: { address: string; savedAt: string },
  language: Language,
  t: Translate,
  { compact }: { compact: boolean },
): string {
  return t("webPages.source", {
    address: compact ? shortenMiddle(page.address, CARD_ADDRESS_LENGTH) : page.address,
    date: (compact ? formatShortDate : formatDate)(page.savedAt, language),
  });
}
