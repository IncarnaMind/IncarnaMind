/**
 * The clock the written check's key cells run on (tests/helpers/writeChecked.ts): a write that
 * fails is reported as that write's failure (#2532, #2944).
 */
import { expect, test } from "vitest";
import { virtualClock } from "../helpers/writeChecked";

// protects=a write that fails while the test's clock moves is reported as that write's own failure, and never also as an unhandled rejection while the clock waits for the work it runs (#2995); fails_when=the clock leaves the failed write's promise without a handler across a turn of the event loop; no_claim=why a write fails.
test("a write that fails on the test's clock is reported as its own failure, not an unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const hear = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", hear);
  const clock = virtualClock();
  const failed = new Error("The write failed.");
  try {
    await expect(
      clock.until(async () => {
        await clock.after(100);
        throw failed;
      }),
    ).rejects.toBe(failed);
    // A turn of the event loop, in which a rejection nobody handled is reported.
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.off("unhandledRejection", hear);
  }

  expect(clock.now()).toBe(100);
  expect(unhandled).toEqual([]);
});
