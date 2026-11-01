import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, test } from "vitest";
import type { RecognizedLine } from "../../src/core";
import { stripBoilerplate } from "../../src/core/documents/boilerplate";
import { convexHull, minAreaRect, textBoxes } from "../../src/core/documents/scan/detect";
import {
  mixedNumberWord,
  readingOrder,
  scannedUnit,
  unsureSpansIn,
  unsureWords,
} from "../../src/core/documents/scan/layout";
import { onnxMetadata } from "../../src/core/documents/scan/onnxMetadata";
import { pictureShare } from "../../src/core/documents/scan/pages";
import { decodeLine, lineFrame } from "../../src/core/documents/scan/recognize";
import type { TextUnit } from "../../src/shared/units";

/** A line read at a box, every character as sure as `confidence`. */
function line(
  text: string,
  [left, top, right, bottom]: [number, number, number, number],
  confidence = 0.98,
): RecognizedLine {
  const pieces = [...text];
  return {
    text,
    quad: [
      [left, top],
      [right, top],
      [right, bottom],
      [left, bottom],
    ],
    confidence,
    characters: pieces.map((piece, at) => ({
      text: piece,
      confidence,
      at: (at + 0.5) / pieces.length,
    })),
  };
}

const texts = (rows: RecognizedLine[][]) => rows.map((row) => row.map((each) => each.text));

