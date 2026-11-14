/**
 * A label that gives a figure's unit states the figure for the number rule (#2997): a right
 * sentence whose number the Document gives plain, with its unit in the number's own label, the
 * heading over its rows, its column's heading, or a caption, a unit line or a clause of prose that
 * heads its rows, keeps the model's ✓ in an Answer, as does one that writes the quote's unit in
 * another word. A sentence in another unit, scale, rate or notation, beside a twin, under two units
 * or none, or under another table's line, reads as on main, and a number in a column or row the
 * sentence doesn't name, while it names another of its table, takes nothing from the line over the
 * table. Each row is read in both interface languages, as an Answer's sentence and in Check against
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

  // protects=a label states a figure only when every number of its written value in the quote carries a label of the figure's kind that gives its unit, scale, rate and notation, so a wrong sentence gains no ✓: another scale or another unit of the measure, a twin under another scale or another measure, a heading or bracket that names two units, a label that isn't a unit, the neighbouring column's, a rate dropped or changed, ‰ under a percent, and two unit lines at two scales all read as on main, and the number's own caption at another scale than the sentence's ("表4 各港吞吐量（万吨）" over "甲港\t31" for "甲港吞吐量为31吨。") is caught in both checks; fails_when=any of them reads ✓ in an Answer or loses Check against Documents' Unsupported; no_claim=telling which of two columns a sentence is about, which stays the model's.
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
        caught("31（万吨）", "31吨"),
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
  // protects=a Document that says in prose, just above the rows it speaks of, what its figures are counted in ("本报告产量以瓦计。", "库存以吨计。") states that unit, so the right sentence keeps its ✓ and reads Supported in Check against Documents, another scale of its unit is caught in both checks, and another unit of the measure, or "以克计划" that goes on as a word, reads as on main; fails_when="二厂产量为31瓦。" there reads Unsupported in Check against Documents, "二厂产量为31万吨。" beside "以吨计" keeps a ✓, or "二厂产量为31千克。" there reads Supported in Check against Documents; no_claim=the Answer's ✓ on a wrong unit the Document states nowhere, which is the model's, as on main.
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
      [rows("本报告产量以吨计。"), "二厂\t31", "二厂产量为31万吨。", caught("31", "31万吨")],
      [rows("以克计划为准。"), "二厂\t31", "二厂产量为31克。", leftToTheModel("31", "31克")],
    ]);
  });
});

describe("A unit stated on another line reaches only the rows it heads (#2997)", {
  timeout: 120_000,
}, () => {
  // protects=a caption, a unit line or a line of words directly above a table states its unit for that table's rows alone, so in a Document of two tables each right sentence keeps or gains its ✓, while a number of one table never takes the other's unit (and "二厂产量为31万吨。" citing the 万元 table is caught in both checks), a table without a caption of its own takes none, and a caption or prose set apart by a blank line states nothing, in both languages; fails_when="二厂产量为31万吨。" citing the 万元 table, or "研发数值为31千克。" citing the headcount table after a （千克） caption, reads ✓; no_claim=a caption that heads a table across a blank line, which the part after this one reads.
  test("each table's own heading lines give its rows their unit, and no other's", async () => {
    const twoCaptions =
      "表3 各厂产量（万吨）\n厂区\t产量\n一厂\t54\n二厂\t62\n\n表4 各厂收入（万元）\n厂区\t收入\n一厂\t77\n二厂\t31";
    const twoScales =
      "表3 各厂产量（万吨）\n厂区\t产量\n一厂\t54\n二厂\t62\n\n表4 各厂库存（吨）\n厂区\t库存\n一厂\t77\n二厂\t31";
    const twoUnitLines =
      "单位：万元\n项目\t金额\n收入\t54\n费用\t62\n\n单位：万吨\n厂区\t产量\n一厂\t77\n二厂\t31";
    const englishCaptions =
      "Table 3. Output by site (kt)\nSite\tOutput\nA\t54\nB\t62\n\nTable 4. Revenue by site (USD millions)\nSite\tRevenue\nA\t77\nB\t31";
    const englishUnitLines =
      "Unit: MW\nSite\tCapacity\nA\t54\nB\t62\n\nUnit: GWh\nSite\tOutput\nA\t77\nB\t31";
    await readsAsWanted([
      [twoCaptions, "二厂\t62", "二厂产量为62万吨。", TICK],
      [twoCaptions, "二厂\t31", "二厂收入为31万元。", TICK],
      [twoCaptions, "二厂\t31", "二厂产量为31万吨。", caught("31", "31万吨")],
      [twoScales, "二厂\t31", "二厂库存为31吨。", TICK],
      [twoUnitLines, "二厂\t31", "二厂产量为31万吨。", TICK],
      [twoUnitLines, "二厂\t31", "二厂费用为31万元。", UNJUDGED],
      [twoUnitLines, "费用\t62", "费用为62万吨。", UNJUDGED],
      [englishCaptions, "B\t62", "Site B's output was 62 kt.", TICK],
      [englishCaptions, "B\t31", "Site B's output was 31 kt.", UNJUDGED],
      [englishUnitLines, "B\t31", "Site B's output was 31 GWh.", TICK],
      [englishUnitLines, "B\t31", "Site B's capacity was 31 MW.", UNJUDGED],
    ]);
  });

  // protects=a table after a captioned one, with a caption of its own or none, takes nothing from the first table's caption, and prose or a caption set apart from its table by a blank line reads as on main, while a line of words between a caption and its table leaves the caption heading it; fails_when="二厂数值为31千克。" or "Site B's value was 31 kg." citing the headcount table reads ✓, or "二厂产量为31千克。" under a caption and a line of words reads Not checked.
  test("a caption over another table, or set apart by a blank line, gives nothing", async () => {
    const countAfter =
      "表3 各厂数值（千克）\n厂区\t数值\n一厂\t54\n二厂\t62\n\n表4 各厂人数\n厂区\t人数\n一厂\t77\n二厂\t31";
    const countAfterInEnglish =
      "Table 3. Value by site (kg)\nSite\tValue\nA\t54\nB\t62\n\nTable 4. Headcount by site\nSite\tHeadcount\nA\t77\nB\t31";
    const proseApart =
      "本报告数值以千克计。\n\n厂区\t数值\n一厂\t54\n二厂\t62\n\n部门\t人数\n研发\t31\n销售\t77";
    await readsAsWanted([
      [countAfter, "二厂\t31", "二厂数值为31千克。", UNJUDGED],
      [countAfterInEnglish, "B\t31", "Site B's value was 31 kg.", UNJUDGED],
      [proseApart, "二厂\t62", "二厂数值为62千克。", UNJUDGED],
      [proseApart, "研发\t31", "研发数值为31千克。", UNJUDGED],
      [
        "表3 各厂产量（千克）\n\n厂区\t产量\n一厂\t54\n二厂\t31",
        "二厂\t31",
        "二厂产量为31千克。",
        UNJUDGED,
      ],
      [
        "表3 各厂产量（千克）\n下表列示各厂情况。\n厂区\t产量\n一厂\t54\n二厂\t31",
        "二厂\t31",
        "二厂产量为31千克。",
        TICK,
      ],
    ]);
  });
});

describe("A W before a capitalised word may be West (#2997)", { timeout: 120_000 }, () => {
  // protects=a plain number before a W that is West ("Block 5 W Wing", "Exit 12 W Toward Katy") keeps its ✓ in both checks and both languages; fails_when="The office is in Block 5." or "Take Exit 12." citing those words reads Not checked; no_claim="It draws 60 W." citing "It draws 60 W. The case is steel.", which reads Not checked as on main until a figure carries both readings.
  test("the plain number before it keeps its ✓", async () => {
    const block = "The office is in Block 5 W Wing of the campus.";
    const exit = "Take Exit 12 W Toward Katy, then 3 miles.";
    await readsAsWanted([
      [block, block, "The office is in Block 5.", TICK],
      [exit, exit, "Take Exit 12.", TICK],
    ]);
  });
});

describe("A unit said in prose names only the rows it heads (#2997)", { timeout: 120_000 }, () => {
  // protects=prose that says what figures are counted in ("库存以吨计。", "功率以瓦计。") states its unit only for the rows it heads, so a headcount in another table, glued under the first or after a blank line, in a section apart where it is the only table, or in a list after a blank line, reads Unsupported in Check against Documents, as on main, in both languages; fails_when="研发人数为31吨。" or "研发人数为31瓦。" citing "研发\t31" or "研发人数: 31" reads Supported there; no_claim=the Answer's ✓ on a unit the Document states nowhere for the number, which is the model's, as on main.
  test("the eight headcounts under another table's prose read Unsupported in Check against Documents, as on main", async () => {
    await readsAsWanted([
      [
        "库存以吨计。\n项目\t库存\n一厂\t54\n\n部门\t人数\n研发\t31",
        "研发\t31",
        "研发人数为31吨。",
        leftToTheModel("31", "31吨"),
      ],
      [
        "库存以吨计。\n项目\t库存\n一厂\t54\n部门\t人数\n研发\t31",
        "研发\t31",
        "研发人数为31吨。",
        leftToTheModel("31", "31吨"),
      ],
      [
        "本报告库存以吨计。\n\n第三节 人员\n\n部门\t人数\n研发\t31",
        "研发\t31",
        "研发人数为31吨。",
        leftToTheModel("31", "31吨"),
      ],
      [
        "库存以吨计。\n一厂: 54\n\n研发人数: 31",
        "研发人数: 31",
        "研发人数为31吨。",
        leftToTheModel("31", "31吨"),
      ],
      [
        "功率以瓦计。\n项目\t功率\n一厂\t54\n\n部门\t人数\n研发\t31",
        "研发\t31",
        "研发人数为31瓦。",
        leftToTheModel("31", "31瓦"),
      ],
      [
        "功率以瓦计。\n项目\t功率\n一厂\t54\n部门\t人数\n研发\t31",
        "研发\t31",
        "研发人数为31瓦。",
        leftToTheModel("31", "31瓦"),
      ],
      [
        "本报告功率以瓦计。\n\n第三节 人员\n\n部门\t人数\n研发\t31",
        "研发\t31",
        "研发人数为31瓦。",
        leftToTheModel("31", "31瓦"),
      ],
      [
        "功率以瓦计。\n一厂: 54\n\n研发人数: 31",
        "研发人数: 31",
        "研发人数为31瓦。",
        leftToTheModel("31", "31瓦"),
      ],
    ]);
  });

  // protects=prose over its own list or table still states its unit in Check against Documents ("一厂为54吨。" under "库存以吨计。"), and prose set apart from its rows by a blank line and a section heading reads as on main, in both languages; fails_when="一厂为54吨。" under "库存以吨计。" over its list reads Unsupported, or "二厂库存为31吨。" under prose apart reads Supported; no_claim=prose apart from its rows, which the part after this one reads.
  test("prose over its own rows states its unit, and prose apart from them reads as on main", async () => {
    await readsAsWanted([
      ["库存以吨计。\n一厂: 54\n\n研发人数: 31", "一厂: 54", "一厂为54吨。", TICK],
      ["功率以瓦计。\n一厂: 54\n\n研发人数: 31", "一厂: 54", "一厂为54瓦。", TICK],
      [
        "库存以吨计。\n项目\t库存\n一厂\t54\n\n部门\t人数\n研发\t31",
        "一厂\t54",
        "一厂库存为54吨。",
        TICK,
      ],
      [
        "功率以瓦计。\n项目\t功率\n一厂\t54\n\n部门\t人数\n研发\t31",
        "一厂\t54",
        "一厂功率为54瓦。",
        TICK,
      ],
      [
        "本报告库存以吨计。\n\n第三节 各厂情况\n\n厂区\t库存\n一厂\t54\n二厂\t31",
        "二厂\t31",
        "二厂库存为31吨。",
        leftToTheModel("31", "31吨"),
      ],
      [
        "本报告功率以瓦计。\n\n第三节 各厂情况\n\n厂区\t功率\n一厂\t54\n二厂\t31",
        "二厂\t31",
        "二厂功率为31瓦。",
        leftToTheModel("31", "31瓦"),
      ],
    ]);
  });
});

describe("A table's own heading lines and labels give its rows their unit (#2997)", {
  timeout: 120_000,
}, () => {
  // protects=a table glued under another, with no line between, starts at its own heading row, so it takes nothing from the first table's caption, unit line or prose, while a heading row of periods ("厂区\t2023年\t2024年", "Site\t2023\t2024", "FY2023") heads its own table and lets the caption over it through, in both languages; fails_when="研发产量为31千克。" or "Research's headcount was 31 kg." citing the glued table reads ✓, or "二厂2024年产量为31千克。" under a caption over a heading row of years reads Not checked; no_claim=a number below a section row inside a table, which reads as on main.
  test("a glued table takes nothing from the table above, and a heading row of periods heads its own table", async () => {
    await readsAsWanted([
      [
        "表3 各厂产量（千克）\n厂区\t产量\n一厂\t54\n二厂\t62\n部门\t人数\n研发\t31",
        "研发\t31",
        "研发产量为31千克。",
        UNJUDGED,
      ],
      [
        "Unit: kg\nSite\tValue\nA\t54\nB\t62\nTeam\tHeadcount\nResearch\t31",
        "Research\t31",
        "Research's value was 31 kg.",
        UNJUDGED,
      ],
      [
        "Unit: kg\nItem\tStock\nA\t54\nTeam\tHeadcount\nResearch\t31",
        "Research\t31",
        "Research's headcount was 31 kg.",
        UNJUDGED,
      ],
      [
        "Unit: kg\nItem\tStock\nA\t54\nTeam\tHeadcount\nResearch\t31",
        "A\t54",
        "A's stock was 54 kg.",
        TICK,
      ],
      [
        "表3 各厂产量（千克）\n厂区\t2023年\t2024年\n一厂\t54\t77\n二厂\t62\t31\n部门\t2023年\t2024年\n研发\t40\t45",
        "研发\t40\t45",
        "研发2024年为45千克。",
        UNJUDGED,
      ],
      [
        "表3 各厂产量（千克）\n厂区\t2023年\t2024年\n一厂\t54\t77\n二厂\t62\t31\n部门\t2023年\t2024年\n研发\t40\t45",
        "二厂\t62\t31",
        "二厂2024年产量为31千克。",
        TICK,
      ],
      [
        "Table 3. Output by site (kg)\nSite\t2023\t2024\nA\t54\t77\nB\t62\t31\nTeam\t2023\t2024\nResearch\t40\t45",
        "Research\t40\t45",
        "Research's figure for 2024 was 45 kg.",
        UNJUDGED,
      ],
      [
        "Table 3. Output by site (kg)\nSite\t2023\t2024\nA\t54\t77\nB\t62\t31\nTeam\t2023\t2024\nResearch\t40\t45",
        "B\t62\t31",
        "Site B's output in 2024 was 31 kg.",
        TICK,
      ],
      [
        "Table 3. Output by site (kg)\nSite\tFY2023\tFY2024\nA\t54\t77\nB\t62\t31",
        "B\t62\t31",
        "Site B's output in FY2024 was 31 kg.",
        TICK,
      ],
    ]);
  });
});

describe("A heading's own exception leaves out the numbers it names (#2997)", {
  timeout: 120_000,
}, () => {
  // protects=a scale a heading states "except per share data" (a unit line, a caption, "$ in millions, except per share amounts", "except where noted", 除每股数据外, 每股数据除外, 除另有说明外, the number's own label or its column's heading, where the clause itself is no name) gives nothing to a per-share figure, nor to a share count where the clause leaves share counts out too, in a row-wise table, a column-wise one and side-by-side panels, while the amounts beside it keep the ✓ the heading gives them, in both languages; fails_when="Earnings per share were $2 million in 2024." or "2024年每股收益为2.00万元。" under such a heading reads ✓, or "Revenue was $620 million in 2024." there reads Not checked; no_claim=a per-share figure in plain dollars or 元, which reads Not checked as on main.
  test("a per-share figure or a share count takes no scale from a heading that excepts it", async () => {
    await readsAsWanted([
      [
        "(USD millions, except per share data)\nItem\t2023\t2024\nRevenue\t540\t620\nEarnings per share\t1.50\t2.00",
        "Earnings per share\t1.50\t2.00",
        "Earnings per share were $2 million in 2024.",
        UNJUDGED,
      ],
      [
        "(USD millions, except per share data)\nItem\t2023\t2024\nRevenue\t540\t620\nEarnings per share\t1.50\t2.00",
        "Earnings per share\t1.50\t2.00",
        "Earnings per share were $2.00 in 2024.",
        UNJUDGED,
      ],
      [
        "(USD millions, except per share data)\nItem\t2023\t2024\nRevenue\t540\t620\nEarnings per share\t1.50\t2.00",
        "Revenue\t540\t620",
        "Revenue was $620 million in 2024.",
        TICK,
      ],
      [
        "单位：万元（除每股数据外）\n项目\t2023年\t2024年\n营业收入\t540\t620\n每股收益\t1.50\t2.00",
        "每股收益\t1.50\t2.00",
        "2024年每股收益为2.00万元。",
        UNJUDGED,
      ],
      [
        "单位：万元（除每股数据外）\n项目\t2023年\t2024年\n营业收入\t540\t620\n每股收益\t1.50\t2.00",
        "每股收益\t1.50\t2.00",
        "2024年每股收益为2.00元。",
        UNJUDGED,
      ],
      [
        "单位：万元（除每股数据外）\n项目\t2023年\t2024年\n营业收入\t540\t620\n每股收益\t1.50\t2.00",
        "营业收入\t540\t620",
        "2024年营业收入为620万元。",
        TICK,
      ],
      [
        "Table 2. Results ($ in millions, except per share data)\nItem\t2023\t2024\nRevenue\t540\t620\nEarnings per share\t1.50\t2.00",
        "Earnings per share\t1.50\t2.00",
        "Earnings per share were $2 million in 2024.",
        UNJUDGED,
      ],
      [
        "Table 2. Results ($ in millions, except per share data)\nItem\t2023\t2024\nRevenue\t540\t620\nEarnings per share\t1.50\t2.00",
        "Revenue\t540\t620",
        "Revenue was $620 million in 2024.",
        TICK,
      ],
      [
        "表2 主要财务数据（百万元，除每股数据外）\n项目\t2023年\t2024年\n营业收入\t540\t620\n每股收益\t1.50\t2.00",
        "每股收益\t1.50\t2.00",
        "2024年每股收益为2.00百万元。",
        UNJUDGED,
      ],
      [
        "表2 主要财务数据（百万元，除每股数据外）\n项目\t2023年\t2024年\n营业收入\t540\t620\n每股收益\t1.50\t2.00",
        "营业收入\t540\t620",
        "2024年营业收入为620百万元。",
        TICK,
      ],
      [
        "表2 主要财务数据（人民币百万元，除每股数据外）\n项目\t2023年\t2024年\n营业收入\t540\t620\n每股收益\t1.50\t2.00",
        "每股收益\t1.50\t2.00",
        "2024年每股收益为2.00百万元。",
        UNJUDGED,
      ],
      [
        "表2 主要财务数据（人民币百万元，除每股数据外）\n项目\t2023年\t2024年\n营业收入\t540\t620\n每股收益\t1.50\t2.00",
        "营业收入\t540\t620",
        "2024年营业收入为620百万元。",
        TICK,
      ],
      [
        "$ in millions, except per share amounts\nItem\t2023\t2024\nRevenue\t540\t620\nEarnings per share\t1.50\t2.00",
        "Earnings per share\t1.50\t2.00",
        "Earnings per share were $2 million in 2024.",
        UNJUDGED,
      ],
      [
        "$ in millions, except per share amounts\nItem\t2023\t2024\nRevenue\t540\t620\nEarnings per share\t1.50\t2.00",
        "Revenue\t540\t620",
        "Revenue was $620 million in 2024.",
        TICK,
      ],
      [
        "单位：百万元（每股数据除外）\n项目\t2023年\t2024年\n营业收入\t540\t620\n每股收益\t1.50\t2.00",
        "每股收益\t1.50\t2.00",
        "2024年每股收益为2.00百万元。",
        UNJUDGED,
      ],
      [
        "单位：百万元（每股数据除外）\n项目\t2023年\t2024年\n营业收入\t540\t620\n每股收益\t1.50\t2.00",
        "营业收入\t540\t620",
        "2024年营业收入为620百万元。",
        TICK,
      ],
      [
        "(USD millions, except where noted)\nItem\t2023\t2024\nRevenue\t540\t620\nEarnings per share\t1.50\t2.00",
        "Earnings per share\t1.50\t2.00",
        "Earnings per share were $2 million in 2024.",
        UNJUDGED,
      ],
      [
        "(USD millions, except where noted)\nItem\t2023\t2024\nRevenue\t540\t620\nEarnings per share\t1.50\t2.00",
        "Revenue\t540\t620",
        "Revenue was $620 million in 2024.",
        TICK,
      ],
      [
        "单位：万元（除另有说明外）\n项目\t2023年\t2024年\n营业收入\t540\t620\n每股收益\t1.50\t2.00",
        "每股收益\t1.50\t2.00",
        "2024年每股收益为2.00万元。",
        UNJUDGED,
      ],
      [
        "单位：万元（除另有说明外）\n项目\t2023年\t2024年\n营业收入\t540\t620\n每股收益\t1.50\t2.00",
        "营业收入\t540\t620",
        "2024年营业收入为620万元。",
        TICK,
      ],
      [
        "(USD millions, except per share data)\nYear\tRevenue\tEPS\n2023\t540\t1.50\n2024\t620\t2.00",
        "2024\t620\t2.00",
        "EPS was $2 million in 2024.",
        UNJUDGED,
      ],
      [
        "(USD millions, except per share data)\nYear\tRevenue\tEPS\n2023\t540\t1.50\n2024\t620\t2.00",
        "2024\t620\t2.00",
        "Revenue was $620 million in 2024.",
        TICK,
      ],
      [
        "单位：万元（除每股数据外）\n年份\t营业收入\t每股收益\n2023\t540\t1.50\n2024\t620\t2.00",
        "2024\t620\t2.00",
        "2024年每股收益为2.00万元。",
        UNJUDGED,
      ],
      [
        "单位：万元（除每股数据外）\n年份\t营业收入\t每股收益\n2023\t540\t1.50\n2024\t620\t2.00",
        "2024\t620\t2.00",
        "2024年营业收入为620万元。",
        TICK,
      ],
      [
        "(In thousands, except share and per share data)\nItem\t2023\t2024\nRevenue\t540\t620\nShares outstanding\t1,000\t1,200\nEarnings per share\t1.50\t2.00",
        "Shares outstanding\t1,000\t1,200",
        "Shares outstanding were 1,200 thousand in 2024.",
        UNJUDGED,
      ],
      [
        "(In thousands, except share and per share data)\nItem\t2023\t2024\nRevenue\t540\t620\nShares outstanding\t1,000\t1,200\nEarnings per share\t1.50\t2.00",
        "Revenue\t540\t620",
        "Revenue was 620 thousand in 2024.",
        TICK,
      ],
      [
        "单位：千元（除股数及每股数据外）\n项目\t2023年\t2024年\n营业收入\t540\t620\n加权平均股份\t1,000\t1,200",
        "加权平均股份\t1,000\t1,200",
        "2024年加权平均股份为1,200千元。",
        UNJUDGED,
      ],
      [
        "单位：千元（除股数及每股数据外）\n项目\t2023年\t2024年\n营业收入\t540\t620\n加权平均股份\t1,000\t1,200",
        "营业收入\t540\t620",
        "2024年营业收入为620千元。",
        TICK,
      ],
      [
        "(USD millions, except per share data)\n| EPS | 2.00 | Revenue | 620 |\n| Diluted EPS | 1.95 | Costs | 410 |",
        "| EPS | 2.00 | Revenue | 620 |",
        "EPS was $2 million.",
        UNJUDGED,
      ],
      [
        "(USD millions, except per share data)\n| EPS | 2.00 | Revenue | 620 |\n| Diluted EPS | 1.95 | Costs | 410 |",
        "| EPS | 2.00 | Revenue | 620 |",
        "Revenue was $620 million.",
        TICK,
      ],
      [
        "单位：万元（除每股数据外）\n| 每股收益 | 2.00 | 营业收入 | 620 |\n| 稀释每股收益 | 1.95 | 营业成本 | 410 |",
        "| 每股收益 | 2.00 | 营业收入 | 620 |",
        "每股收益为2.00万元。",
        UNJUDGED,
      ],
      [
        "单位：万元（除每股数据外）\n| 每股收益 | 2.00 | 营业收入 | 620 |\n| 稀释每股收益 | 1.95 | 营业成本 | 410 |",
        "| 每股收益 | 2.00 | 营业收入 | 620 |",
        "营业收入为620万元。",
        TICK,
      ],
      [
        "营业收入（万元，除每股数据外）: 620\n每股收益（万元，除每股数据外）: 2.00",
        "每股收益（万元，除每股数据外）: 2.00",
        "每股收益为2.00万元。",
        UNJUDGED,
      ],
      [
        "营业收入（万元，除每股数据外）: 620\n每股收益（万元，除每股数据外）: 2.00",
        "营业收入（万元，除每股数据外）: 620",
        "营业收入为620万元。",
        TICK,
      ],
      [
        "项目\t2023年（万元，除每股数据外）\t2024年（万元，除每股数据外）\n营业收入\t540\t620\n每股收益\t1.50\t2.00",
        "每股收益\t1.50\t2.00",
        "2024年每股收益为2.00万元。",
        UNJUDGED,
      ],
      [
        "项目\t2023年（万元，除每股数据外）\t2024年（万元，除每股数据外）\n营业收入\t540\t620\n每股收益\t1.50\t2.00",
        "营业收入\t540\t620",
        "2024年营业收入为620万元。",
        TICK,
      ],
      [
        "项目\t本期（万元，除每股数据外）\t上期（万元，除每股数据外）\n营业收入\t620\t540\n每股收益\t2.00\t1.50",
        "每股收益\t2.00\t1.50",
        "本期每股收益为2.00万元。",
        UNJUDGED,
      ],
      [
        "项目\t本期（万元，除每股数据外）\t上期（万元，除每股数据外）\n营业收入\t620\t540\n每股收益\t2.00\t1.50",
        "营业收入\t620\t540",
        "本期营业收入为620万元。",
        TICK,
      ],
    ]);
  });

  // protects=a label that holds a digit is still read for the clause: a note number in any form ("(note 7)", "(Note 7)", a bare 7, （附注7）, （注7）, 注7, "(1)"), a period before the name ("Q4 earnings per share", 第4季度每股收益) or after it ("EPS (FY2024)"), in a row, beside a Note column and in side-by-side panels; the per-share figure given the heading's scale reads Not checked, as on main, and in plain dollars or 元 no worse than on main; the revenue beside it keeps its ✓ with a note number of its own, as "Tier 1 capital" does; fails_when=a per-share row whose label holds a digit takes the scale the heading excepts it from, or a row that is no per-share row loses its ✓; no_claim=that a cell with a digit is a label: it may be a value, and the measure rule still reads none as one.
  test("a per-share row whose label holds a note number or a period takes no scale from a heading that excepts it", async () => {
    await readsAsWanted([
      [
        "(USD millions, except per share data)\nItem\t2023\t2024\nRevenue\t540\t620\nEarnings per share (note 7)\t1.50\t2.00",
        "Earnings per share (note 7)\t1.50\t2.00",
        "Earnings per share were $2.00 million in 2024.",
        UNJUDGED,
      ],
      [
        "(USD millions, except per share data)\nItem\t2023\t2024\nRevenue\t540\t620\nEarnings per share (note 7)\t1.50\t2.00",
        "Earnings per share (note 7)\t1.50\t2.00",
        "Earnings per share were $2.00 in 2024.",
        UNJUDGED,
      ],
      [
        "(USD millions, except per share data)\nItem\t2023\t2024\nRevenue\t540\t620\nEarnings per share (Note 7)\t1.50\t2.00",
        "Earnings per share (Note 7)\t1.50\t2.00",
        "Earnings per share were $2.00 million in 2024.",
        UNJUDGED,
      ],
      [
        "(USD millions, except per share data)\nItem\t2023\t2024\nRevenue\t540\t620\nEarnings per share (Note 7)\t1.50\t2.00",
        "Earnings per share (Note 7)\t1.50\t2.00",
        "Earnings per share were $2.00 in 2024.",
        UNJUDGED,
      ],
      [
        "(USD millions, except per share data)\nItem\t2023\t2024\nRevenue\t540\t620\nEarnings per share 7\t1.50\t2.00",
        "Earnings per share 7\t1.50\t2.00",
        "Earnings per share were $2.00 million in 2024.",
        UNJUDGED,
      ],
      [
        "(USD millions, except per share data)\nItem\t2023\t2024\nRevenue\t540\t620\nEarnings per share 7\t1.50\t2.00",
        "Earnings per share 7\t1.50\t2.00",
        "Earnings per share were $2.00 in 2024.",
        UNJUDGED,
      ],
      [
        "(USD millions, except per share data)\nItem\t2023\t2024\nRevenue\t540\t620\nQ4 earnings per share\t1.50\t2.00",
        "Q4 earnings per share\t1.50\t2.00",
        "Q4 earnings per share were $2.00 million in 2024.",
        UNJUDGED,
      ],
      [
        "(USD millions, except per share data)\nItem\t2023\t2024\nRevenue\t540\t620\nQ4 earnings per share\t1.50\t2.00",
        "Q4 earnings per share\t1.50\t2.00",
        "Q4 earnings per share were $2.00 in 2024.",
        UNJUDGED,
      ],
      [
        "(USD millions, except per share data)\nItem\t2023\t2024\nRevenue\t540\t620\nEPS (FY2024)\t1.50\t2.00",
        "EPS (FY2024)\t1.50\t2.00",
        "EPS was $2.00 million in 2024.",
        UNJUDGED,
      ],
      [
        "(USD millions, except per share data)\nItem\t2023\t2024\nRevenue\t540\t620\nEPS (FY2024)\t1.50\t2.00",
        "EPS (FY2024)\t1.50\t2.00",
        "EPS was $2.00 in 2024.",
        UNJUDGED,
      ],
      [
        "单位：百万元（每股数据除外）\n项目\t2023年\t2024年\n营业收入\t540\t620\n每股收益（附注7）\t1.50\t2.00",
        "每股收益（附注7）\t1.50\t2.00",
        "2024年每股收益为2.00百万元。",
        UNJUDGED,
      ],
      [
        "单位：百万元（每股数据除外）\n项目\t2023年\t2024年\n营业收入\t540\t620\n每股收益（附注7）\t1.50\t2.00",
        "每股收益（附注7）\t1.50\t2.00",
        "2024年每股收益为2.00元。",
        UNJUDGED,
      ],
      [
        "单位：百万元（每股数据除外）\n项目\t2023年\t2024年\n营业收入\t540\t620\n每股收益（注7）\t1.50\t2.00",
        "每股收益（注7）\t1.50\t2.00",
        "2024年每股收益为2.00百万元。",
        UNJUDGED,
      ],
      [
        "单位：百万元（每股数据除外）\n项目\t2023年\t2024年\n营业收入\t540\t620\n每股收益（注7）\t1.50\t2.00",
        "每股收益（注7）\t1.50\t2.00",
        "2024年每股收益为2.00元。",
        UNJUDGED,
      ],
      [
        "单位：百万元（每股数据除外）\n项目\t2023年\t2024年\n营业收入\t540\t620\n每股收益 注7\t1.50\t2.00",
        "每股收益 注7\t1.50\t2.00",
        "2024年每股收益为2.00百万元。",
        UNJUDGED,
      ],
      [
        "单位：百万元（每股数据除外）\n项目\t2023年\t2024年\n营业收入\t540\t620\n每股收益 注7\t1.50\t2.00",
        "每股收益 注7\t1.50\t2.00",
        "2024年每股收益为2.00元。",
        UNJUDGED,
      ],
      [
        "单位：百万元（每股数据除外）\n项目\t2023年\t2024年\n营业收入\t540\t620\n每股收益(1)\t1.50\t2.00",
        "每股收益(1)\t1.50\t2.00",
        "2024年每股收益为2.00百万元。",
        UNJUDGED,
      ],
      [
        "单位：百万元（每股数据除外）\n项目\t2023年\t2024年\n营业收入\t540\t620\n每股收益(1)\t1.50\t2.00",
        "每股收益(1)\t1.50\t2.00",
        "2024年每股收益为2.00元。",
        UNJUDGED,
      ],
      [
        "单位：百万元（每股数据除外）\n项目\t2023年\t2024年\n营业收入\t540\t620\n第4季度每股收益\t1.50\t2.00",
        "第4季度每股收益\t1.50\t2.00",
        "2024年第4季度每股收益为2.00百万元。",
        UNJUDGED,
      ],
      [
        "单位：百万元（每股数据除外）\n项目\t2023年\t2024年\n营业收入\t540\t620\n第4季度每股收益\t1.50\t2.00",
        "第4季度每股收益\t1.50\t2.00",
        "2024年第4季度每股收益为2.00元。",
        UNJUDGED,
      ],
      [
        "(USD millions, except per share data)\nItem\t2023\t2024\nRevenue (note 3)\t540\t620\nEarnings per share (note 7)\t1.50\t2.00",
        "Revenue (note 3)\t540\t620",
        "Revenue was $620 million in 2024.",
        TICK,
      ],
      [
        "(USD millions, except per share data)\nItem\t2023\t2024\nRevenue (note 3)\t540\t620\nEarnings per share (note 7)\t1.50\t2.00",
        "Revenue (note 3)\t540\t620",
        "Revenue was $620 billion in 2024.",
        caught("620", "$620 billion"),
      ],
      [
        "(USD millions, except per share data)\nItem\t2023\t2024\nTier 1 capital\t540\t620\nEarnings per share\t1.50\t2.00",
        "Tier 1 capital\t540\t620",
        "Tier 1 capital was $620 million in 2024.",
        TICK,
      ],
      [
        "单位：百万元（每股数据除外）\n项目\t2023年\t2024年\n营业收入（附注3）\t540\t620\n每股收益（附注7）\t1.50\t2.00",
        "营业收入（附注3）\t540\t620",
        "2024年营业收入为620百万元。",
        TICK,
      ],
      [
        "单位：百万元（每股数据除外）\n项目\t2023年\t2024年\n营业收入（附注3）\t540\t620\n每股收益（附注7）\t1.50\t2.00",
        "营业收入（附注3）\t540\t620",
        "2024年营业收入为620万元。",
        caught("620", "620万元"),
      ],
      [
        "(USD millions, except per share data)\nItem\tNote\t2023\t2024\nRevenue\t3\t540\t620\nEarnings per share\t7\t1.50\t2.00",
        "Earnings per share\t7\t1.50\t2.00",
        "Earnings per share were $2.00 million in 2024.",
        UNJUDGED,
      ],
      [
        "(USD millions, except per share data)\nItem\tNote\t2023\t2024\nRevenue\t3\t540\t620\nEarnings per share\t7\t1.50\t2.00",
        "Revenue\t3\t540\t620",
        "Revenue was $620 million in 2024.",
        TICK,
      ],
      [
        "单位：百万元（每股数据除外）\n项目\t附注\t2023年\t2024年\n营业收入\t3\t540\t620\n每股收益\t7\t1.50\t2.00",
        "每股收益\t7\t1.50\t2.00",
        "2024年每股收益为2.00百万元。",
        UNJUDGED,
      ],
      [
        "单位：百万元（每股数据除外）\n项目\t附注\t2023年\t2024年\n营业收入\t3\t540\t620\n每股收益\t7\t1.50\t2.00",
        "营业收入\t3\t540\t620",
        "2024年营业收入为620百万元。",
        TICK,
      ],
      [
        "(USD millions, except per share data)\nEPS (note 7)\t2.00\tRevenue (note 3)\t620",
        "EPS (note 7)\t2.00\tRevenue (note 3)\t620",
        "Revenue was $620 million.",
        TICK,
      ],
      [
        "(USD millions, except per share data)\nEPS (note 7)\t2.00\tRevenue (note 3)\t620",
        "EPS (note 7)\t2.00\tRevenue (note 3)\t620",
        "EPS was $2.00 million.",
        UNJUDGED,
      ],
      [
        "(USD millions, except per share data)\nRevenue (note 3)\t620\tEPS (note 7)\t2.00",
        "Revenue (note 3)\t620\tEPS (note 7)\t2.00",
        "EPS was $2.00 million.",
        UNJUDGED,
      ],
      [
        "(USD millions, except per share data)\nRevenue (note 3)\t620\tEPS (note 7)\t2.00",
        "Revenue (note 3)\t620\tEPS (note 7)\t2.00",
        "Revenue was $620 million.",
        TICK,
      ],
    ]);
  });

  // protects=the clause is read by the calculation rule's own test of a label, which takes an English label that begins "Basic" or "Diluted" for a per-share row, as under "Earnings per share:", and reads 每股 in Chinese: a right sentence about "Basic materials revenue" or "Diluted net income" under such a heading reads Not checked, as on main, where a row named Basic or Diluted alone takes no scale from it either; its wrong twins read as on main in both checks (no scale: Not checked, and no guard of Check against Documents objects; another scale: Unsupported in both); a Chinese label that begins 基本 or 稀释 is no per-share row to that test, so 基本材料收入 keeps its ✓; fails_when=any reads otherwise without that test having changed; no_claim=that "Basic materials revenue" is a per-share row, or that the sentence with no scale is right.
  test("a row whose label begins Basic or Diluted reads as on main under such a heading, and its wrong twins as on main", async () => {
    await readsAsWanted([
      [
        "(USD millions, except per share data)\nItem\t2023\t2024\nBasic materials revenue\t540\t620\nEarnings per share\t1.50\t2.00",
        "Basic materials revenue\t540\t620",
        "Basic materials revenue was $620 million in 2024.",
        UNJUDGED,
      ],
      [
        "(USD millions, except per share data)\nItem\t2023\t2024\nBasic materials revenue\t540\t620\nEarnings per share\t1.50\t2.00",
        "Basic materials revenue\t540\t620",
        "Basic materials revenue was $620 in 2024.",
        UNJUDGED,
      ],
      [
        "(USD millions, except per share data)\nItem\t2023\t2024\nBasic materials revenue\t540\t620\nEarnings per share\t1.50\t2.00",
        "Basic materials revenue\t540\t620",
        "Basic materials revenue was $620 thousand in 2024.",
        caught("620", "$620 thousand"),
      ],
      [
        "(USD millions, except per share data)\nItem\t2023\t2024\nDiluted net income\t540\t620\nEarnings per share\t1.50\t2.00",
        "Diluted net income\t540\t620",
        "Diluted net income was $620 million in 2024.",
        UNJUDGED,
      ],
      [
        "(USD millions, except per share data)\nItem\t2023\t2024\nDiluted net income\t540\t620\nEarnings per share\t1.50\t2.00",
        "Diluted net income\t540\t620",
        "Diluted net income was $620 thousand in 2024.",
        caught("620", "$620 thousand"),
      ],
      [
        "(USD millions, except per share data)\nItem\t2023\t2024\nRevenue\t540\t620\nBasic\t1.50\t2.00\nDiluted\t1.45\t1.95",
        "Diluted\t1.45\t1.95",
        "Diluted earnings per share were $1.95 million in 2024.",
        UNJUDGED,
      ],
      [
        "(USD millions, except per share data)\nItem\t2023\t2024\nRevenue\t540\t620\nBasic\t1.50\t2.00\nDiluted\t1.45\t1.95",
        "Basic\t1.50\t2.00",
        "Basic earnings per share were $2.00 million in 2024.",
        UNJUDGED,
      ],
      [
        "(USD millions, except per share data)\nItem\t2023\t2024\nRevenue\t540\t620\nBasic\t1.50\t2.00\nDiluted\t1.45\t1.95",
        "Diluted\t1.45\t1.95",
        "Diluted earnings per share were $1.95 in 2024.",
        UNJUDGED,
      ],
      [
        "单位：百万元（除每股数据外）\n项目\t2023年\t2024年\n基本材料收入\t540\t620\n每股收益\t1.50\t2.00",
        "基本材料收入\t540\t620",
        "2024年基本材料收入为620百万元。",
        TICK,
      ],
      [
        "单位：百万元（除每股数据外）\n项目\t2023年\t2024年\n基本材料收入\t540\t620\n每股收益\t1.50\t2.00",
        "基本材料收入\t540\t620",
        "2024年基本材料收入为620元。",
        UNJUDGED,
      ],
      [
        "单位：百万元（除每股数据外）\n项目\t2023年\t2024年\n基本材料收入\t540\t620\n每股收益\t1.50\t2.00",
        "基本材料收入\t540\t620",
        "2024年基本材料收入为620万元。",
        caught("620", "620万元"),
      ],
      [
        "单位：百万元（除每股数据外）\n项目\t2023年\t2024年\n稀释后净利润\t540\t620\n每股收益\t1.50\t2.00",
        "稀释后净利润\t540\t620",
        "2024年稀释后净利润为620百万元。",
        TICK,
      ],
      [
        "单位：百万元（除每股数据外）\n项目\t2023年\t2024年\n稀释后净利润\t540\t620\n每股收益\t1.50\t2.00",
        "稀释后净利润\t540\t620",
        "2024年稀释后净利润为620元。",
        UNJUDGED,
      ],
      [
        "单位：百万元（除每股数据外）\n项目\t2023年\t2024年\n营业收入\t540\t620\n基本每股收益\t1.50\t2.00\n稀释每股收益\t1.45\t1.95",
        "基本每股收益\t1.50\t2.00",
        "2024年基本每股收益为2.00百万元。",
        UNJUDGED,
      ],
      [
        "单位：百万元（除每股数据外）\n项目\t2023年\t2024年\n营业收入\t540\t620\n基本每股收益\t1.50\t2.00\n稀释每股收益\t1.45\t1.95",
        "稀释每股收益\t1.45\t1.95",
        "2024年稀释每股收益为1.95百万元。",
        UNJUDGED,
      ],
      [
        "单位：百万元（除每股数据外）\n项目\t2023年\t2024年\n营业收入\t540\t620\n基本每股收益\t1.50\t2.00\n稀释每股收益\t1.45\t1.95",
        "基本每股收益\t1.50\t2.00",
        "2024年基本每股收益为2.00元。",
        UNJUDGED,
      ],
    ]);
  });
});

/** Each Document and quote with a wrong sentence, Not checked in an Answer, then its right twin, which keeps its ✓ (citing `twinQuote` when given). */
const twins = (
  rows: readonly [text: string, quote: string, wrong: string, right: string, twinQuote?: string][],
): [string, string, string, Wanted][] =>
  rows.flatMap(([text, quote, wrong, right, twinQuote]) => [
    [text, quote, wrong, UNJUDGED],
    [text, twinQuote ?? quote, right, TICK],
  ]);

