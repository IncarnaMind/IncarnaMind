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
const cite = (source: number | null, quote: string) => ({ source, quote });

const cancelled = {
  id: 2,
  kind: "action",
  status: "cancelled",
  text: "The cone order was cancelled.",
  quotes: [cite(1, "Cancel the cones")],
};
const added = {
  id: null,
  kind: "action",
  status: "active",
  text: "Park will book the van on Friday.",
  quotes: [cite(1, "park will book  the van on friday")],
};
const decision = {
  id: null,
  kind: "decision",
  status: "active",
  text: "Meet at the depot.",
  quotes: [cite(2, "We have agreed to meet at the depot")],
};
const reply = (changes: unknown[], unchanged?: unknown) =>
  JSON.stringify({
    summary: "We will meet at the depot.",
    changes,
    ...(unchanged !== undefined && { unchanged }),
  });

test("confirmed changes retain stable ids and preserve every unmentioned agreement and status", () => {
  const out = readMeetingSummaryUpdate(reply([cancelled, added, decision], [7]), draft);
  expect(out).toEqual({
    text: "We will meet at the depot.",
    evidence: { 2: cancelled.quotes, 8: added.quotes, 9: decision.quotes },
    items: [
      { id: 2, kind: "action", status: "cancelled", text: cancelled.text },
      draft.items?.[1],
      { id: 8, kind: "action", status: "active", text: added.text },
      { id: 9, kind: "decision", status: "active", text: decision.text },
    ],
  });
  expect(
    readMeetingSummaryUpdate(reply([], [7, 8, 9]), { ...draft, items: out.items }).items,
  ).toEqual(out.items);
  expect(draft.items?.[0]?.status).toBe("active");
});

