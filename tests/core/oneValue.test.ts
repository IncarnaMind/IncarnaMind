/**
 * Every reader of a judge's reply reads each field once (#2817): a label two lines give with values
 * that differ, whatever their words, a key one JSON object gives twice with two values, and a marker
 * or a sentence's number two entries give, can't be read. Each is paired with the same reply giving
 * the field once, which is read.
 */
import { describe, expect, test } from "vitest";
import { readPart, readVerdict } from "../../src/core/answers/checks/prompt";
import { readBatchReply } from "../../src/core/answers/checks/sentenceBatch";
import { parseCorrections } from "../../src/core/answers/quoteRetry";

const COVERAGE = (complete: boolean) =>
  `Coverage: ${JSON.stringify({
    unit: "stores",
    quantifier: "all",
    complete,
    members: [{ label: "North", verdict: "supported", evidence: [1] }],
    domainEvidence: [1],
  })}`;

describe("A check's reply that gives a field twice", () => {
  test.each([
    ["a Verdict word", "Verdict: supported\nIt says so.", "Verdict: not supported"],
    ["a Chinese verdict", "Verdict: supported\nIt says so.", "结论：不支持"],
    ["Evidence", "Verdict: supported\nIt says so.\nEvidence: [1]", "Evidence: [2]"],
    ["Coverage", `Verdict: supported\nIt says so.\n${COVERAGE(true)}`, COVERAGE(false)],
    [
      "Covered",
      "Verdict: unsupported\nIt says another rent.\nCovered: the rent\nNot covered: the date",
      "Covered: the deposit",
    ],
    [
      "Not covered",
      "Verdict: unsupported\nIt says another rent.\nCovered: the rent\nNot covered: the date",
      "Not covered: the deposit",
    ],
    [
      "Reason kind",
      "Verdict: unsupported\nIt is a forecast.\nReason kind: forecast-certainty",
      "Reason kind: unbacked-cause",
    ],
    [
      "Scope in other words",
      "Verdict: supported\nIt says so.\nScope: staff, wider",
      "Scope: staff",
    ],
    [
      "a Calculation taken back",
      "Verdict: supported\nIt says so.\nCalculation: 61,500 × 12",
      "Calculation: none",
    ],
  ])("can't be read: %s", (_field, once, again) => {
    expect(readVerdict(once)).not.toBeNull();
    expect(readVerdict(`${once}\n${again}`)).toBeNull();
  });

  test("gives it twice alike, and is read", () => {
    expect(
      readVerdict(
        "Verdict: supported\nEvidence: [1]\nIt says so.\nVerdict: supported\nEvidence: [1]",
      ),
    ).toMatchObject({ verdict: "supported", evidence: [1] });
  });
});

describe("A parts reply that gives a phrase twice", () => {
  test.each([
    ["English", "Covered: spring tides\nNot covered: full moon", "Covered: new moon"],
    ["Chinese", "已涵盖：大潮\n未涵盖：满月", "已涵盖：新月"],
  ])("can't be read (%s)", (_language, once, again) => {
    expect(readPart(once)).not.toBeNull();
    expect(readPart(`${once}\n${again}`)).toBeNull();
  });
});

describe("A JSON reply that gives a key, a marker or a number twice", () => {
  const entry = (verdict: string) =>
    `{"number":1,"kind":"fact","verdict":"${verdict}","roles":"same","time":"same","says":"It says so."}`;

  test("a batch's entry with its verdict given twice can't be read", () => {
    const twice = `{"sentences":[{"number":1,"kind":"fact","verdict":"contradicted","roles":"same","time":"same","says":"It says so.","verdict":"supported"}]}`;
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