/** Two sites under `head`, a measure column and a headcount, in the language of `measure`. */
const sites = (head: string, measure: string) =>
  /\p{Script=Han}/u.test(measure)
    ? `${head}\n厂区\t${measure}\t人数\n一厂\t54\t77\n二厂\t62\t31`
    : `${head}\nSite\t${measure}\tStaff\nA\t54\t77\nB\t62\t31`;

/** Two rows under `head`, a measure and a headcount, over two years, in the language of `measure`. */
const keyFigures = (head: string, measure: string) =>
  /\p{Script=Han}/u.test(measure)
    ? `${head}\n项目\t2023年\t2024年\n${measure}\t54\t62\n员工人数\t77\t31`
    : `${head}\nItem\t2023\t2024\n${measure}\t54\t62\nHeadcount\t77\t31`;

const PIPELINE =
  "Pipeline by stage (£k)\nStage\tDeals\tValue\nQualified\t42\t1,260\nProposal\t17\t830";
const COSTS =
  "(USD millions)\nItem\t2023\t2024\nRevenue\t540\t620\nCosts\t300\t350\nProfit\t240\t270";
const COSTS_ZH = "单位：万元\n项目\t2023年\t2024年\n收入\t540\t620\n成本\t300\t350\n利润\t240\t270";
const REGIONS_ZH = "表3 各地区情况（万元）\n地区\t收入\t成本\n华东地区\t62\t40\n华北地区\t54\t31";
const REGIONS =
  "Table 3. Regions (USD millions)\nRegion\tRevenue\tCosts\nEast region\t62\t40\nNorth region\t54\t31";
