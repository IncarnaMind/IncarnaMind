import { describe, expect, test } from "vitest";
import type { SentenceChecksExported } from "../../src/core/api";
import { checkComments, trackedChanges, unmarkedChecks } from "../../src/renderer/src/exportChecks";
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
  comments: 0,
  ...counts,
  commented,
});

describe("The line after saving, for what a file says of its checked sentences", () => {
  test("a Word file says how many check comments it holds, one or more, in English and Chinese", () => {
    const two = checks({ contradicted: 1, notFound: 1, comments: 2 }, true);
    expect(checkComments(two, t("en"))).toBe("2 check comments");
    expect(checkComments(two, t("zh-CN"))).toBe("2 条核对批注");
    const one = checks({ unsupported: 1, comments: 1 }, true);
    expect(checkComments(one, t("en"))).toBe("1 check comment");
    expect(checkComments(one, t("zh-CN"))).toBe("1 条核对批注");
  });

  test("the part is absent when no comment was written", () => {
    expect(checkComments(checks({}, true), t("en"))).toBeNull();
    expect(checkComments(checks({}, true), t("zh-CN"))).toBeNull();
    expect(checkComments(checks({ contradicted: 2 }, false), t("en"))).toBeNull();
  });

  test("say Not found for the sentences that went out unmarked, apart from Unsupported", () => {
    expect(unmarkedChecks(checks({ notFound: 1 }, false), t("en"))).toBe(
      "1 Not found sentence went out unmarked",
    );
    expect(unmarkedChecks(checks({ notFound: 2 }, false), t("zh-CN"))).toBe(
      "有 2 句未找到，导出时没有标记",
    );
  });

  test("sentences that went out with no comment are a warning, not a count", () => {
    const two = checks({ contradicted: 2 }, false);
    expect(checkComments(two, t("en"))).toBeNull();
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