describe("Reading a scanned page's lines (#397)", () => {
  test("lines are read row by row, top to bottom, a table's cells left to right", () => {
    const lines = [
      line("2,147", [600, 160, 700, 190]),
      line("Product line", [100, 100, 300, 130]),
      line("Warehouse sensors", [100, 160, 330, 190]),
      line("2024", [620, 100, 700, 130]),
      line("Table 3. Revenue", [100, 40, 500, 70]),
    ];
    expect(texts(readingOrder(lines))).toEqual([
      ["Table 3. Revenue"],
      ["Product line", "2024"],
      ["Warehouse sensors", "2,147"],
    ]);
  });

  test("a slanted page is levelled first, so a row isn't split across its slant", () => {
    // Turned 2°: the far end of each row is about 35 pixels lower than its start.
    const slant = Math.tan((2 * Math.PI) / 180);
    const at = (x: number, y: number, text: string): RecognizedLine => {
      const w = text.length * 20;
      const dy = (x + w) * slant - x * slant;
      return {
        ...line(text, [x, y + x * slant, x + w, y + x * slant + 30]),
        quad: [
          [x, y + x * slant],
          [x + w, y + x * slant + dy],
          [x + w, y + x * slant + dy + 30],
          [x, y + x * slant + 30],
        ],
      };
    };
    const lines = [
      at(100, 100, "A long first line of the page text"),
      at(100, 150, "A long second line of the page text"),
      at(100, 200, "Total"),
      at(900, 200, "12,133"),
    ];
    expect(texts(readingOrder(lines))).toEqual([
      ["A long first line of the page text"],
      ["A long second line of the page text"],
      ["Total", "12,133"],
    ]);
  });

  test("two columns of text are read one after the other, under a title that spans both", () => {
    const left = (y: number, text: string) => line(text, [100, y, 760, y + 30]);
    const right = (y: number, text: string) => line(text, [860, y, 1520, y + 30]);
    const lines = [
      line("A study of two columns", [300, 40, 1300, 80]),
      left(120, "Left one"),
      right(120, "Right one"),
      left(170, "Left two"),
      right(170, "Right two"),
      left(220, "Left three"),
      right(220, "Right three"),
      left(270, "Left four"),
      right(270, "Right four"),
    ];
    expect(texts(readingOrder(lines)).flat()).toEqual([
      "A study of two columns",
      "Left one",
      "Left two",
      "Left three",
      "Left four",
      "Right one",
      "Right two",
      "Right three",
      "Right four",
    ]);
  });

  test("a page's Unit joins rows by line breaks and a table's cells by tabs, each line anchored to its box", () => {
    const unit = scannedUnit(
      3,
      [
        line("Freight software", [100, 100, 300, 130]),
        line("4,812", [600, 100, 680, 130]),
        line("of the date", [100, 150, 230, 180]),
        line("of receipt", [240, 150, 360, 180], 0.5),
      ],
      { width: 1000, height: 2000 },
      "PP-OCRv5 mobile/1",
    );
    expect(unit.text).toBe("Freight software\t4,812\nof the date of receipt");
    expect(unit.anchors?.map((anchor) => [anchor.target, anchor.start, anchor.end])).toEqual([
      ["line1", 0, 16],
      ["line2", 17, 22],
      ["line3", 23, 34],
      ["line4", 35, 45],
    ]);
    expect(unit.anchors?.[0]?.quad).toEqual([0.1, 0.05, 0.3, 0.05, 0.3, 0.065, 0.1, 0.065]);
    expect(unit.label).toEqual({
      scan: {
        reader: "PP-OCRv5 mobile/1",
        unsure: [
          [35, 37],
          [38, 45],
        ],
      },
    });
  });

  test("a word is unsure at its least sure character; each Chinese character is a word of its own", () => {
    const english = line("pay within thirty days", [0, 0, 100, 10]);
    const third = english.characters[12];
    if (third) third.confidence = 0.42;
    expect(unsureWords(english)).toEqual([[11, 17]]);
    const chinese = line("甲方支付押金", [0, 0, 100, 10]);
    const second = chinese.characters[1];
    if (second) second.confidence = 0.3;
    expect(unsureWords(chinese)).toEqual([[1, 2]]);
  });

  test("a number-shaped word mixing digits with letters or stray marks is always unsure, whatever the score (#535)", () => {
    for (const word of [
      "2o25",
      "7a;45o",
      "1O%",
      "l2,000",
      "3S.6",
      "74;450",
      "1O0",
      "(6O)",
      "1o.",
      "1T5",
      "8D0",
      "1q9",
      "6E0",
      "4H0",
      "１T５",
    ]) {
      const read = line(word, [0, 0, 100, 10]);
      expect(unsureWords(read), word).toEqual([[0, word.length]]);
    }
    // Codes, ordinals, and numbers whose letters follow their digits as a unit or
    // scale does, follow the recognizer's score: sure here, unsure of at 0.4.
    for (const word of [
      "Q3",
      "A4",
      "H2O",
      "FY2025",
      "No.7",
      "1st",
      "2nd",
      "5bn",
      "2.5bn",
      "10bps",
      "1990s",
      "10am",
      "50kg",
      "100ml",
      "4GB",
      "5G",
      "12b",
      "9.Termination",
      "10bps-20bps",
      "10am-12pm",
      "1990s-2000s",
      "3Q24",
      "1H25",
      "2H24",
      "2024Q3",
      "4x4",
      "1e6",
    ]) {
      expect(unsureWords(line(word, [0, 0, 100, 10])), word).toEqual([]);
      expect(unsureWords(line(word, [0, 0, 100, 10], 0.4)), word).toEqual([[0, word.length]]);
    }
  });

  test("a page read before the word-shape rule still marks its misread numbers, once each (#535)", () => {
    const read = scannedUnit(
      1,
      [line("The gauge read 2o25 on 14 May.", [100, 120, 600, 150])],
      { width: 1000, height: 2000 },
      "PP-OCRv5 mobile/1",
    );
    // As an older reader left it: its label holds no unsure words, and the shape still says so.
    const page: TextUnit = { ...read, label: { scan: { reader: "PP-OCRv5 mobile/1" } } };
    expect(page.label?.scan?.unsure).toBeUndefined();
    expect(unsureSpansIn(page).map(([from, to]) => page.text.slice(from, to))).toEqual(["2o25"]);
    // A word stored as unsure, and one the shape finds, are both returned, once.
    const stored = {
      ...page,
      label: { scan: { reader: "PP-OCRv5 mobile/1", unsure: [[0, 3]] as [number, number][] } },
    };
    expect(unsureSpansIn(stored).map(([from, to]) => page.text.slice(from, to))).toEqual([
      "The",
      "2o25",
    ]);
  });

  test("on the scan fixtures only the real misreads are doubtful (#535)", () => {
    const read = JSON.parse(
      readFileSync(join(import.meta.dirname, "../fixtures/scans/read.json"), "utf8"),
    ) as { pages: Record<string, { lines: { text: string }[] }> };
    const doubtful = Object.values(read.pages).flatMap((page) =>
      page.lines.flatMap((line) => line.text.split(/\s+/u)).filter((word) => mixedNumberWord(word)),
    );
    expect(doubtful).toEqual(["(6O)", "1o."]);
  });

  test("a Chinese numeral between a number's digits is a digit the scan may have misread (#535)", () => {
    expect(mixedNumberWord("2〇25")).toBe(true);
    expect(mixedNumberWord("2一5")).toBe(true);
    expect(mixedNumberWord("第2二阶段")).toBe(false);
  });

  test("a Chinese line's numbers are judged on their own, so clean ones stay sure and a misread one is found (#535)", () => {
    const clean = scannedUnit(
      1,
      [line("2025年3月，租金调整为74,450元。", [100, 120, 600, 150])],
      { width: 1000, height: 2000 },
      "PP-OCRv5 mobile/1",
    );
    const cleanPage: TextUnit = { ...clean, label: { scan: { reader: "PP-OCRv5 mobile/1" } } };
    expect(unsureSpansIn(cleanPage)).toEqual([]);
    const old = scannedUnit(
      1,
      [line("租金为2o25元。", [100, 120, 600, 150])],
      { width: 1000, height: 2000 },
      "PP-OCRv5 mobile/1",
    );
    const oldPage: TextUnit = { ...old, label: { scan: { reader: "PP-OCRv5 mobile/1" } } };
    expect(unsureSpansIn(oldPage).map(([from, to]) => oldPage.text.slice(from, to))).toEqual([
      "2o25",
    ]);
    const numeral = scannedUnit(
      1,
      [line("租金为2〇25元。", [100, 120, 600, 150])],
      { width: 1000, height: 2000 },
      "PP-OCRv5 mobile/1",
    );
    const numeralPage: TextUnit = {
      ...numeral,
      label: { scan: { reader: "PP-OCRv5 mobile/1" } },
    };
    expect(
      unsureSpansIn(numeralPage).map(([from, to]) => numeralPage.text.slice(from, to)),
    ).toEqual(["2〇25"]);
  });

  test("taking a running header off a scanned page keeps its anchors and unsure words in step", () => {
    const page = (number: number, body: string): TextUnit =>
      scannedUnit(
        number,
        [
          line("Harbour Survey 2025", [100, 40, 400, 70]),
          line(body, [100, 120, 600, 150], number === 2 ? 0.5 : 0.98),
          line(`${number}`, [480, 1900, 500, 1930]),
        ],
        { width: 1000, height: 2000 },
        "PP-OCRv5 mobile/1",
      );
    const [, second] = stripBoilerplate([
      page(1, "Divers mapped the wreck."),
      page(2, "The survey ended in March."),
      page(3, "Sand covers the floor."),
    ]);
    expect(second?.text).toBe("The survey ended in March.");
    expect(second?.anchors?.map((anchor) => [anchor.target, anchor.start, anchor.end])).toEqual([
      ["line2", 0, 26],
    ]);
    expect(second?.label?.scan?.unsure?.[0]).toEqual([0, 3]);
  });
});