const RESULTS_ZH = "单位：万元\n项目\t2023年\t2024年\n营业收入\t540\t620\n营业成本\t300\t350";
const RESULTS =
  "(USD millions)\nItem\t2023\t2024\nTotal revenue\t540\t620\nCost of sales\t300\t350";

describe("A number that takes its unit from a line over its table isn't the figure of a sentence that means another of its numbers (#2997)", {
  timeout: 120_000,
}, () => {
  // protects=a number in a column the sentence doesn't name, while it names another column of the table, takes nothing from the caption, unit line, heading or prose over its table, so the wrong sentence reads Not checked in an Answer and its right twin keeps its ✓; tab and pipe tables, money and measures, English and Chinese; a number the row holds twice, once in the column the sentence names, still states it; fails_when="二厂产量为31千克。" citing the 31 under 人数 below "表3 各厂情况（千克）" keeps a ✓, or "二厂产量为62千克。" loses it; no_claim=a sentence that names no column or the count column itself, which stays known.
  test("a number in a column the sentence doesn't name, while it names another, reads Not checked beside its right twin", async () => {
    await readsAsWanted([
      ...twins(
        (
          [
            ["表3 各厂情况（千克）", "产量", "二厂产量为31千克。"],
            ["表3 各厂情况（兆瓦）", "产量", "二厂产量为31兆瓦。"],
            ["表3 各厂情况（吨）", "产量", "二厂产量为31吨。"],
            ["表3 各厂情况（瓦）", "产量", "二厂产量为31瓦。"],
            ["单位：万元", "产值", "二厂产值为31万元。"],
            ["单位：万吨", "产值", "二厂产值为31万吨。"],
            ["表3 各厂产值（万元）", "产值", "二厂产值为31万元。"],
            ["产量（千克）", "产量", "二厂产量为31千克。"],
            ["Table 3. Sites (kg)", "Output", "Site B's output was 31 kg."],
            ["Table 3. Sites (kt)", "Output", "Site B's output was 31 kt."],
            ["Table 3. Sites (tonnes)", "Output", "Site B's output was 31 tonnes."],
            ["Table 3. Sites (W)", "Output", "Site B's output was 31 W."],
            ["Table 3. Sites (USD millions)", "Output", "Site B's output was $31 million."],
            ["Table 3. Sites (USD millions)", "Revenue", "Site B's revenue was $31 million."],
            ["(USD millions)", "Revenue", "Site B's revenue was $31 million."],
            ["$ in millions", "Revenue", "Site B's revenue was $31 million."],
            ["Output (kg)", "Output", "Site B's output was 31 kg."],
          ] as const
        ).map(([head, measure, wrong]): [string, string, string, string] => [
          sites(head, measure),
          /\p{Script=Han}/u.test(measure) ? "二厂\t62\t31" : "B\t62\t31",
          wrong,
          wrong.replace("31", "62"),
        ]),
      ),
      ...twins([
        [
          "本报告金额以万元计。\n厂区\t产值\t人数\n一厂\t54\t12\n二厂\t57\t31",
          "二厂\t57\t31",
          "二厂产值为31万元。",
          "二厂产值为57万元。",
        ],
        [
          "All amounts are in USD millions.\nSite\tRevenue\tStaff\nA\t54\t12\nB\t57\t31",
          "B\t57\t31",
          "Site B's revenue was $31 million.",
          "Site B's revenue was $57 million.",
        ],
        [
          "各厂产量（千克）\n厂区\t产量\t人数\n一厂\t54\t12\n二厂\t40\t31",
          "二厂\t40\t31",
          "二厂产量为31千克。",
          "二厂产量为40千克。",
        ],
        [
          "表3 各厂情况（千克）\n| 厂区 | 产量 | 人数 |\n| --- | --- | --- |\n| 一厂 | 54 | 77 |\n| 二厂 | 62 | 31 |",
          "| 二厂 | 62 | 31 |",
          "二厂产量为31千克。",
          "二厂产量为62千克。",
        ],
        [
          "Table 3. Sites (kg)\n| Site | Output | Staff |\n|---|---|---|\n| A | 54 | 77 |\n| B | 62 | 31 |",
          "| B | 62 | 31 |",
          "Site B's output was 31 kg.",
          "Site B's output was 62 kg.",
        ],
        [
          PIPELINE,
          "Proposal\t17\t830",
          "The number of deals at the proposal stage was £830k.",
          "Seventeen deals worth £830k were at the proposal stage.",
        ],
        [
          "各阶段商机（万元）\n阶段\t数量\t金额\n初筛\t42\t960\n方案\t17\t830",
          "方案\t17\t830",
          "方案阶段商机数量为830万元。",
          "方案阶段金额为830万元。",
        ],
      ]),
      [
        "表3 各厂情况（千克）\n厂区\t产量\t库存\n一厂\t54\t77\n二厂\t31\t31",
        "二厂\t31\t31",
        "二厂产量为31千克。",
        TICK,
      ],
      [
        "Table 3. Sites (kg)\nSite\tOutput\tStock\nA\t54\t77\nB\t31\t31",
        "B\t31\t31",
        "Site B's output was 31 kg.",
        TICK,
      ],
    ]);
  });

  // protects=another row's number, in a row-wise table under a caption or in a column-wise one under a caption or a unit line, takes nothing from the line over its table when the sentence names another row and not its own, so the wrong sentence reads Not checked in an Answer and its right twin keeps its ✓, English and Chinese, tab and pipe tables; fails_when="2024年产量为31千克。" citing the 员工人数 row below "表3 主要指标（千克）", or "二厂产量为54吨。" citing 一厂's 54 below "表3 各厂产量（吨）", keeps a ✓, or its twin loses it; no_claim=another row's number under labelled lines ("一厂产量（吨）: 54"), which stays known.
  test("another row's number reads Not checked beside its right twin", async () => {
    await readsAsWanted([
      ...twins(
        (
          [
            ["表3 主要指标（千克）", "产量", "2024年产量为31千克。"],
            ["表3 主要指标（兆瓦）", "产量", "2024年产量为31兆瓦。"],
            ["表3 主要指标（吨）", "产量", "2024年产量为31吨。"],
            ["表3 主要指标（瓦）", "产量", "2024年产量为31瓦。"],
            ["Table 3. Key figures (kg)", "Output", "Output in 2024 was 31 kg."],
            ["Table 3. Key figures (kt)", "Output", "Output in 2024 was 31 kt."],
            ["Table 3. Key figures (tonnes)", "Output", "Output in 2024 was 31 tonnes."],
            ["Table 3. Key figures (W)", "Output", "Output in 2024 was 31 W."],
            ["Table 3. Key figures (USD millions)", "Output", "Output in 2024 was $31 million."],
          ] as const
        ).map(([head, measure, wrong]): [string, string, string, string, string] => {
          const zh = /\p{Script=Han}/u.test(measure);
          return [
            keyFigures(head, measure),
            zh ? "员工人数\t77\t31" : "Headcount\t77\t31",
            wrong,
            wrong.replace("31", "62"),
            `${measure}\t54\t62`,
          ];
        }),
      ),
      ...twins([
        [
          "表3 各厂产量（吨）\n厂区\t产量\n一厂\t54\n二厂\t31",
          "一厂\t54",
          "二厂产量为54吨。",
          "一厂产量为54吨。",
        ],
        [
          "Table 3. Output by site (tonnes)\nSite\tOutput\nA\t54\nB\t31",
          "A\t54",
          "Site B's output was 54 tonnes.",
          "Site A's output was 54 tonnes.",
        ],
        [
          "Unit: t\nSite\tOutput\nA\t54\nB\t31",
          "A\t54",
          "Site B's output was 54 t.",
          "Site A's output was 54 t.",
        ],
        [
          "Table 3. Output by site (tonnes)\n| Site | Output |\n|---|---|\n| A | 54 |\n| B | 31 |",
          "| A | 54 |",
          "Site B's output was 54 tonnes.",
          "Site A's output was 54 tonnes.",
        ],
        [
          COSTS,
          "Profit\t240\t270",
          "Costs were $270 million in 2024.",
          "Profit was $270 million in 2024.",
        ],
        [COSTS_ZH, "利润\t240\t270", "2024年成本为270万元。", "2024年利润为270万元。"],
      ]),
    ]);
  });

  // protects=a column or row the sentence names for another of its own figures, whose number the row or column holds, gives this number nothing away: "Seventeen deals worth £830k were at the proposal stage." under "Pipeline by stage (£k)" over Stage, Deals and Value keeps its ✓ (the measured table's l-fs-038, there under "Value (£k)", also keeps it); so do a name the number's own name holds ("Revenue" beside "Revenue change"), a sentence that names both columns, a panel to the right, and a year heading; fails_when=any of these reads Not checked; no_claim=a sentence that names another column for none of its figures, which reads Not checked.
  test("a name the sentence gives another of its figures, or one the number's own name holds, gives no number away", async () => {
    await readsAsWanted([
      [
        PIPELINE,
        "Proposal\t17\t830",
        "Seventeen deals worth £830k were at the proposal stage.",
        TICK,
      ],
      [
        "Pipeline by stage\nStage\tDeals\tValue (£k)\nQualified\t42\t1,260\nProposal\t17\t830",
        "Proposal\t17\t830",
        "Seventeen deals worth £830k were at the proposal stage.",
        TICK,
      ],
      [
        "Unit: £k\nStage\tDeals\tValue\nQualified\t42\t1,260\nProposal\t17\t830",
        "Proposal\t17\t830",
        "Seventeen deals worth £830k were at the proposal stage.",
        TICK,
      ],
      [
        COSTS,
        "Costs\t300\t350\nProfit\t240\t270",
        "Costs of $350 million in 2024 left $270 million.",
        TICK,
      ],
      [COSTS_ZH, "成本\t300\t350\n利润\t240\t270", "2024年成本350万元，余下270万元。", TICK],
      [
        "表3 各厂情况（千克）\n厂区\t产量\t库存\n一厂\t54\t77\n二厂\t62\t31",
        "二厂\t62\t31",
        "二厂产量为62千克，另有31千克。",
        TICK,
      ],
      [
        "Table 3. Sites (tonnes)\nSite\tOutput\tStock\nA\t54\t77\nB\t62\t31",
        "B\t62\t31",
        "Site B's output was 62 tonnes, with another 31 tonnes left over.",
        TICK,
      ],
      [
        "表3 各厂情况（千克）\n厂区\t产量\t库存\n一厂\t54\t77\n二厂\t62\t31",
        "二厂\t62\t31",
        "二厂产量为62千克，库存为31千克。",
        TICK,
      ],
      [
        "Table 3. Sites (tonnes)\nSite\tOutput\tStock\nA\t54\t77\nB\t62\t31",
        "B\t62\t31",
        "Site B's output was 62 tonnes and its stock 31 tonnes.",
        TICK,
      ],
      [
        "Table 3. Sites (USD millions)\nSite\tRevenue\tRevenue change\nA\t54\t5\nB\t62\t8",
        "B\t62\t8",
        "Site B's revenue rose by $8 million.",
        TICK,
      ],
      [
        "表3 各厂收入（万元）\n厂区\t收入\t收入增加额\n一厂\t54\t5\n二厂\t62\t8",
        "二厂\t62\t8",
        "二厂收入增加了8万元。",
        TICK,
      ],
      [
        "Unit: kW\nSite\tLoad\tSite\tLoad\nA\t54\tC\t12\nB\t31\tD\t40",
        "B\t31\tD\t40",
        "Site D's load was 40 kW.",
        TICK,
      ],
      [
        "单位：千瓦\n厂区\t负荷\t厂区\t负荷\n一厂\t54\t三厂\t12\n二厂\t31\t四厂\t40",
        "二厂\t31\t四厂\t40",
        "四厂负荷为40千瓦。",
        TICK,
      ],
      [keyFigures("表3 主要指标（千克）", "产量"), "产量\t54\t62", "2023年产量为54千克。", TICK],
    ]);
  });

  // protects=what the names can't tell, pinned so the next change that touches them shows it: a right sentence that names another column or row of the table for its one figure and not its own reads Not checked in an Answer where the line over the table gave it a ✓ ("Deals at the proposal stage were worth £830k." over Stage, Deals and Value; "方案阶段商机价值830万元。" over 阶段, 商机 and 金额; "The second site made 31 tonnes of the total." beside a Total row; "The second site had a load of 31 kW.", whose article says row A), and so does one that says its own column or row by a shorter name or another word while it says another in full ("Revenue in 2024 was $620 million, well above cost of sales." beside Total revenue and Cost of sales; "华东地区营收为62万元，成本较低。" over 收入 and 成本), while naming its own column or row in full keeps the ✓; a wrong sentence that names both columns with its two figures swapped keeps its ✓; fails_when=any reads otherwise without this list changing; no_claim=that these readings are right.
  test("what the names can't tell", async () => {
    await readsAsWanted([
      [PIPELINE, "Proposal\t17\t830", "Deals at the proposal stage were worth £830k.", UNJUDGED],
      [
        "各阶段商机（万元）\n阶段\t商机\t金额\n初筛\t42\t960\n方案\t17\t830",
        "方案\t17\t830",
        "方案阶段商机价值830万元。",
        UNJUDGED,
      ],
      [
        "Table 3. Output by site (tonnes)\nSite\tOutput\nA\t54\nB\t31\nTotal\t85",
        "B\t31",
        "The second site made 31 tonnes of the total.",
        UNJUDGED,
      ],
      [
        "Table 3. Output by site (tonnes)\nSite\tOutput\nA\t54\nB\t31\nTotal\t85",
        "B\t31",
        "Site B made 31 tonnes of the total.",
        TICK,
      ],
      [
        "表3 各厂产量（吨）\n厂区\t产量\n一厂\t54\n二厂\t31\n合计\t85",
        "二厂\t31",
        "二号厂区的产量为31吨，计入合计。",
        UNJUDGED,
      ],
      [
        "Unit: kW\nSite\tLoad\nA\t54\nB\t31",
        "B\t31",
        "The second site had a load of 31 kW.",
        UNJUDGED,
      ],
      ["Unit: kW\nSite\tLoad\nA\t54\nB\t31", "B\t31", "Site B had a load of 31 kW.", TICK],
      [
        "表3 各厂情况（千克）\n厂区\t产量\t库存\n一厂\t54\t77\n二厂\t62\t31",
        "二厂\t62\t31",
        "二厂产量为31千克，库存为62千克。",
        TICK,
      ],
      [
        "Table 3. Sites (tonnes)\nSite\tOutput\tStock\nA\t54\t77\nB\t62\t31",
        "B\t62\t31",
        "Site B's output was 31 tonnes and its stock 62 tonnes.",
        TICK,
      ],
      [REGIONS_ZH, "华东地区\t62\t40", "华东地区营收为62万元，成本较低。", UNJUDGED],
      [REGIONS_ZH, "华东地区\t62\t40", "华东地区收入为62万元，成本较低。", TICK],
      [
        REGIONS,
        "East region\t62\t40",
        "The East region's sales were $62 million, with lower costs.",
        UNJUDGED,
      ],
      [
        REGIONS,
        "East region\t62\t40",
        "The East region's revenue was $62 million, with lower costs.",
        TICK,
      ],
      [RESULTS_ZH, "营业收入\t540\t620", "2024年收入为620万元，高于营业成本。", UNJUDGED],
      [RESULTS_ZH, "营业收入\t540\t620", "2024年营业收入为620万元，高于营业成本。", TICK],
      [
        RESULTS,
        "Total revenue\t540\t620",
        "Revenue in 2024 was $620 million, well above cost of sales.",
        UNJUDGED,
      ],
      [
        RESULTS,
        "Total revenue\t540\t620",
        "Total revenue in 2024 was $620 million, well above cost of sales.",
        TICK,
      ],
    ]);
  });
});

