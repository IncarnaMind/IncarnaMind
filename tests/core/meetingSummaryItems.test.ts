import { expect, test } from "vitest";
import { readMeetingSummaryUpdate } from "../../src/core/meetings/summaryItems";
import type { MeetingSummaryInput } from "../../src/core/meetings/summaryModel";

const draft: MeetingSummaryInput = {
  previous: "Asha will order cones by Monday. Ben will collect the keys.",
  items: [
    { id: 2, kind: "action", status: "active", text: "Asha will order cones by Monday." },
    { id: 7, kind: "action", status: "active", text: "Ben will collect the keys." },
  ],
  utterances: [
    { text: "Cancel the cones; Park will book the van on Friday." },
    { text: "We have agreed to meet at the depot." },
  ],
};
const cancelled = {
  id: 2,
  kind: "action",
  status: "cancelled",
  text: "The cone order was cancelled.",
  quote: "Cancel the cones",
};
const added = {
  id: null,
  kind: "action",
  status: "active",
  text: "Park will book the van on Friday.",
  quote: "park will book  the van on friday",
};
const decision = {
  id: null,
  kind: "decision",
  status: "active",
  text: "Meet at the depot.",
  quote: "We have agreed to meet at the depot",
};
const reply = (changes: unknown[]) =>
  JSON.stringify({ summary: "We will meet at the depot.", changes });

test("confirmed changes retain stable ids and preserve every unmentioned agreement and status", () => {
  const out = readMeetingSummaryUpdate(reply([cancelled, added, decision]), draft);
  expect(out).toEqual({
    text: "We will meet at the depot.",
    evidence: { 2: cancelled.quote, 8: added.quote, 9: decision.quote },
    items: [
      { id: 2, kind: "action", status: "cancelled", text: cancelled.text },
      draft.items?.[1],
      { id: 8, kind: "action", status: "active", text: added.text },
      { id: 9, kind: "decision", status: "active", text: decision.text },
    ],
  });
  expect(readMeetingSummaryUpdate(reply([]), { ...draft, items: out.items }).items).toEqual(
    out.items,
  );
  expect(draft.items?.[0]?.status).toBe("active");
});

test("an unrelated action cannot replace a saved decision by borrowing its id", () => {
  const input: MeetingSummaryInput = {
    ...draft,
    items: [{ id: 4, kind: "decision", status: "active", text: "Meet on Tuesday." }],
  };
  expect(() => readMeetingSummaryUpdate(reply([{ ...added, id: 4 }]), input)).toThrow();
  expect(readMeetingSummaryUpdate(reply([added]), input).items).toEqual([
    input.items?.[0],
    { id: 5, kind: "action", status: "active", text: added.text },
  ]);
});

test.each(["done", "cancelled"])(
  "records a concrete task first heard as %s only with evidence from current speech",
  (status) => {
    const quote =
      status === "done"
        ? "The team already returned the samples."
        : "The team called off the return.";
    const update = reply([
      { id: null, kind: "action", status, text: "Return the samples.", quote },
    ]);
    expect(
      readMeetingSummaryUpdate(update, { previous: null, utterances: [{ text: quote }] }).items,
    ).toEqual([{ id: 1, kind: "action", status, text: "Return the samples." }]);
    expect(() =>
      readMeetingSummaryUpdate(update, { previous: quote, utterances: [{ text: "Hello." }] }),
    ).toThrow();
  },
);

test("a repeated unchanged commitment retains its original evidence", () => {
  const previous = {
    id: 2,
    kind: "action",
    status: "active",
    text: "Asha will order cones by Monday.",
  };
  const out = readMeetingSummaryUpdate(reply([{ ...previous, quote: "Asha still has this." }]), {
    ...draft,
    utterances: [{ text: "Asha still has this." }],
  });
  expect(out.items).toEqual(draft.items);
  expect(out.evidence).toEqual({});
});

