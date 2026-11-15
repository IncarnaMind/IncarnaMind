/**
 * A write's check on a key that refuses with a stated wait (#2944): the refused request waits as
 * long as the service says and goes again inside its check, a check that can't go on for two
 * minutes is Not checked for the rate limit with the sentences after it unsent, and a limit that
 * doesn't say how long keeps today's steps. The model's replies are scripted, and the clock is the
 * test's own: no request is paid for.
 */
import { describe, expect, test } from "vitest";
import type { KeyAnswer, KeyShape } from "../helpers/scriptedKeys";
import { keyWrites } from "../helpers/writeChecked";

const refused = (retryAfter: number | null): KeyAnswer => ({ fits: false, retryAfter });
const FITS: KeyAnswer = { fits: true };

/** A write of `count` sentences on a key that answers as `answers` say, then as `after` says. */
const onKey = (count: number, answers: readonly KeyAnswer[], after: KeyAnswer = FITS) =>
  keyWrites(count, 1000, { kind: "script", answers, after } satisfies KeyShape, 1).then(
    ([write]) => {
      if (!write) throw new Error("No write.");
      return write;
    },
  );

/** When each request was sent, from the write's start, in ms: the timeline's first words. */
const sentAt = (timeline: readonly string[]) => timeline.map((line) => Number(line.split(" ")[0]));

describe("A write's check on a key that states how long to wait", () => {
  // protects=a check request refused with a stated wait of 40 s is sent again after it, however many times it is refused within two minutes, and its verdict lands (#2944); fails_when=a request is sent again sooner than the wait it was told, or its sentence is Not checked; no_claim=how a real service words its wait.
  test("a request refused for 40 s goes again after them, each time, and its verdict lands", async () => {
    const write = await onKey(1, [refused(40), refused(40), refused(40)]);

    const times = sentAt(write.timeline);
    const refusals = write.timeline.flatMap((line, at) => (line.endsWith("refused") ? [at] : []));
    expect(refusals).toHaveLength(3);
    for (const at of refusals) {
      expect((times[at + 1] ?? 0) - (times[at] ?? 0)).toBeGreaterThanOrEqual(40_000);
    }
    expect(write.marks).toEqual({ supported: 1 });
  });

  // protects=while a request waits on a stated limit the check says when it resumes, to the moment its wait ends, and says no more once it doesn't (#2944: the line reads "Rate limit reached · resumes at {time}" meanwhile); fails_when=nothing is said, the time isn't the wait's end, or it is never said to end; no_claim=how the line is worded.
  test("while a request waits for 40 s the check says when it resumes, then says no more", async () => {
    const write = await onKey(1, [refused(40)]);

    const refusedAt = sentAt(write.timeline)[
      write.timeline.findIndex((line) => line.endsWith("refused"))
    ];
    expect(write.waits).toEqual([(refusedAt ?? 0) + 40_000, null]);
  });

  // protects=a wait of a few seconds is never told, so the line doesn't change its words for a moment (#2944); fails_when=a stated wait of 2 s is told; no_claim=where the line's threshold is.
  test("a wait of 2 s is not told", async () => {
    const write = await onKey(1, [refused(2)]);

    expect(write.waits).toEqual([]);
    expect(write.marks).toEqual({ supported: 1 });
  });

  // protects=a request refused past two minutes of waiting leaves its sentence Not checked for the rate limit, and the sentences after it aren't sent (#2944); fails_when=it waits on, its mark is another reason, or a later sentence is sent; no_claim=what a real key does after two minutes.
  test("refused past two minutes the sentence is Not checked, and the later ones aren't sent", async () => {
    const write = await onKey(9, [], refused(50));

    expect(write.sent).toBe(0);
    // Two minutes of waiting at most for a request: the check is given up soon after, not after
    // five rounds of pauses that each wait it out again.
    expect(write.end).toBeGreaterThanOrEqual(100_000);
    expect(write.end).toBeLessThanOrEqual(130_000);
    const numbers = new Set(write.order.map((request) => Number(request.split(":")[0])));
    // Six sentences are checked at once: the seventh to the ninth never get a request.
    expect([...numbers].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(write.marks).toEqual({ "not-checked: rate-limit": 9 });
  });

  // protects=a rate limit that doesn't say how long keeps today's steps: the AI SDK sends the request again after its own waits, then the run pauses (#2944); fails_when=a limit with no stated wait is waited out for minutes, or isn't sent again at all; no_claim=the length of today's steps.
  test("a limit that doesn't say how long is answered by today's steps", async () => {
    const write = await onKey(1, [refused(null)]);

    expect(write.marks).toEqual({ supported: 1 });
    // Today's steps are seconds: the AI SDK's 2 s, never a stated wait of tens of seconds.
    expect(write.end).toBeLessThan(10_000);
  });
});
