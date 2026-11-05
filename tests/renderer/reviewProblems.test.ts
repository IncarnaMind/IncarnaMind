import { describe, expect, test } from "vitest";
import type { Document, DocumentGroupAssignment, ProviderErrorKind } from "../../src/core/api";
import {
  PROBLEM_FIX,
  PROBLEM_WORDS,
  reviewProblemKind,
  reviewProblemsOf,
} from "../../src/renderer/src/reviewProblems";
import { translate } from "../../src/shared/i18n";

const doc = (id: string): Document => ({ id, name: id, tagging: "tagged" }) as Document;

const held = (
  documentId: string,
  kind: ProviderErrorKind | null,
  over: Partial<DocumentGroupAssignment> = {},
): DocumentGroupAssignment =>
  ({
    documentId,
    groupId: null,
    source: "automatic",
    suggested: false,
    status: "failed",
    error: kind ? { kind, message: "The provider's own sentence, cut short in a row." } : null,
    model: null,
    ...over,
  }) as DocumentGroupAssignment;

describe("one line for the group, not one per row", () => {
  test("four Documents that met the same cause are one group", () => {
    const documents = ["a", "b", "c", "d"].map(doc);
    expect(
      reviewProblemsOf(
        documents,
        documents.map((each) => held(each.id, "out-of-credit")),
      ),
    ).toEqual([{ kind: "credit", documentIds: ["a", "b", "c", "d"] }]);
  });

  test("a refused key and one that can't be read are the same fix", () => {
    expect(
      reviewProblemsOf([doc("a"), doc("b")], [held("a", "auth"), held("b", "api-key-unreadable")]),
    ).toEqual([{ kind: "keyRefused", documentIds: ["a", "b"] }]);
  });

  test("names the causes in the Library's order, one entry each", () => {
    expect(
      reviewProblemsOf(["a", "b", "c", "d"].map(doc), [
        held("a", "rate-limit"),
        held("b", "plan-limit"),
        held("c", "out-of-credit"),
        held("d", "auth"),
      ]).map((problem) => problem.kind),
    ).toEqual(["credit", "keyRefused", "planLimit", "rateLimit"]);
  });

  test("keeps the provider's sentence for a cause the Library has no words for", () => {
    expect(reviewProblemsOf([doc("a")], [held("a", "provider")])).toEqual([]);
    expect(reviewProblemsOf([doc("a")], [held("a", null)])).toEqual([]);
  });

  test("says nothing of a Document whose latest run did not fail", () => {
    expect(
      reviewProblemsOf([doc("a")], [held("a", "out-of-credit", { status: "classified" })]),
    ).toEqual([]);
  });

  test("a key the provider does not know and one this device can't read are both the key", () => {
    expect(reviewProblemKind("auth")).toBe("keyRefused");
    expect(reviewProblemKind("api-key-unreadable")).toBe("keyRefused");
    expect(reviewProblemKind("provider")).toBeNull();
  });
});

describe("the words and the actions", () => {
  test("each cause offers the Answer's own action, and a rate limit only Try again", () => {
    expect(PROBLEM_FIX).toEqual({
      credit: "answer.error.addCredit",
      keyRefused: "answer.error.checkKey",
      planLimit: "answer.error.chooseModel",
    });
    expect(translate("en", "answer.error.addCredit")).toBe("Add credit");
    expect(translate("zh-CN", "answer.error.addCredit")).toBe("充值");
    expect(translate("en", "answer.error.checkKey")).toBe("Check the key");
    expect(translate("zh-CN", "answer.error.checkKey")).toBe("检查密钥");
    expect(translate("en", "answer.error.chooseModel")).toBe("Choose another model");
    expect(translate("zh-CN", "answer.error.chooseModel")).toBe("换一个模型");
    expect(translate("en", "answer.error.retry")).toBe("Try again");
    expect(translate("zh-CN", "answer.error.retry")).toBe("重试");
  });

  test("the credit line says what ran out", () => {
    expect(translate("en", PROBLEM_WORDS.credit)).toBe("No credit left on the key Organize uses");
    expect(translate("zh-CN", PROBLEM_WORDS.credit)).toBe("整理用的密钥没有额度了");
  });

  test("a refused key says so", () => {
    expect(translate("en", PROBLEM_WORDS.keyRefused)).toBe("The key Organize uses was refused");
    expect(translate("zh-CN", PROBLEM_WORDS.keyRefused)).toBe("整理用的密钥被拒绝");
  });

  test("a plan's limit says so", () => {
    expect(translate("en", PROBLEM_WORDS.planLimit)).toBe(
      "The plan for Organize’s model is used up for now",
    );
    expect(translate("zh-CN", PROBLEM_WORDS.planLimit)).toBe("整理所用模型的套餐额度暂时用完");
  });

  test("a rate limit says so", () => {
    expect(translate("en", PROBLEM_WORDS.rateLimit)).toBe(
      "The service Organize uses is limiting requests right now",
    );
    expect(translate("zh-CN", PROBLEM_WORDS.rateLimit)).toBe("整理用的服务暂时限制了请求");
  });
});
