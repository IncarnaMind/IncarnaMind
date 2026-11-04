import { expect, test } from "vitest";
import { readFigures } from "../../src/shared/figures";

/** Each figure's scale readings: its value, scale word and unit under each stated unit (#2512). */
const scales = (text: string) =>
  readFigures(text).map((figure) => [
    figure.chars,
    figure.ambiguous
      .find((each) => each.kind === "scale")
      ?.readings.map((reading) => [reading.value, reading.scaleWord, reading.unit]) ?? null,
  ]);

const PLAIN = { kind: "plain" };
const CNY = { kind: "currency", code: "CNY" };

test("a unit stated over two tables gives each figure its reading once", () => {
  expect(scales("单位：万元\n| 收入 | 1,234 |\n\n单位：万元\n| 成本 | 567 |")).toEqual([
    [
      "1,234",
      [
        [1234, null, PLAIN],
        [12_340_000, "万", CNY],
      ],
    ],
    [
      "567",
      [
        [567, null, PLAIN],
        [5_670_000, "万", CNY],
      ],
    ],
  ]);
});

test("a stated unit that reads a figure as it is written leaves it nothing to choose", () => {
  expect(scales("单位：元\n| 收入 | 1,234元 |")).toEqual([["1,234元", null]]);
});

test("two different stated units still make a figure ambiguous, with both readings", () => {
  expect(scales("单位：万元\n| 收入 | 1,234 |\n\n单位：元\n| 成本 | 567 |")).toEqual([
    [
      "1,234",
      [
        [1234, null, PLAIN],
        [12_340_000, "万", CNY],
        [1234, null, CNY],
      ],
    ],
    [
      "567",
      [
        [567, null, PLAIN],
        [5_670_000, "万", CNY],
        [567, null, CNY],
      ],
    ],
  ]);
});

test("a caption that states the text's own unit gives one reading, which the caption still states", () => {
  const [figure] = readFigures("单位：万元\n| 收入 | 1,234 |", { header: "单位：万元" });
  expect(
    figure?.ambiguous
      .find((each) => each.kind === "scale")
      ?.readings.map((reading) => [reading.value, reading.statedIn]),
  ).toEqual([
    [1234, undefined],
    [12_340_000, "both"],
  ]);
});

test("a caption and the text that both state the unit a figure is written in leave it nothing to choose", () => {
  const [figure] = readFigures("单位：元\n| 收入 | 1,234元 |", { header: "单位：元" });
  expect(figure?.ambiguous.find((each) => each.kind === "scale")).toBeUndefined();
});
