import { APICallError, RetryError, StreamProviderError, TypeValidationError } from "ai";
import { describe, expect, test } from "vitest";
import { KeyCharacterError } from "../../src/core/providers/apiKey";
import { JevRequestError } from "../../src/core/providers/jev";
import { classifyProviderError } from "../../src/core/providers/providerErrors";
import { translate } from "../../src/shared/i18n";
import { en } from "../../src/shared/i18n/en";
import { zhCN } from "../../src/shared/i18n/zh-CN";

const refused = (message: string, statusCode = 400) =>
  new APICallError({
    message,
    url: "https://api.anthropic.com/v1/messages",
    requestBodyValues: {},
    statusCode,
    responseBody: JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message },
    }),
    isRetryable: false,
  });

describe("A provider's refusal", () => {
  test("of a model that needs 30-day data retention, asked by an organization without it, says so", () => {
    const error = classifyProviderError(
      refused(
        "In order to access this model, your organization or workspace must have data retention enabled.",
      ),
    );
    expect(error.kind).toBe("data-retention");
    // Each line names the model it was asked for, and neither tells the User what to change in the Console.
    for (const key of ["answer.error.data-retention", "providers.test.data-retention"] as const) {
      expect(en[key], key).toContain("{model}");
      expect(zhCN[key], key).toContain("{model}");
      expect(en[key], key).toContain("30-day retention");
      expect(zhCN[key], key).toContain("30 天数据保留");
      expect(`${en[key]}${zhCN[key]}`, key).not.toMatch(/Console/);
    }
  });

  test("with another 400 is a refused request, with its status", () => {
    expect(classifyProviderError(refused("messages: field required"))).toEqual({
      kind: "refused",
      message: "messages: field required",
      status: 400,
    });
  });

  test("of a key, said only in the body of a 400 (Google's model list), is a refused key", () => {
    const listRefused = new APICallError({
      message: "HTTP 400",
      url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
      requestBodyValues: undefined,
      statusCode: 400,
      responseBody: JSON.stringify({
        error: { code: 400, message: "API key not valid. Please pass a valid API key." },
      }),
    });
    expect(classifyProviderError(listRefused).kind).toBe("auth");
  });
});

describe("A failed request", () => {
  const streamed = (statusCode: number | undefined, message: string) =>
    new StreamProviderError({ message, type: "overloaded_error", statusCode });

  test("ended by the provider once its reply began is sorted by the status it gave", () => {
    expect(classifyProviderError(streamed(529, "Overloaded"))).toEqual({
      kind: "provider",
      message: "Overloaded",
      status: 529,
    });
    expect(classifyProviderError(streamed(429, "Rate limited")).kind).toBe("rate-limit");
    expect(classifyProviderError(streamed(401, "Invalid key")).kind).toBe("auth");
    expect(classifyProviderError(streamed(400, "Bad request")).kind).toBe("refused");
    expect(classifyProviderError(streamed(undefined, "Something odd"))).toEqual({
      kind: "provider",
      message: "Something odd",
    });
  });

  test("whose connection timed out or ended partway is no connection", () => {
    expect(
      classifyProviderError(
        new TypeError("terminated", {
          cause: Object.assign(new Error("Body Timeout Error"), { code: "UND_ERR_BODY_TIMEOUT" }),
        }),
      ).kind,
    ).toBe("network");
    expect(classifyProviderError(new DOMException("Timed out", "TimeoutError")).kind).toBe(
      "network",
    );
    expect(classifyProviderError(refused("Request Timeout", 408)).kind).toBe("network");
  });

  test("whose reply is cut off partway, wrapped as the SDK wraps it, is no connection, with its cause", () => {
    const wrapped = (cause: Error) =>
      new APICallError({
        message: "Failed to process successful response",
        url: "https://api.anthropic.com/v1/messages",
        requestBodyValues: {},
        statusCode: 200,
        cause,
      });
    const cut = wrapped(
      new TypeError("terminated", {
        cause: Object.assign(new Error("other side closed"), {
          name: "SocketError",
          code: "UND_ERR_SOCKET",
        }),
      }),
    );
    expect(classifyProviderError(cut)).toEqual({
      kind: "network",
      message: "terminated",
      status: 200,
    });
    expect(translate("en", "answer.error.network", { service: "Anthropic" })).toBe(
      "Couldn’t reach Anthropic. Check your internet connection",
    );
    expect(translate("zh-CN", "answer.error.network", { service: "Anthropic" })).toBe(
      "无法连接 Anthropic，请检查网络连接",
    );
    // A reply that was whole but couldn't be read stays a reply that couldn't be read.
    expect(
      classifyProviderError(wrapped(new SyntaxError("Unexpected end of JSON input"))).kind,
    ).toBe("no-answer");
  });

  test("whose reply can't be read is no Answer, without the reply it quotes", () => {
    const unreadable = new TypeValidationError({
      value: { answer: "The codeword is zanzibar." },
      cause: new Error("Expected a string."),
    });
    expect(classifyProviderError(unreadable)).toEqual({
      kind: "no-answer",
      message: "The model's reply couldn't be read (AI_TypeValidationError).",
    });
    expect(classifyProviderError(refused("Invalid JSON response", 200)).kind).toBe("no-answer");
  });

  test("that nothing explains is unknown, and keeps its status", () => {
    expect(classifyProviderError(refused("Found", 302))).toEqual({
      kind: "unknown",
      message: "Found",
      status: 302,
    });
  });
});

