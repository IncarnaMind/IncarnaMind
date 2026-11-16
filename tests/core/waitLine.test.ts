/**
 * What a write's row says while its checks wait on a rate limit (#2944): the time it resumes, only
 * for a wait of 5 seconds or more, from the wait's start to its end.
 */
import { expect, test } from "vitest";
import { waitLine } from "../../src/core/answers/checks/waitLine";

/** The row's line as the run's waits come, on a clock the test moves: each thing it was told. */
function row() {
  let now = 0;
  const said: (number | null)[] = [];
  const hear = waitLine(
    () => now,
    (until) => said.push(until),
  );
  return {
    said,
    /** The run's wait, heard at `at`: when it ends, or null once it has. */
    at(at: number, until: number | null) {
      now = at;
      hear(until);
    },
  };
}

// protects=a wait under 5 s leaves the row's checking words, one after another too, and a wait of 5 s or more shows when it resumes from its start until it ends (#2944); fails_when=a second's wait shows the line, or a 5 s or 40 s wait doesn't, or the line stays after the wait; no_claim=the words, which ../renderer/answerSteps.test.ts holds.
test("the row names a wait of 5 s or more, from its start to its end, and no shorter one", () => {
  const short = row();
  for (const start of [0, 1_000, 2_000, 3_000]) {
    short.at(start, start + 1_000);
    short.at(start + 1_000, null);
  }
  expect(short.said).toEqual([]);

  const five = row();
  five.at(0, 5_000);
  five.at(5_000, null);
  expect(five.said).toEqual([5_000, null]);

  const forty = row();
  forty.at(0, 40_000);
  forty.at(40_000, null);
  expect(forty.said).toEqual([40_000, null]);
});

// protects=once the row names a wait it holds it to its end, and a shorter wait met meanwhile neither ends the line nor shows its own; a wait that runs longer moves the time on (#2944); fails_when=the row goes back to its checking words and comes again inside one wait; no_claim=which request's wait it was.
test("the row never goes back to its checking words inside one wait", () => {
  const line = row();
  line.at(0, 40_000);
  // A second's wait met meanwhile: the run's latest end is still the long wait's.
  line.at(10_000, 40_000);
  // A wait that ends a little later than the long one.
  line.at(38_000, 41_000);
  line.at(41_000, null);
  // After it, a second's wait leaves the checking words again.
  line.at(42_000, 43_000);
  line.at(43_000, null);

  expect(line.said).toEqual([40_000, 41_000, null]);
});
