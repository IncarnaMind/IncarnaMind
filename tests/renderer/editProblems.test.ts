import { describe, expect, test } from "vitest";
import { ConsentRevokedError } from "../../src/core/errors";
import { CutShortError } from "../../src/core/providers/outputLimits";
import { classifyProviderError } from "../../src/core/providers/providerErrors";
import { failedEdit } from "../../src/renderer/src/editProblems";
import { providerErrorText } from "../../src/renderer/src/errors";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

/*
 * An Edit with AI the User stopped by turning off sending to its service
 * (#1206) says so in the interface's words, as an Answer does, with nothing
 * to try again; any other failure keeps Try again.
 */

const revoked = classifyProviderError(
  new ConsentRevokedError({
    id: "edits",
    service: { id: "https://api.anthropic.com", name: "Anthropic" },
    sends: ["selection"],
  }),
);

const say = (language: "en" | "zh-CN") => (key: MessageKey, params?: MessageParams) =>
  translate(language, key, params);

describe("an Edit with AI stopped by turned-off sending", () => {
  // protects=the line says the User turned off sending to the service, in English and Chinese, with no Try again; fails_when=it shows the core's English in the Chinese interface, or offers a retry; no_claim=where the line sits.
  test("says so, naming the service, in English and Chinese, with nothing to try again", () => {
    const problem = failedEdit(revoked, () => undefined);
    expect(problem.kind).toBe("consent-revoked");
    if (problem.kind !== "consent-revoked") return;
    expect(providerErrorText(problem.error, say("en"))).toBe(
      "Stopped: you turned off sending to Anthropic",
    );
    expect(providerErrorText(problem.error, say("zh-CN"))).toBe(
      "已停止：你关闭了向 Anthropic 发送内容",
    );
  });

  // protects=any other failure keeps its message and Try again; fails_when=it loses the retry; no_claim=none beyond protects.
  test("any other failure keeps Try again", () => {
    let retried = false;
    const problem = failedEdit({ kind: "network", message: "Offline." }, () => {
      retried = true;
    });
    expect(problem).toMatchObject({ kind: "failed", message: "Offline." });
    if (problem.kind === "failed") problem.retry();
    expect(retried).toBe(true);
  });
});

describe("an Edit with AI whose reply was cut off at its output limit (#2333)", () => {
  // protects=a reply cut short gets its own line, in the interface's words in English and Chinese, saying nothing changed and what to do, with no Try again, which would meet the same limit; fails_when=it shows the core's English sentence with its token count, or offers a retry; no_claim=where the line sits.
  test("has a line of its own in English and Chinese, and nothing to try again", () => {
    let retried = false;
    const problem = failedEdit(classifyProviderError(new CutShortError(1024, true)), () => {
      retried = true;
    });

    expect(problem).toEqual({ kind: "cut-short" });
    expect(say("en")("edit.problem.cut-short")).toBe(
      "The AI’s reply ran too long, so nothing changed. Select less text and try again.",
    );
    expect(say("zh-CN")("edit.problem.cut-short")).toBe(
      "AI 的回复太长，没有改动。请少选一些文字再试。",
    );
    expect(retried).toBe(false);
    expect(failedEdit({ kind: "network", message: "Offline." }, () => undefined)).toHaveProperty(
      "retry",
    );
  });
});

describe("an Edit with AI whose reply named a paragraph wrongly (#2356)", () => {
  // protects=a reply that names a paragraph twice, one the selection hasn't, or one with no words has its own line in English and Chinese, saying nothing changed and to try again; fails_when=the line is missing in a language, or reads as the removal line; no_claim=where the line sits.
  test("has a line of its own in English and Chinese", () => {
    expect(say("en")("edit.problem.misnamed")).toBe(
      "The AI didn’t say clearly which paragraph each change replaces, so nothing changed. Try again.",
    );
    expect(say("zh-CN")("edit.problem.misnamed")).toBe(
      "AI 没有说清每处修改替换哪一段，没有改动。请重试。",
    );
    expect(say("en")("edit.problem.misnamed")).not.toBe(say("en")("edit.problem.unplaced"));
  });
});