describe("A provider's own words for what went wrong", () => {
  const said = (status: number, message: string, type = "") =>
    new APICallError({
      message,
      url: "https://provider.example/v1/chat",
      requestBodyValues: {},
      statusCode: status,
      responseBody: JSON.stringify({ error: { message: type ? "" : message, type, code: type } }),
      isRetryable: false,
    });
  const QUOTA = "You exceeded your current quota, please check your plan and billing details.";
  const CONTEXT = "This model's maximum context length is 128000 tokens.";

  type Row = [name: string, status: number, message: string, type?: string];
  const credit: Row[] = [
    ["Anthropic's 400", 400, "Your credit balance is too low to access the Anthropic API."],
    ["Anthropic's 402 billing error", 402, "There was an issue with your billing information"],
    ["OpenAI's 429 with no quota left", 429, QUOTA, "insufficient_quota"],
    [
      "OpenAI's billing limit",
      400,
      "Billing hard limit has been reached",
      "billing_hard_limit_reached",
    ],
    [
      "Kimi's 429",
      429,
      "Account suspended: insufficient balance, please recharge",
      "exceeded_current_quota_error",
    ],
    ["DeepSeek's 402", 402, "Insufficient Balance"],
    ["OpenRouter's 402", 402, "Insufficient credits. Add more using https://openrouter.ai/credits"],
    ["xAI's words", 403, "Your team has used all available credits. Please purchase more credits."],
    ["Zhipu's Chinese", 429, "您的账户已欠费，请充值后重试。"],
    [
      "Alibaba's code",
      400,
      "Access denied, please make sure your account is in good standing.",
      "Arrearage",
    ],
  ];
  test.each(credit)(
    "%s: the account is out of credit, not rate limited or refused",
    (_, status, message, type) => {
      const error = said(status, message, type);
      expect(classifyProviderError(error)).toEqual({ kind: "out-of-credit", message, status });
    },
  );

  const others: [...Row, string][] = [
    [
      "OpenAI's per-minute limit",
      429,
      "Rate limit reached for gpt-6 on tokens per min (TPM)",
      "tokens",
      "rate-limit",
    ],
    ["Gemini's quota, which resets by itself", 429, QUOTA, "RESOURCE_EXHAUSTED", "rate-limit"],
    [
      "Anthropic's rate limit",
      429,
      "Number of request tokens has exceeded your limit",
      "rate_limit_error",
      "rate-limit",
    ],
    ["Anthropic's refused key", 401, "invalid x-api-key", "authentication_error", "auth"],
    [
      "a key without permission",
      403,
      "Your API key does not have permission",
      "permission_error",
      "auth",
    ],
    [
      "an unknown model",
      404,
      "The model `gpt-9` does not exist or you do not have access to it.",
      "",
      "model",
    ],
    ["an outage", 500, "Internal server error", "api_error", "provider"],
    [
      "a local server out of memory",
      500,
      "model requires more system memory (5.5 GiB)",
      "",
      "provider",
    ],
    [
      "OpenAI's country, region or territory",
      403,
      "Country, region, or territory not supported",
      "unsupported_country_region_territory",
      "region",
    ],
    [
      "Gemini's location",
      400,
      "User location is not supported for the API use.",
      "FAILED_PRECONDITION",
      "region",
    ],
    ["Anthropic's bare 403", 403, "Request not allowed", "forbidden", "region"],
    [
      "Anthropic's prompt",
      400,
      "prompt is too long: 214000 tokens > 200000 maximum",
      "",
      "too-long",
    ],
    [
      "Anthropic's size limit",
      413,
      "Request exceeds the maximum allowed number of bytes.",
      "request_too_large",
      "too-long",
    ],
    ["OpenAI's and DeepSeek's context window", 400, CONTEXT, "context_length_exceeded", "too-long"],
    [
      "Gemini's input",
      400,
      "The input token count (1200000) exceeds the maximum number of tokens allowed",
      "",
      "too-long",
    ],
    [
      "Kimi's token limit",
      400,
      "Invalid request: Your request exceeded model token limit: 262144",
      "",
      "too-long",
    ],
  ];
  test.each(others)("%s keeps or finds its own kind", (_, status, message, type, kind) => {
    expect(classifyProviderError(said(status, message, type)).kind).toBe(kind);
  });

  test("a 403 with more words than Anthropic's bare one, or a 400 or 451 with the same first words, is not a region", () => {
    expect(
      classifyProviderError(said(403, "Request not allowed: this key is restricted to workspace X"))
        .kind,
    ).toBe("auth");
    expect(classifyProviderError(said(400, "Request not allowed for this model")).kind).toBe(
      "refused",
    );
    expect(classifyProviderError(said(451, "Request not allowed")).kind).toBe("refused");
    expect(classifyProviderError(said(403, "Request not allowed.")).kind).toBe("region");
  });

  test("a body that repeats the request, with a Document's own words, does not make a kind", () => {
    const echoed = (status: number, echo: string) =>
      new APICallError({
        message: "Input should be a valid string",
        url: "http://127.0.0.1:8000/v1/chat/completions",
        requestBodyValues: {},
        statusCode: status,
        responseBody: JSON.stringify({ detail: [{ type: "string_type", input: echo }] }),
        isRetryable: false,
      });
    expect(classifyProviderError(echoed(422, "Insufficient funds at the bank")).kind).toBe(
      "refused",
    );
    expect(classifyProviderError(echoed(400, "The token limit was raised")).kind).toBe("refused");
    expect(classifyProviderError(echoed(400, "Country not supported in the treaty")).kind).toBe(
      "refused",
    );
  });

  test("a failure of a model on this computer is never out of credit", () => {
    expect(classifyProviderError(new TypeError("fetch failed")).kind).toBe("network");
    expect(classifyProviderError(said(500, "llama runner process has terminated")).kind).toBe(
      "provider",
    );
    expect(classifyProviderError(said(404, 'model "llama9" not found, try pulling it')).kind).toBe(
      "model",
    );
  });

  test("an out-of-credit or region problem has a line in both languages, for the Answer, a test and tagging", () => {
    for (const kind of ["out-of-credit", "region"] as const) {
      for (const key of [
        `answer.error.${kind}`,
        `providers.test.${kind}`,
        `tagging.problem.${kind}`,
      ] as const) {
        expect(en[key], key).toBeTruthy();
        expect(zhCN[key], key).toBeTruthy();
      }
    }
  });
});

