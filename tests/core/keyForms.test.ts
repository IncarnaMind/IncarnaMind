import { describe, expect, test } from "vitest";
import { checkKey, serviceOfKey } from "../../src/core/providers/catalog/keyForms";

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
    ["a bare sk- and 48 letters and digits, which Kimi and the relays have", `sk-${alnum(48)}`],
    ["a bare sk- and 48 lowercase letters, which SiliconFlow has", `sk-${alnum(48, "abc")}`],
    [
      "a bare sk- and 32 hex digits, which DeepSeek and Qwen have",
      `sk-${"0123456789abcdef".repeat(2)}`,
    ],
    ["a Chinese key with a dot", `${"0123456789abcdef".repeat(2)}.${alnum(16)}`],
    ["not a key", "hello"],
  ])("%s names nobody", (_what, key) => {
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
