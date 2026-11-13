import { describe, expect, test } from "vitest";
import { type FigureUnit, measureOf, readFigures, writesMeasure } from "../../src/shared/figures";

const read = (text: string) =>
  readFigures(text).map(({ chars, unit }) => [
    chars,
    unit.kind === "other" ? unit.word : unit.kind,
  ]);
const unit = (word: string): FigureUnit => ({ kind: "other", word });

describe("the watt and the watt-hour by themselves (#2997)", () => {
  // protects=a figure in watts or watt-hours reads with its unit, in letters and in Chinese ("1500 W", "31Wh", "31 watts", "31瓦", "31瓦时"), so a check can tell it from kilowatts; fails_when="Rated power: 1500 W" reads a plain 1500 or "功率为31W。" nothing; no_claim=a rate after it ("31 W/m2" reads 31 W).
  test.each([
    ["Rated power: 1500 W", "1500 W", "W"],
    ["The pack stores 31 Wh.", "31 Wh", "Wh"],
    ["The pack stores 31Wh.", "31Wh", "Wh"],
    ["It draws 31 watts.", "31 watts", "watts"],
    ["It stores 31 watt-hours.", "31 watt-hours", "watt-hours"],
    ["功率为31瓦。", "31瓦", "瓦"],
    ["电量为31瓦时。", "31瓦时", "瓦时"],
    ["功率为31W。", "31W", "W"],
  ])("%s reads %s", (text, chars, word) => {
    expect(read(text)).toEqual([[chars, word]]);
  });

  // protects=a W that is no watt stays unread: a street's "W." or "W" before a name, an oil's grade, and 瓦 before 片, which is tiles; fails_when="31 W. Main St." reads 31 watts or "31瓦片" 31瓦; no_claim=a W that ends a clause and stands for something else ("31 W and 12 L").
  test.each([
    ["The office is at 31 W. Main St.", [["31", "plain"]]],
    ["The office is at 31 W Main St.", [["31", "plain"]]],
    ["Use 5W-30 oil.", []],
    ["屋顶用了31瓦片。", [["31", "plain"]]],
  ])("%s reads no watts", (text, figures) => {
    expect(read(text)).toEqual(figures);
  });

  // protects=the watt and the watt-hour measure power and energy, and a Document that writes only them writes the measure for a figure in them and for no other, so "（瓦）" is no unit for a figure in 千瓦; fails_when="W" or "瓦时" has no measure, "数值（瓦）" writes power for a figure in 千瓦, or "31瓦片" writes it for one in 瓦; no_claim=converting watts to kilowatts.
  test("they measure power and energy, written only for a figure in them", () => {
    for (const word of ["W", "瓦", "watts"]) expect(measureOf(unit(word)), word).toBe("power");
    for (const word of ["Wh", "瓦时", "watt-hours", "watt hours"])
      expect(measureOf(unit(word)), word).toBe("energy");
    expect(writesMeasure("数值（瓦）", "power")).toBe(false);
    expect(writesMeasure("数值（瓦）", "power", unit("瓦"))).toBe(true);
    expect(writesMeasure("数值（瓦）", "power", unit("千瓦"))).toBe(false);
    expect(writesMeasure("Power (W)", "power", unit("W"))).toBe(true);
    expect(writesMeasure("Power (W)", "power", unit("kW"))).toBe(false);
    expect(writesMeasure("Energy (Wh)", "energy", unit("Wh"))).toBe(true);
    expect(writesMeasure("Energy (Wh)", "energy", unit("kWh"))).toBe(false);
    expect(writesMeasure("Power (kW)", "power", unit("W"))).toBe(true);
    expect(writesMeasure("屋顶用了31瓦片。", "power", unit("瓦"))).toBe(false);
  });
});