describe("Wrong sentences the check doesn't catch yet (#2997)", { timeout: 120_000 }, () => {
  // protects=known wrong ✓, 23 of the 52 wrong sentences that gained a ✓ when a label's unit came to state a figure and 3 that main ticks, pinned at what they read so the next change that touches them shows it: a number of a count column given the unit a caption over the table states for it, with no column or row named ("二厂为31千克。", "Site B had 31 kg.") or with the count column itself named in that unit ("二厂人数为31千克。"); another row's number under labelled lines ("二厂产量为54吨。" citing "一厂产量（吨）: 54"); a per-share row under a heading that states a scale and excepts nothing ("Earnings per share in 2024 were $2.00 million." under "(USD millions)"), or named 基本 or 稀释 alone under one that excepts per-share data, a label the clause's test reads in English only ("2024年稀释每股收益为1.95百万元。" citing the 稀释 row); 度 as a temperature, an angle or against kilowatt-hours; and three that main's own heading rule ticks (a column heading of a table glued above, in both languages, and the other of two labelled columns). The 29 that name another column or row of the table moved to the test above. They are wrong sentences the check doesn't catch yet (#2997); fails_when=any reads otherwise without its kind being fixed and this list changed; no_claim=that they are right.
  test("known wrong ✓", async () => {
    await readsAsWanted([
      [
        "表3 各厂情况（千克）\n厂区\t产量\t人数\n一厂\t54\t77\n二厂\t62\t31",
        "二厂\t62\t31",
        "二厂为31千克。",
        TICK,
      ],
      [
        "表3 各厂情况（兆瓦）\n厂区\t产量\t人数\n一厂\t54\t77\n二厂\t62\t31",
        "二厂\t62\t31",
        "二厂为31兆瓦。",
        TICK,
      ],
      [
        "表3 各厂情况（吨）\n厂区\t产量\t人数\n一厂\t54\t77\n二厂\t62\t31",
        "二厂\t62\t31",
        "二厂为31吨。",
        TICK,
      ],
      [
        "表3 各厂情况（瓦）\n厂区\t产量\t人数\n一厂\t54\t77\n二厂\t62\t31",
        "二厂\t62\t31",
        "二厂为31瓦。",
        TICK,
      ],
      [
        "Table 3. Sites (kg)\nSite\tOutput\tStaff\nA\t54\t77\nB\t62\t31",
        "B\t62\t31",
        "Site B had 31 kg.",
        TICK,
      ],
      [
        "Table 3. Sites (kt)\nSite\tOutput\tStaff\nA\t54\t77\nB\t62\t31",
        "B\t62\t31",
        "Site B had 31 kt.",
        TICK,
      ],
      [
        "Table 3. Sites (tonnes)\nSite\tOutput\tStaff\nA\t54\t77\nB\t62\t31",
        "B\t62\t31",
        "Site B had 31 tonnes.",
        TICK,
      ],
      [
        "Table 3. Sites (W)\nSite\tOutput\tStaff\nA\t54\t77\nB\t62\t31",
        "B\t62\t31",
        "Site B had 31 W.",
        TICK,
      ],
      [
        "Table 3. Sites (USD millions)\nSite\tOutput\tStaff\nA\t54\t77\nB\t62\t31",
        "B\t62\t31",
        "Site B had $31 million.",
        TICK,
      ],
      [
        "表3 各厂情况（千克）\n厂区\t产量\t人数\n一厂\t54\t77\n二厂\t62\t31",
        "二厂\t62\t31",
        "二厂人数为31千克。",
        TICK,
      ],
      [
        "表3 各厂情况（兆瓦）\n厂区\t产量\t人数\n一厂\t54\t77\n二厂\t62\t31",
        "二厂\t62\t31",
        "二厂人数为31兆瓦。",
        TICK,
      ],
      [
        "表3 各厂情况（吨）\n厂区\t产量\t人数\n一厂\t54\t77\n二厂\t62\t31",
        "二厂\t62\t31",
        "二厂人数为31吨。",
        TICK,
      ],
      [
        "表3 各厂情况（瓦）\n厂区\t产量\t人数\n一厂\t54\t77\n二厂\t62\t31",
        "二厂\t62\t31",
        "二厂人数为31瓦。",
        TICK,
      ],
      ["一厂产量（吨）: 54\n二厂产量（吨）: 62", "一厂产量（吨）: 54", "二厂产量为54吨。", TICK],
      [
        "(USD millions)\nItem\t2023\t2024\nRevenue\t540\t620\nEarnings per share\t1.50\t2.00",
        "Earnings per share\t1.50\t2.00",
        "Earnings per share in 2024 were $2.00 million.",
        TICK,
      ],
      [
        "单位：百万元\n项目\t2023年\t2024年\n营业收入\t540\t620\n每股收益\t1.50\t2.00",
        "每股收益\t1.50\t2.00",
        "2024年每股收益为2.00百万元。",
        TICK,
      ],
      [
        "(USD millions)\nItem\t2023\t2024\nRevenue\t540\t620\nEarnings per share (note 7)\t1.50\t2.00",
        "Earnings per share (note 7)\t1.50\t2.00",
        "Earnings per share were $2.00 million in 2024.",
        TICK,
      ],
      [
        "单位：百万元\n项目\t2023年\t2024年\n营业收入\t540\t620\n每股收益（附注7）\t1.50\t2.00",
        "每股收益（附注7）\t1.50\t2.00",
        "2024年每股收益为2.00百万元。",
        TICK,
      ],
      [
        "单位：百万元（除每股数据外）\n项目\t2023年\t2024年\n营业收入\t540\t620\n基本\t1.50\t2.00\n稀释\t1.45\t1.95",
        "稀释\t1.45\t1.95",
        "2024年稀释每股收益为1.95百万元。",
        TICK,
      ],
      [
        "单位：百万元（除每股数据外）\n项目\t2023年\t2024年\n营业收入\t540\t620\n基本\t1.50\t2.00\n稀释\t1.45\t1.95",
        "基本\t1.50\t2.00",
        "2024年基本每股收益为2.00百万元。",
        TICK,
      ],
      ["室温：26度\n用电：60度", "室温：26度", "室内用电为26千瓦时。", TICK],
      ["用电：26千瓦时\n室温：22度", "用电：26千瓦时", "室温为26度。", TICK],
      ["夹角：30度\n用电：60度", "夹角：30度", "用电为30千瓦时。", TICK],
      [
        "厂区\t产量（千克）\n一厂\t54\n二厂\t62\n部门\t人数\n研发\t31",
        "研发\t31",
        "研发人数为31千克。",
        TICK,
      ],
      [
        "Site\tOutput (kg)\nA\t54\nB\t62\nTeam\tHeadcount\nResearch\t31",
        "Research\t31",
        "Research's headcount was 31 kg.",
        TICK,
      ],
      [
        "厂区\t产量（千克）\t库存（千克）\n一厂\t54\t77\n二厂\t62\t31",
        "二厂\t62\t31",
        "二厂产量为31千克。",
        TICK,
      ],
    ]);
  });
});

