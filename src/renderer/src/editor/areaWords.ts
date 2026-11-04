import type { AskedQuote } from "../../../core/api";
import { badgeMessage, type CitationState } from "../../../shared/citations";
import { citationLocation, formatLocation, type Translate } from "../../../shared/locations";

/** An area's chip says "Figure · p. 7", or just "Figure" where its Location names no place. */
export function areaLabel(quote: AskedQuote, t: Translate): { where: string; label: string } {
  const location = citationLocation(quote);
  const where = location ? formatLocation(location, t) : "";
  return {
    where,
    label: where ? t("composer.chip.area", { location: where }) : t("composer.chip.figure"),
  };
}

/** The check an area's chip shows: the figure's words found, or its Citation's own badge, worded by its reason. */
export function areaCheck(quote: AskedQuote, where: string, t: Translate): string {
  if (!quote.check) return "";
  if (quote.check === "found") {
    return where
      ? t("composer.chip.areaFound", { location: where })
      : t("composer.chip.areaFoundHere");
  }
  const state: CitationState = {
    check: quote.check,
    reason: quote.checkReason ?? null,
    documentId: quote.documentId,
    changedAfterCited: false,
  };
  const message = badgeMessage(state, quote, t);
  return t(message.key, message.params);
}