test("an unrelated action cannot replace a saved decision by borrowing its id", () => {
  const input: MeetingSummaryInput = {
    ...draft,
    items: [{ id: 4, kind: "decision", status: "active", text: "Meet on Tuesday." }],
  };
  expect(() => readMeetingSummaryUpdate(reply([{ ...added, id: 4 }], []), input)).toThrow();
  expect(readMeetingSummaryUpdate(reply([added], [4]), input).items).toEqual([
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
    const spoken = reply([
      { id: null, kind: "action", status, text: "Return the samples.", quotes: [cite(1, quote)] },
    ]);
    const seeded = reply([
      {
        id: null,
        kind: "action",
        status,
        text: "Return the samples.",
        quotes: [cite(null, quote)],
      },
    ]);
    expect(
      readMeetingSummaryUpdate(spoken, { previous: null, utterances: [{ text: quote }] }).items,
    ).toEqual([{ id: 1, kind: "action", status, text: "Return the samples." }]);
    expect(() =>
      readMeetingSummaryUpdate(seeded, { previous: quote, utterances: [{ text: "Hello." }] }),
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
  const out = readMeetingSummaryUpdate(
    reply([{ ...previous, quotes: [cite(1, "Asha still has this.")] }], [7]),
    {
      ...draft,
      utterances: [{ text: "Asha still has this." }],
    },
  );
  expect(out.items).toEqual(draft.items);
  expect(out.evidence).toEqual({});
});

test("repeating an identical item needs no new evidence and cannot authorize a changed item", () => {
  const item = draft.items?.[0];
  if (!item) throw new Error("Missing action fixture");
  const repeated = { ...item, quotes: [cite(1, "Words absent from the new speech")] };
  const result = readMeetingSummaryUpdate(reply([repeated, decision], [7]), draft);
  expect(result.items[0]).toEqual(item);
  expect(Object.values(result.evidence)).toEqual([decision.quotes]);
  expect(() => readMeetingSummaryUpdate(reply([repeated, repeated], [7]), draft)).toThrow();
  expect(() =>
    readMeetingSummaryUpdate(reply([{ ...repeated, status: "done" }], [7]), draft),
  ).toThrow();
});

test("a repeated addition never supplies coverage or changes the saved item’s status or evidence", () => {
  const saved = { id: 2, kind: "action", status: "active", text: "Order the cones." } as const;
  const utterances = [{ text: "Order the cones. Cancel the cones." }];
  const input = { previous: null, items: [saved], utterances };
  const repeated = { ...saved, id: null, quotes: [cite(1, "Order the cones.")] };
  const unchanged = readMeetingSummaryUpdate(reply([repeated], [2]), input);
  expect(unchanged.items).toEqual([saved]);
  expect(unchanged.evidence).toEqual({});
  expect(() =>
    readMeetingSummaryUpdate(reply([{ ...repeated, quotes: [cite(1, "missing")] }], [2]), input),
  ).toThrow();
  expect(() =>
    readMeetingSummaryUpdate(reply([{ ...repeated, status: "done" }], [2]), input),
  ).toThrow();
  for (const changes of [
    [repeated, cancelled],
    [cancelled, repeated],
  ]) {
    expect(() => readMeetingSummaryUpdate(reply(changes, []), input)).toThrow();
  }
  expect(() => readMeetingSummaryUpdate(reply([repeated], []), input)).toThrow();
});

test("any update with active items accounts for every active item and can acknowledge earlier closed items", () => {
  const done = { id: 3, kind: "action", status: "done", text: "Return the cart." } as const;
  const withdrawn = { id: 5, kind: "action", status: "cancelled", text: "Book a lift." } as const;
  const input = { ...draft, items: [...(draft.items ?? []), done, withdrawn] };
  const updateWith = (unchanged: unknown) =>
    JSON.stringify({
      summary: "Only the cone order was cancelled.",
      changes: [cancelled],
      ...(unchanged !== undefined && { unchanged }),
    });
  const result = readMeetingSummaryUpdate(updateWith([7]), input);
  expect(result.items.map((item) => item.status)).toEqual([
    "cancelled",
    "active",
    "done",
    "cancelled",
  ]);
  expect(result.evidence).toEqual({ 2: cancelled.quotes });
  expect(readMeetingSummaryUpdate(updateWith([3, 5, 7]), input)).toEqual(result);
  for (const ids of [undefined, [], [3, 5], [7, 7], [7, 5, 5], [7, 2], [9, 7]]) {
    expect(() => readMeetingSummaryUpdate(updateWith(ids), input)).toThrow();
  }
  const noActiveInputs: MeetingSummaryInput[] = [
    { previous: null, utterances: draft.utterances },
    { ...draft, items: [] },
    { ...draft, items: [done, withdrawn] },
  ];
  for (const noActive of noActiveInputs) {
    expect(readMeetingSummaryUpdate(reply([]), noActive).items).toEqual(noActive.items ?? []);
    expect(() => readMeetingSummaryUpdate(reply([], []), noActive)).toThrow();
  }
});

test("previous visible prose can seed historical commitments once with null source; empty structured records disable that path", () => {
  const input = { previous: "周六之前由小林订场地。", utterances: [{ text: "先休息一下。" }] };
  const raw = reply([
    {
      id: null,
      kind: "action",
      status: "active",
      text: "小林周六之前订场地。",
      quotes: [cite(null, "小林订场地")],
    },
  ]);
  expect(readMeetingSummaryUpdate(raw, input)).toEqual({
    text: "We will meet at the depot.",
    items: [{ id: 1, kind: "action", status: "active", text: "小林周六之前订场地。" }],
    evidence: { 1: [cite(null, "小林订场地")] },
  });
  expect(() => readMeetingSummaryUpdate(raw, { ...input, items: [] })).toThrow();
});

test.each([
  {
    name: "English",
    lines: ["PARK will book", "the van.", "PARK will book"],
    sameSourceDuplicate: "park  will book",
    stitched: "Park will book the van.",
    combined: "PARK  will book\nthe van.",
    combinedQuote: "Park will book the van.",
    itemText: "Park will book the van on Friday.",
  },
  {
    name: "Chinese",
    lines: ["各组统计箱子数量", "周五前发给小李。", "各组统计箱子数量"],
    sameSourceDuplicate: "各组统计箱子数量",
    stitched: "各组统计箱子数量周五前发给小李。",
    combined: "各组统计箱子数量\n周五前发给小李。",
    combinedQuote: "各组统计箱子数量 周五前发给小李。",
    itemText: "各组周五前统计箱子数量并发给小李。",
  },
])(
  "each $name excerpt must match its exact numbered utterance and a change accepts 1 or 2 excerpts",
  ({ lines, sameSourceDuplicate, stitched, combined, combinedQuote, itemText }) => {
    const [first, second, third] = lines;
    if (!first || !second || !third) throw new Error("Expected three lines");
    const apart = { ...draft, utterances: lines.map((text) => ({ text })) };
    const change = (quotes: unknown[]) => ({
      id: null,
      kind: "action",
      status: "active",
      text: itemText,
      quotes,
    });

    expect(() =>
      readMeetingSummaryUpdate(reply([change([cite(1, stitched)])], [2, 7]), apart),
    ).toThrow();
    expect(() =>
      readMeetingSummaryUpdate(reply([change([cite(2, first)])], [2, 7]), apart),
    ).toThrow();
    expect(() =>
      readMeetingSummaryUpdate(reply([change([cite(4, first)])], [2, 7]), apart),
    ).toThrow();

    const paired = readMeetingSummaryUpdate(
      reply([change([cite(1, first), cite(2, second)])], [2, 7]),
      apart,
    );
    expect(paired.evidence).toEqual({ 8: [cite(1, first), cite(2, second)] });

    expect(
      readMeetingSummaryUpdate(
        reply([change([cite(1, first), cite(1, sameSourceDuplicate)])], [2, 7]),
        apart,
      ).evidence,
    ).toEqual({ 8: [cite(1, first)] });

    expect(
      readMeetingSummaryUpdate(reply([change([cite(1, first), cite(3, third)])], [2, 7]), apart)
        .evidence,
    ).toEqual({ 8: [cite(1, first), cite(3, third)] });

    expect(() =>
      readMeetingSummaryUpdate(
        reply([change([cite(1, first), cite(2, "missing second line")])], [2, 7]),
        apart,
      ),
    ).toThrow();
    expect(() =>
      readMeetingSummaryUpdate(
        reply([change([cite(1, first), cite(2, second), cite(3, third)])], [2, 7]),
        apart,
      ),
    ).toThrow();

    const together = { ...draft, utterances: [{ text: combined }] };
    expect(
      readMeetingSummaryUpdate(reply([change([cite(1, combinedQuote)])], [2, 7]), together)
        .evidence,
    ).toEqual({ 8: [cite(1, combinedQuote)] });
  },
);

test("typographic apostrophes denote the same quote without dropping significant punctuation", () => {
  const input = { ...draft, utterances: [{ text: "Cancel Karim’s booking； budget is 3.6万." }] };
  const quote = "cancel Karim's booking; budget";
  expect(
    readMeetingSummaryUpdate(reply([{ ...cancelled, quotes: [cite(1, quote)] }], [7]), input)
      .evidence,
  ).toEqual({
    2: [cite(1, quote)],
  });
  expect(() =>
    readMeetingSummaryUpdate(
      reply([{ ...cancelled, quotes: [cite(1, "budget is 36万")] }], [7]),
      input,
    ),
  ).toThrow();
});

test.each([
  [cancelled, { ...added, id: 4 }],
  [cancelled, { ...cancelled, status: "done" }],
  [added, added],
  [added, { ...decision, id: 8 }],
  [{ ...added, id: 0 }],
  [{ ...added, id: 1.5 }],
  [{ ...cancelled, quotes: [cite(null, "Asha will order cones")] }],
  [{ ...cancelled, quotes: [cite(1, "Asha never bought any cones")] }],
  [{ ...cancelled, quotes: [cite(2, "Cancel the cones")] }],
  [{ ...cancelled, quotes: [cite(0, "Cancel the cones")] }],
  [{ ...cancelled, quotes: [cite(-1, "Cancel the cones")] }],
  [{ ...cancelled, quotes: [cite(1.5, "Cancel the cones")] }],
  [{ ...cancelled, quotes: [cite(3, "Cancel the cones")] }],
  [{ ...cancelled, quotes: [] }],
  [{ ...cancelled, quotes: [cite(1, "  ")] }],
  [{ ...cancelled, quotes: [cite(1, "Cancel the cones"), cite(1, "  ")] }],
  [{ ...cancelled, quotes: ["Cancel the cones"] }],
  [{ ...cancelled, quotes: [{ source: 1, quote: "Cancel the cones", extra: true }] }],
  [
    {
      id: cancelled.id,
      kind: cancelled.kind,
      status: cancelled.status,
      text: cancelled.text,
      quote: "Cancel the cones",
    },
  ],
  [{ ...cancelled, text: "  " }],
  [{ ...cancelled, unsupported: true }],
  [{ ...cancelled, text: "Ben will collect the keys." }],
])("rejects a malformed or conflicting edit atomically", (...changes) => {
  const before = structuredClone(draft);
  expect(() => readMeetingSummaryUpdate(reply(changes, [7]), draft)).toThrow();
  expect(draft).toEqual(before);
});

test.each([
  "plain paragraph",
  "```json\n{}\n```",
  '{"summary":"", "changes":[]}',
  '{"summary":"So far","changes":[],"items":[]}',
  '{"summary":"So far"}',
  '{"summary":"So far","changes":[]}',
])("rejects an unreadable response rather than erasing the old summary", (raw) => {
  expect(() => readMeetingSummaryUpdate(raw, draft)).toThrow();
});
