import { describe, expect, test } from "vitest";
import type { ProviderErrorKind } from "../../src/core/api";
import { CHATGPT_SERVICE } from "../../src/core/providers/chatgpt/service";
import { CLAUDE_ACCOUNT_SERVICE } from "../../src/core/providers/claudeAccount/service";
import {
  ClaudePlanLimitError,
  classifyProviderError,
  SignInRouteError,
} from "../../src/core/providers/providerErrors";
import type { FlowRoute } from "../../src/renderer/src/taggingDestination";
import {
  planLimitLine,
  taggingProblem,
  taggingProblemService,
} from "../../src/renderer/src/taggingProblem";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

const say = (language: "en" | "zh-CN") => (key: MessageKey, params?: MessageParams) =>
  translate(language, key, params);

const SERVICES = /ChatGPT|OpenAI|Claude|Anthropic|Copilot|GitHub/;

const LOCAL: FlowRoute = { where: "local" };
const NONE: FlowRoute = { where: "none" };
const UNKNOWN: FlowRoute = { where: "unknown" };
const CHATGPT: FlowRoute = { where: "cloud", service: CHATGPT_SERVICE };
const CLAUDE: FlowRoute = { where: "cloud", service: CLAUDE_ACCOUNT_SERVICE };

test.each([
  { text: LOCAL, reader: CLAUDE, expected: CLAUDE_ACCOUNT_SERVICE },
  { text: CLAUDE, reader: CLAUDE, expected: CLAUDE_ACCOUNT_SERVICE },
  {
    text: CLAUDE,
    reader: {
      where: "cloud" as const,
      service: { ...CLAUDE_ACCOUNT_SERVICE, name: "Same service" },
    },
    expected: CLAUDE_ACCOUNT_SERVICE,
  },
  { text: CHATGPT, reader: CLAUDE, expected: null },
  { text: CHATGPT, reader: UNKNOWN, expected: null },
  { text: UNKNOWN, reader: CLAUDE, expected: null },
  { text: CHATGPT, reader: NONE, expected: CHATGPT_SERVICE },
  { text: CHATGPT, reader: LOCAL, expected: CHATGPT_SERVICE },
  { text: NONE, reader: CLAUDE, expected: CLAUDE_ACCOUNT_SERVICE },
  { text: LOCAL, reader: NONE, expected: null },
])(
  "the problem action uses only a unique resolved current service ($text.where, $reader.where)",
  ({ text, reader, expected }) => {
    expect(taggingProblemService(text, reader)).toEqual(expected);
  },
);

test.each(["en", "zh-CN"] as const)(
  "the image plan is named only when unambiguous (%s)",
  (language) => {
    expect(planLimitLine(taggingProblemService(LOCAL, CLAUDE), null, say(language), language)).toBe(
      language === "en" ? "Your Claude plan’s limit is reached" : "Claude 订阅额度已用完",
    );
    expect(
      planLimitLine(taggingProblemService(CHATGPT, CLAUDE), null, say(language), language),
    ).toBe(language === "en" ? "Your plan’s limit is reached" : "订阅额度已用完");
  },
);

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

describe("the sidebar's line while Tagging and Organize wait for a plan's limit", () => {
  const now = new Date(2026, 9, 12, 9, 0);
  const later = new Date(2026, 9, 12, 14, 30).toISOString();

  test("names the plan and when it resets, in English and Chinese", () => {
    expect(planLimitLine(CHATGPT_SERVICE, later, say("en"), "en", now)).toMatch(
      /^Your ChatGPT plan’s limit is reached until (14:30|2:30 pm)$/,
    );
    expect(planLimitLine(CHATGPT_SERVICE, later, say("zh-CN"), "zh-CN", now)).toMatch(
      /^ChatGPT 订阅额度已用完，(14:30|下午2:30) 恢复$/,
    );
    expect(planLimitLine(CLAUDE_ACCOUNT_SERVICE, later, say("en"), "en", now)).toMatch(
      /^Your Claude plan’s limit is reached until (14:30|2:30 pm)$/,
    );
  });

  test("says no time when the plan didn't say one, or once it has passed", () => {
    expect(planLimitLine(CLAUDE_ACCOUNT_SERVICE, null, say("en"), "en", now)).toBe(
      "Your Claude plan’s limit is reached",
    );
    expect(planLimitLine(CLAUDE_ACCOUNT_SERVICE, null, say("zh-CN"), "zh-CN", now)).toBe(
      "Claude 订阅额度已用完",
    );
    const earlier = new Date(2026, 9, 12, 8, 0).toISOString();
    expect(planLimitLine(CHATGPT_SERVICE, earlier, say("en"), "en", now)).toBe(
      "Your ChatGPT plan’s limit is reached",
    );
  });

  test("names no plan while the service it sends to is unknown, or isn't a plan's", () => {
    expect(planLimitLine(null, later, say("en"), "en", now)).toMatch(
      /^Your plan’s limit is reached until (14:30|2:30 pm)$/,
    );
    const key = { id: "https://api.openai.com", name: "OpenAI" };
    expect(planLimitLine(key, null, say("zh-CN"), "zh-CN", now)).toBe("订阅额度已用完");
  });
});