describe("The models' input and output (#397)", () => {
  test("a blob of likely text becomes its box, grown by the unclip distance", () => {
    const width = 200;
    const height = 100;
    const data = new Float32Array(width * height);
    // A line 100 × 10 pixels, sure, at (50, 40).
    for (let y = 40; y < 50; y++) for (let x = 50; x < 150; x++) data[y * width + x] = 0.9;
    const boxes = textBoxes({ width, height, data }, 1, 1, width, height);
    expect(boxes).toHaveLength(1);
    const [topLeft, topRight, bottomRight, bottomLeft] = boxes[0]?.quad ?? [];
    // Grown by 99 × 9 × 1.5 / (2 × 108) ≈ 6.2 pixels on every side.
    expect(topLeft).toEqual([44, 34]);
    expect(topRight).toEqual([155, 34]);
    expect(bottomRight).toEqual([155, 55]);
    expect(bottomLeft).toEqual([44, 55]);
    expect(boxes[0]?.score).toBeCloseTo(0.9);
  });

  test("a faint blob is no text", () => {
    const data = new Float32Array(100 * 100).fill(0.35);
    expect(textBoxes({ width: 100, height: 100, data }, 1, 1, 100, 100)).toEqual([]);
  });

  test("a turned rectangle's smallest box is turned with it", () => {
    const angle = Math.PI / 12;
    const turn = (x: number, y: number): [number, number] => [
      x * Math.cos(angle) - y * Math.sin(angle),
      x * Math.sin(angle) + y * Math.cos(angle),
    ];
    const corners = [turn(0, 0), turn(100, 0), turn(100, 20), turn(0, 20)];
    const rect = minAreaRect(convexHull(corners));
    const [short, long] = [rect.halfLength * 2, rect.halfWidth * 2].sort((a, b) => a - b);
    expect(short).toBeCloseTo(20);
    expect(long).toBeCloseTo(100);
    // Its sides lie along the rectangle's: at the angle it was turned, or square to it.
    const turned = Math.atan2(rect.along[1], rect.along[0]);
    const off = Math.abs(((turned - angle) % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
    expect(Math.min(off, Math.PI / 2 - off)).toBeCloseTo(0);
  });

  test("a tall box is read turned a quarter, as a column of vertical text", () => {
    const frame = lineFrame([
      [0, 0],
      [30, 0],
      [30, 300],
      [0, 300],
    ]);
    expect(frame.length).toBe(300);
    expect(frame.breadth).toBe(30);
    expect(frame.quad[0]).toEqual([30, 0]);
  });

  test("the recognition model's steps collapse into text: repeats and blanks dropped", () => {
    const characters = ["甲", "方", "a"];
    // Classes: blank, 甲, 方, a, and the space last.
    const classes = 5;
    const steps = [1, 1, 0, 2, 4, 3, 3, 0, 3];
    const output = new Float32Array(steps.length * classes);
    steps.forEach((best, step) => {
      output[step * classes + best] = best === 2 ? 0.6 : 0.9;
    });
    const decoded = decodeLine(output, 0, steps.length, classes, characters, 0.5);
    expect(decoded.text).toBe("甲方 aa");
    expect(decoded.characters.map((each) => each.text)).toEqual(["甲", "方", " ", "a", "a"]);
    for (const [index, each] of decoded.characters.entries()) {
      expect(each.confidence).toBeCloseTo(index === 1 ? 0.6 : 0.9);
    }
    // Its first character's middle, along the half of the padded width the line took.
    expect(decoded.characters[0]?.at).toBeCloseTo(0.5 / 9 / 0.5);
    expect(decoded.confidence).toBeCloseTo((0.9 * 4 + 0.6) / 5);
  });

  test("a model's metadata is read from its file", () => {
    const varint = (value: number) => {
      const bytes: number[] = [];
      let rest = value;
      while (rest >= 0x80) {
        bytes.push((rest & 0x7f) | 0x80);
        rest >>>= 7;
      }
      bytes.push(rest);
      return bytes;
    };
    const field = (number: number, payload: number[]) => [
      ...varint((number << 3) | 2),
      ...varint(payload.length),
      ...payload,
    ];
    const text = (value: string) => [...new TextEncoder().encode(value)];
    const model = Uint8Array.from([
      // ir_version, a varint, and a graph to skip over.
      ...[0x08, 0x0a],
      ...field(7, text("graph bytes that aren't read")),
      ...field(14, [...field(1, text("character")), ...field(2, text("甲\n乙\nA"))]),
    ]);
    expect(onnxMetadata(model)).toEqual({ character: "甲\n乙\nA" });
  });
});

describe("Which pages are scans (#397)", () => {
  /** An A4 page drawing these operations, as pdf.js lists them. */
  const page = (operations: [number, unknown[] | null][]) => ({
    view: [0, 0, 595, 842],
    getOperatorList: async () => ({
      fnArray: operations.map(([op]) => op),
      argsArray: operations.map(([, args]) => args),
    }),
  });
  const strip = (row: number) => [595, 0, 0, 84.2, 0, 84.2 * row];

  test("a picture drawn over the whole page covers it; drawn at half the width, half of it", async () => {
    const whole = page([
      [OPS.save, null],
      [OPS.transform, [595, 0, 0, 842, 0, 0]],
      [OPS.paintImageXObject, ["img_p0_1", 2480, 3508]],
      [OPS.restore, null],
    ]);
    expect(await pictureShare(whole, OPS)).toBeCloseTo(1);
    const half = page([
      [OPS.transform, [0.5, 0, 0, 1, 0, 0]],
      [OPS.transform, [595, 0, 0, 842, 0, 0]],
      [OPS.paintImageXObject, ["img_p0_1", 2480, 3508]],
    ]);
    expect(await pictureShare(half, OPS)).toBeCloseTo(0.5);
  });

  test("a scan in strips covers its page, though pdf.js groups or repeats the strips", async () => {
    const rows = Array.from({ length: 10 }, (_, row) => row);
    const inline = page([
      [OPS.paintInlineImageXObjectGroup, [{}, rows.map((row) => ({ transform: strip(row) }))]],
    ]);
    expect(await pictureShare(inline, OPS)).toBeCloseTo(1);
    const masks = page([
      [OPS.paintImageMaskXObjectGroup, [rows.map((row) => ({ transform: strip(row) }))]],
    ]);
    expect(await pictureShare(masks, OPS)).toBeCloseTo(1);
    const positions = new Float32Array(rows.flatMap((row) => [0, 84.2 * row]));
    const repeated = page([[OPS.paintImageXObjectRepeat, ["img_p0_1", 595, 84.2, positions]]]);
    expect(await pictureShare(repeated, OPS)).toBeCloseTo(1);
    const maskRepeated = page([
      [OPS.paintImageMaskXObjectRepeat, [{}, 595, 0, 0, 84.2, positions]],
    ]);
    expect(await pictureShare(maskRepeated, OPS)).toBeCloseTo(1);
    // Drawn through a matrix of their own, as any picture is.
    const shrunk = page([
      [OPS.transform, [0.5, 0, 0, 0.5, 0, 0]],
      [OPS.paintImageXObjectRepeat, ["img_p0_1", 595, 84.2, positions]],
    ]);
    expect(await pictureShare(shrunk, OPS)).toBeCloseTo(0.25);
  });
});
