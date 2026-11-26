/**
 * Pure formatting helpers for AI-proposed deck changes and their confirmed receipts (#149 part 2).
 */
import type { DeckProposalItem } from "../../../../core/api";
import type { Language } from "../../../../core/language";
import { formatDateTime } from "../../../../shared/dates";
import type { MessageKey, MessageParams } from "../../../../shared/i18n/types";

export interface DeckReceipt {
  undoId: string;
  unchanged: number;
  changed: number;
  total: number;
  letGo?: readonly string[];
}

export type DeckTranslate = (key: MessageKey, params?: MessageParams) => string;

/** Plain, human-readable label for a proposed change's place on a slide (never raw "Text 0"). */
export function formatDeckPlace(item: DeckProposalItem, t: DeckTranslate): string {
  const base = t(`viewer.deck.place.${item.placeKind}`);
  if (item.change.kind === "notes") return base;
  if (item.change.kind === "chartSeries") {
    const series = item.seriesName
      ? t("viewer.deck.proposal.series", { name: item.seriesName })
      : null;
    const head = item.shapeLabel || base;
    return series ? `${head} · ${series}` : head;
  }
  if (item.change.kind === "cell" && item.cell) {
    const where = t("viewer.deck.proposal.cell", {
      row: item.cell.row,
      col: item.cell.column,
    });
    return `${base} · ${where}`;
  }
  if (item.placeKind === "title" || item.placeKind === "subtitle" || item.placeKind === "footer") {
    return base;
  }
  return item.shapeLabel ? `${base} “${item.shapeLabel}”` : base;
}

export function formatDeckReceipt(
  receipt: DeckReceipt,
  t: DeckTranslate,
  language: Language,
): string {
  const base =
    receipt.unchanged === 0
      ? t("viewer.deck.proposal.receipt.all", { changed: receipt.changed })
      : receipt.unchanged === 1
        ? t("viewer.deck.proposal.receipt.one", { changed: receipt.changed })
        : t("viewer.deck.proposal.receipt", {
            unchanged: receipt.unchanged,
            changed: receipt.changed,
          });
  const letGo = receipt.letGo?.[0];
  return letGo
    ? `${base} ${t("viewer.deck.saved.letGo", { date: formatDateTime(letGo, language) })}`
    : base;
}
