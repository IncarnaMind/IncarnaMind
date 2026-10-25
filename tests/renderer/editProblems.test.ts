import { describe, expect, test } from "vitest";
import { ConsentRevokedError } from "../../src/core/errors";
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
