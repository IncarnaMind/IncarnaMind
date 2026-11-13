/**
 * A label that gives a figure's unit states the figure for the number rule (#2997): a right
 * sentence whose number the Document gives plain, with its unit in the number's own label, the
 * heading over its rows, its column's heading, a caption, a unit line or a clause of prose, keeps
 * the model's ✓ in an Answer, as does one that writes the quote's unit in another word. A sentence
 * in another unit, scale, rate or notation, beside a twin, or under two units or none, reads as on
 * main. Each row is read in both interface languages, as an Answer's sentence and in Check against
 * Documents.
 */
import { describe, expect, test } from "vitest";
import type { Language } from "../../src/core/language";
import { type File, type Read, readRows } from "../helpers/answerUnitsTable";

type Wanted = (language: Language) => Read;

const SUPPORTED = { verdict: "supported", reason: null };
const TICK: Wanted = () => ({ answer: [{ check: "found", verdict: null }], document: SUPPORTED });
const UNJUDGED: Wanted = () => ({
  answer: [{ check: "not-checked", verdict: null }],
  document: SUPPORTED,
});
const line = (language: Language, given: string, figure: string) =>
  language === "zh-CN"
    ? `文档写的是 ${given}，不是 ${figure}。`
    : `The Document gives ${given}, not ${figure}.`;
/** Unsupported in both checks with the line, as on main. */
const caught =
  (given: string, figure: string): Wanted =>
  (language) => {
    const reason = line(language, given, figure);
    return {
      answer: [{ check: "unsupported", verdict: reason }],
      document: { verdict: "unsupported", reason },
    };
  };
/** The model's ✓ in an Answer, where the Document states no unit for the figure, and Unsupported in Check against Documents, as on main. */
const leftToTheModel =
  (given: string, figure: string): Wanted =>
  (language) => ({
    answer: [{ check: "found", verdict: null }],
    document: { verdict: "unsupported", reason: line(language, given, figure) },
  });

/** Each row's Document, its quote and its sentence, read through the core in both languages. */
async function readsAsWanted(rows: readonly [string, string, string, Wanted][]) {
  const files: Record<string, File> = {};
  const asked = rows.flatMap(([text, quote, sentence, wanted], at) => {
    files[`f${at}`] = { name: `Report ${at}.txt`, text: `${text}\n` };
    return (["en", "zh-CN"] as const).map((language) => ({
      id: `${at}-${language}`,
      language,
      sentence,
      quotes: [quote],
      files: [`f${at}`],
      wanted: wanted(language),
    }));
  });
  await readRows(
    asked,
    (row, read) => expect(read, `${row.id}: ${row.sentence}`).toEqual(row.wanted),
    files,
  );
}

