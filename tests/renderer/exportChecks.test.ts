import { describe, expect, test } from "vitest";
import type { SentenceChecksExported } from "../../src/core/api";
import {
  commentedChecks,
  trackedChanges,
  unmarkedChecks,
} from "../../src/renderer/src/exportChecks";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

const t =
  (language: "en" | "zh-CN") =>
  (key: MessageKey, params?: MessageParams): string =>
    translate(language, key, params);

const checks = (
  counts: Partial<Omit<SentenceChecksExported, "commented">>,
  commented: boolean,
): SentenceChecksExported => ({
  contradicted: 0,
  notFound: 0,
  unsupported: 0,
  needsRecheck: 0,
  ...counts,
  commented,
});

describe("The line after saving, for what a file says of its checked sentences", () => {
  test("a Word file counts what went in as comments, leaving out what is zero", () => {
    const both = checks({ contradicted: 2, unsupported: 1 }, true);
    expect(commentedChecks(both, t("en"))).toBe("2 Contradicted and 1 Unsupported, as comments");
    expect(commentedChecks(both, t("zh-CN"))).toBe("2 处与文档矛盾、1 处无依据，已作为批注");
    expect(commentedChecks(checks({ unsupported: 3 }, true), t("en"))).toBe(
      "3 Unsupported, as comments",
    );
    expect(commentedChecks(checks({ contradicted: 1, needsRecheck: 4 }, true), t("zh-CN"))).toBe(
      "1 处与文档矛盾、4 处需重新核对，已作为批注",
    );
    expect(commentedChecks(checks({}, true), t("en"))).toBeNull();
  });

  test("say Not found for the comments that say so, apart from Unsupported", () => {
    const both = checks({ contradicted: 1, notFound: 2, unsupported: 1 }, true);
    expect(commentedChecks(both, t("en"))).toBe(
      "1 Contradicted, 2 Not found and 1 Unsupported, as comments",
    );
    expect(commentedChecks(both, t("zh-CN"))).toBe(
      "1 处与文档矛盾、2 处未找到、1 处无依据，已作为批注",
    );
    expect(unmarkedChecks(checks({ notFound: 1 }, false), t("en"))).toBe(
      "1 Not found sentence went out unmarked",
    );
    expect(unmarkedChecks(checks({ notFound: 2 }, false), t("zh-CN"))).toBe(
      "有 2 句未找到，导出时没有标记",
    );
  });

  test("all three results make one list", () => {
    const all = checks({ contradicted: 2, unsupported: 1, needsRecheck: 1 }, true);
    expect(commentedChecks(all, t("en"))).toBe(
      "2 Contradicted, 1 Unsupported and 1 Needs re-check, as comments",
    );
    expect(commentedChecks(all, t("zh-CN"))).toBe(
      "2 处与文档矛盾、1 处无依据、1 处需重新核对，已作为批注",
    );
  });

  test("sentences that went out with no comment are a warning, not a count", () => {
    const two = checks({ contradicted: 2 }, false);
    expect(commentedChecks(two, t("en"))).toBeNull();
    expect(unmarkedChecks(two, t("en"))).toBe("2 Contradicted sentences went out unmarked");
    expect(unmarkedChecks(two, t("zh-CN"))).toBe("有 2 句与文档矛盾，导出时没有标记");
    expect(unmarkedChecks(checks({ contradicted: 1 }, false), t("en"))).toBe(
      "1 Contradicted sentence went out unmarked",
    );
  });

  test("every failed check is counted in the warning, and the noun agrees with the last count", () => {
    const mixed = checks({ contradicted: 2, unsupported: 1 }, false);
    expect(unmarkedChecks(mixed, t("en"))).toBe(
      "2 Contradicted and 1 Unsupported sentence went out unmarked",
    );
    expect(unmarkedChecks(mixed, t("zh-CN"))).toBe("有 2 句与文档矛盾、1 句无依据，导出时没有标记");
    expect(unmarkedChecks(checks({ contradicted: 1, needsRecheck: 2 }, false), t("en"))).toBe(
      "1 Contradicted and 2 Needs re-check sentences went out unmarked",
    );
  });

  test("a file that holds them as comments warns of nothing, and one with none says nothing", () => {
    expect(unmarkedChecks(checks({ contradicted: 2 }, true), t("en"))).toBeNull();
    expect(unmarkedChecks(checks({}, false), t("en"))).toBeNull();
  });

  test("the changes waiting that went in as tracked changes are counted when there are any", () => {
    expect(trackedChanges(3, t("en"))).toBe("3 changes waiting, as tracked changes");
    expect(trackedChanges(3, t("zh-CN"))).toBe("3 处待确认修改，已作为修订");
    expect(trackedChanges(1, t("en"))).toBe("1 change waiting, as tracked changes");
    expect(trackedChanges(1, t("zh-CN"))).toBe("1 处待确认修改，已作为修订");
    expect(trackedChanges(0, t("en"))).toBeNull();
  });
});