const COAL = "指标\t2023年\t2024年\n原煤产量（万吨）\t54\t31\n发电量（亿千瓦时）\t77\t80";
const COAL_EN = "Item\t2023\t2024\nCoal output (kt)\t54\t31\nPower generated (GWh)\t77\t80";
const INCOME = "项目\t2023年\t2024年\n营业收入（万元）\t540\t620\n员工人数（人）\t77\t80";
const INCOME_EN = "Item\t2023\t2024\nRevenue (USD millions)\t540\t620\nHeadcount\t77\t80";
const UNITS = "指标\t单位\t2023年\t2024年\n原煤产量\t万吨\t54\t31\n发电量\t亿千瓦时\t77\t80";
const UNITS_EN = "Item\tUnit\t2023\t2024\nCoal output\tkt\t54\t31\nRevenue\tUSD millions\t540\t620";

describe("A table's row and units column label its values (#2997)", { timeout: 120_000 }, () => {
  // protects=in a table of tab-separated rows a row's heading cell labels the values of its own row, as a row of bars or spaces does, in every value column and with one cell quoted, a note number in the label and all, outranking a caption or unit line over the table, while a column whose heading states its own unit keeps it; the right sentence keeps its ✓ and reads Supported in Check against Documents, and a wrong scale or a figure of the share column is caught in both, in measures and money, English and Chinese; fails_when="2024年原煤产量为31万吨。" citing "原煤产量（万吨）\t54\t31" reads Unsupported in Check against Documents, or "2024年原煤产量为31吨。" or "原煤产量为5.2万吨。" there keeps a ✓; no_claim=a figure of another measure at the label's scale ("31 GWh" beside "Coal output (kt)"), which reads as on main.
  test("a row's heading cell gives its values their unit", async () => {
    await readsAsWanted([
      [COAL, "原煤产量（万吨）\t54\t31", "2024年原煤产量为31万吨。", TICK],
      [COAL, "原煤产量（万吨）\t54\t31", "2023年原煤产量为54万吨。", TICK],
      [COAL, "31", "2024年原煤产量为31万吨。", TICK],
      [COAL, "原煤产量（万吨）\t54\t31", "2024年原煤产量为31吨。", caught("31（万吨）", "31吨")],
      [COAL, "原煤产量（万吨）\t54\t31", "2024年原煤产量为31亿吨。", caught("31", "31亿吨")],
      [COAL, "发电量（亿千瓦时）\t77\t80", "2024年发电量为80亿千瓦时。", TICK],
      [
        COAL,
        "发电量（亿千瓦时）\t77\t80",
        "2024年发电量为80千瓦时。",
        caught("80（亿千瓦时）", "80千瓦时"),
      ],
      [COAL_EN, "Coal output (kt)\t54\t31", "Coal output in 2024 was 31 kt.", TICK],
      [COAL_EN, "Coal output (kt)\t54\t31", "Coal output in 2024 was 31 thousand tonnes.", TICK],
      [
        COAL_EN,
        "Coal output (kt)\t54\t31",
        "Coal output in 2024 was 31 tonnes.",
        caught("31 (kt)", "31 tonnes"),
      ],
      [
        COAL_EN,
        "Coal output (kt)\t54\t31",
        "Coal output in 2024 was 31 Mt.",
        caught("31 (kt)", "31 Mt"),
      ],
      [INCOME, "营业收入（万元）\t540\t620", "2024年营业收入为620万元。", TICK],
      [
        INCOME,
        "营业收入（万元）\t540\t620",
        "2024年营业收入为620元。",
        caught("620（万元）", "620元"),
      ],
      [INCOME, "营业收入（万元）\t540\t620", "2024年营业收入为620亿元。", caught("620", "620亿元")],
      [INCOME_EN, "Revenue (USD millions)\t540\t620", "Revenue in 2024 was $620 million.", TICK],
      [
        INCOME_EN,
        "Revenue (USD millions)\t540\t620",
        "Revenue in 2024 was $620.",
        caught("620 (USD millions)", "$620"),
      ],
      [
        INCOME_EN,
        "Revenue (USD millions)\t540\t620",
        "Revenue in 2024 was $620 billion.",
        caught("620", "$620 billion"),
      ],
      [
        "项目\t2024年\t同比（%）\n原煤产量（万吨）\t31\t5.2\n发电量（亿千瓦时）\t80\t6.1",
        "原煤产量（万吨）\t31\t5.2",
        "原煤产量同比增长5.2%。",
        TICK,
      ],
      [
        "项目\t2024年\t同比（%）\n原煤产量（万吨）\t31\t5.2\n发电量（亿千瓦时）\t80\t6.1",
        "原煤产量（万吨）\t31\t5.2",
        "原煤产量为5.2万吨。",
        caught("5.2", "5.2万吨"),
      ],
      [
        "指标\t2023年\t2024年\n原煤产量（万吨）（注1）\t54\t31",
        "原煤产量（万吨）（注1）\t54\t31",
        "2024年原煤产量为31万吨。",
        TICK,
      ],
      [
        "指标\t2023年\t2024年\n原煤产量（万吨）（注1）\t54\t31",
        "原煤产量（万吨）（注1）\t54\t31",
        "2024年原煤产量为31吨。",
        caught("31（万吨）", "31吨"),
      ],
      [
        `表3 主要指标（亿吨）\n${COAL}`,
        "原煤产量（万吨）\t54\t31",
        "2024年原煤产量为31万吨。",
        TICK,
      ],
      [
        `表3 主要指标（亿吨）\n${COAL}`,
        "原煤产量（万吨）\t54\t31",
        "2024年原煤产量为31亿吨。",
        caught("31", "31亿吨"),
      ],
    ]);
  });

  // protects=a column headed 单位, 计量单位 or Unit gives each row's values the unit in its cell, in measures, money and counts, English and Chinese, tabs and bars, and a table glued under another; two units columns give none, as on main; fails_when="2024年原煤产量为31万吨。" citing "原煤产量\t万吨\t54\t31" reads Unsupported in Check against Documents, or "2024年原煤产量为31吨。" there keeps a ✓; no_claim=which of two units columns a number is under.
  test("a units column gives its row's values their unit", async () => {
    await readsAsWanted([
      [UNITS, "原煤产量\t万吨\t54\t31", "2024年原煤产量为31万吨。", TICK],
      [UNITS, "原煤产量\t万吨\t54\t31", "2024年原煤产量为31吨。", caught("31 万吨", "31吨")],
      [UNITS, "原煤产量\t万吨\t54\t31", "2024年原煤产量为31亿吨。", caught("31", "31亿吨")],
      [
        UNITS.replace("单位", "计量单位"),
        "原煤产量\t万吨\t54\t31",
        "2024年原煤产量为31万吨。",
        TICK,
      ],
      [UNITS_EN, "Coal output\tkt\t54\t31", "Coal output in 2024 was 31 kt.", TICK],
      [
        UNITS_EN,
        "Coal output\tkt\t54\t31",
        "Coal output in 2024 was 31 Mt.",
        caught("31 kt", "31 Mt"),
      ],
      [UNITS_EN, "Revenue\tUSD millions\t540\t620", "Revenue in 2024 was $620 million.", TICK],
      [
        UNITS_EN,
        "Revenue\tUSD millions\t540\t620",
        "Revenue in 2024 was $620.",
        caught("620 USD millions", "$620"),
      ],
      [
        "项目\t单位\t2023年\t2024年\n营业收入\t万元\t540\t620\n员工人数\t人\t77\t80",
        "员工人数\t人\t77\t80",
        "2024年员工人数为80人。",
        TICK,
      ],
      [
        "项目\t单位\t2023年\t2024年\n营业收入\t万元\t540\t620\n员工人数\t人\t77\t80",
        "员工人数\t人\t77\t80",
        "2024年员工人数为80万人。",
        caught("80", "80万人"),
      ],
      [
        "| 指标 | 单位 | 2023年 | 2024年 |\n| --- | --- | --- | --- |\n| 原煤产量 | 万吨 | 54 | 31 |",
        "| 原煤产量 | 万吨 | 54 | 31 |",
        "2024年原煤产量为31万吨。",
        TICK,
      ],
      [
        "| 指标 | 单位 | 2023年 | 2024年 |\n| --- | --- | --- | --- |\n| 原煤产量 | 万吨 | 54 | 31 |",
        "| 原煤产量 | 万吨 | 54 | 31 |",
        "2024年原煤产量为31吨。",
        caught("31 万吨", "31吨"),
      ],
      [
        "指标\t单位\t数值\t指标\t单位\t数值\n原煤产量\t万吨\t31\t发电量\t亿千瓦时\t80",
        "原煤产量\t万吨\t31\t发电量\t亿千瓦时\t80",
        "发电量为80亿千瓦时。",
        leftToTheModel("80", "80亿千瓦时"),
      ],
    ]);
  });
});