describe("A label that gives a figure's unit states it for the number rule (#2997)", {
  timeout: 120_000,
}, () => {
  // protects=a right sentence whose number the Document gives plain, its unit in the number's own label, the heading over its rows, a caption or a unit line, in money, a share or a measure, keeps the model's ✓ in an Answer and reads Supported in Check against Documents, in English and Chinese; fails_when="二厂产量为31吨。" citing "二厂产量（吨）: 31" or under "表3 各厂产量（吨）", or "Site B's load was 31 kW." under "Unit: kW", reads Not checked; no_claim=a row's heading cell, which the part after this one reads.
  test("a right sentence under each kind of label keeps its ✓", async () => {
    await readsAsWanted([
      ["一厂产量（吨）: 54\n二厂产量（吨）: 31", "二厂产量（吨）: 31", "二厂产量为31吨。", TICK],
      [
        "Site A output (t): 54\nSite B output (t): 31",
        "Site B output (t): 31",
        "Site B's output was 31 t.",
        TICK,
      ],
      ["各厂产量（千克）\n一厂: 54\n二厂: 31", "二厂: 31", "二厂产量为31千克。", TICK],
      ["Output by site (kg)\nA: 54\nB: 31", "B: 31", "Site B's output was 31 kg.", TICK],
      ["表3 各厂产量（吨）\n厂区\t产量\n一厂\t54\n二厂\t31", "二厂\t31", "二厂产量为31吨。", TICK],
      [
        "Table 3. Output by site (tonnes)\nSite\tOutput\nA\t54\nB\t31",
        "B\t31",
        "Site B's output was 31 tonnes.",
        TICK,
      ],
      ["单位：千克\n厂区\t产量\n一厂\t54\n二厂\t31", "二厂\t31", "二厂产量为31千克。", TICK],
      ["Unit: kW\nSite\tLoad\nA\t54\nB\t31", "B\t31", "Site B's load was 31 kW.", TICK],
      ["单位：万吨/年\n厂区\t产能\n一厂\t54\n二厂\t31", "二厂\t31", "二厂产能为31万吨/年。", TICK],
      [
        "一厂收入（万元）: 54\n二厂收入（万元）: 31",
        "二厂收入（万元）: 31",
        "二厂收入为31万元。",
        TICK,
      ],
      [
        "Site A revenue ($m): 54\nSite B revenue ($m): 31",
        "Site B revenue ($m): 31",
        "Site B's revenue was $31 million.",
        TICK,
      ],
      ["一厂增速（%）: 5\n二厂增速（%）: 31", "二厂增速（%）: 31", "二厂增速为31%。", TICK],
    ]);
  });

  // protects=a column's heading gives its unit as the reader reads it, capital letters and all, so a right sentence in kW, MW or GWh under its own column keeps its ✓, and one in kW under a column in kWh, or MW under MWh, is still caught; fails_when="Site B's capacity was 31 kW." under "Capacity (kW)" reads Not checked, or "31 kW" under "Output (kWh)" keeps a ✓; no_claim=a heading in another case than the unit's own ("KW"), which the reader doesn't read.
  test("a column's heading matches its unit whatever its case", async () => {
    await readsAsWanted([
      ["Site\tCapacity (kW)\nA\t54\nB\t31", "B\t31", "Site B's capacity was 31 kW.", TICK],
      ["厂区\t产量（MW）\n一厂\t54\n二厂\t31", "二厂\t31", "二厂产量为31MW。", TICK],
      ["Site\tGWh\nA\t54\nB\t31", "B\t31", "Site B generated 31 GWh.", TICK],
      [
        "Site\tOutput (kWh)\nA\t54\nB\t31",
        "B\t31",
        "Site B's output was 31 kW.",
        caught("31", "31 kW"),
      ],
      [
        "厂区\t发电（MWh）\n一厂\t54\n二厂\t31",
        "二厂\t31",
        "二厂发电为31MW。",
        caught("31", "31MW"),
      ],
    ]);
  });

  // protects=a label states a figure only when every number of its written value in the quote carries a label of the figure's kind that gives its unit, scale, rate and notation, so a wrong sentence gains no ✓: another scale or another unit of the measure, a twin under another scale or another measure, a heading or bracket that names two units, a label that isn't a unit, the neighbouring column's, a rate dropped or changed, ‰ under a percent, a caption of another table at another scale, and two unit lines at two scales all read as on main; fails_when=any of them reads ✓ in an Answer or loses Check against Documents' Unsupported; no_claim=telling which of two columns a sentence is about, which stays the model's.
  test("a sentence the label doesn't give reads as on main", async () => {
    await readsAsWanted([
      [
        "一厂产量（吨）: 54\n二厂产量（吨）: 31",
        "二厂产量（吨）: 31",
        "二厂产量为31万吨。",
        caught("31", "31万吨"),
      ],
      [
        "Output by site (t)\nA: 54\nB: 31",
        "B: 31",
        "Site B's output was 31 kt.",
        caught("31 (t)", "31 kt"),
      ],
      ["各厂产量（千克）\n一厂: 54\n二厂: 31", "二厂: 31", "二厂产量为31吨。", UNJUDGED],
      [
        "一厂产量（吨）: 54，库存（万吨）: 12\n二厂产量（吨）: 31，库存（万吨）: 31",
        "二厂产量（吨）: 31，库存（万吨）: 31",
        "二厂库存为31吨。",
        UNJUDGED,
      ],
      [
        "一厂产量（吨）: 54，产值（万元）: 12\n二厂产量（吨）: 31，产值（万元）: 31",
        "二厂产量（吨）: 31，产值（万元）: 31",
        "二厂产值为31吨。",
        UNJUDGED,
      ],
      [
        "Site A: output (t) 54; margin (%) 12\nSite B: output (t) 31; margin (%) 31",
        "Site B: output (t) 31; margin (%) 31",
        "Site B's margin was 31 t.",
        UNJUDGED,
      ],
      [
        "一厂产量（吨，%）: 54\n二厂产量（吨，%）: 31",
        "二厂产量（吨，%）: 31",
        "二厂产量为31吨。",
        UNJUDGED,
      ],
      ["各月产量（吨）及同比（%）\n7月: 54\n8月: 31", "8月: 31", "8月产量为31吨。", UNJUDGED],
      [
        "Monthly output (t) and change (%)\nJuly: 54\nAugust: 31",
        "August: 31",
        "August output was 31 t.",
        UNJUDGED,
      ],
      [
        "一厂产量（含税）: 54\n二厂产量（含税）: 31",
        "二厂产量（含税）: 31",
        "二厂产量为31吨。",
        leftToTheModel("31", "31吨"),
      ],
      [
        "Site A output (restated): 54\nSite B output (restated): 31",
        "Site B output (restated): 31",
        "Site B's output was 31 t.",
        leftToTheModel("31", "31 t"),
      ],
      [
        "厂区\t产量（吨）\t库存\n一厂\t54\t12\n二厂\t40\t31",
        "二厂\t40\t31",
        "二厂库存为31吨。",
        UNJUDGED,
      ],
      ["单位：万吨/年\n厂区\t产能\n一厂\t54\n二厂\t31", "二厂\t31", "二厂产能为31万吨。", UNJUDGED],
      [
        "单位：万吨/年\n厂区\t产能\n一厂\t54\n二厂\t31",
        "二厂\t31",
        "二厂产能为31万吨/日。",
        UNJUDGED,
      ],
      ["一厂增速（%）: 5\n二厂增速（%）: 31", "二厂增速（%）: 31", "二厂增速为31‰。", UNJUDGED],
      [
        "表3 各厂产量（吨）\n厂区\t产量\n一厂\t54\n\n表4 各港吞吐量（万吨）\n港口\t吞吐量\n甲港\t31",
        "甲港\t31",
        "甲港吞吐量为31吨。",
        UNJUDGED,
      ],
      [
        "单位：万吨\n单位：吨\n厂区\t产量\n一厂\t54\n二厂\t31",
        "二厂\t31",
        "二厂产量为31吨。",
        UNJUDGED,
      ],
    ]);
  });
});

