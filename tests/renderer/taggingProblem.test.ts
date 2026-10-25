import { describe, expect, test } from "vitest";
import type { ProviderErrorKind } from "../../src/core/api";
import {
  ClaudePlanLimitError,
  classifyProviderError,
  SignInRouteError,
} from "../../src/core/providers/providerErrors";
import { taggingProblem } from "../../src/renderer/src/taggingProblem";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

const say = (language: "en" | "zh-CN") => (key: MessageKey, params?: MessageParams) =>
  translate(language, key, params);

const SERVICES = /ChatGPT|OpenAI|Claude|Anthropic|Copilot|GitHub/;

const failures: { kind: ProviderErrorKind; route: string; error: Error }[] = [
  {
    kind: "not-signed-in",
    route: "a Claude account",
    error: new SignInRouteError("signed-out", "Sign in with your Claude account first."),
  },
  {
    kind: "not-signed-in",
    route: "Copilot",
    error: new SignInRouteError("sign-in-expired", "Your GitHub sign-in expired. Sign in again."),
  },
  {
    kind: "plan-limit",
    route: "a Claude account",
    error: new ClaudePlanLimitError("Your Claude plan's usage limit is reached.", null),
  },
  {
    kind: "plan-limit",
    route: "Copilot",
    error: new SignInRouteError("plan-limit", "Your Copilot plan's limit is reached: no requests."),
  },
  {
    kind: "blocked",
    route: "a Claude account",
    error: new SignInRouteError("refused", "Anthropic refused the Claude sign-in (403): denied"),
  },
  {
    kind: "blocked",
    route: "Copilot",
    error: new SignInRouteError("policy-blocked", "GitHub Copilot refused the request (403)."),
  },
];

describe("why a Document couldn't be tagged, in the tag footer's tooltip and the sidebar's reasons", () => {
  for (const { kind, route, error } of failures) {
    test(`"${kind}" through ${route} names no service, in English and Chinese`, () => {
      const problem = classifyProviderError(error);
      expect(problem.kind).toBe(kind);

      const english = taggingProblem(problem, say("en"));
      const chinese = taggingProblem(problem, say("zh-CN"));

      expect(english).toMatch(/^Couldn’t tag: /);
      expect(chinese).toMatch(/^无法打标签：/);
      expect(english).not.toMatch(SERVICES);
      expect(chinese).not.toMatch(SERVICES);
    });
  }

  test("the core's own words come first when it gave them", () => {
    const problem = {
      kind: "local-mode" as const,
      message: "Local mode is on.",
      wording: { key: "providers.test.local-mode" as const },
    };

    expect(taggingProblem(problem, say("zh-CN"))).toBe(
      "未发送：已开启“所有内容都留在这台电脑上”。",
    );
  });
});
