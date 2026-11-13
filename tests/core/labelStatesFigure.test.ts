/**
 * A label that gives a figure's unit states the figure for the number rule (#2997): a right
 * sentence whose number the Document gives plain, with its unit in the number's own label, the
 * heading over its rows, its column's heading, or a caption, a unit line or a clause of prose that
 * heads its rows, keeps the model's ✓ in an Answer, as does one that writes the quote's unit in
 * another word. A sentence in another unit, scale, rate or notation, beside a twin, under two units
 * or none, or under another table's line, reads as on main. Each row is read in both interface languages, as an Answer's sentence and in Check against
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
  // protects=a Document that says in prose, just above the rows it speaks of, what its figures are counted in ("本报告产量以瓦计。", "库存以吨计。") states that unit, so the right sentence keeps its ✓ and reads Supported in Check against Documents, while another unit or scale of the measure, or "以克计划" that goes on as a word, reads as on main; fails_when="二厂产量为31瓦。" there reads Unsupported in Check against Documents, or "二厂产量为31千克。" beside "以吨计" reads Supported there; no_claim=the Answer's ✓ on a wrong unit the Document states nowhere, which is the model's, as on main.
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

describe("A unit stated on another line reaches only the rows it heads (#2997)", {
  timeout: 120_000,
}, () => {
  // protects=a caption, a unit line or a line of words directly above a table states its unit for that table's rows alone, so in a Document of two tables each right sentence keeps or gains its ✓, while a number of one table never takes the other's unit, a table without a caption of its own takes none, and a caption or prose set apart by a blank line states nothing, in both languages; fails_when="二厂产量为31万吨。" citing the 万元 table, or "研发数值为31千克。" citing the headcount table after a （千克） caption, reads ✓; no_claim=a caption that heads a table across a blank line, which the part after this one reads.
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
      [twoCaptions, "二厂\t31", "二厂产量为31万吨。", UNJUDGED],
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

describe("Wrong sentences the check doesn't catch yet (#2997)", { timeout: 120_000 }, () => {
  // protects=known wrong ✓, pinned at what they read so the next change that touches them shows it: a number of a count column or another row given the unit a caption, a unit line or a heading states for the table ("二厂产量为31千克。" citing the 31 under 人数, "2024年产量为31千克。" citing the 员工人数 row), the same with no column or row named; another row's number under labelled lines; 度 as a temperature, an angle or against kilowatt-hours; and two that main's own heading rule ticks (a column heading of a table glued above, the other of two labelled columns). They are wrong sentences the check doesn't catch yet (#2997); fails_when=any reads otherwise without its kind being fixed and this list changed; no_claim=that they are right.
  test("known wrong ✓", async () => {
    await readsAsWanted([
      [
        "表3 各厂情况（千克）\n厂区\t产量\t人数\n一厂\t54\t77\n二厂\t62\t31",
        "二厂\t62\t31",
        "二厂产量为31千克。",
        TICK,
      ],
      [
        "Table 3. Sites (kg)\nSite\tOutput\tStaff\nA\t54\t77\nB\t62\t31",
        "B\t62\t31",
        "Site B's output was 31 kg.",
        TICK,
      ],
      [
        "表3 主要指标（千克）\n项目\t2023年\t2024年\n产量\t54\t62\n员工人数\t77\t31",
        "员工人数\t77\t31",
        "2024年产量为31千克。",
        TICK,
      ],
      [
        "Table 3. Key figures (kg)\nItem\t2023\t2024\nOutput\t54\t62\nHeadcount\t77\t31",
        "Headcount\t77\t31",
        "Output in 2024 was 31 kg.",
        TICK,
      ],
      [
        "各厂产量（千克）\n厂区\t产量\t人数\n一厂\t54\t12\n二厂\t40\t31",
        "二厂\t40\t31",
        "二厂产量为31千克。",
        TICK,
      ],
      [
        "单位：万元\n厂区\t产值\t人数\n一厂\t54\t77\n二厂\t62\t31",
        "二厂\t62\t31",
        "二厂产值为31万元。",
        TICK,
      ],
      [
        "Table 3. Sites (USD millions)\nSite\tRevenue\tStaff\nA\t54\t77\nB\t62\t31",
        "B\t62\t31",
        "Site B's revenue was $31 million.",
        TICK,
      ],
      [
        "$ in millions\nSite\tRevenue\tStaff\nA\t54\t77\nB\t62\t31",
        "B\t62\t31",
        "Site B's revenue was $31 million.",
        TICK,
      ],
      [
        "表3 各厂情况（千克）\n厂区\t产量\t人数\n一厂\t54\t77\n二厂\t62\t31",
        "二厂\t62\t31",
        "二厂为31千克。",
        TICK,
      ],
      [
        "Table 3. Sites (kg)\nSite\tOutput\tStaff\nA\t54\t77\nB\t62\t31",
        "B\t62\t31",
        "Site B had 31 kg.",
        TICK,
      ],
      ["一厂产量（吨）: 54\n二厂产量（吨）: 31", "一厂产量（吨）: 54", "二厂产量为54吨。", TICK],
      ["室温：26度", "室温：26度", "室内用电为26千瓦时。", TICK],
      ["用电：26千瓦时", "用电：26千瓦时", "室温为26度。", TICK],
      ["夹角：30度", "夹角：30度", "用电为30千瓦时。", TICK],
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