describe("The same unit in another word at the number is the figure's unit (#2997)", {
  timeout: 120_000,
}, () => {
  // protects=W, watts and 瓦; kW, kilowatts and 千瓦; t, tonnes and 吨 are one unit at one scale, so a sentence that writes the quote's unit in another word keeps its ✓, while another scale in another word (60 kilowatts beside 60 W, 60 kt beside 60 tonnes) is still caught, in both languages; fails_when="It draws 60 watts." citing "Rated power: 60 W" reads Not checked, or "It draws 60 kilowatts." there keeps a ✓; no_claim=度 beside 瓦时, which may be degrees and stays as on main.
  test("a sentence in the quote's unit, written in another word, keeps its ✓", async () => {
    await readsAsWanted([
      ["Rated power: 60 W", "Rated power: 60 W", "It draws 60 watts.", TICK],
      ["额定功率：60瓦", "额定功率：60瓦", "额定功率为60W。", TICK],
      ["Rated power: 60 kW", "Rated power: 60 kW", "It draws 60 kilowatts.", TICK],
      ["额定功率：60kW", "额定功率：60kW", "额定功率为60千瓦。", TICK],
      ["Output: 60 tonnes", "Output: 60 tonnes", "Output was 60 t.", TICK],
      ["产量：60 t", "产量：60 t", "产量为60吨。", TICK],
      [
        "Rated power: 60 W",
        "Rated power: 60 W",
        "It draws 60 kilowatts.",
        caught("60 W", "60 kilowatts"),
      ],
      ["额定功率：60瓦", "额定功率：60瓦", "额定功率为60千瓦。", caught("60瓦", "60千瓦")],
      ["Output: 60 tonnes", "Output: 60 tonnes", "Output was 60 kt.", caught("60 tonnes", "60 kt")],
      ["用电：60瓦时", "用电：60瓦时", "用电为60度。", UNJUDGED],
    ]);
  });
});

