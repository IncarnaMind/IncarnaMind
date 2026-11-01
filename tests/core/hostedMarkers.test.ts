import { describe, expect, test } from "vitest";
import { CITATION_TOKEN } from "../../src/core/agents/citations";
import { withoutOurMarkers } from "../../src/core/agents/hosted";
import { MARKER } from "../../src/shared/answerSentences";
import { FIGURE_MARKER } from "../../src/shared/figureMarkers";

const markersIn = (text: string) => [...text.matchAll(MARKER)].map((found) => found[0]);
const figuresIn = (text: string) => [...text.matchAll(FIGURE_MARKER)].map((found) => found[0]);
const tokensIn = (text: string) => [...text.matchAll(CITATION_TOKEN)].map((found) => found[0]);

describe("a hosted agent's own text can't borrow IncarnaMind's markers (#353 spike)", () => {
  test("a Citation marker the agent wrote is plain text, and its minted token is still there", () => {
    const written = "Revenue grew 12% [^2]. Costs fell [cite:k3x9a2b7].";

    expect(markersIn(written)).toEqual(["[^2]"]);
    const safe = withoutOurMarkers(written);

    expect(markersIn(safe)).toEqual([]);
    expect(safe).toBe("Revenue grew 12% [\\^2]. Costs fell [cite:k3x9a2b7].");
    expect(tokensIn(safe)).toEqual(["[cite:k3x9a2b7]"]);
  });

  test("a figure marker the agent wrote is plain text too", () => {
    const written = "Margin was [=1] in 2025 [cite:k3x9a2b7].";

    expect(figuresIn(written)).toEqual(["[=1]"]);
    const safe = withoutOurMarkers(written);

    expect(figuresIn(safe)).toEqual([]);
    expect(safe).toBe("Margin was [\\=1] in 2025 [cite:k3x9a2b7].");
    expect(tokensIn(safe)).toEqual(["[cite:k3x9a2b7]"]);
  });

  test("in Chinese, and with a footnote definition, every marker is made plain", () => {
    const written = "收入增长了12%[^1]，利润率为[=3]。\n\n[^1]: 年报第4页";

    const safe = withoutOurMarkers(written);

    expect(markersIn(safe)).toEqual([]);
    expect(figuresIn(safe)).toEqual([]);
    expect(safe).toBe("收入增长了12%[\\^1]，利润率为[\\=3]。\n\n[\\^1]: 年报第4页");
  });

  test("plain bracketed text is left as it is and matches no marker", () => {
    const written = "See [Report, p. 4] and [1].";

    expect(withoutOurMarkers(written)).toBe(written);
    expect(markersIn(written)).toEqual([]);
    expect(figuresIn(written)).toEqual([]);
  });
});
