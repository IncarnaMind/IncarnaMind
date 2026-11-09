import { describe, expect, test } from "vitest";
import { checkKey, formOfKey, serviceOfKey } from "../../src/core/providers/catalog/keyForms";
import { catalogProvider } from "../../src/core/providers/catalog/providers";

const alnum = (length: number, seed = "aZ3") =>
  seed.repeat(Math.ceil(length / seed.length)).slice(0, length);

/** Keys with a prefix that names its service, made up: no real key is in a test. */
const NAMED: readonly { service: string; key: string }[] = [
  { service: "anthropic", key: `sk-ant-api03-${alnum(40)}` },
  { service: "anthropic", key: `sk-ant-admin01-${alnum(40)}` },
  { service: "openrouter", key: `sk-or-v1-${alnum(64, "0f9a")}` },
  { service: "xai", key: `xai-${alnum(80)}` },
  { service: "google", key: `AIzaSy${alnum(33, "a-Z_9")}` },
  { service: "google", key: `AQ.${alnum(40, "aZ3_-")}` },
  { service: "openai", key: `sk-proj-${alnum(60)}` },
  { service: "openai", key: `sk-None-${alnum(60)}` },
  { service: "openai", key: `sk-${alnum(20)}T3BlbkFJ${alnum(20)}` },
  { service: "glm", key: "0123456789abcdef0123456789abcdef.aZ3aZ3aZ3aZ3aZ3a" },
];

/** Services whose keys must start with a prefix of their own. */
const STRICT = ["anthropic", "openrouter", "xai", "google"];

describe("A key's prefix and its service (#1384)", () => {
  test.each(NAMED)("a $service key is recognised as its own", ({ service, key }) => {
    expect(serviceOfKey(key)).toBe(service);
    expect(checkKey(service, key)).toEqual({ ok: true });
  });

  test.each(NAMED)(
    "a $service key is another service's, whichever else is chosen",
    ({ service, key }) => {
      for (const other of [...STRICT, "openai", "deepseek", "kimi", "qwen"].filter(
        (each) => each !== service,
      )) {
        expect(checkKey(other, key), `${other} for ${service}'s key`).toEqual({
          ok: false,
          service,
        });
      }
    },
  );

  test.each([
    ["a bare sk- and 48 letters and digits", `sk-${alnum(48)}`],
    ["a bare sk- and 48 lowercase letters", `sk-${alnum(48, "abc")}`],
    ["a bare sk- and 32 hex digits", `sk-${"0123456789abcdef".repeat(2)}`],
    ["Model Studio's newer sk-ws key", "sk-ws-0123456789abcdef0123456789abcdef"],
    ["not a key", "hello"],
  ])("%s names nobody by itself, so a provider's form never switches to it", (_what, key) => {
    expect(serviceOfKey(key)).toBeNull();
  });

  test("a key is read as it is cleaned: invisible characters around it change nothing", () => {
    const key = `sk-ant-api03-${alnum(40)}`;
    for (const around of ["\u200B", "\uFEFF", "\u00A0", "\u2800", "\uFE0F", " \n"]) {
      expect(serviceOfKey(`${around}${key}${around}`), JSON.stringify(around)).toBe("anthropic");
      expect(checkKey("anthropic", `${around}${key}${around}`)).toEqual({ ok: true });
    }
  });

  test.each(STRICT)(
    "under %s, a key that names nobody lacks the prefix its keys start with",
    (service) => {
      const check = checkKey(service, `sk-${alnum(48)}`);
      expect(check).toMatchObject({ ok: false, service: null });
      expect("prefixes" in check ? check.prefixes.length : 0).toBeGreaterThan(0);
    },
  );
});

/*
 * The forms first run reads a key by (#2865), each with a made-up sample key written out in full:
 * no real key is in a test, and none is sent anywhere to find out whose it is. Only a form that
 * names a service with one host is used at once; every other is asked about, naming the host.
 */
