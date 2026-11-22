/**
 * Reading the shared screen (ADR-0031), its pure parts: when a window's
 * thumbnails say it is worth reading, and the text read from a settled
 * picture, with the figures that may be misread.
 */
import { describe, expect, test } from "vitest";
import type { PagePicture, RecognizedLine } from "../../src/core";
import { createScreenChanges, STILL_MS } from "../../src/core/meetings/screenChanges";
import { markedText, misreadNumber, screenText } from "../../src/core/meetings/screenText";

const WIDTH = 96;
const HEIGHT = 54;

/** A thumbnail filled with one grey, with a block of another where `block` says. */
function thumbnail(
  grey: number,
  block?: { x: number; y: number; size: number; grey: number },
): PagePicture {
  const pixels = new Uint8Array(WIDTH * HEIGHT).fill(grey);
  if (block) {
    for (let y = block.y; y < block.y + block.size; y++) {
      for (let x = block.x; x < block.x + block.size; x++) pixels[y * WIDTH + x] = block.grey;
    }
  }
  return { width: WIDTH, height: HEIGHT, pixels };
}

/** A line read at `top` on a 1000 × 600 picture, sure of each character unless `unsure` holds its index. */
function line(text: string, top: number, left = 50, unsure: number[] = []): RecognizedLine {
  const right = left + 10 * text.length;
  return {
    text,
    quad: [
      [left, top],
      [right, top],
      [right, top + 20],
      [left, top + 20],
    ],
    confidence: 0.95,
    characters: [...text].map((character, at, all) => ({
      text: character,
      confidence: unsure.includes(at) ? 0.5 : 0.98,
      at: (at + 0.5) / all.length,
    })),
  };
}
const PICTURE = { width: 1000, height: 600 };

describe("When the shared window is read", () => {
  test("a new picture is read once it has stayed still, and not again while it stays", () => {
    const changes = createScreenChanges();
    expect(changes.sample(thumbnail(40), 0)).toBe(false);
    expect(changes.sample(thumbnail(40), 1000)).toBe(false);
    expect(changes.sample(thumbnail(40), STILL_MS + 500)).toBe(true);
    changes.read(thumbnail(40));
    expect(changes.sample(thumbnail(40), 3000)).toBe(false);

    // The next slide: read once it settles, not while it is still changing.
    expect(changes.sample(thumbnail(160), 4000)).toBe(false);
    expect(changes.sample(thumbnail(200), 5000)).toBe(false);
    expect(changes.sample(thumbnail(200), 6000)).toBe(false);
    expect(changes.sample(thumbnail(200), 7000)).toBe(true);
  });

  test("a cursor or a video tile that keeps moving isn't a change worth reading", () => {
    const changes = createScreenChanges();
    changes.sample(thumbnail(40), 0);
    changes.sample(thumbnail(40), 2000);
    changes.read(thumbnail(40));
    // A cursor: a pixel or two.
    expect(changes.sample(thumbnail(40, { x: 10, y: 10, size: 1, grey: 255 }), 3000)).toBe(false);
    expect(changes.sample(thumbnail(40, { x: 11, y: 10, size: 1, grey: 255 }), 5000)).toBe(false);
    // A video tile, changing at every sample.
    let at = 6000;
    for (let frame = 0; frame < 12; frame++) {
      at += 1000;
      const tile = { x: 70, y: 30, size: 20, grey: frame % 2 === 0 ? 90 : 220 };
      expect(changes.sample(thumbnail(40, tile), at)).toBe(false);
    }
    // The slide behind it changes: read, the tile still moving.
    for (let frame = 0; frame < 3; frame++) {
      at += 1000;
      const tile = { x: 70, y: 30, size: 20, grey: frame % 2 === 0 ? 90 : 220 };
      const due = changes.sample(thumbnail(120, tile), at);
      if (frame === 2) expect(due).toBe(true);
    }
  });
});

describe("The text read from a shared window", () => {
  test("keeps a table's rows together and marks the figures the two readings disagree on", () => {
    const first = [
      line("Budget", 100),
      line("£1.2m", 100, 600),
      line("Spent to date", 140),
      line("£640k", 140, 600),
    ];
    const second = [
      line("Budget", 100),
      line("£1.2m", 100, 600),
      line("Spent to date", 140),
      line("£648k", 140, 600),
    ];
    const read = screenText(first, second, PICTURE);
    expect(read.text).toBe("Budget\t£1.2m\nSpent to date\t£640k");
    expect(markedText(read)).toBe("Budget\t£1.2m\nSpent to date\t£⟦640⟧k");
    expect(read.lines.map((each) => read.text.slice(each.start, each.end))).toEqual([
      "Budget",
      "£1.2m",
      "Spent to date",
      "£640k",
    ]);
    const [left, top, right, bottom] = read.lines[0]?.box ?? [];
    expect([left, right]).toEqual([0.05, 0.11]);
    expect(top).toBeCloseTo(100 / 600, 3);
    expect(bottom).toBeCloseTo(120 / 600, 3);
  });

  test("marks a figure with a character the recogniser was unsure of, and none when both readings agree", () => {
    const first = [line("Revenue 3.2 bn", 100, 50, [9])];
    expect(markedText(screenText(first, null, PICTURE))).toBe("Revenue ⟦3.2⟧ bn");
    const sure = [line("收入 3.2 亿元", 100), line("同比增长 18%", 140)];
    expect(markedText(screenText(sure, sure, PICTURE))).toBe("收入 3.2 亿元\n同比增长 18%");
  });

  test.each([
    ["2o25", true],
    ["7a;45o", true],
    ["1O%", true],
    ["l2,000", true],
    ["3S.6", true],
    ["Q3", false],
    ["A4", false],
    ["H2O", false],
    ["FY2025", false],
    ["No.7", false],
    ["£1.2m", false],
    ["2026年10月14日", false],
  ])("%s is a misread number: %s", (word, misread) => {
    expect(misreadNumber(word)).toBe(misread);
  });
});
