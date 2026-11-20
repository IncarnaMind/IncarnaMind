/**
 * A Canvas's file is told by its bytes, not its name (#3406), and the network addresses its HTML
 * loads from are named back to the agent, since a Canvas reaches none.
 */
import { describe, expect, it } from "vitest";
import { canvasFileType, fileNameOf } from "../../src/core/canvases";
import { networkReferences } from "../../src/core/canvases/references";

const bytes = (...values: (number | string)[]) =>
  Uint8Array.from(
    values.flatMap((each) =>
      typeof each === "string" ? [...each].map((character) => character.charCodeAt(0)) : [each],
    ),
  );
const text = (value: string) => new TextEncoder().encode(value);

describe("A Canvas's file", () => {
  it("is the picture or font its bytes show, whatever its name says", () => {
    expect(canvasFileType("chart.jpg", bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe(
      "image/png",
    );
    expect(canvasFileType("photo", bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(canvasFileType("a.png", bytes("GIF89a", 1, 0))).toBe("image/gif");
    expect(canvasFileType("a.png", bytes("RIFF", 0, 0, 0, 0, "WEBPVP8 "))).toBe("image/webp");
    expect(canvasFileType("a.png", bytes(0, 0, 0, 0x1c, "ftypavif"))).toBe("image/avif");
    expect(canvasFileType("a.css", bytes("wOF2", 0))).toBe("font/woff2");
    expect(canvasFileType("a.css", bytes("wOFF", 0))).toBe("font/woff");
    expect(canvasFileType("a.css", bytes("OTTO", 0))).toBe("font/otf");
    expect(canvasFileType("a.css", bytes(0, 1, 0, 0, 0))).toBe("font/ttf");
  });

  it("is an SVG picture by its first element, and other text by its name once it is text", () => {
    expect(
      canvasFileType("a.txt", text('<?xml version="1.0"?>\n<!-- x -->\n<svg viewBox="0 0 1 1"/>')),
    ).toBe("image/svg+xml");
    expect(canvasFileType("style.css", text("body { color: red }"))).toBe(
      "text/css; charset=utf-8",
    );
    expect(canvasFileType("app.js", text("console.log(1)"))).toBe("text/javascript; charset=utf-8");
    expect(canvasFileType("data.json", text('{"a":1}'))).toBe("application/json; charset=utf-8");
    expect(canvasFileType("rows.csv", text("a,b\n1,2"))).toBe("text/csv; charset=utf-8");
    expect(canvasFileType("潮汐.txt", text("春季大潮"))).toBe("text/plain; charset=utf-8");
  });

  it("is refused when it is a page, a program, or text of no kind a page loads", () => {
    expect(canvasFileType("other.html", text("<p>another page</p>"))).toBeNull();
    expect(canvasFileType("tool.exe", bytes("MZ", 0x90, 0))).toBeNull();
    expect(canvasFileType("archive.zip", bytes("PK", 3, 4))).toBeNull();
    expect(canvasFileType("chart.png", text("not a picture"))).toBeNull();
    expect(canvasFileType("binary.js", bytes("var a", 0, "b"))).toBeNull();
    expect(canvasFileType("latin1.css", bytes("caf", 0xe9))).toBeNull();
  });

  it("is named by the last part of its path, which the page refers to", () => {
    expect(fileNameOf("/Users/priya/report/chart.png")).toBe("chart.png");
    expect(fileNameOf("C:\\Users\\priya\\图表 1.png")).toBe("图表 1.png");
    for (const path of [
      "/Users/priya/",
      "/Users/..",
      ".",
      "/a/b\u0007.png",
      `/a/${"x".repeat(201)}`,
    ]) {
      expect(fileNameOf(path), path).toBeNull();
    }
  });
});

describe("What a Canvas's HTML loads from the network", () => {
  it("is each address once, in order, and never a link the User follows", () => {
    const html = [
      '<link rel="stylesheet" href="https://fonts.example/a.css">',
      '<script src="//cdn.example/chart.js"></script>',
      '<img srcset="https://img.example/a.png 2x">',
      "<style>body { background: url('https://img.example/b.png') } @import \"https://fonts.example/c.css\";</style>",
      '<a href="https://example.com/read-more">Read more</a>',
      '<img src="chart.png"><img src="data:image/png;base64,AAAA">',
      '<link rel="stylesheet" href="https://fonts.example/a.css">',
    ].join("\n");
    expect(networkReferences(html)).toEqual([
      "https://fonts.example/a.css",
      "//cdn.example/chart.js",
      "https://img.example/a.png",
      "https://img.example/b.png",
      "https://fonts.example/c.css",
    ]);
  });
});
