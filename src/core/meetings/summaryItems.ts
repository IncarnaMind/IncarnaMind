import { z } from "zod";
import type { MeetingSummaryItem } from "../api";
import { TranslatableError } from "../errors";
import { type NumberedSummaryQuote, normalizeSummaryEvidence } from "./summaryEvidence";
import { hasActiveSummaryItems, type MeetingSummaryInput } from "./summaryModel";

export { normalizeSummaryEvidence } from "./summaryEvidence";

const text = z.string().trim().min(1);
const evidenceQuote = z.strictObject({
  source: z.int().positive().nullable(),
  quote: text,
});
const update = z.strictObject({
  summary: text,
  unchanged: z.array(z.int().positive()).optional(),
  changes: z.array(
    z.strictObject({
      id: z.int().positive().nullable(),
      kind: z.enum(["decision", "action"]),
      status: z.enum(["active", "done", "cancelled"]),
      text,
      quotes: z.array(evidenceQuote).min(1).max(2),
    }),
  ),
});

function invalid(): never {
  throw new TranslatableError({ key: "error.meeting.summaryIncomplete" });
}

export function readMeetingSummaryUpdate(
  raw: string,
  input: MeetingSummaryInput,
  lastReservedId = 0,
): { text: string; items: MeetingSummaryItem[]; evidence: Record<number, NumberedSummaryQuote[]> } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return invalid();
  }
  const reply = update.safeParse(json);
  if (!reply.success) return invalid();

  const speech = input.utterances.map(({ text }) => normalizeSummaryEvidence(text));
  // Before structured items existed, an earlier visible summary could be the only record of an agreement.
  const historical =
    input.items === undefined && input.previous ? normalizeSummaryEvidence(input.previous) : "";
  const existing = new Map(input.items?.map((item) => [item.id, item]));
  const updated = new Map(existing);
  const evidence: Record<number, NumberedSummaryQuote[]> = {};
  const touched = new Set<number>();
  const addressed = new Set(reply.data.changes.map((change) => change.id));
  let nextId = lastReservedId + 1;
  for (const id of existing.keys()) nextId = Math.max(nextId, id + 1);
  for (const change of reply.data.changes) {
    if (change.id !== null) {
      const prior = existing.get(change.id);
      if (!prior || prior.kind !== change.kind || touched.has(change.id)) return invalid();
      touched.add(change.id);
      if (prior.status === change.status && prior.text === change.text) continue;
    }
    const cited: NumberedSummaryQuote[] = [];
    const seen = new Set<string>();
    for (const entry of change.quotes) {
      const quote = normalizeSummaryEvidence(entry.quote);
      if (entry.source === null) {
        if (change.status !== "active" || !historical.includes(quote)) return invalid();
      } else {
        const line = speech[entry.source - 1];
        if (line === undefined || !line.includes(quote)) return invalid();
      }
      const key = `${entry.source ?? "previous"}:${quote}`;
      if (!seen.has(key)) {
        seen.add(key);
        cited.push({ source: entry.source, quote: entry.quote });
      }
    }
    if (change.id === null) {
      const repeat = input.items?.find(
        (item) =>
          item.kind === change.kind && item.status === change.status && item.text === change.text,
      );
      if (repeat) {
        if (addressed.has(repeat.id)) return invalid();
        continue;
      }
    }
    const id = change.id ?? nextId++;
    if (!Number.isSafeInteger(id)) return invalid();
    updated.set(id, { id, kind: change.kind, status: change.status, text: change.text });
    evidence[id] = cited;
  }
  if (hasActiveSummaryItems(input.items)) {
    if (!reply.data.unchanged) return invalid();
    for (const id of reply.data.unchanged) {
      if (!existing.has(id) || touched.has(id)) return invalid();
      touched.add(id);
    }
    if (input.items?.some((item) => item.status === "active" && !touched.has(item.id))) {
      return invalid();
    }
  } else if (reply.data.unchanged !== undefined) {
    return invalid();
  }
  const descriptions = new Set<string>();
  for (const item of updated.values()) {
    const description = JSON.stringify([item.kind, normalizeSummaryEvidence(item.text)]);
    if (descriptions.has(description)) return invalid();
    descriptions.add(description);
  }
  return { text: reply.data.summary, items: [...updated.values()], evidence };
}