describe("What a key's form says of where it goes (#2865)", () => {
  test.each([
    ["Anthropic", "sk-ant-api03-aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3a", "anthropic"],
    [
      "OpenRouter",
      "sk-or-v1-0f9a0f9a0f9a0f9a0f9a0f9a0f9a0f9a0f9a0f9a0f9a0f9a0f9a0f9a0f9a",
      "openrouter",
    ],
    ["xAI", "xai-aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3a", "xai"],
    ["Google's AIza", "AIzaSyA-Z_9a-Z_9a-Z_9a-Z_9a-Z_9a-Z_9", "google"],
    ["Google's AQ.", "AQ.aZ3_-aZ3_-aZ3_-aZ3_-aZ3_-aZ3_-aZ3_-aZ3_-", "google"],
    [
      "an OpenAI project",
      "sk-proj-aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3",
      "openai",
    ],
  ])(
    "%s key names its service, whose one host takes it at once, in either language",
    (_what, key, service) => {
      expect(formOfKey(key, "zh-CN")).toEqual({ kind: "named", service });
      expect(formOfKey(key, "en")).toEqual({ kind: "named", service });
      expect(catalogProvider(service)?.endpoints).toHaveLength(1);
    },
  );

  test("GLM's {id}.{secret} names GLM but not its platform: it asks, the language's platform first", () => {
    const key = "0123456789abcdef0123456789abcdef.aZ3aZ3aZ3aZ3aZ3a";
    expect(serviceOfKey(key)).toBe("glm");
    expect(formOfKey(key, "zh-CN")).toEqual({
      kind: "ask",
      targets: [
        { service: "glm", region: "cn" },
        { service: "glm", region: "intl" },
      ],
    });
    expect(formOfKey(key, "en")).toEqual({
      kind: "ask",
      targets: [
        { service: "glm", region: "intl" },
        { service: "glm", region: "cn" },
      ],
    });
  });

  test.each([
    ["DeepSeek's or Qwen's 32 hex digits", "sk-0123456789abcdef0123456789abcdef"],
    ["SiliconFlow's lowercase letters", "sk-abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuv"],
    ["48 letters and digits", "sk-aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3"],
  ])("a bare sk- key (%s) asks about DeepSeek first", (_what, key) => {
    const targets = [
      { service: "deepseek", region: null },
      { service: "qwen", region: null },
      { service: "siliconflow", region: null },
    ];
    expect(formOfKey(key, "zh-CN")).toEqual({ kind: "ask", targets });
    expect(formOfKey(key, "en")).toEqual({ kind: "ask", targets });
  });

  test("Model Studio's newer sk-ws key asks about Qwen in the language's region first, then the other", () => {
    const key = "sk-ws-0123456789abcdef0123456789abcdef0123456789";
    expect(formOfKey(key, "zh-CN")).toEqual({
      kind: "ask",
      targets: [
        { service: "qwen", region: "cn" },
        { service: "qwen", region: "intl" },
        { service: "deepseek", region: null },
        { service: "siliconflow", region: null },
      ],
    });
    expect(formOfKey(key, "en")).toEqual({
      kind: "ask",
      targets: [
        { service: "qwen", region: "intl" },
        { service: "qwen", region: "cn" },
        { service: "deepseek", region: null },
        { service: "siliconflow", region: null },
      ],
    });
  });

  test.each([
    ["GLM", "0123456789abcdef0123456789abcdef.aZ3aZ3aZ3aZ3aZ3a"],
    ["sk-ws", "sk-ws-0123456789abcdef0123456789abcdef0123456789"],
    ["bare sk-", "sk-0123456789abcdef0123456789abcdef"],
  ])("the question a %s key asks names one host: a region, or a service with one", (_what, key) => {
    for (const language of ["en", "zh-CN"] as const) {
      const form = formOfKey(key, language);
      const [asked] = form.kind === "ask" ? form.targets : [];
      expect(asked, language).toBeDefined();
      const hosts = catalogProvider(asked?.service ?? "")?.endpoints ?? [];
      if (asked?.region === null) expect(hosts, language).toHaveLength(1);
      else
        expect(
          hosts.map((each) => each.id),
          language,
        ).toContain(asked?.region);
    }
  });

  test("the form is read from the cleaned key: spaces and invisible characters around it change nothing", () => {
    expect(formOfKey("\u200B sk-0123456789abcdef0123456789abcdef \n", "zh-CN")).toMatchObject({
      kind: "ask",
      targets: [{ service: "deepseek", region: null }, {}, {}],
    });
    expect(formOfKey("\uFEFFsk-ant-api03-aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3aZ3a ", "en")).toEqual(
      {
        kind: "named",
        service: "anthropic",
      },
    );
  });

  test.each([
    ["a key from a service we don't list", "pk-live-a-key-from-a-service-we-dont-list"],
    ["Model Studio's Token or Coding Plan key", "sk-sp-0123456789abcdef0123456789abcdef"],
    ["sk- with nothing after it", "sk-"],
    ["a web address", "deepseek.com"],
    [
      "a sign-in token with two dots",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlMTIz",
    ],
    ["words", "hello"],
  ])("%s matches no form: the service choice opens, as before", (_what, key) => {
    expect(formOfKey(key, "zh-CN")).toEqual({ kind: "unknown" });
    expect(formOfKey(key, "en")).toEqual({ kind: "unknown" });
  });
});