const COAL_CAPTION = "表3 各厂能耗（吨标准煤）\n厂区\t能耗\n一厂\t54\n二厂\t31";
const TWO_TABLES =
  "表2 各厂产值（万元）\n厂区\t产值\n一厂\t540\n二厂\t620\n\n表3 各厂产量（吨）\n厂区\t产量\n一厂\t54\n二厂\t31";
const TWO_SCALES =
  "表7 各厂产量（万吨）\n厂区\t产量\n一厂\t54\n\n表8 全国产量（亿吨）\n地区\t产量\n全国\t31";
const TWO_SCALES_EN =
  "Table 7. Output by site (kt)\nSite\tOutput\nA\t54\n\nTable 8. National output (Mt)\nRegion\tOutput\nNational\t31";
const CHARGING = "各月充电量（万千瓦时）\n7月\t118\n8月\t126\n\n各月收入\n7月\t20\n8月\t22";

describe("A plain unit with a qualifier states its unit (#2997)", { timeout: 120_000 }, () => {
  // protects=a bare unit followed by words of its own that say what it measures (（吨标准煤）, （吨二氧化碳当量）, "(tonnes CO2e)") states that unit where a unit is written, as a caption, a column's heading, the number's own label, a units column or a unit line, so the right sentence keeps its ✓ and reads Supported, and another scale is caught in both checks, while a word the unit begins (人口, 吨位) states nothing and a caption's scale still reaches its column; fails_when="二厂能耗为31吨标准煤。" under "表3 各厂能耗（吨标准煤）" reads Unsupported in Check against Documents, or "二厂能耗为31万吨标准煤。" keeps a ✓; no_claim=千克标准煤 under 吨标准煤, which needs converting.
  test("吨标准煤 is 吨 and 万吨标准煤 another scale", async () => {
    await readsAsWanted([
      [COAL_CAPTION, "二厂\t31", "二厂能耗为31吨标准煤。", TICK],
      [COAL_CAPTION, "二厂\t31", "二厂能耗为31万吨标准煤。", caught("31", "31万吨")],
      ["厂区\t能耗（吨标准煤）\n一厂\t54\n二厂\t31", "二厂\t31", "二厂能耗为31吨标准煤。", TICK],
      [
        "厂区\t能耗（吨标准煤）\n一厂\t54\n二厂\t31",
        "二厂\t31",
        "二厂能耗为31万吨标准煤。",
        caught("31", "31万吨"),
      ],
      [
        "一厂能耗（吨标准煤）: 54\n二厂能耗（吨标准煤）: 31",
        "二厂能耗（吨标准煤）: 31",
        "二厂能耗为31吨标准煤。",
        TICK,
      ],
      [
        "指标\t单位\t2023年\t2024年\n综合能耗\t吨标准煤\t54\t31",
        "综合能耗\t吨标准煤\t54\t31",
        "2024年综合能耗为31吨标准煤。",
        TICK,
      ],
      [
        "指标\t单位\t2023年\t2024年\n综合能耗\t吨标准煤\t54\t31",
        "综合能耗\t吨标准煤\t54\t31",
        "2024年综合能耗为31万吨标准煤。",
        caught("31", "31万吨"),
      ],
      [
        "厂区\t排放量（吨二氧化碳当量）\n一厂\t54\n二厂\t31",
        "二厂\t31",
        "二厂排放量为31吨二氧化碳当量。",
        TICK,
      ],
      [
        "厂区\t排放量（吨二氧化碳当量）\n一厂\t54\n二厂\t31",
        "二厂\t31",
        "二厂排放量为31万吨二氧化碳当量。",
        caught("31", "31万吨"),
      ],
      [
        "Site\tEmissions (tonnes CO2e)\nA\t54\nB\t31",
        "B\t31",
        "Site B's emissions were 31 tonnes CO2e.",
        TICK,
      ],
      [
        "Site\tEmissions (tonnes CO2e)\nA\t54\nB\t31",
        "B\t31",
        "Site B's emissions were 31 thousand tonnes CO2e.",
        caught("31", "31 thousand tonnes"),
      ],
      [
        "表3 各市常住人口（万人）\n城市\t人口\n甲市\t455\n乙市\t310",
        "乙市\t310",
        "乙市常住人口为310万人。",
        TICK,
      ],
      [
        "表3 各船吨位（万吨）\n船名\t吨位\n甲轮\t45\n乙轮\t31",
        "乙轮\t31",
        "乙轮吨位为31万吨。",
        TICK,
      ],
    ]);
  });
});

