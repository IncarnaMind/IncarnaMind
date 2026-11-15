/**
 * Check this Note checks twelve sentences at once only where the AI service's replies state the
 * key has room for the whole Note, and six everywhere else (#2532), on scripted keys.
 */
import { expect, test } from "vitest";
import type { KeyShape } from "../helpers/scriptedKeys";
import { type KeyWrite, keyNotes } from "../helpers/writeChecked";

const REPLY_MS = 1000;

/** How many check requests were out at once at the most, each taking `REPLY_MS`. */
function mostAtOnce({ timeline }: KeyWrite): number {
  const sent = timeline.flatMap((entry) =>
    entry.endsWith("refused") ? [] : [parseInt(entry, 10)],
  );
  return Math.max(
    ...sent.map((at) => sent.filter((other) => other <= at && at < other + REPLY_MS).length),
  );
}

const ROOMY: KeyShape = { kind: "bucket", holds: 1000, refillsPerReply: 1000 };

// protects=a Note checked on a key whose replies state room for all its sentences has twelve check requests out at once, and the same key stating nothing has six, every mark landing either way; fails_when=a key that states nothing is sent more than six at once, or a key that states its room never gets more than six; no_claim=how soon a real service's headers arrive, or what a real key takes.
test("a key that states room for the Note is sent twelve at once, one that states nothing six", async () => {
  const [stated] = await keyNotes(12, REPLY_MS, ROOMY, true, 1);
  const [silent] = await keyNotes(12, REPLY_MS, ROOMY, false, 1);

  expect(stated).toMatchObject({ refused: 0, marks: { supported: 12 } });
  expect(silent).toMatchObject({ refused: 0, marks: { supported: 12 } });
  expect(mostAtOnce(stated as KeyWrite)).toBe(12);
  expect(mostAtOnce(silent as KeyWrite)).toBe(6);
  expect((stated as KeyWrite).end).toBeLessThan((silent as KeyWrite).end);
});

// protects=a key that states less than the Note's sentences could take (here 100 requests for 12 sentences at 9 each) is sent six at once, as before; fails_when=the check widens on room smaller than the Note needs; no_claim=that 9 requests and 30,000 tokens a sentence are the right sizes for every Library.
test("a key that states less than the Note needs is sent six at once", async () => {
  const [short] = await keyNotes(
    12,
    REPLY_MS,
    { kind: "bucket", holds: 100, refillsPerReply: 100 },
    true,
    1,
  );

  expect(short).toMatchObject({ refused: 0, marks: { supported: 12 } });
  expect(mostAtOnce(short as KeyWrite)).toBe(6);
});

// protects=a key that states a minute's room but takes only a second's worth at once refuses part of the twelve, and from that refusal on the check sends at most six at once and still lands every sentence's mark; fails_when=the check keeps twelve out after a refusal, or a refused sentence ends Not checked; no_claim=how long the service's stated wait is honoured, which the run's own retries decide.
test("a refusal takes the check back to six at once, and every mark still lands", async () => {
  const key: KeyShape = {
    kind: "tokens",
    requests: 4_000,
    input: 2_000_000,
    output: null,
    minutes: 1 / 60,
    costs: { input: 10_000, output: 0 },
    firstCosts: 10_000,
  };
  const [note] = (await keyNotes(12, REPLY_MS, key, true, 1)) as [KeyWrite];

  expect(note.refused).toBeGreaterThan(0);
  expect(note.marks).toEqual({ supported: 12 });
  const firstRefusal = note.timeline.findIndex((entry) => entry.endsWith("refused"));
  const after = { ...note, timeline: note.timeline.slice(firstRefusal + 1) };
  expect(mostAtOnce(after)).toBeLessThanOrEqual(6);
});
