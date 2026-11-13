/**
 * Whether the place a view was opened at is gone from its Document, and the line that says so
 * (#2984): worded as the Citation's chip words its place, in each language.
 */
import { describe, expect, test } from "vitest";
import type { CitationLocation } from "../../src/core/api";
import type { ViewerTarget } from "../../src/renderer/src/store";
import { citedPlaceGone, citedPlaceGoneLine } from "../../src/renderer/src/viewer/citedPlace";
import { translate } from "../../src/shared/i18n";

describe("whether the place a view was opened at is gone", () => {
  test.each([
    ["no place was asked for", undefined, 3, false],
    ["the first Unit is there", 1, 3, false],
    ["the last Unit is there", 3, 3, false],
    ["the Unit after the last", 4, 3, true],
    ["a Unit far past the end", 9999, 3, true],
    ["a Document with no Unit left", 1, 0, true],
  ])("%s", (_name, pageFrom, unitCount, gone) => {
    expect(citedPlaceGone({ pageFrom }, unitCount)).toBe(gone);
  });
});

const target = (citation: ViewerTarget["citation"], pageFrom = 9): ViewerTarget => ({
  documentId: "doc-1",
  request: 1,
  pageFrom,
  pageTo: pageFrom,
  ...(citation && { citation }),
});

const line = (location: CitationLocation, language: "en" | "zh-CN") =>
  citedPlaceGoneLine(
    target({ check: "found", location }),
    (key, params) => translate(language, key, params),
    null,
  );

describe("the line that says the cited place is gone", () => {
  test.each<[string, CitationLocation, string, string]>([
    [
      "a PDF page",
      { kind: "page", from: 9, to: 9 },
      "The cited place (p. 9) is no longer in this Document.",
      "引用的位置（第 9 页）已不在此文档中。",
    ],
    [
      "a slide",
      { kind: "slide", from: 9, to: 9 },
      "The cited place (slide 9) is no longer in this Document.",
      "引用的位置（第 9 张幻灯片）已不在此文档中。",
    ],
    [
      "rows of a sheet",
      { kind: "rows", sheet: "Revenue", from: 12, to: 14 },
      "The cited place (Revenue, rows 12–14) is no longer in this Document.",
      "引用的位置（Revenue，第 12–14 行）已不在此文档中。",
    ],
    [
      "a heading's section",
      { kind: "section", heading: "Sensitivity" },
      "The cited place (§ Sensitivity) is no longer in this Document.",
      "引用的位置（§ Sensitivity）已不在此文档中。",
    ],
    [
      "lines of a text file",
      { kind: "lines", from: 120, to: 134 },
      "The cited place (lines 120–134) is no longer in this Document.",
      "引用的位置（第 120–134 行）已不在此文档中。",
    ],
    [
      "a Transcript's line",
      { kind: "time", from: 723_000, to: 730_000, speaker: "Dana" },
      "The cited place (Dana · 12:03) is no longer in this Document.",
      "引用的位置（Dana · 12:03）已不在此文档中。",
    ],
  ])("words %s as the chip does", (_name, location, english, chinese) => {
    expect(line(location, "en")).toBe(english);
    expect(line(location, "zh-CN")).toBe(chinese);
  });

  test("a Citation from before Locations names its page", () => {
    const old = target({ check: "found", pageFrom: 9, pageTo: 9 });
    const said = (language: "en" | "zh-CN") =>
      citedPlaceGoneLine(old, (key, params) => translate(language, key, params), null);
    expect(said("en")).toBe("The cited place (p. 9) is no longer in this Document.");
    expect(said("zh-CN")).toBe("引用的位置（第 9 页）已不在此文档中。");
  });

  test("a page no Citation opened has no line, and neither has a Citation that says where in no words", () => {
    const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
      translate("en", key, params);
    expect(citedPlaceGoneLine(target(undefined), t, null)).toBeNull();
    expect(
      citedPlaceGoneLine(
        { documentId: "doc-1", request: 1, citation: { check: "found" } },
        t,
        null,
      ),
    ).toBeNull();
  });
});
