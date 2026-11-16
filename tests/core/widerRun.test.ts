/**
 * Check this Note checks twelve sentences at once only where the AI service's replies state the
 * key has room for the whole Note and it has answered six large requests, and six everywhere else
 * (#2532), on scripted keys.
 */
import { expect, test } from "vitest";
import { type KeyShape, measuredKey } from "../helpers/scriptedKeys";
import { type KeyWrite, keyNotes } from "../helpers/writeChecked";

const REPLY_MS = 1000;

/** When each sentence's check was out: from its first request, refused or not, to its last reply. */
function checksOut({ timeline }: KeyWrite): { from: number; to: number }[] {
  const out = new Map<string, { from: number; to: number }>();
  for (const entry of timeline) {
    const [at, request, refused] = entry.split(" ");
    const sentence = request?.split(":")[0] ?? "";
    const span = out.get(sentence) ?? { from: Number(at), to: Number(at) };
    if (!refused) span.to = Number(at) + REPLY_MS;
    out.set(sentence, span);
  }
  return [...out.values()];
}

/** How many sentences' checks were out as each began, itself counted; `after`: those begun later than that. */
const outAsEachBegan = (note: KeyWrite, after = -1): number[] => {
  const out = checksOut(note);
  return out
    .filter((each) => each.from > after)
    .map((each) => out.filter((other) => other.from <= each.from && each.from < other.to).length);
};

const firstRefusal = ({ timeline }: KeyWrite) =>
  Number(timeline.find((entry) => entry.endsWith("refused"))?.split(" ")[0]);

const only = (notes: KeyWrite[]): KeyWrite => {
  const [note] = notes;
  if (!note) throw new Error("No Note was checked.");
  return note;
};

const ROOMY: KeyShape = { kind: "bucket", holds: 1000, refillsPerReply: 1000 };

// protects=a Note checked on a key whose replies state room for all its sentences has twelve sentences' checks out at once, and only after the first six's requests carrying search results were answered, while the same key stating nothing has six, every mark landing either way and the wide check ending sooner; fails_when=a key that states nothing is sent more than six at once, a key that states its room never gets more than six, or the check widens before the service has answered six large requests; no_claim=how soon a real service's headers arrive, or what a real key takes.
test("a key that states room for the Note is sent twelve at once, one that states nothing six", async () => {
  const stated = only(await keyNotes(12, REPLY_MS, ROOMY, true, 1));
  const silent = only(await keyNotes(12, REPLY_MS, ROOMY, false, 1));

  expect(stated).toMatchObject({ refused: 0, marks: { supported: 12 } });
  expect(silent).toMatchObject({ refused: 0, marks: { supported: 12 } });
  expect(Math.max(...outAsEachBegan(stated))).toBe(12);
  expect(Math.max(...outAsEachBegan(silent))).toBe(6);
  // The seventh sentence waits for the first six's second requests, which carry what was found.
  expect(checksOut(stated)[6]?.from).toBe(REPLY_MS);
  expect(stated.end).toBeLessThan(silent.end);
});

// protects=a key that states less than the Note's sentences could take, in requests (100 for 12 sentences at 9 each) or in input tokens (300,000 a minute for 12 sentences at 30,000 each), is sent six at once, as before; fails_when=the check widens on room smaller than the Note needs, in either count; no_claim=that 9 requests and 30,000 tokens a sentence are the right sizes for every Library.
test("a key that states less than the Note needs is sent six at once", async () => {
  const fewRequests = only(
    await keyNotes(12, REPLY_MS, { kind: "bucket", holds: 100, refillsPerReply: 100 }, true, 1),
  );
  const fewTokens = only(await keyNotes(12, REPLY_MS, measuredKey(300_000, 1), true, 1));

  for (const short of [fewRequests, fewTokens]) {
    expect(short).toMatchObject({ refused: 0, marks: { supported: 12 } });
    expect(Math.max(...outAsEachBegan(short))).toBe(6);
  }
});

// protects=a key that states a minute's room but refuses the check's large requests at six at once is never sent more than six sentences at once, and every mark still lands; fails_when=the check widens on the stated room alone, before the large requests have gone through; no_claim=a key that takes six large requests and refuses twelve, which the next test covers.
test("a key that states room and refuses large requests at six stays at six", async () => {
  const note = only(await keyNotes(12, REPLY_MS, measuredKey(2_000_000, 1 / 60), true, 1));

  expect(note.refused).toBeGreaterThan(0);
  expect(note.marks).toEqual({ supported: 12 });
  expect(Math.max(...outAsEachBegan(note))).toBe(6);
});

// protects=on a key that takes six large requests at once and refuses twelve, the check widens, is refused, and from that refusal on begins a sentence only while fewer than six others are out, every mark still landing; fails_when=the check keeps beginning sentences past six after a refusal, or a refused sentence ends Not checked; no_claim=that the sentences already out when the refusal came are taken back, which they aren't.
test("a refusal takes the check back to six at once, and every mark still lands", async () => {
  const note = only(await keyNotes(30, REPLY_MS, measuredKey(6_000_000, 1 / 60), true, 1));

  expect(Math.max(...outAsEachBegan(note))).toBeGreaterThan(6);
  expect(note.refused).toBeGreaterThan(0);
  expect(note.marks).toEqual({ supported: 30 });
  const later = outAsEachBegan(note, firstRefusal(note));
  expect(later.length).toBeGreaterThan(0);
  expect(Math.max(...later)).toBeLessThanOrEqual(6);
});