describe("A caption heads its own table (#2997)", { timeout: 120_000 }, () => {
  // protects=an unlabelled number takes its unit and scale from the lines heading its own table, and from no caption, bracket or prose elsewhere in the Document, so in a Document of two captioned tables the right sentence keeps its ✓ and Supported while the other table's scale or measure is caught in both checks, and under a heading that states no unit the other heading's bracket gives nothing in Check against Documents, English and Chinese; a Document's unit line still reaches a table whose caption states none; fails_when="全国产量为31万吨。" under "表8 全国产量（亿吨）", "二厂产量为31万元。" under "表3 各厂产量（吨）" or "National output was 31 kt." under "Table 8. National output (Mt)" reads ✓ or Supported; no_claim=the Answer's ✓ where the number's own heading states no unit ("8月收入为22万千瓦时。"), which is the model's, as on main.
  test("an unlabelled number takes the scale of its own table's caption alone", async () => {
    await readsAsWanted([
      [TWO_TABLES, "二厂\t31", "二厂产量为31吨。", TICK],
      [TWO_TABLES, "二厂\t31", "二厂产量为31万吨。", caught("31", "31万吨")],
      [TWO_TABLES, "二厂\t31", "二厂产量为31万元。", caught("31", "31万元")],
      [TWO_SCALES, "全国\t31", "全国产量为31亿吨。", TICK],
      [TWO_SCALES, "全国\t31", "全国产量为31万吨。", caught("31", "31万吨")],
      [TWO_SCALES_EN, "National\t31", "National output was 31 Mt.", TICK],
      [TWO_SCALES_EN, "National\t31", "National output was 31 kt.", caught("31 (Mt)", "31 kt")],
      [CHARGING, "8月\t126", "8月充电量为126万千瓦时。", TICK],
      [CHARGING, "8月\t22", "8月收入为22万千瓦时。", leftToTheModel("22", "22万千瓦时")],
      [
        "单位：万元\n\n表3 各厂产值\n厂区\t产值\n一厂\t54\n二厂\t31",
        "二厂\t31",
        "二厂产值为31万元。",
        TICK,
      ],
    ]);
  });
});

