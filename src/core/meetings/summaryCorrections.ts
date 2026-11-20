import { z } from "zod";
import type { MeetingSummary, MeetingSummaryItem } from "../api";
import { InvalidInputError } from "../errors";
import type { StoredMeetingSummary } from "./liveSummary";
import type { StoredSummaryQuote } from "./summaryEvidence";

const fields = z.strictObject({
  kind: z.enum(["decision", "action"]),
  status: z.enum(["active", "done", "cancelled"]),
  text: z.string().trim().min(1),
});
const replacement = fields.extend({ restoreGenerated: z.literal(true).optional() });
const expected = fields.extend({
  id: z.int().positive(),
  corrected: z.literal(true).optional(),
});

interface ItemEvidence {
  documentId: string;
  quotes: readonly StoredSummaryQuote[];
}

interface Correction {
  item: MeetingSummaryItem;
  source: ItemEvidence | null;
}

export function readCorrections(json: string | null): Correction[] {
  return json === null ? [] : (JSON.parse(json) as Correction[]);
}

export function visibleSummary(
  stored: StoredMeetingSummary | null,
  corrections: readonly Correction[],
): MeetingSummary | undefined {
  if (!stored || !corrections.length) return stored?.summary;
  const items = new Map(stored.summary.items?.map((item) => [item.id, item]));
  for (const { item } of corrections) items.set(item.id, { ...item, corrected: true });
  return { ...stored.summary, items: [...items.values()] };
}

export function itemEvidence(
  stored: StoredMeetingSummary | null,
  corrections: readonly Correction[],
  id: number,
): ItemEvidence | null {
  const correction = corrections.find(({ item }) => item.id === id);
  if (correction) return correction.source;
  const quotes = stored?.evidence?.[id];
  return stored?.documentId &&
    quotes?.length &&
    stored.summary.items?.some((item) => item.id === id)
    ? { documentId: stored.documentId, quotes }
    : null;
}

const sameWords = (
  a: MeetingSummaryItem,
  b: Pick<MeetingSummaryItem, "text" | "kind" | "status">,
) => a.text === b.text && a.kind === b.kind && a.status === b.status;

export function correctItem(
  stored: StoredMeetingSummary,
  corrections: Correction[],
  was: unknown,
  next: unknown,
): Correction[] {
  const before = expected.safeParse(was);
  const after = replacement.safeParse(next);
  if (!before.success || !after.success)
    throw new InvalidInputError({ key: "error.meeting.summaryItemInvalid" });
  const { id } = before.data;
  const current = visibleSummary(stored, corrections)?.items?.find((item) => item.id === id);
  if (!current || !sameWords(current, before.data) || current.corrected !== before.data.corrected)
    throw new InvalidInputError({ key: "error.meeting.summaryItemChanged" });
  const { restoreGenerated, ...fieldsToSave } = after.data;
  const rest = corrections.filter((entry) => entry.item.id !== id);
  if (restoreGenerated) {
    const ai = stored.summary.items?.find((item) => item.id === id);
    if (ai && sameWords(ai, fieldsToSave)) return current.corrected ? rest : corrections;
  }
  if (current.corrected && sameWords(current, fieldsToSave)) return corrections;
  return [
    ...rest,
    { item: { id, ...fieldsToSave }, source: itemEvidence(stored, corrections, id) },
  ];
}
