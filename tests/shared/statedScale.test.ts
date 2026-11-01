/**
 * A page's stated scale (`statedScale`), read only on the lines that may state one, is what
 * reading the whole page gave: the first currency next to a scale token, else the first
 * statement with a scale (#2365).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  currencyScaleMarker,
  type FigureContext,
  figureContextOf,
  pageScale,
  readStatedUnits,
  statedScale,
  unsettledScales,
} from "../../src/shared/figures";

const work = vi.hoisted(() => ({ normalised: 0 }));

vi.mock("../../src/shared/text", async (importOriginal) => {
  const text = await importOriginal<typeof import("../../src/shared/text")>();
  return {
    ...text,
    normaliseWithOffsets: (written: string) => {
      work.normalised += written.length;
      return text.normaliseWithOffsets(written);
    },
  };
});

beforeEach(() => {
  work.normalised = 0;
});

/** The page read whole, as processing read it before: the reference every reading must equal. */
const wholePageScale = (text: string, context: FigureContext = {}): string | null =>
  currencyScaleMarker(text) ??
  readStatedUnits(text, context).find((each) => each.scale !== 1)?.chars ??
  null;

const expectSameAsWholePage = (
  texts: readonly string[],
  contexts = (text: string) => [{}, figureContextOf(text)],
) => {
  const differing = texts.flatMap((text) =>
    contexts(text).flatMap((context) => {
      const whole = wholePageScale(text, context);
      const lines = statedScale(text, context);
      return whole === lines ? [] : [{ text: text.slice(0, 300), whole, lines }];
    }),
  );
  expect(differing).toEqual([]);
  // The forms that read two ways (#2365), read only on the lines that may state a scale too.
  const unsettledDiffering = texts.flatMap((text) =>
    contexts(text).flatMap((context) => {
      const whole = wholePageScale(text, context) ?? unsettledScales(text, context)[0] ?? null;
      const lines = pageScale(text, context);
      return whole === lines ? [] : [{ text: text.slice(0, 300), whole, lines }];
    }),
  );
  expect(unsettledDiffering).toEqual([]);
};

const ROOT = join(__dirname, "../..");
const TEXT_KINDS = new Set([".txt", ".md", ".csv", ".vtt", ".html", ".htm"]);

function textFiles(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) return textFiles(path);
    return TEXT_KINDS.has(extname(name)) ? [path] : [];
  });
}

/** A file cut into pages of about 4,000 characters at line ends, as a reader gives them. */
function pagesOf(text: string): string[] {
  const pages: string[] = [];
  let page = "";
  for (const line of text.split(/(?<=\n)/)) {
    page += line;
    if (page.length >= 4000) {
      pages.push(page);
      page = "";
    }
  }
  return page ? [...pages, page] : pages;
}

/**
 * Every string literal the figure reader's own cases write, and the calculation tests' too: their
 * scale lines, row heads and the rows that must or mustn't take a scale (#2365).
 */
function figureCaseTexts(): string[] {
  const source = ["tests/shared/figures.test.ts", "tests/core/calculations.test.ts"]
    .map((file) => readFileSync(join(ROOT, file), "utf8"))
    .join("\n");
  const quoted = [...source.matchAll(/"(?:[^"\\\n]|\\.)*"/g)].flatMap(([literal]) => {
    try {
      return [JSON.parse(literal) as string];
    } catch {
      return [];
    }
  });
  const templates = [...source.matchAll(/`((?:[^`\\$]|\$(?!\{))*)`/g)].map(
    ([, body]) => body ?? "",
  );
  return [...quoted, ...templates].filter((text) => text.trim() !== "");
}

describe("the same scale as reading the whole page", () => {
  test("for every page of the text Documents in the fixtures and the evaluation", () => {
    const files = [...textFiles(join(ROOT, "tests/fixtures")), ...textFiles(join(ROOT, "eval"))];
    expect(files.length).toBeGreaterThan(100);
    const pages = files.flatMap((file) => pagesOf(readFileSync(file, "utf8")));
    const stating = pages.filter((page) => wholePageScale(page) !== null);
    expect(stating.length).toBeGreaterThan(0);
    expectSameAsWholePage(pages, () => [{}]);
  });

  test("for every text the figure reader's cases write, alone and joined", () => {
    const texts = figureCaseTexts();
    expect(texts.length).toBeGreaterThan(500);
    expect(texts.filter((text) => wholePageScale(text) !== null).length).toBeGreaterThan(50);
    expect(texts.filter((text) => unsettledScales(text).length > 0).length).toBeGreaterThan(10);
    expectSameAsWholePage(texts);
    expectSameAsWholePage([texts.join("\n"), texts.join("\n\n"), texts.join(" ")]);
  });

  test("for random pages of scale lines, filler and the breaks the normaliser reads apart", () => {
    const cases = figureCaseTexts();
    const scaleLines = cases.filter((text) => wholePageScale(text) !== null);
    const pieces = [
      ...cases,
      "单位：人民币万元",
      "金额（万元）",
      "（港幣百萬）",
      "All figures in £'000",
      "Revenue (in millions)",
      "in thousands of US dollars",
      "Unit: million tonnes",
      "USD m",
      "$ in m",
      "€ Mio.",
      "m CN¥",
      "人民幣 m",
      "新台幣bn",
      "英鎊m",
      "I'm all in",
      "Spring tides come twice a month.",
      "收入同比增长百分之五。",
      "Total 1,234.5 4,812",
    ];
    const joins = [
      "\n",
      "\r\n",
      "\r",
      "\u2029",
      "\v",
      "\f",
      " \n ",
      "\n\n",
      "\t\n",
      "-\n",
      "–\n",
      "‐\n",
      "\u00ad\n",
      "\n\u0301",
      "\n\u302a",
      "\na\u302a",
      "¨\n",
      "\n¨",
      "\u2028",
      "\u3000\n",
      "\u00a0\n",
      "\ufeff\n",
      " ",
      "  ",
      "\t",
      "\u00a0",
      "\u2009",
      "\u200b",
      "\0",
      "`",
      "’",
      "，",
      "。",
      "",
    ];
    const marks = [
      "-\n",
      "–\n",
      "`",
      "’",
      "-",
      "–",
      "\u200b",
      "\u00ad",
      "\n",
      " ",
      "＄",
      "Ｍ",
      "萬",
      "億",
      "幣",
      "²",
      "仟",
    ];
    let seed = 2365;
    const random = (below: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 8) % below;
    };
    const pick = <T>(list: readonly T[]): T => list[random(list.length)] as T;
    const texts = Array.from({ length: 3000 }, () => {
      let text = "";
      for (let count = 1 + random(8); count > 0; count--) {
        text += pick(random(2) === 0 ? scaleLines : pieces) + pick(joins);
      }
      for (let count = random(3); count > 0; count--) {
        const at = random(text.length + 1);
        text = text.slice(0, at) + pick(marks) + text.slice(at);
      }
      return text;
    });
    expect(texts.filter((text) => wholePageScale(text) !== null).length).toBeGreaterThan(1000);
    expectSameAsWholePage(texts);
  });
});

