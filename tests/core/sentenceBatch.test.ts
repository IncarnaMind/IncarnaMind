/**
 * A batch's reply read back (#2311): each sentence's verdict by its number, and nothing for a
 * sentence the reply gave no readable verdict, or two entries, readable or not; nothing at all when
 * an entry's number can't be read.
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

  test.each([
    {
      case: "its second verdict unreadable",
      entries: [entry(1, "supported"), entry(1, "Contradicted"), entry(2, "supported")],
    },
    {
      case: "its first number written as digits",
      entries: [
        { ...entry(1, "contradicted"), number: "1" },
        entry(1, "supported"),
        entry(2, "supported"),
      ],
    },
  ])("a sentence numbered twice, $case, is left unjudged, never green", async ({ entries }) => {
    const read = await readBatchReply(JSON.stringify({ sentences: entries }), 2);

    expect(read.has(1)).toBe(false);
    expect(read.get(2)).toMatchObject({ verdict: "supported" });
  });

  test.each(["1.0", null, "0x1"])(
    "an entry numbered %j, which can't be read as a sentence's, leaves the whole batch unjudged",
    async (number) => {
      const reply = JSON.stringify({
        sentences: [
          { ...entry(1, "contradicted"), number },
          entry(1, "supported"),
          entry(2, "supported"),
        ],
      });

      expect((await readBatchReply(reply, 2)).size).toBe(0);
    },
  );

  test("a clean batch's entries are each judged", async () => {
    const reply = JSON.stringify({
      sentences: [entry(1, "supported"), { ...entry(2, "contradicted"), number: "2" }],
    });

    const read = await readBatchReply(reply, 2);

    expect(read.get(1)).toMatchObject({ verdict: "supported" });
    expect(read.get(2)).toMatchObject({ verdict: "contradicted" });
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
