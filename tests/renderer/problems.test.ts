import { describe, expect, test } from "vitest";
import type { ChatProviderKind, ProviderErrorKind } from "../../src/core/api";
import { billingUrlOf, catalogProvider } from "../../src/core/providers/catalog/providers";
import { SIGN_IN_ROUTES } from "../../src/core/providers/signInRoutes";
import { readinessKey } from "../../src/renderer/src/components/providers/shared";
import {
  ANSWER_PROBLEMS,
  answerProblem,
  failedAnswerLine,
  saveFailureReason,
} from "../../src/renderer/src/problems";
import { settingsPages } from "../../src/renderer/src/settingsPages";
import { type MessageKey, translate } from "../../src/shared/i18n";

const KINDS: ProviderErrorKind[] = [
  "auth",
  "model",
  "rate-limit",
  "network",
  "provider",
  "refused",
  "out-of-credit",
  "region",
  "consent-declined",
  "consent-revoked",
  "local-mode",
  "ollama-not-running",
  "data-retention",
  "not-signed-in",
  "plan-limit",
  "blocked",
  "too-long",
  "cost-cap",
  "no-answer",
  "unknown",
];

describe("a failed Answer's problem line", () => {
  test("every kind of provider error has a line", () => {
    expect(Object.keys(ANSWER_PROBLEMS).sort()).toEqual([...KINDS].sort());
  });

  test("offers at most one action: a page of Settings, trying again, a provider's page, signing in, a model on this computer, Ollama, or nothing", () => {
    for (const kind of KINDS) {
      const { fix } = ANSWER_PROBLEMS[kind];
      if (fix.kind === "settings") expect(settingsPages).toContain(fix.page);
      if (fix.kind === "link") expect(fix.url).toMatch(/^https:\/\//);
      expect(["settings", "retry", "link", "sign-in", "local-model", "ollama", "none"]).toContain(
        fix.kind,
      );
    }
  });

  test("local mode stopping an Answer offers a local model in place, and never a company's settings", () => {
    expect(ANSWER_PROBLEMS["local-mode"].fix).toEqual({
      kind: "local-model",
      label: "answer.error.useLocal",
    });
  });

  test("local mode stopping an Answer says everything stays on this computer, in both languages", () => {
    const { line } = ANSWER_PROBLEMS["local-mode"];
    expect(translate("en", line)).toBe("Stopped: everything stays on this computer");
    expect(translate("zh-CN", line)).toBe("已停止：所有内容都留在这台电脑上");
  });

  test("turning off sending while an Answer is written says so, naming the service, in both languages, with nothing to press", () => {
    const { line, fix } = ANSWER_PROBLEMS["consent-revoked"];
    expect(fix).toEqual({ kind: "none" });
    expect(translate("en", line, { service: "OpenAI" })).toBe(
      "Stopped: you turned off sending to OpenAI",
    );
    expect(translate("zh-CN", line, { service: "OpenAI" })).toBe(
      "已停止：你关闭了向 OpenAI 发送内容",
    );
  });

  test("Ollama not running says so in both languages, and its fix is Ollama's own (open it or get it)", () => {
    expect(ANSWER_PROBLEMS["ollama-not-running"]).toEqual({
      line: "answer.error.ollama-not-running",
      fix: { kind: "ollama", label: "localModel.open" },
    });
    expect(translate("en", "answer.error.ollama-not-running")).toBe(
      "Ollama isn’t running on this computer",
    );
    expect(translate("zh-CN", "answer.error.ollama-not-running")).toBe(
      "Ollama 没有在这台电脑上运行",
    );
    expect(translate("en", "localModel.open")).toBe("Open Ollama");
    expect(translate("en", "providers.ollama.get")).toBe("Get Ollama");
    expect(translate("zh-CN", "localModel.open")).toBe("打开 Ollama");
    expect(translate("zh-CN", "providers.ollama.get")).toBe("下载 Ollama");
  });

  test("an ended ChatGPT sign-in offers to sign in again, right from the Answer", () => {
    expect(ANSWER_PROBLEMS["not-signed-in"].fix).toEqual({
      kind: "sign-in",
      label: "answer.error.signIn",
    });
  });

  test("a reached ChatGPT plan limit offers Manage usage, ChatGPT's own page for it", () => {
    expect(ANSWER_PROBLEMS["plan-limit"].fix).toEqual({
      kind: "link",
      url: "https://chatgpt.com/settings/usage",
      label: "answer.error.manageUsage",
    });
  });

  test("the monthly cap says so, and Change cap opens General, where the cap is", () => {
    expect(ANSWER_PROBLEMS["cost-cap"]).toEqual({
      line: "answer.error.cost-cap",
      fix: { kind: "settings", page: "general", label: "answer.error.changeCap" },
    });
    expect(translate("en", "answer.error.cost-cap")).toBe("Monthly cap reached");
    expect(translate("en", "answer.error.changeCap")).toBe("Change cap");
  });

  test("a reply with no text says so, and offers Try again, in both languages", () => {
    expect(ANSWER_PROBLEMS["no-answer"]).toEqual({
      line: "answer.error.no-answer",
      fix: { kind: "retry", label: "answer.error.retry" },
    });
    expect(translate("en", "answer.error.no-answer")).toBe("The model sent no Answer");
    expect(translate("zh-CN", "answer.error.no-answer")).toBe("模型没有给出回答");
  });

  test("a sign-in route's plain line never names ChatGPT, nor offers its sign-in or usage page", () => {
    for (const route of ["claude-account", "copilot"] as const) {
      for (const kind of KINDS) {
        const { line, fix } = answerProblem(kind, route);
        expect(["sign-in", "link"]).not.toContain(fix.kind);
        for (const language of ["en", "zh-CN"] as const) {
          expect(translate(language, line)).not.toMatch(/ChatGPT|OpenAI/);
        }
      }
    }
  });

  test("a sign-in route's Answer gets the route's own line only where this build signs in with it", () => {
    expect(failedAnswerLine("blocked", "copilot", "policy-blocked", true)).toEqual({
      kind: "route",
      route: "copilot",
      words: SIGN_IN_ROUTES.copilot.problems["policy-blocked"],
    });
    const notOffered = failedAnswerLine("blocked", "copilot", "policy-blocked", false);
    expect(notOffered.kind).toBe("plain");
  });

  test("a route's Answer whose provider is gone or not loaded yet never gets ChatGPT's line or sign-in", () => {
    for (const kind of ["not-signed-in", "plan-limit", "blocked"] as const) {
      const shown = failedAnswerLine(kind, undefined, "signed-out", true);
      if (shown.kind !== "plain") throw new Error("A route's line with no route known.");
      expect(translate("en", shown.problem.line)).not.toMatch(/ChatGPT|OpenAI/);
      expect(["sign-in", "link"]).not.toContain(shown.problem.fix.kind);
    }
    expect(failedAnswerLine("not-signed-in", "chatgpt", null, false)).toEqual({
      kind: "plain",
      problem: ANSWER_PROBLEMS["not-signed-in"],
    });
  });

  test("an Ollama Cloud allowance used up is managed on Ollama's own page", () => {
    expect(answerProblem("plan-limit", "ollama")).toEqual({
      line: "answer.error.plan-limit.ollama",
      fix: { kind: "link", url: "https://ollama.com/settings", label: "answer.error.manageUsage" },
    });
    expect(answerProblem("plan-limit", "chatgpt")).toBe(ANSWER_PROBLEMS["plan-limit"]);
    expect(answerProblem("plan-limit", undefined)).toBe(ANSWER_PROBLEMS["plan-limit"]);
  });

  test("an account out of credit is sent to the provider's own billing page, when the catalog has one, in both languages", () => {
    const billing = (id: string, endpoint?: string) => {
      const provider = catalogProvider(id);
      return provider && billingUrlOf(provider, endpoint);
    };
    expect(billing("anthropic")).toBe("https://platform.claude.com/settings/billing");
    expect(billing("kimi", "cn")).toBe("https://platform.kimi.com/console");
    expect(billing("kimi", "intl")).toBe("https://platform.kimi.ai/console");
    const url = billing("openai");
    if (!url) throw new Error("OpenAI has a billing page.");
    const problem = answerProblem("out-of-credit", "openai", false, { billingUrl: url });
    expect(problem.fix).toEqual({ kind: "link", url, label: "answer.error.addCredit" });
    expect(translate("en", "answer.error.addCredit")).toBe("Add credit");
    expect(translate("zh-CN", "answer.error.addCredit")).toBe("充值");
    // No page known: the only help is another model.
    expect(billing("google")).toBeUndefined();
    expect(answerProblem("out-of-credit", "google")).toBe(ANSWER_PROBLEMS["out-of-credit"]);
    expect(
      failedAnswerLine("out-of-credit", "anthropic", null, false, { billingUrl: url }),
    ).toMatchObject({
      kind: "plain",
      problem: { fix: { kind: "link", url } },
    });
  });

  test("a model on this computer is never out of credit nor refused by a region; it is refused, and another model may take it", () => {
    for (const kind of ["out-of-credit", "region"] as const) {
      expect(answerProblem(kind, "ollama", false, { local: true })).toBe(ANSWER_PROBLEMS.refused);
      expect(
        answerProblem(kind, "openai-compatible", false, {
          local: true,
          billingUrl: "https://example.com/billing",
        }),
      ).toBe(ANSWER_PROBLEMS.refused);
      expect(answerProblem(kind, "openai", false, { local: false }).line).toBe(
        `answer.error.${kind}`,
      );
    }
  });

  test("a hosted model's too-long line doesn't blame the Question, and offers another model; a local one keeps Shorten it", () => {
    const hosted = answerProblem("too-long", "anthropic", false, { local: false });
    expect(hosted.fix).toEqual({
      kind: "settings",
      page: "models",
      label: "answer.error.chooseModel",
    });
    expect(translate("en", hosted.line, { model: "Claude Haiku 5.5" })).toBe(
      "This is too long for Claude Haiku 5.5",
    );
    expect(translate("zh-CN", hosted.line, { model: "Claude Haiku 5.5" })).toBe(
      "内容太长，超出了 Claude Haiku 5.5 的上限",
    );
    expect(answerProblem("too-long", "ollama", false, { local: true })).toBe(
      ANSWER_PROBLEMS["too-long"],
    );
    expect(answerProblem("too-long", "ollama")).toBe(ANSWER_PROBLEMS["too-long"]);
  });

  test("what the User can fix in Settings opens the page that fixes it", () => {
    expect(ANSWER_PROBLEMS.auth.fix).toMatchObject({ kind: "settings", page: "models" });
    expect(ANSWER_PROBLEMS.model.fix).toMatchObject({ kind: "settings", page: "models" });
    // A declined data flow is allowed again on the Privacy page.
    expect(ANSWER_PROBLEMS["consent-declined"].fix).toMatchObject({
      kind: "settings",
      page: "privacy",
    });
  });

  test("a limit or a lost connection is tried again; a Question too long for the model is not", () => {
    for (const kind of ["rate-limit", "network", "provider", "unknown"] as const) {
      expect(ANSWER_PROBLEMS[kind].fix.kind).toBe("retry");
    }
    expect(ANSWER_PROBLEMS["too-long"].fix.kind).toBe("none");
  });

  test("each way an Answer fails says why, with the action that fits, in both languages (#1487)", () => {
    const service = { model: "claude-haiku-5-5", service: "Anthropic" };
    const shown = (kind: ProviderErrorKind, language: "en" | "zh-CN") => {
      const { line, fix } = ANSWER_PROBLEMS[kind];
      return [
        translate(language, line, service),
        fix.kind === "none" ? "" : translate(language, fix.label),
      ];
    };
    expect(shown("network", "en")).toEqual([
      "Couldn’t reach Anthropic. Check your internet connection",
      "Try again",
    ]);
    expect(shown("rate-limit", "en")).toEqual([
      "Anthropic is limiting requests right now",
      "Try again",
    ]);
    expect(shown("auth", "en")).toEqual([
      "The key for claude-haiku-5-5 was refused",
      "Check the key",
    ]);
    expect(shown("refused", "en")).toEqual([
      "Anthropic refused this request",
      "Choose another model",
    ]);
    expect(shown("out-of-credit", "en")).toEqual([
      "No credit on this key",
      "Choose another model",
    ]);
    expect(shown("region", "en")).toEqual([
      "Anthropic doesn’t accept requests from your region",
      "Choose another model",
    ]);
    expect(shown("no-answer", "en")).toEqual(["The model sent no Answer", "Try again"]);
    expect(shown("provider", "en")).toEqual(["Anthropic ran into a problem", "Try again"]);
    expect(shown("unknown", "en")).toEqual(["Something went wrong with Anthropic", "Try again"]);

    expect(shown("network", "zh-CN")).toEqual(["无法连接 Anthropic，请检查网络连接", "重试"]);
    expect(shown("rate-limit", "zh-CN")).toEqual(["Anthropic 暂时限制了请求", "重试"]);
    expect(shown("auth", "zh-CN")).toEqual(["claude-haiku-5-5 的密钥被拒绝了", "检查密钥"]);
    expect(shown("refused", "zh-CN")).toEqual(["Anthropic 拒绝了这个请求", "换一个模型"]);
    expect(shown("out-of-credit", "zh-CN")).toEqual(["这个密钥没有额度", "换一个模型"]);
    expect(shown("region", "zh-CN")).toEqual([
      "Anthropic 不接受来自你所在地区的请求",
      "换一个模型",
    ]);
    expect(shown("no-answer", "zh-CN")).toEqual(["模型没有给出回答", "重试"]);
    expect(shown("provider", "zh-CN")).toEqual(["Anthropic 出错了", "重试"]);
    expect(shown("unknown", "zh-CN")).toEqual(["Anthropic 出了问题，原因不明", "重试"]);
    expect(ANSWER_PROBLEMS.refused.fix).toEqual({
      kind: "settings",
      page: "models",
      label: "answer.error.chooseModel",
    });
  });

  test("the line is one short sentence in both languages, naming the model where it can", () => {
    const labels = (language: "en" | "zh-CN") =>
      KINDS.map((kind) => {
        const { line, fix } = ANSWER_PROBLEMS[kind];
        const words = translate(language, line, { model: "claude-sonnet-5.5", service: "OpenAI" });
        const label = fix.kind === "none" ? "" : translate(language, fix.label);
        return { kind, words, label };
      });
    for (const language of ["en", "zh-CN"] as const) {
      for (const { kind, words, label } of labels(language)) {
        expect(words, `${language} ${kind}`).not.toMatch(/\{/);
        // No full stop, so the action follows on the same line; but data retention and too long are two sentences, the second what to do.
        if (kind !== "data-retention" && kind !== "too-long") {
          expect(words, `${language} ${kind}`).not.toMatch(/[.。]$/);
        }
        if (ANSWER_PROBLEMS[kind].fix.kind !== "none") expect(label).not.toBe("");
      }
    }
    expect(translate("en", ANSWER_PROBLEMS.auth.line, { model: "claude-sonnet-5.5" })).toBe(
      "The key for claude-sonnet-5.5 was refused",
    );
    expect(translate("en", ANSWER_PROBLEMS.network.line, { model: "m", service: "OpenAI" })).toBe(
      "Couldn’t reach OpenAI. Check your internet connection",
    );
    expect(
      translate("zh-CN", ANSWER_PROBLEMS.network.line, { model: "m", service: "OpenAI" }),
    ).toBe("无法连接 OpenAI，请检查网络连接");
    expect(translate("zh-CN", ANSWER_PROBLEMS.auth.line, { model: "claude-sonnet-5.5" })).toContain(
      "claude-sonnet-5.5",
    );
  });
});

describe("why a file couldn't be saved", () => {
  const key = (message: string): MessageKey | null => saveFailureReason(message);

  test("a folder that can't be written to is read-only", () => {
    expect(key("EACCES: permission denied, open '/Library/x.docx'")).toBe("export.failed.readOnly");
    expect(key("EROFS: read-only file system, open '/Volumes/x/a.docx'")).toBe(
      "export.failed.readOnly",
    );
    expect(key("EPERM: operation not permitted, open '/x/a.docx'")).toBe("export.failed.readOnly");
  });

  test("a full disk and a folder that's gone are told apart", () => {
    expect(key("ENOSPC: no space left on device, write")).toBe("export.failed.full");
    expect(key("ENOENT: no such file or directory, open '/gone/a.docx'")).toBe(
      "export.failed.gone",
    );
  });

  test("anything else is left to the system's own words", () => {
    expect(key("Something else happened.")).toBeNull();
  });

  test('the reasons read after "Couldn\'t save:" in both languages', () => {
    expect(
      translate("en", "export.failed.save", { reason: translate("en", "export.failed.readOnly") }),
    ).toBe("Couldn’t save: the folder is read-only");
    expect(
      translate("zh-CN", "export.failed.save", {
        reason: translate("zh-CN", "export.failed.readOnly"),
      }),
    ).toBe("无法保存：这个文件夹是只读的");
  });
});

describe("Questions waiting for a sign-in", () => {
  const signedOut = (kind: ChatProviderKind) =>
    readinessKey({
      ready: false,
      reason: "sign-in-required",
      provider: {
        id: "provider-1",
        kind,
        catalogId: null,
        endpoint: null,
        baseUrl: null,
        hasApiKey: false,
        service: null,
      },
      modelId: "model-1",
    });

  test("name the route's own provider, never ChatGPT, in both languages", () => {
    expect(translate("en", signedOut("chatgpt"))).toMatch(/ChatGPT/);
    for (const [kind, name] of [
      ["claude-account", /Claude/],
      ["copilot", /GitHub Copilot/],
    ] as const) {
      for (const language of ["en", "zh-CN"] as const) {
        const line = translate(language, signedOut(kind));
        expect(line).toMatch(name);
        expect(line).not.toMatch(/ChatGPT/);
      }
    }
  });
});
