/**
 * A batch's reply read back (#2311): each sentence's verdict by its number, and nothing for a
 * sentence the reply gave no readable verdict, or two.
 */
import { describe, expect, test } from "vitest";
import { readBatchReply } from "../../src/core/answers/checks/sentenceBatch";

const entry = (number: number, verdict: string) => ({
  number,
  kind: "fact",
  verdict,
  roles: "same",
  time: "same",
  says: "The schedule says so.",
});

describe("a batch's reply", () => {
  test("a sentence numbered twice is left unjudged, never green, and the others keep theirs", async () => {
    const reply = JSON.stringify({
      sentences: [
        entry(1, "unsupported"),
        entry(1, "supported"),
        entry(2, "supported"),
        entry(3, "contradicted"),
      ],
    });

    const read = await readBatchReply(reply, 3);

    expect(read.has(1)).toBe(false);
    expect(read.get(2)).toMatchObject({ verdict: "supported" });
    expect(read.get(3)).toMatchObject({ verdict: "contradicted" });
  });

  test("a reply in another order, with a number past the batch, maps each verdict to its sentence", async () => {
    const reply = JSON.stringify({
      sentences: [entry(2, "unsupported"), entry(4, "supported"), entry(1, "supported")],
    });

    const read = await readBatchReply(reply, 2);

    expect([...read.entries()].map(([number, { verdict }]) => [number, verdict])).toEqual([
      [2, "unsupported"],
      [1, "supported"],
    ]);
  });
});
