import { describe, expect, test } from "vitest";
import type { SentenceChecksExported } from "../../src/core/api";
import {
  checkComments,
  commentsHint,
  rewrittenLine,
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

  test("someone else's Word file written without them says they are off while a claim needs a look, in English and Chinese (#110)", () => {
    const off = checks({ unsupported: 1, needsRecheck: 1 }, false);
    expect(checkComments(off, t("en"), true)).toBe("Check comments off");
    expect(checkComments(off, t("zh-CN"), true)).toBe("未添加核对批注");
    expect(checkComments(checks({}, false), t("en"), true)).toBeNull();
    const on = checks({ contradicted: 1, unsupported: 1, comments: 2 }, true);
    expect(checkComments(on, t("en"), true)).toBe("2 check comments");
    expect(checkComments(on, t("zh-CN"), true)).toBe("2 条核对批注");
  });

  test("the undo line of a file written again says what changed in it, one or more, in English and Chinese (#110)", () => {
    const name = "Harbour report.docx";
    expect(rewrittenLine(t("en"), true, 2, name)).toBe(
      "Added 2 check comments to “Harbour report.docx”",
    );
    expect(rewrittenLine(t("zh-CN"), true, 2, name)).toBe(
      "已在“Harbour report.docx”中添加 2 条核对批注",
    );
    expect(rewrittenLine(t("en"), true, 1, name)).toBe(
      "Added 1 check comment to “Harbour report.docx”",
    );
    expect(rewrittenLine(t("zh-CN"), true, 1, name)).toBe(
      "已在“Harbour report.docx”中添加 1 条核对批注",
    );
    expect(rewrittenLine(t("en"), false, 0, name)).toBe(
      "Removed the check comments from “Harbour report.docx”",
    );
    expect(rewrittenLine(t("zh-CN"), false, 0, name)).toBe(
      "已从“Harbour report.docx”中移除核对批注",
    );
  });

  test("comments added to a copy, as the file changed after it was saved, say so with the count, one or more, in English and Chinese (#110)", () => {
    const copy = "Harbour report 2.docx";
    const changed = "Harbour report.docx";
    expect(rewrittenLine(t("en"), true, 2, copy, changed)).toBe(
      "Added 2 check comments to a copy, “Harbour report 2.docx”, because “Harbour report.docx” changed after it was saved",
    );
    expect(rewrittenLine(t("en"), true, 1, copy, changed)).toBe(
      "Added 1 check comment to a copy, “Harbour report 2.docx”, because “Harbour report.docx” changed after it was saved",
    );
    expect(rewrittenLine(t("zh-CN"), true, 2, copy, changed)).toBe(
      "已在副本“Harbour report 2.docx”中添加 2 条核对批注，因为“Harbour report.docx”保存后有改动",
    );
    expect(rewrittenLine(t("zh-CN"), true, 1, copy, changed)).toBe(
      "已在副本“Harbour report 2.docx”中添加 1 条核对批注，因为“Harbour report.docx”保存后有改动",
    );
  });

  test("Change asks with what the comments give away, in English and Chinese", () => {
    expect(t("en")("export.checkComments.ask")).toBe(
      "Comment on what needs a look? Comments quote your Documents and name them.",
    );
    expect(t("zh-CN")("export.checkComments.ask")).toBe(
      "为需要留意的说法添加批注？批注会引用你的文档原文并写出文档名。",
    );
  });

  test("the switch's hint says what its comments give away only for someone else's file, while it is on", () => {
    expect(t("en")(commentsHint(true))).toBe("Comments quote your Documents and name them");
    expect(t("zh-CN")(commentsHint(true))).toBe("批注会引用你的文档原文并写出文档名");
    const covers = "Contradicted, Unsupported, Not found, Quote not found or Needs re-check";
    expect(t("en")(commentsHint(false))).toBe(covers);
    expect(t("en")(commentsHint(null))).toBe(covers);
    expect(t("zh-CN")(commentsHint(null))).toBe(
      "与文档矛盾、无依据、未找到、未找到引文或需重新核对",
    );
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
