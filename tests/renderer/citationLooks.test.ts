import { describe, expect, test } from "vitest";
import type { CitationCheck } from "../../src/core/api";
import {
  type CitationLook,
  groupBadgeText,
  worstLook,
} from "../../src/renderer/src/editor/citationLooks";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

/*
 * A chip that stands for several Citations of one place (#3654) shows the state that asks most
 * of the User, never hiding a quote that needs a look behind one found, and its card's first line
 * says how many quotes it holds.
 */

const look = (key: string, check: CitationCheck, recheck = false, badge = ""): CitationLook => ({
  key,
  check,
  recheck,
  badge,
  quote: `Quote ${key}`,
  pageFrom: 1,
  pageTo: 1,
  changed: null,
  here: () => ({}),
  fix: null,
});

const tEn = (key: MessageKey, params?: MessageParams) => translate("en", key, params);
const tZh = (key: MessageKey, params?: MessageParams) => translate("zh-CN", key, params);

describe("the chip of several Citations", () => {
  test("takes the state that asks most: contradicted, not found, re-check, then the rest", () => {
    const found = look("a", "found");
    const recheck = look("b", "found", true);
    const missing = look("c", "not-found");
    const otherwise = look("d", "contradicted");
    expect(worstLook([found, look("e", "found")])).toBe(found);
    expect(worstLook([found, recheck, found])).toBe(recheck);
    expect(worstLook([recheck, missing])).toBe(missing);
    expect(worstLook([missing, otherwise, found])).toBe(otherwise);
    expect(worstLook([found, look("f", "not-checked")])?.check).toBe("not-checked");
    expect(worstLook([])).toBeNull();
  });

  test("counts its quotes in its card's first line, all found or not, in English and Chinese", () => {
    const found = [look("a", "found"), look("b", "found"), look("c", "found")];
    const own = { key: "citation.badge.found.in" as const, params: { location: "¶ 19" } };
    expect(groupBadgeText(found, worstLook(found), own, tEn)).toBe("3 quotes found in ¶ 19");
    expect(groupBadgeText(found, worstLook(found), own, tZh)).toBe("已在“¶ 19”中找到 3 处引文");

    const mixed = [
      look("a", "found"),
      look("b", "found", true, "Needs re-check"),
      look("c", "found"),
    ];
    expect(groupBadgeText(mixed, worstLook(mixed), own, tEn)).toBe(
      "Needs re-check · 1 of 3 quotes",
    );
    const zh = mixed.map((each) => (each.recheck ? { ...each, badge: "需重新核对" } : each));
    expect(groupBadgeText(zh, worstLook(zh), own, tZh)).toBe("需重新核对 · 3 处引文中的 1 处");
  });
});