// protects=#2365; fails_when=a page whose only scale is written with "Rs" is skipped by the hint and read unscaled, or a page whose only scale reads two ways ("in MM") keeps no marker.
test("a rupee scale is read, and a form that reads two ways is the page's scale when nothing else is", () => {
  const rupees = [
    "Rs. 000",
    "Rs 000",
    "Rs.000",
    "Rs m",
    "Rs.m",
    "Rs mn",
    "Rs. bn",
    "Rs k",
    "Rs. Mio.",
    "Rs Tsd.",
  ];
  expect(rupees.map((form) => statedScale(`Revenue\n${form}\nTotal 5,000`))).toEqual(rupees);
  expect(pageScale("Revenue in MM\nTotal $5,000")).toBe("in MM");
  expect(pageScale("Revenue in MM\nAll figures in thousands")).toBe("in thousands");
  expect(pageScale("Revenue in MM\nAmounts in £'000")).toBe("£'000");
  expect(pageScale("Spring tides come twice a month.")).toBeNull();
});

describe("footnote marks and line breaks beside a scale", () => {
  test("a superscript or circled letter the reader makes a footnote mark keeps the scale", () => {
    const texts = [
      "\u24d0m USD",
      "\u207fm USD",
      "Revenue \u24d0k EUR",
      "EUR k\u24d1",
      "\u2071\0Mrd HK$",
    ];
    expect(texts.map((text) => statedScale(text))).toEqual([
      "m USD",
      "m USD",
      "k EUR",
      "EUR k",
      "Mrd HK$",
    ]);
    expectSameAsWholePage(texts);
  });

  test("a currency and a scale token on two lines state no scale, read whole or by line", () => {
    expect(wholePageScale("USD\nm")).toBeNull();
    expect(statedScale("USD\nm")).toBeNull();
  });
});

describe("a page written as one long line", () => {
  const line = "Spring tides come twice a month. ".repeat(6_000);

  test("states the same scale as reading it whole", () => {
    expectSameAsWholePage([line, `${line}Revenue in millions`, `单位：万元 ${line}`], () => [{}]);
    expect(statedScale(`${line}Revenue in millions`)).toBe("in millions");
  });
});

describe("only the lines that may state a scale are normalised", () => {
  const filler = "Spring tides come twice a month.\n".repeat(100_000);

  test("a 3.3 MB page that states none is not normalised at all", () => {
    expect(statedScale(filler)).toBeNull();
    expect(work.normalised).toBe(0);
    expect(statedScale("Spring tides come twice a month.\nRevenue in millions")).toBe(
      "in millions",
    );
    expect(work.normalised).toBe(19);
  });

  test("a 3.3 MB page with one scale line normalises only that line", () => {
    const page = `${filler}Revenue in millions of dollars\n${filler}`;
    expect(statedScale(page)).toBe("in millions of dollars");
    expect(work.normalised).toBe(30);
  });

  test("a Chinese page that writes no currency or scale character is not normalised", () => {
    const page = "收入同比增长，利润率保持稳定。\n".repeat(100_000);
    expect(statedScale(page)).toBeNull();
    expect(work.normalised).toBe(0);
    expect(statedScale("收入同比增长。\n单位：万吨")).toBe("单位：万吨");
    expect(work.normalised).toBe(13);
  });
});
