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
  readStatedUnits,
  statedScale,
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

/** Every string literal the figure reader's own cases write. */
function figureCaseTexts(): string[] {
  const source = readFileSync(join(ROOT, "tests/shared/figures.test.ts"), "utf8");
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
