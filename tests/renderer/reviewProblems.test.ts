import { describe, expect, test } from "vitest";
import type { Document, DocumentGroupAssignment, ProviderErrorKind } from "../../src/core/api";
import {
  PROBLEM_FIX,
  PROBLEM_WORDS,
  problemAction,
  problemLine,
  ROW_PROBLEM_WORDS,
  reviewProblemKind,
  reviewProblemsOf,
  reviewReason,
} from "../../src/renderer/src/reviewProblems";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

const en = (key: MessageKey, params?: MessageParams) => translate("en", key, params);
const zh = (key: MessageKey, params?: MessageParams) => translate("zh-CN", key, params);

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

  test("a cause it can't name, and one with no cause at all, are one plain group", () => {
    expect(
      reviewProblemsOf(["a", "b", "c"].map(doc), [
        held("a", "provider"),
        held("b", "network"),
        held("c", null),
      ]),
    ).toEqual([{ kind: "other", documentIds: ["a", "b", "c"] }]);
  });

  test("says nothing of a Document whose latest run did not fail", () => {
    expect(
      reviewProblemsOf([doc("a")], [held("a", "out-of-credit", { status: "classified" })]),
    ).toEqual([]);
  });

  test("a key the provider does not know and one this device can't read are both the key", () => {
    expect(reviewProblemKind("auth")).toBe("keyRefused");
    expect(reviewProblemKind("api-key-unreadable")).toBe("keyRefused");
    expect(reviewProblemKind("provider")).toBe("other");
    expect(reviewProblemKind("network")).toBe("other");
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

  test("each cause names the service Organize sends to, in both languages", () => {
    expect(translate("en", PROBLEM_WORDS.credit, { service: "OpenAI" })).toBe(
      "Your OpenAI key is out of credit",
    );
    expect(translate("zh-CN", PROBLEM_WORDS.credit, { service: "OpenAI" })).toBe(
      "你的 OpenAI 密钥额度已用完",
    );
    expect(translate("en", PROBLEM_WORDS.keyRefused, { service: "Anthropic" })).toBe(
      "Your Anthropic key was refused",
    );
    expect(translate("zh-CN", PROBLEM_WORDS.keyRefused, { service: "Anthropic" })).toBe(
      "你的 Anthropic 密钥被拒绝",
    );
    expect(translate("en", PROBLEM_WORDS.planLimit, { service: "ChatGPT" })).toBe(
      "Your ChatGPT plan is used up for now",
    );
    expect(translate("zh-CN", PROBLEM_WORDS.planLimit, { service: "ChatGPT" })).toBe(
      "你的 ChatGPT 套餐额度暂时用完",
    );
    expect(translate("en", PROBLEM_WORDS.rateLimit, { service: "OpenAI" })).toBe(
      "OpenAI is limiting requests right now",
    );
    expect(translate("zh-CN", PROBLEM_WORDS.rateLimit, { service: "OpenAI" })).toBe(
      "OpenAI 暂时限制了请求",
    );
  });

  test("a cause it can't name is one plain line that keeps Try again", () => {
    expect(problemLine("other", 4, null, en)).toBe("Organize couldn’t sort 4 Documents");
    expect(problemLine("other", 1, null, en)).toBe("Organize couldn’t sort 1 Document");
    expect(problemLine("other", 2, null, zh)).toBe("“整理”未能处理 2 个文档");
    expect(PROBLEM_FIX.other).toBeUndefined();
  });

  test("a cause with no service it can name says Organize's own count instead", () => {
    expect(problemLine("credit", 4, null, en)).toBe("Organize couldn’t sort 4 Documents");
    expect(problemLine("credit", 1, null, zh)).toBe("“整理”未能处理 1 个文档");
  });
});

describe("the one action a line offers and the row's own words (#2535)", () => {
  test("a named cause offers its fix alone; only a cause it can't name keeps Try again", () => {
    expect(problemAction("credit", "OpenAI")).toBe("fix");
    expect(problemAction("keyRefused", "OpenAI")).toBe("fix");
    expect(problemAction("planLimit", "OpenAI")).toBe("fix");
    expect(problemAction("rateLimit", "OpenAI")).toBe("retry");
    expect(problemAction("other", null)).toBe("retry");
    expect(problemAction("credit", null)).toBe("retry");

    expect(PROBLEM_FIX.credit).toBe("answer.error.addCredit");
    expect(en("answer.error.addCredit")).toBe("Add credit");
    expect(zh("answer.error.addCredit")).toBe("充值");
    expect(PROBLEM_FIX.keyRefused).toBe("answer.error.checkKey");
    expect(en("answer.error.checkKey")).toBe("Check the key");
    expect(zh("answer.error.checkKey")).toBe("检查密钥");
    expect(PROBLEM_FIX.planLimit).toBe("answer.error.chooseModel");
    expect(en("answer.error.chooseModel")).toBe("Choose another model");
    expect(zh("answer.error.chooseModel")).toBe("换一个模型");
  });

  test("a named row names only the cause; its tooltip carries the whole sentence", () => {
    expect(reviewReason("credit", "OpenAI", en)).toEqual({
      kind: "credit",
      title: "Your OpenAI key is out of credit",
    });
    expect(reviewReason("keyRefused", "OpenAI", en).title).toBe("Your OpenAI key was refused");
    expect(reviewReason("planLimit", "OpenAI", en).title).toBe(
      "Your OpenAI plan is used up for now",
    );
    expect(reviewReason("rateLimit", "OpenAI", en).title).toBe(
      "OpenAI is limiting requests right now",
    );
    expect(en(ROW_PROBLEM_WORDS.credit)).toBe("No credit left");
    expect(zh(ROW_PROBLEM_WORDS.credit)).toBe("额度已用完");
    expect(en(ROW_PROBLEM_WORDS.keyRefused)).toBe("Key refused");
    expect(zh(ROW_PROBLEM_WORDS.keyRefused)).toBe("密钥被拒绝");
    expect(en(ROW_PROBLEM_WORDS.planLimit)).toBe("Plan used up for now");
    expect(zh(ROW_PROBLEM_WORDS.planLimit)).toBe("套餐额度暂时用完");
    expect(en(ROW_PROBLEM_WORDS.rateLimit)).toBe("Busy right now");
    expect(zh(ROW_PROBLEM_WORDS.rateLimit)).toBe("服务繁忙");
  });

  test("a cause it can't name is a short row with a whole tooltip, never the same words twice", () => {
    const unnamed = reviewReason("other", null, en);
    expect(unnamed).toEqual({
      kind: "other",
      title: "Organize couldn’t sort this Document",
    });
    expect(en(ROW_PROBLEM_WORDS.other)).toBe("Couldn’t sort");
    expect(zh(ROW_PROBLEM_WORDS.other)).toBe("未能整理");
    expect(zh("library.row.problem.other.title")).toBe("“整理”未能处理这个文档");
    expect(unnamed.title).not.toBe(en(ROW_PROBLEM_WORDS.other));

    // The service is unknown while it loads: the same short row, not a cause without its service.
    expect(reviewReason("credit", null, en)).toEqual(unnamed);
    expect(reviewReason("credit", null, en).title).not.toBe(en(ROW_PROBLEM_WORDS.credit));
  });
});
