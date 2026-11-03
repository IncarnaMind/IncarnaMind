import { describe, expect, test } from "vitest";
import type { AskedQuote, CitationLocation } from "../../src/core/api";
import type { Language } from "../../src/core/language";
import { areaCheck, areaLabel } from "../../src/renderer/src/editor/areaWords";
import { translate } from "../../src/shared/i18n";

const t =
  (language: Language) =>
  (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate(language, key, params);

const quote = (
  location: CitationLocation | null,
  check?: AskedQuote["check"],
  checkReason?: AskedQuote["checkReason"],
): AskedQuote => ({
  documentId: "doc-1",
  documentName: "Report.pdf",
  quote: "",
  pageFrom: null,
  pageTo: null,
  location,
  pick: "area",
  ...(check !== undefined && { check }),
  ...(checkReason !== undefined && { checkReason }),
});

const page: CitationLocation = {
  kind: "page",
  from: 7,
  to: 7,
  area: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
};
const headingless: CitationLocation = {
  kind: "section",
  heading: null,
  area: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
};

describe("an area's chip words", () => {
  test("names its place in English and Chinese", () => {
    expect(areaLabel(quote(page), t("en"))).toEqual({ where: "p. 7", label: "Figure · p. 7" });
    expect(areaLabel(quote(page), t("zh-CN"))).toEqual({
      where: "第 7 页",
      label: "图 · 第 7 页",
    });
  });

  test("names no place where its section has no heading, rather than a trailing separator", () => {
    expect(areaLabel(quote(headingless), t("en"))).toEqual({ where: "", label: "Figure" });
    expect(areaLabel(quote(headingless), t("zh-CN"))).toEqual({ where: "", label: "图" });
  });

  test("says the figure's words were found, with and without a place", () => {
    expect(areaCheck(quote(page, "found", null), "p. 7", t("en"))).toBe(
      "The figure’s words were found on p. 7",
    );
    expect(areaCheck(quote(headingless, "found", null), "", t("en"))).toBe(
      "The figure’s words were found.",
    );
    expect(areaCheck(quote(page, "found", null), "第 7 页", t("zh-CN"))).toBe(
      "已在第 7 页找到图中的文字",
    );
    expect(areaCheck(quote(headingless, "found", null), "", t("zh-CN"))).toBe("已找到图中的文字。");
  });

  test("says Picture, not checked only for a picture's reason", () => {
    expect(areaCheck(quote(page, "cant-check", "picture"), "p. 7", t("en"))).toBe(
      "Picture, not checked",
    );
    expect(areaCheck(quote(page, "cant-check", "picture"), "第 7 页", t("zh-CN"))).toBe(
      "图片，未核对",
    );
  });

  test("gives any other can't-check its own words, not the picture's", () => {
    expect(areaCheck(quote(headingless, "cant-check", "unsure-word"), "", t("en"))).toBe(
      "Check the page",
    );
    expect(areaCheck(quote(headingless, "cant-check", "document-removed"), "", t("en"))).toBe(
      "Can’t check",
    );
    expect(areaCheck(quote(headingless, "cant-check", "unsure-word"), "", t("zh-CN"))).toBe(
      "请核对原页",
    );
    expect(areaCheck(quote(headingless, "cant-check", "document-removed"), "", t("zh-CN"))).toBe(
      "无法核对",
    );
  });

  test("gives a not-found area the Citation's badge", () => {
    expect(areaCheck(quote(page, "not-found", null), "p. 7", t("en"))).toBe(
      "Quote not found on p. 7",
    );
    expect(areaCheck(quote(page, "not-found", null), "第 7 页", t("zh-CN"))).toBe(
      "未在第 7 页找到引文",
    );
  });

  test("says nothing before a check", () => {
    expect(areaCheck(quote(page), "p. 7", t("en"))).toBe("");
  });
});