test("repeating an identical item needs no new evidence and cannot authorize a changed item", () => {
  const item = draft.items?.[0];
  if (!item) throw new Error("Missing action fixture");
  const repeated = { ...item, quote: "Words absent from the new speech" };
  const result = readMeetingSummaryUpdate(reply([repeated, decision]), draft);
  expect(result.items[0]).toEqual(item);
  expect(Object.values(result.evidence)).toEqual([decision.quote]);
  expect(() => readMeetingSummaryUpdate(reply([repeated, repeated]), draft)).toThrow();
  expect(() => readMeetingSummaryUpdate(reply([{ ...repeated, status: "done" }]), draft)).toThrow();
});

test("the closing update accounts for every prior active item exactly once", () => {
  const input = { ...draft, closing: true };
  const close = (unchanged: unknown) =>
    JSON.stringify({
      summary: "Only the cone order was cancelled.",
      changes: [cancelled],
      unchanged,
    });
  expect(readMeetingSummaryUpdate(close([7]), input).items.map((item) => item.status)).toEqual([
    "cancelled",
    "active",
  ]);
  for (const ids of [undefined, [], [7, 7], [7, 2], [9, 7]]) {
    expect(() => readMeetingSummaryUpdate(close(ids), input)).toThrow();
  }
  expect(() => readMeetingSummaryUpdate(close([7]), draft)).toThrow();
});

test("previous visible prose can seed historical commitments once; empty structured records disable that path", () => {
  const input = { previous: "周六之前由小林订场地。", utterances: [{ text: "先休息一下。" }] };
  const raw = reply([
    {
      id: null,
      kind: "action",
      status: "active",
      text: "小林周六之前订场地。",
      quote: "小林订场地",
    },
  ]);
  expect(readMeetingSummaryUpdate(raw, input).items).toEqual([
    { id: 1, kind: "action", status: "active", text: "小林周六之前订场地。" },
  ]);
  expect(() => readMeetingSummaryUpdate(raw, { ...input, items: [] })).toThrow();
});

test("an evidence quote must occur within one utterance; whitespace inside that speech can vary", () => {
  const apart = {
    ...draft,
    utterances: [{ text: "PARK will book" }, { text: "the van." }, { text: "By Friday." }],
  };
  expect(() =>
    readMeetingSummaryUpdate(reply([{ ...added, quote: "Park will book the van." }]), apart),
  ).toThrow();
  const together = { ...draft, utterances: [{ text: "PARK  will book\nthe van." }] };
  const quote = "Park will book the van.";
  expect(readMeetingSummaryUpdate(reply([{ ...added, quote }]), together).evidence).toEqual({
    8: quote,
  });
});
test("typographic apostrophes denote the same quote without dropping significant punctuation", () => {
  const input = { ...draft, utterances: [{ text: "Cancel Karim’s booking； budget is 3.6万." }] };
  const quote = "cancel Karim's booking; budget";
  expect(readMeetingSummaryUpdate(reply([{ ...cancelled, quote }]), input).evidence).toEqual({
    2: quote,
  });
  expect(() =>
    readMeetingSummaryUpdate(reply([{ ...cancelled, quote: "budget is 36万" }]), input),
  ).toThrow();
});

test.each([
  [cancelled, { ...added, id: 4 }],
  [cancelled, { ...cancelled, status: "done" }],
  [added, added],
  [added, { ...decision, id: 8 }],
  [{ ...added, id: 0 }],
  [{ ...added, id: 1.5 }],
  [{ ...cancelled, quote: "Asha will order cones" }],
  [{ ...cancelled, quote: "Asha never bought any cones" }],
  [{ ...cancelled, quote: "  " }],
  [{ ...cancelled, text: "  " }],
  [{ ...cancelled, unsupported: true }],
  [{ ...cancelled, text: "Ben will collect the keys." }],
])("rejects a malformed or conflicting edit atomically", (...changes) => {
  const before = structuredClone(draft);
  expect(() => readMeetingSummaryUpdate(reply(changes), draft)).toThrow();
  expect(draft).toEqual(before);
});

test.each([
  "plain paragraph",
  "```json\n{}\n```",
  '{"summary":"", "changes":[]}',
  '{"summary":"So far","changes":[],"items":[]}',
  '{"summary":"So far"}',
])("rejects an unreadable response rather than erasing the old summary", (raw) => {
  expect(() => readMeetingSummaryUpdate(raw, draft)).toThrow();
});