const CARS = "车型\t销量\nSUV\t57\n轿车\t31";

describe("A table's unit said in other ways is read (#2997)", { timeout: 120_000 }, () => {
  // protects=a unit said in a sentence of prose over the rows ("单位为万辆", "in thousand tonnes"), after a slash or in square brackets ("各车型销量/万辆", "销量[万辆]", "产量［万吨］", "产量〔万吨〕", "Output [kt]", "Output / kt"), in a caption that gives a value of its own ("全年销量（万辆）合计 99"), or in a bracket right after the number ("8月: 126（万千瓦时）") states it, so the right sentence keeps its ✓ and reads Supported, and another scale is caught in both checks, English and Chinese, while prose apart from its rows, a list row above a table, a bracket that is no unit and a note mark in square brackets on a row's label (甲厂〔1〕, ［2］, 【注】, [注1]) state nothing; fails_when="SUV销量为57万辆。" under any of them reads Unsupported in Check against Documents, "SUV销量为57亿辆。" or "甲厂产量为31吨。" under 产量［万吨］ keeps a ✓, or "甲厂2024年产量为31万吨。" beside a note mark loses its ✓; no_claim=a count in its plain unit ("SUV销量为57辆。"), which the unit check doesn't read.
  test("prose, a slash, square brackets, a caption with a value and a bracket after the number state their unit", async () => {
    const notes = (mark: string) =>
      `表1 各厂产量（万吨）\n厂区\t2023年\t2024年\n甲厂${mark}\t54\t31\n乙厂\t77\t80`;
    await readsAsWanted([
      ...["［万吨］", "〔万吨〕"].flatMap((bracket): [string, string, string, Wanted][] => {
        const plants = `厂区\t产量${bracket}\n甲厂\t31\n乙厂\t54`;
        return [
          [plants, "甲厂\t31", "甲厂产量为31万吨。", TICK],
          [plants, "甲厂\t31", "甲厂产量为31吨。", caught(`31${bracket}`, "31吨")],
          [plants, "甲厂\t31", "甲厂产量为31亿吨。", caught("31", "31亿吨")],
        ];
      }),
      ...["〔1〕", "［2］", "【注】", "[注1]"].map((mark): [string, string, string, Wanted] => [
        notes(mark),
        `甲厂${mark}\t54\t31`,
        "甲厂2024年产量为31万吨。",
        TICK,
      ]),
      [`本表列出各车型销量，单位为万辆。\n${CARS}`, "SUV\t57", "SUV销量为57万辆。", TICK],
      [
        `本表列出各车型销量，单位为万辆。\n${CARS}`,
        "SUV\t57",
        "SUV销量为57亿辆。",
        caught("57", "57亿辆"),
      ],
      [
        "The table gives output in thousand tonnes.\nSite\tOutput\nA\t54\nB\t31",
        "B\t31",
        "Site B's output was 31 thousand tonnes.",
        TICK,
      ],
      [
        "The table gives output in thousand tonnes.\nSite\tOutput\nA\t54\nB\t31",
        "B\t31",
        "Site B's output was 31 tonnes.",
        caught("31 thousand tonnes", "31 tonnes"),
      ],
      [`各车型销量/万辆\n${CARS}`, "SUV\t57", "SUV销量为57万辆。", TICK],
      [`各车型销量[万辆]\n${CARS}`, "SUV\t57", "SUV销量为57万辆。", TICK],
      [`各车型销量【万辆】\n${CARS}`, "SUV\t57", "SUV销量为57万辆。", TICK],
      ["车型\t销量/万辆\nSUV\t57\n轿车\t31", "SUV\t57", "SUV销量为57万辆。", TICK],
      ["Site\tOutput [kt]\nA\t54\nB\t31", "B\t31", "Site B's output was 31 kt.", TICK],
      [
        "Site\tOutput [kt]\nA\t54\nB\t31",
        "B\t31",
        "Site B's output was 31 Mt.",
        caught("31 [kt]", "31 Mt"),
      ],
      [
        "Site\tOutput / kt\nA\t54\nB\t31",
        "B\t31",
        "Site B's output was 31 Mt.",
        caught("31 kt", "31 Mt"),
      ],
      [
        "SUV销量/万辆: 57\n轿车销量/万辆: 31",
        "SUV销量/万辆: 57",
        "SUV销量为57亿辆。",
        caught("57", "57亿辆"),
      ],
      [`全年销量（万辆）合计 99\n${CARS}`, "SUV\t57", "SUV销量为57万辆。", TICK],
      [
        "Total output (kt): 85\nSite\tOutput\nA\t54\nB\t31",
        "B\t31",
        "Site B's output was 31 Mt.",
        caught("31 (kt)", "31 Mt"),
      ],
      [
        "7月: 118（万千瓦时）\n8月: 126（万千瓦时）",
        "8月: 126（万千瓦时）",
        "8月用电为126万千瓦时。",
        TICK,
      ],
      [
        "7月: 118（万千瓦时）\n8月: 126（万千瓦时）",
        "8月: 126（万千瓦时）",
        "8月用电为126千瓦时。",
        caught("126（万千瓦时）", "126千瓦时"),
      ],
      [
        "July: 118 (GWh)\nAugust: 126 (GWh)",
        "August: 126 (GWh)",
        "August output was 126 GWh.",
        TICK,
      ],
      [`7月: 118\n${CARS}`, "SUV\t57", "SUV销量为57万辆。", leftToTheModel("57", "57万辆")],
      [
        "7月: 118（预计）\n8月: 126（预计）",
        "8月: 126（预计）",
        "8月用电为126万千瓦时。",
        leftToTheModel("126", "126万千瓦时"),
      ],
      [
        `本报告销量单位为万辆。\n\n第三节 人员\n\n部门\t人数\n研发\t31`,
        "研发\t31",
        "研发人数为31万辆。",
        leftToTheModel("31", "31万辆"),
      ],
    ]);
  });

  // protects=another counting word for the same thing states the caption's scale (万台 or 万部 under 万辆, 万名 under 万人), while a count of another thing at that scale (万家 or 万人次 under 万人, 万人 under 万户) or another scale is caught in both checks; fails_when="SUV销量为57万台。" under "表3 各车型销量（万辆）" reads Unsupported in Check against Documents, or "甲市有455万家企业。" under "表3 各市常住人口（万人）" reads Supported there; no_claim=which word a Document would choose.
  test("a counting word for the same thing is the caption's unit, and one for another thing isn't", async () => {
    const people = "表3 各市常住人口（万人）\n城市\t人口\n甲市\t455\n乙市\t310";
    await readsAsWanted([
      [`表3 各车型销量（万辆）\n${CARS}`, "SUV\t57", "SUV销量为57万台。", TICK],
      [`表3 各车型销量（万辆）\n${CARS}`, "SUV\t57", "SUV销量为57万部。", TICK],
      [people, "甲市\t455", "甲市有455万名常住居民。", TICK],
      [people, "甲市\t455", "甲市有455万家企业。", caught("455", "455万家")],
      [people, "甲市\t455", "甲市常住人次为455万人次。", caught("455", "455万人次")],
      [people, "甲市\t455", "甲市有455亿名居民。", caught("455", "455亿名")],
      [
        "厂区\t户数（万户）\n一厂\t54\n二厂\t31",
        "二厂\t31",
        "二厂有31万人。",
        caught("31", "31万人"),
      ],
    ]);
  });
});

describe("Wrong sentences a table's row label reads as every label does (#2997)", {
  timeout: 120_000,
}, () => {
  // protects=known wrong ✓ that a row's heading cell gives as main gives them under a column's heading, a caption or the number's own label: a rate dropped or changed (31万吨 or 31万吨/日 under 产量（万吨/年）, 31万桶 under 产量（万桶/日）), a unit the reader doesn't read (31厘米 under 产量（米）, "31 g" under "Output (kg)", "31 m" under "Output (km)"), pinned at what they read so the next change that touches them shows it; fails_when=any reads otherwise without its kind being fixed under every label and this list changed; no_claim=that they are right.
  test("known wrong ✓ under a row's label", async () => {
    const row = (label: string) => `指标\t2023年\t2024年\n${label}\t54\t31`;
    const rowEn = (label: string) => `Item\t2023\t2024\n${label}\t54\t31`;
    await readsAsWanted([
      [row("产量（万吨/年）"), "产量（万吨/年）\t54\t31", "2024年产量为31万吨。", TICK],
      [row("产量（万吨/年）"), "产量（万吨/年）\t54\t31", "2024年产量为31万吨/日。", TICK],
      [row("产量（万桶/日）"), "产量（万桶/日）\t54\t31", "2024年产量为31万桶。", TICK],
      [row("产量（米）"), "产量（米）\t54\t31", "2024年产量为31厘米。", TICK],
      [rowEn("Output (kg)"), "Output (kg)\t54\t31", "Output in 2024 was 31 g.", TICK],
      [rowEn("Output (km)"), "Output (km)\t54\t31", "Output in 2024 was 31 m.", TICK],
    ]);
  });

  // protects=known costs, right sentences that lose their ✓ beside a footnote letter that is a unit's symbol on a row's label, pinned at what they read: with "(t)" and "(W)" the tab row's label now reads as main already reads it with bars and spaces (Unsupported, "The Document gives 31 (t), not 31 kt.", and Not checked), where main reads tabs ✓ and Supported; with "[t]" and "[W]" the cost is new in tabs, bars and spaces alike, from reading square brackets as round ones are read, where main reads all three ✓ and Supported; fails_when=any reads otherwise without this list changing; no_claim=that the letter is a unit.
  test("known costs of a footnote letter in brackets on a row's label", async () => {
    const plants = (mark: string, layout: "tabs" | "bars" | "spaces") => {
      const lines = [
        ["Plant", "2023", "2024"],
        [`Alpha ${mark}`, "54", "31"],
        ["Beta", "77", "80"],
      ];
      const row = (cells: string[]) =>
        layout === "tabs"
          ? cells.join("\t")
          : layout === "bars"
            ? `| ${cells.join(" | ")} |`
            : cells.join(" ");
      const [head = [], alpha = [], beta = []] = lines;
      const table =
        layout === "bars"
          ? [row(head), "| --- | --- | --- |", row(alpha), row(beta)]
          : [row(head), row(alpha), row(beta)];
      return [`Table 1. Output by plant (kt)\n${table.join("\n")}`, row(alpha)] as const;
    };
    await readsAsWanted(
      (["tabs", "bars", "spaces"] as const).flatMap((layout) =>
        (
          [
            ["(t)", caught("31 (t)", "31 kt")],
            ["[t]", caught("31 [t]", "31 kt")],
            ["(W)", UNJUDGED],
            ["[W]", UNJUDGED],
          ] as const
        ).map(([mark, wanted]): [string, string, string, Wanted] => {
          const [text, quote] = plants(mark, layout);
          return [text, quote, "Alpha's output in 2024 was 31 kt.", wanted];
        }),
      ),
    );
  });
});