describe("A key with a character that keys don't use", () => {
  const engine = (code: number) =>
    new TypeError(
      `Cannot convert argument to a ByteString because the character at index 19 has a value of ${code} which is greater than 255.`,
    );

  test("is said as a bad key, naming only that character, in both languages", () => {
    const error = classifyProviderError(engine(20316));

    expect(error.kind).toBe("auth");
    expect(error.wording).toEqual({
      key: "error.provider.keyCharacter",
      values: { character: "作" },
    });
    expect(error.message).toBe("This key has a character keys don’t use (作). Paste it again.");
    expect(
      translate(
        "zh-CN",
        error.wording?.key ?? "error.provider.keyCharacter",
        error.wording?.values,
      ),
    ).toBe("密钥里有一个不该有的字符（作）。重新粘贴密钥。");
  });

  test("names an invisible character by its code, not by a blank", () => {
    for (const [code, named] of [
      [0x200b, "U+200B"],
      [0xfe0f, "U+FE0F"],
      [0x2800, "U+2800"],
      [0x3164, "U+3164"],
    ] as const) {
      expect(classifyProviderError(engine(code)).wording?.values).toEqual({ character: named });
    }
    expect(classifyProviderError(engine(0x2019)).wording?.values).toEqual({ character: "\u2019" });
  });

  test("is found before the error Jev's request wraps it in", () => {
    const wrapped = new JevRequestError(
      "network",
      `Couldn't reach https://api.typesafe.ai: ${engine(20316).message}`,
    );
    const error = classifyProviderError(wrapped);

    expect(error.kind).toBe("auth");
    expect(error.wording).toEqual({
      key: "error.provider.keyCharacter",
      values: { character: "作" },
    });
  });

  test("is the same line when the core found the character first", () => {
    const error = classifyProviderError(new KeyCharacterError("作"));

    expect(error.kind).toBe("auth");
    expect(error.wording).toEqual({
      key: "error.provider.keyCharacter",
      values: { character: "作" },
    });
  });

  test("is found inside the AI SDK's retry error too", () => {
    const retried = new RetryError({
      message: "Failed after 3 attempts.",
      reason: "maxRetriesExceeded",
      errors: [engine(20316)],
    });
    expect(classifyProviderError(retried).wording?.values).toEqual({ character: "作" });
  });

  test("leaves another TypeError as it was", () => {
    expect(classifyProviderError(new TypeError("fetch failed")).kind).toBe("network");
    expect(classifyProviderError(new TypeError("x is not a function")).kind).toBe("unknown");
  });
});
