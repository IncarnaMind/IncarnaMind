import { type Figure, type FigureContext, readFigures } from "../../../shared/figures";
import { type MessageKey, type MessageParams, translate } from "../../../shared/i18n";
import { LIBRARY_FACTS } from "../../../shared/libraryFacts";
import type { Citation, UnsupportedReason } from "../../api";
import type { AnswerDocuments } from "../citations";
import type { ClaimCheckDependencies } from "./claimCheck";
import { type BoundNumber, type CheckedText, unitNotStated } from "./units";

export function checkedTextOf(
  citation: Citation,
  pageTexts: ClaimCheckDependencies["documents"]["pageTexts"],
): CheckedText {
  const text = (from: number | null, to: number | null) =>
    pageTexts(citation.documentId, citation.contentHash, from, to)
      .map((unit) => unit.text)
      .join("\n");
  return {
    cited: () =>
      citation.pageFrom === null ? citation.quote : text(citation.pageFrom, citation.pageTo),
    document: () => text(null, null),
    gateReads: true,
  };
}

/**
 * Why a sentence's quotes don't back a unit, currency or scale it states, with the one quote that
 * gives its amount; `decides` when the reason stands even over a contradiction: a Document that
 * doesn't say the currency neither backs nor contradicts one (#2226).
 */
export function unitGate(
  deps: Pick<ClaimCheckDependencies, "language">,
  documents: Pick<AnswerDocuments, "pageTexts">,
  figureContext: (citation: Citation) => FigureContext,
  /**
   * Whether it reads what the Document leaves unsaid: which dollar a bare "$" is, the yuan sign,
   * and a unit, currency or scale stated nowhere for the figure. An Answer's check doesn't: its
   * Chinese replies write 美元 for a bare "$" (#3030), and "not found" in a table is no evidence
   * that the Document doesn't say it (#2997).
   */
  unsaid = true,
) {
  return (
    citations: readonly Citation[],
    claim: string,
    bound?: readonly BoundNumber[],
    worked?: readonly Figure[],
  ): { why: UnsupportedReason; quote: Citation | null; decides: boolean } | null => {
    const checked = citations.map((citation) => ({
      citation,
      ...checkedTextOf(citation, documents.pageTexts),
    }));
    const found = unitNotStated(claim, checked, bound, worked, unsaid);
    if (!found) return null;
    const t = (key: MessageKey, params?: MessageParams) => translate(deps.language(), key, params);
    const { amount } = found;
    const candidates = checked
      .filter((text) => found.matches.some((each) => each.text === text))
      .map(({ citation }) => citation);
    const unique = new Map(
      candidates.map((citation) => [
        JSON.stringify([
          citation.documentId,
          citation.contentHash,
          citation.passageId,
          citation.pageFrom,
          citation.pageTo,
          citation.location,
          citation.quote,
        ]),
        citation,
      ]),
    );
    const repeated = found.matches.some((each, at) =>
      found.matches
        .slice(0, at)
        .some((earlier) => earlier.text === each.text && earlier.start !== each.start),
    );
    const single = !repeated && unique.size === 1 ? (unique.values().next().value ?? null) : null;
    const quote =
      single &&
      readFigures(single.quote, { ...figureContext(single), midLine: true }).some(
        (figure) => figure.chars === amount,
      )
        ? single
        : null;
    const problem = (why: UnsupportedReason, decides = false) => ({ why, quote, decides });
    if (found.kind === "which dollar" || found.kind === "yuan sign") {
      const document = candidates[0]?.documentName ?? "";
      const key =
        found.kind === "which dollar"
          ? "claim.unsupported.whichDollar"
          : "claim.unsupported.yuanSign";
      // The Document doesn't say the currency, so it neither backs nor contradicts one (#2226).
      const reason = t(key, { document, amount });
      return problem({ reason, covered: null, uncovered: null, found: true }, true);
    }
    // A Library fact's number is the Library's, not a Document's (#2525).
    const unitKey =
      candidates.length > 0 && candidates.every((each) => each.documentId === LIBRARY_FACTS)
        ? "claim.unsupported.unit.library"
        : "claim.unsupported.unit";
    if (found.kind === "scale") {
      return problem({
        found: true,
        reason: t(unitKey, { amount, figure: found.figure }),
        covered: t("claim.unsupported.currency.covered", { amount }),
        uncovered: t("claim.unsupported.scale.uncovered", { figure: found.figure }),
      });
    }
    if (found.kind === "unit") {
      const reason = t(unitKey, { amount, figure: found.figure });
      return problem({ reason, covered: null, uncovered: null, found: true });
    }
    return problem({
      found: true,
      reason: t("claim.unsupported.currency.reason", { amount }),
      covered: t("claim.unsupported.currency.covered", { amount }),
      uncovered: t("claim.unsupported.currency.uncovered", { currency: found.currency }),
    });
  };
}

export type UnitGate = ReturnType<typeof unitGate>;
