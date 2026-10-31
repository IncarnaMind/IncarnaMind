import { describe, expect, test } from "vitest";
import { fontClass, fontStack, nearestFonts } from "../../src/renderer/src/editor/wordFonts";

describe("a Word font that isn't installed is drawn with the nearest of its script and kind", () => {
  test("Office's fonts take the open faces made to their metrics first, which ship with the app", () => {
    expect(nearestFonts("Calibri")[0]).toBe("Carlito");
    expect(nearestFonts("Cambria")[0]).toBe("Caladea");
    expect(nearestFonts("Times New Roman").slice(0, 2)).toEqual(["Liberation Serif", "Tinos"]);
    expect(nearestFonts("Arial").slice(0, 2)).toEqual(["Liberation Sans", "Arimo"]);
    expect(nearestFonts("Book Antiqua")).toContain("Palatino");
  });

  test("a Latin font falls to its own kind: serif to serifs, sans to sans, mono to mono", () => {
    expect(fontClass("Garamond")).toEqual({ script: "latin", kind: "serif" });
    expect(fontClass("Century Gothic")).toEqual({ script: "latin", kind: "sans" });
    expect(fontClass("Consolas")).toEqual({ script: "latin", kind: "mono" });
    expect(nearestFonts("Segoe UI")).toContain("Arial");
    expect(nearestFonts("Segoe UI")).not.toContain("Times New Roman");
    expect(nearestFonts("Consolas")).toContain("Courier New");
  });

  test("Chinese fonts fall to Song, Hei, Kai or Fangsong by their own names and their English ones", () => {
    expect(fontClass("华文中宋")).toEqual({ script: "zh-Hans", kind: "song" });
    expect(fontClass("STZhongsong")).toEqual({ script: "zh-Hans", kind: "song" });
    expect(fontClass("微软雅黑")).toEqual({ script: "zh-Hans", kind: "hei" });
    expect(fontClass("DengXian")).toEqual({ script: "zh-Hans", kind: "hei" });
    expect(fontClass("楷体_GB2312")).toEqual({ script: "zh-Hans", kind: "kai" });
    expect(fontClass("KaiTi_GB2312")).toEqual({ script: "zh-Hans", kind: "kai" });
    expect(fontClass("仿宋_GB2312")).toEqual({ script: "zh-Hans", kind: "fangsong" });
    expect(fontClass("新細明體")).toEqual({ script: "zh-Hant", kind: "song" });
    expect(fontClass("微軟正黑體")).toEqual({ script: "zh-Hant", kind: "hei" });
    expect(fontClass("標楷體")).toEqual({ script: "zh-Hant", kind: "kai" });
    const song = nearestFonts("华文中宋");
    expect(song).toEqual(expect.arrayContaining(["SimSun", "Songti SC", "Noto Serif CJK SC"]));
    expect(song).not.toContain("SimHei");
    expect(nearestFonts("黑体")).toEqual(
      expect.arrayContaining(["Microsoft YaHei", "PingFang SC"]),
    );
    // No Kai installed: a Song is nearer than a Hei.
    const kai = nearestFonts("楷体");
    expect(kai.indexOf("KaiTi")).toBeLessThan(kai.indexOf("SimSun"));
    expect(kai).not.toContain("SimHei");
  });

  test("Japanese and Korean fonts fall to their own Mincho, Gothic, Batang or Gulim", () => {
    expect(fontClass("ＭＳ 明朝")).toEqual({ script: "ja", kind: "song" });
    expect(fontClass("MS Gothic")).toEqual({ script: "ja", kind: "hei" });
    expect(fontClass("游ゴシック")).toEqual({ script: "ja", kind: "hei" });
    expect(fontClass("바탕")).toEqual({ script: "ko", kind: "song" });
    expect(fontClass("맑은 고딕")).toEqual({ script: "ko", kind: "hei" });
    expect(nearestFonts("MS Mincho")).toContain("Hiragino Mincho ProN");
    expect(nearestFonts("Malgun Gothic")).toContain("Apple SD Gothic Neo");
  });

  test("a run's stack: its Latin face and the nearest, then its East Asian face and the nearest, then the Mind's font of that kind", () => {
    const stack = fontStack({ font: "Book Antiqua", eastAsia: "华文中宋" }) ?? "";
    const names = stack.split(", ");
    expect(names[0]).toBe('"Book Antiqua"');
    expect(names.indexOf('"Palatino"')).toBeLessThan(names.indexOf('"华文中宋"'));
    expect(names.indexOf('"华文中宋"')).toBeLessThan(names.indexOf('"Songti SC"'));
    expect(names.at(-1)).toBe("var(--font-serif)");
    expect(fontStack({ font: "Calibri" })).toMatch(/^"Calibri", "Carlito", .*var\(--font-sans\)$/);
    expect(fontStack({ size: 12 })).toBeNull();
    // Each name once, however the file names it.
    expect(new Set(names).size).toBe(names.length);
  });
});
