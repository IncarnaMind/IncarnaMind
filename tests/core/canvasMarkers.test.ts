/**
 * The Citations a Canvas's text cites become markers as IncarnaMind serves the page (#3406): only in
 * text a reader reads, numbered in the order the page first cites each, and a token IncarnaMind
 * didn't mint for the agent says it wasn't found. Nothing in a script, a style, an attribute or a
 * comment changes.
 */
import { describe, expect, it } from "vitest";
import { citedTokens, tokensOutsideText, withMarkers } from "../../src/core/canvases/markers";

const WORDS = {
  label: (token: string, n: number) => `Citation ${n}: Tides & "Moon" (${token})`,
  notFound: "citation not found",
};

const PAGE = [
  "<!doctype html><html><head><title>Tides [cite:t1]</title>",
  '<style>.a::after { content: "[cite:t2]" }</style>',
  '<script>const said = "[cite:t3]"; if (1 < 2) document.title = "[cite:t3]";</script></head>',
  '<body><p title="[cite:t4]">Spring tides come twice a month [cite:t5].</p>',
  "<!-- [cite:t6] -->",
  "<p data-x='a > b'>Neap tides [cite:t7] and again [cite:t5]; unknown [cite:zz].</p>",
  "<textarea>[cite:t8]</textarea></body></html>",
].join("\n");

describe("A Canvas's Citations", () => {
  it("are the tokens in its text alone, each once, in order", () => {
    expect(citedTokens(PAGE)).toEqual(["t5", "t7", "zz"]);
    expect(tokensOutsideText(PAGE)).toEqual(["t1", "t2", "t3", "t4", "t6", "t8"]);
  });

  it("become markers in the text, numbered as first cited, and nothing else changes", () => {
    const marked = withMarkers(PAGE, new Set(["t5", "t7", "t1", "t3"]), WORDS);
    const markers = [...marked.matchAll(/<incarnamind-cite([^>]*)>([^<]*)<\/incarnamind-cite>/g)];
    expect(markers.map((each) => each[2])).toEqual(["[1]", "[2]", "[1]", "[citation not found]"]);
    expect(markers[0]?.[1]).toContain('data-token="t5"');
    expect(markers[0]?.[1]).toContain('role="link"');
    expect(markers[0]?.[1]).toContain('tabindex="0"');
    // The label is text in an attribute, never markup.
    expect(markers[0]?.[1]).toContain('aria-label="Citation 1: Tides & &quot;Moon&quot; (t5)"');
    expect(markers[3]?.[1]).toContain("data-missing");
    expect(markers[3]?.[1]).not.toContain("data-token");
    for (const kept of [
      "<title>Tides [cite:t1]</title>",
      '<style>.a::after { content: "[cite:t2]" }</style>',
      'const said = "[cite:t3]"; if (1 < 2) document.title = "[cite:t3]";',
      '<p title="[cite:t4]">',
      "<!-- [cite:t6] -->",
      '<p data-x="a > b">',
      "<textarea>[cite:t8]</textarea>",
    ]) {
      expect(marked).toContain(kept);
    }
  });

  it("leave a page that cites nothing in its text exactly as written, a bundled app's script among them", () => {
    const page = "<p>No citations here, only [brackets] and 1 &lt; 2.</p>";
    expect(withMarkers(page, new Set(), WORDS)).toBe(page);
    // A React app bundled into one script, its text and tokens inside it: it runs as written.
    const bundled = `<!doctype html><html><head><script type="module">const App = () => h("p", null, "Spring tides [cite:t5]", h("a", { title: "[cite:t7]" }));</script></head><body><div id="root"></div></body></html>`;
    expect(withMarkers(bundled, new Set(["t5", "t7"]), WORDS)).toBe(bundled);
    expect(citedTokens(bundled)).toEqual([]);
    expect(tokensOutsideText(bundled)).toEqual(["t5", "t7"]);
    const inAttribute = '<p><img alt="Chart [cite:t5]" src="chart.png"> Shown above.</p>';
    expect(withMarkers(inAttribute, new Set(["t5"]), WORDS)).toBe(inAttribute);
  });
});
