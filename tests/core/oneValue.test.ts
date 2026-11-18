/**
 * A judge's JSON reply that gives a field twice can't be read (#2817): a key one JSON object gives
 * twice with two values, and a marker two entries give. Each is paired with the same reply giving
 * the field once, which is read.
 */
import { describe, expect, test } from "vitest";
import { readBatchReply } from "../../src/core/answers/checks/sentenceBatch";
import { parseCorrections } from "../../src/core/answers/quoteRetry";

describe("A JSON reply that gives a key, a marker or a number twice", () => {
  const entry = (verdict: string) =>
    `{"number":1,"kind":"fact","verdict":"${verdict}","roles":"same","time":"same","quoted":"states","says":"It says so."}`;

  test("a batch's entry with its verdict given twice can't be read", () => {
    const twice = `{"sentences":[{"number":1,"kind":"fact","verdict":"contradicted","roles":"same","time":"same","quoted":"states","says":"It says so.","verdict":"supported"}]}`;
    expect(readBatchReply(`{"sentences":[${entry("supported")}]}`, 1).get(1)).toMatchObject({
      verdict: "supported",
    });
    expect(readBatchReply(twice, 1).size).toBe(0);
  });

  test("a quote given twice for one marker leaves that marker as it was", () => {
    expect(parseCorrections({ quotes: [{ marker: 1, quote: "A" }] })).toEqual(new Map([[1, "A"]]));
    expect(
      parseCorrections({
        quotes: [
          { marker: 1, quote: "A" },
          { marker: 1, quote: "B" },
          { marker: 2, quote: "C" },
        ],
      }),
    ).toEqual(new Map([[2, "C"]]));
  });
});
