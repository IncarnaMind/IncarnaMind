/**
 * A turn with no overlap and no refusal sends the same requests as before waiting on a rate limit
 * and behind replies were added (#2944): the same, in the same order, at the same times. The
 * expected requests were recorded on `main` at 9182cdc7, before this change, on a key that never
 * refuses: six sentences at once, each sentence's requests one after another (two, now that its
 * first search is made for the model, #3512).
 */
import { expect, test } from "vitest";
import { keyWrites } from "../helpers/writeChecked";

/** The requests of a write of `count` sentences on `main`: "sentence:turn", and when each went out. */
function recordedOnMain(count: number) {
  const order: string[] = [];
  const timeline: string[] = [];
  let at = 0;
  for (let first = 1; first <= count; first += 6) {
    const group = Array.from(
      { length: Math.min(6, count - first + 1) },
      (_, index) => first + index,
    );
    for (let turn = 0; turn < 2; turn++) {
      for (const sentence of group) {
        order.push(`${sentence}:${turn}`);
        timeline.push(`${at} ${sentence}:${turn}`);
      }
      at += 1000;
    }
  }
  return { order, timeline, end: at, sent: order.length };
}

// protects=with no limit met and no reply out, a write's check sends the requests it sent before this change, in the same order and at the same times, and lands the same marks (#2944: path identity); fails_when=waiting on a limit or behind a reply adds, drops, reorders or delays a request; no_claim=what happens once a limit is met, which the other tests hold.
test.each([3, 12])(
  "a write of %i sentences on a key that never refuses sends what main sent",
  async (count) => {
    const [write] = await keyWrites(
      count,
      1000,
      { kind: "bucket", holds: 1000, refillsPerReply: 1000 },
      1,
    );
    const main = recordedOnMain(count);

    expect(write?.order).toEqual(main.order);
    expect(write?.timeline).toEqual(main.timeline);
    expect(write?.end).toBe(main.end - 1000 + 1000);
    expect(write?.sent).toBe(main.sent);
    expect(write?.refused).toBe(0);
    expect(write?.marks).toEqual({ supported: count });
    expect(write?.waits).toEqual([]);
  },
);
