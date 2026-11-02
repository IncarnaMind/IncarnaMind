import { describe, expect, test } from "vitest";
import { markdownUnits } from "../../src/core/documents/formats/text";

import {
  type Block,
  type Inline,
  parseMarkdown,
  sectionHeadings,
} from "../../src/renderer/src/viewer/markdown";

/** The tree with every source range replaced by the text it covers, for readable expectations. */
function show(source: string, blocks: readonly Block[]): unknown[] {
  const inlines = (list: readonly Inline[]): unknown[] =>
    list.map((inline) => {
      switch (inline.kind) {
        case "text":
        case "code":
          return { [inline.kind]: source.slice(inline.start, inline.end) };
        case "link":
          return { link: inline.href, children: inlines(inline.children) };
        case "image":
          return { image: inline.src, alt: inline.alt };
        case "break":
          return "break";
        default:
          return { [inline.kind]: inlines(inline.children) };
      }
    });
  const showBlock = (block: Block): unknown => {
    switch (block.kind) {
      case "heading":
        return { [`h${block.level}`]: inlines(block.inlines) };
      case "paragraph":
        return { p: inlines(block.inlines) };
      case "quote":
        return { quote: block.blocks.map(showBlock) };
      case "list":
        return {
          [block.ordered ? "ol" : "ul"]: block.items.map((item) =>
            item.checked === null && item.children.length === 0
              ? inlines(item.inlines)
              : {
                  ...(item.checked === null ? {} : { checked: item.checked }),
                  text: inlines(item.inlines),
                  ...(item.children.length > 0 ? { children: item.children.map(showBlock) } : {}),
                },
          ),
          ...(block.ordered && block.start !== 1 ? { start: block.start } : {}),
        };
      case "verbatim":
        return block.language
          ? { verbatim: source.slice(block.start, block.end), language: block.language }
          : { verbatim: source.slice(block.start, block.end) };
      case "table":
        return {
          table: {
            align: block.align,
            head: block.head.map(inlines),
            rows: block.rows.map((row) => row.map(inlines)),
          },
        };
      case "frontMatter":
        return { frontMatter: source.slice(block.start, block.end) };
      case "rule":
        return "rule";
    }
  };
  return blocks.map(showBlock);
}

const parse = (source: string) => show(source, parseMarkdown(source));

