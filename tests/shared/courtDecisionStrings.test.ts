import { describe, expect, test } from "vitest";
import { translate } from "../../src/shared/i18n";

describe("The court decision card's words", () => {
  test("when no Document holds the decision", () => {
    expect(translate("en", "claim.courtDecision.title")).toBe("This cites a court decision.");
    expect(translate("en", "claim.courtDecision.body")).toBe(
      "IncarnaMind can’t check that this case exists or says this. Check it in your legal research service before you rely on it.",
    );
    expect(translate("zh-CN", "claim.courtDecision.title")).toBe("本句引用了法院判决。");
    expect(translate("zh-CN", "claim.courtDecision.body")).toBe(
      "IncarnaMind 无法核对该判决是否存在、是否这样说。依赖前请在你的法律数据库中查证。",
    );
  });

  test("when the opinion is among the Documents, naming the Document and where in it", () => {
    const given = { document: "Hallmark Builders v. Rio Grande Supply", location: "p. 3" };
    expect(translate("en", "claim.courtDecision.held", given)).toBe(
      "Quote found in your copy of the opinion (Hallmark Builders v. Rio Grande Supply, p. 3). Not checked whether it was overruled or changed. Check it in your legal research service before you rely on it.",
    );
    expect(translate("zh-CN", "claim.courtDecision.held", { ...given, location: "第 3 页" })).toBe(
      "已在你保存的判决书中找到引文（Hallmark Builders v. Rio Grande Supply，第 3 页）。未核对是否已被推翻或修改。依赖前请在你的法律数据库中查证。",
    );
  });

  test.each(["en", "zh-CN"] as const)(
    "never calls a decision verified, valid or good law (%s)",
    (language) => {
      const words = [
        translate(language, "claim.courtDecision.title"),
        translate(language, "claim.courtDecision.body"),
        translate(language, "claim.courtDecision.held", { document: "X", location: "p. 1" }),
        translate(language, "claim.citedCaseUnchecked"),
        translate(language, "export.comment.sentence.citedCaseUnchecked"),
      ].join(" ");
      expect(words).not.toMatch(/verified|\bvalid|good law|已核实|有效判例/i);
    },
  );

  test("when a Supported sentence cites a case in no Document: the card line and the export's short form", () => {
    expect(translate("en", "claim.citedCaseUnchecked")).toBe(
      "Not checked: the cited case isn’t in your Documents. Check it in your legal research service before you rely on it.",
    );
    expect(translate("zh-CN", "claim.citedCaseUnchecked")).toBe(
      "未核对：引用的判决不在你的文档中。依赖前请在你的法律数据库中查证。",
    );
    expect(translate("en", "export.comment.sentence.citedCaseUnchecked")).toBe(
      "Cited case not checked: not in the Documents.",
    );
    expect(translate("zh-CN", "export.comment.sentence.citedCaseUnchecked")).toBe(
      "所引判决尚未核对：不在文档中。",
    );
  });

  test("a saved web page's source line", () => {
    const given = { address: "https://example.com/opinion", date: "12 Oct" };
    expect(translate("en", "webPages.source", given)).toBe(
      "Saved web page · https://example.com/opinion · saved 12 Oct",
    );
    expect(translate("zh-CN", "webPages.source", { ...given, date: "10月12日" })).toBe(
      "保存的网页 · https://example.com/opinion · 保存于 10月12日",
    );
  });
});