describe("A unit said only in a sentence of prose is read (#2997)", { timeout: 120_000 }, () => {
  // protects=a Document that says in prose what its figures are counted in ("本报告产量以瓦计。", "库存以吨计。") states that unit, so the right sentence keeps its ✓ and reads Supported in Check against Documents, while another unit or scale of the measure, or "以克计划" that goes on as a word, reads as on main; fails_when="二厂产量为31瓦。" there reads Unsupported in Check against Documents, or "二厂产量为31千克。" beside "以吨计" reads Supported there; no_claim=the Answer's ✓ on a wrong unit the Document states nowhere, which is the model's, as on main.
  test("a unit said in prose states it, and states no other", async () => {
    const rows = (prose: string) => `${prose}\n厂区\t产量\n一厂\t54\n二厂\t31`;
    await readsAsWanted([
      [rows("本报告产量以瓦计。"), "二厂\t31", "二厂产量为31瓦。", TICK],
      ["库存以吨计。\n厂区\t库存\n一厂\t54\n二厂\t31", "二厂\t31", "二厂库存为31吨。", TICK],
      [
        rows("本报告产量以吨计。"),
        "二厂\t31",
        "二厂产量为31千克。",
        leftToTheModel("31", "31千克"),
      ],
      [
        rows("本报告产量以吨计。"),
        "二厂\t31",
        "二厂产量为31万吨。",
        leftToTheModel("31", "31万吨"),
      ],
      [rows("以克计划为准。"), "二厂\t31", "二厂产量为31克。", leftToTheModel("31", "31克")],
    ]);
  });
});

describe("An English W before a capital or a number is watts where it is no address (#2997)", {
  timeout: 120_000,
}, () => {
  // protects=a quote that writes "60 W" before a capitalised word states 60 W, so the right sentence keeps its ✓ and 60 kW is caught in both checks, while a street's "31 W. Main St." and an oil's "5W-30" give no watts; fails_when="It draws 60 W." citing "It draws 60 W. The case is steel." reads Not checked, or "It draws 60 kW." there keeps a ✓.
  test("the watt before a capital is read, and an address isn't", async () => {
    const steel = "It draws 60 W. The case is steel.";
    const lamp = "The lamp is a 60 W LED.";
    const shop = "The shop is at 31 W. Main St.";
    await readsAsWanted([
      [steel, steel, "It draws 60 W.", TICK],
      [lamp, lamp, "The lamp draws 60 watts.", TICK],
      [steel, steel, "It draws 60 kW.", caught("60 W", "60 kW")],
      [lamp, lamp, "The lamp is a 60 kW lamp.", caught("60 W", "60 kW")],
      [shop, shop, "The shop draws 31 W.", UNJUDGED],
    ]);
  });
});