describe("reading Markdown for the viewer", () => {
  test("headings, paragraphs (lines joined by their line break) and rules", () => {
    expect(parse("# Title #\n\nFirst line\nsecond line.\n\n---\n### Sub")).toEqual([
      { h1: [{ text: "Title" }] },
      { p: [{ text: "First line" }, { text: "\n" }, { text: "second line." }] },
      "rule",
      { h3: [{ text: "Sub" }] },
    ]);
  });

  test("emphasis, strikethrough, inline code and escapes", () => {
    expect(
      parse("Some **bold**, *it*, _em_, ~~gone~~, `co*de` and \\*stars\\* in snake_case_name."),
    ).toEqual([
      {
        p: [
          { text: "Some " },
          { strong: [{ text: "bold" }] },
          { text: ", " },
          { em: [{ text: "it" }] },
          { text: ", " },
          { em: [{ text: "em" }] },
          { text: ", " },
          { strike: [{ text: "gone" }] },
          { text: ", " },
          { code: "co*de" },
          { text: " and " },
          { text: "*stars" },
          { text: "* in snake_case_name." },
        ],
      },
    ]);
  });

  test("links are followed only for http, https and mailto; images keep their path and description", () => {
    expect(
      parse(
        '[site](https://example.com "Title") [bad](javascript:void) ![a chart](figures/chart.png) [wiki](https://en.wikipedia.org/wiki/Tide_(disambiguation))',
      ),
    ).toEqual([
      {
        p: [
          { link: "https://example.com", children: [{ text: "site" }] },
          { text: " " },
          { link: null, children: [{ text: "bad" }] },
          { text: " " },
          { image: "figures/chart.png", alt: "a chart" },
          { text: " " },
          {
            link: "https://en.wikipedia.org/wiki/Tide_(disambiguation)",
            children: [{ text: "wiki" }],
          },
        ],
      },
    ]);
  });

  test("links by reference, autolinks and bare web addresses", () => {
    const source = [
      "See [the report][r1], [Tides] and <https://noaa.gov>.",
      "Mail <data@example.org> or visit https://example.com/path, or www.example.org.",
      "",
      "[r1]: https://example.com/report.pdf",
      "[tides]: <https://tides.example> 'Tide tables'",
    ].join("\n");
    expect(parse(source)).toEqual([
      {
        p: [
          { text: "See " },
          { link: "https://example.com/report.pdf", children: [{ text: "the report" }] },
          { text: ", " },
          { link: "https://tides.example", children: [{ text: "Tides" }] },
          { text: " and " },
          { link: "https://noaa.gov", children: [{ text: "https://noaa.gov" }] },
          { text: "." },
          { text: "\n" },
          { text: "Mail " },
          { link: "mailto:data@example.org", children: [{ text: "data@example.org" }] },
          { text: " or visit " },
          { link: "https://example.com/path", children: [{ text: "https://example.com/path" }] },
          { text: ", or " },
          { link: "https://www.example.org", children: [{ text: "www.example.org" }] },
          { text: "." },
        ],
      },
    ]);
  });

  test("raw HTML stays text", () => {
    expect(parse("<script>alert(1)</script> <b>bold</b>")).toEqual([
      { p: [{ text: "<script>alert(1)</script> <b>bold</b>" }] },
    ]);
  });

  test("a line ending in two spaces or a backslash breaks the line", () => {
    expect(parse("First  \nsecond\\\nthird")).toEqual([
      { p: [{ text: "First" }, "break", { text: "second" }, "break", { text: "third" }] },
    ]);
  });

  test("lists, quotes and fenced code", () => {
    const source = [
      "- one",
      "  continued",
      "- two",
      "",
      "3. third",
      "4) fourth",
      "> quoted",
      "> more",
      "```js",
      "const a = 1;",
      "```",
    ].join("\n");
    expect(parse(source)).toEqual([
      { ul: [[{ text: "one" }, { text: "\n" }, { text: "continued" }], [{ text: "two" }]] },
      { ol: [[{ text: "third" }]], start: 3 },
      { ol: [[{ text: "fourth" }]], start: 4 },
      { quote: [{ p: [{ text: "quoted" }, { text: "\n" }, { text: "more" }] }] },
      { verbatim: "const a = 1;", language: "js" },
    ]);
  });

  test("nested lists, task lists, and a quote holding a list", () => {
    const source = [
      "- [x] Calibrate",
      "- [ ] Read the gauges",
      "  1. at high water",
      "  2. at low water",
      "",
      "     More about low water.",
      "- Plain",
      "",
      "> - quoted item",
      "> - another",
    ].join("\n");
    expect(parse(source)).toEqual([
      {
        ul: [
          { checked: true, text: [{ text: "Calibrate" }] },
          {
            checked: false,
            text: [{ text: "Read the gauges" }],
            children: [
              {
                ol: [
                  [{ text: "at high water" }],
                  {
                    text: [{ text: "at low water" }],
                    children: [{ p: [{ text: "More about low water." }] }],
                  },
                ],
              },
            ],
          },
          [{ text: "Plain" }],
        ],
      },
      { quote: [{ ul: [[{ text: "quoted item" }], [{ text: "another" }]] }] },
    ]);
  });

  test("tables, with their columns' alignment", () => {
    const source = [
      "| Site | Gauges | Rise (mm/yr) |",
      "|:-----|:------:|-------------:|",
      "| Harbour | 5 | **4.1** |",
      "| Estuary | 4 |",
      "",
      "a | b",
      "--|--",
      "1 | `x|y`",
    ].join("\n");
    expect(parse(source)).toEqual([
      {
        table: {
          align: ["left", "center", "right"],
          head: [[{ text: "Site" }], [{ text: "Gauges" }], [{ text: "Rise (mm/yr)" }]],
          rows: [
            [[{ text: "Harbour" }], [{ text: "5" }], [{ strong: [{ text: "4.1" }] }]],
            [[{ text: "Estuary" }], [{ text: "4" }], []],
          ],
        },
      },
      {
        table: {
          align: [null, null],
          head: [[{ text: "a" }], [{ text: "b" }]],
          rows: [[[{ text: "1" }], [{ code: "x|y" }]]],
        },
      },
    ]);
    // A row of pipes without a delimiter row under it is a paragraph.
    expect(parse("| a | b |")).toEqual([{ p: [{ text: "| a | b |" }] }]);
  });

  test("underlined headings, indented code and front matter", () => {
    const source = [
      "---",
      "title: Field notes",
      "tags: [tides]",
      "---",
      "Results",
      "=======",
      "",
      "Method",
      "------",
      "",
      "    gauge.read()",
      "    gauge.log()",
    ].join("\n");
    expect(parse(source)).toEqual([
      { frontMatter: "title: Field notes\ntags: [tides]" },
      { h1: [{ text: "Results" }] },
      { h2: [{ text: "Method" }] },
      { verbatim: "gauge.read()\n    gauge.log()" },
    ]);
  });

  test("an unclosed code fence runs to the end", () => {
    expect(parse("```\ncode\nmore")).toEqual([{ verbatim: "code\nmore" }]);
  });

  test("the headings numbered for the outline are the sections the file's Units have", () => {
    const source = [
      "Intro",
      "=====",
      "# One",
      "> # Not a section",
      "- item",
      "  ## Two, in a list",
      "```",
      "# not a heading",
      "```",
      "### Three",
    ].join("\n");
    const blocks = parseMarkdown(source);
    const headings = [...sectionHeadings(blocks).entries()].map(([block, index]) => [
      block.kind === "heading" ? source.slice(...range(block)) : "",
      index,
    ]);
    const units = markdownUnits(source).filter((unit) => (unit.label?.path ?? []).length > 0);
    expect(headings.map(([text]) => text)).toEqual(["One", "Two, in a list", "Three"]);
    expect(units.map((unit) => unit.label?.path?.at(-1))).toEqual([
      "One",
      "Two, in a list",
      "Three",
    ]);
  });
  test("a converted file's words stay words: emphasis, code and links are not read (#762)", () => {
    const source =
      "#\tFees\n\nCost *estimate* and a [link], `code`, C#_notes.\n# not a heading\n- not a list\n> not a quote\n1. not a list\n``` not code";
    expect(show(source, parseMarkdown(source, { literal: true }))).toEqual([
      { h1: [{ text: "Fees" }] },
      {
        p: [
          { text: "Cost *estimate* and a [link], `code`, C#_notes." },
          "break",
          { text: "# not a heading" },
          "break",
          { text: "- not a list" },
          "break",
          { text: "> not a quote" },
          "break",
          { text: "1. not a list" },
          "break",
          { text: "``` not code" },
        ],
      },
    ]);
  });
});

/** A heading's text range in the source. */
function range(block: Block): [number, number] {
  if (block.kind !== "heading") return [0, 0];
  const first = block.inlines[0];
  const last = block.inlines.at(-1);
  return first?.kind === "text" && last?.kind === "text" ? [first.start, last.end] : [0, 0];
}
