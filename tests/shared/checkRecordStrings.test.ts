import { describe, expect, test } from "vitest";
import { RECORD_CITE_KEYS, recordCiteTranslatorFor } from "../../src/core/checkRecord/strings";
import { type MessageKey, translate } from "../../src/shared/i18n";
import { en } from "../../src/shared/i18n/en";
import { zhCN } from "../../src/shared/i18n/zh-CN";

/*
 * The words of the check record (#738), which a person attaches to their work: every one comes
 * in English and in Chinese, with the same placeholders, and the Chinese follows the guide.
 */

const keys = (Object.keys(en) as MessageKey[]).filter((key) => key.startsWith("checkRecord."));
const NO_TRANSLATION = new Set<MessageKey>([
  "checkRecord.summary.mind",
  "checkRecord.column.sha256",
  "checkRecord.checker",
  "checkRecord.time",
  "checkRecord.modelAt",
]);

describe("the words of the check record", () => {
  test("there are some", () => {
    expect(keys.length).toBeGreaterThan(40);
  });

  test.each(keys)("%s is in English and in Chinese, with the same placeholders", (key) => {
    const params = { name: "Essay", count: 3, format: "PDF" };
    const english = translate("en", key, params);
    const chinese = translate("zh-CN", key, params);
    expect(english).not.toBe("");
    expect(chinese).not.toBe("");
    if (!NO_TRANSLATION.has(key)) {
      expect(chinese).toMatch(/\p{Script=Han}/u);
      expect(chinese).not.toBe(english);
    }
    const placeholders = (value: string) =>
      [...value.matchAll(/\{(\w+)\}/g)].map((each) => each[1]);
    expect(placeholders(en[key])).toEqual(placeholders(zhCN[key]));
  });

  test("the Chinese never says 您 and keeps a space between Chinese and Latin letters or digits", () => {
    for (const key of keys) {
      const value = zhCN[key];
      expect(value).not.toContain("您");
      expect(value).not.toMatch(/[\p{Script=Han}][A-Za-z0-9]|[A-Za-z0-9][\p{Script=Han}]/u);
    }
  });
});

describe("the record-cite words of the check record", () => {
  test.each(RECORD_CITE_KEYS)("%s matches in English and Chinese", (key) => {
    const english = recordCiteTranslatorFor("en")(key, "3");
    const chinese = recordCiteTranslatorFor("zh-CN")(key, "3");
    expect(english).not.toBe("");
    expect(chinese).not.toBe("");
    expect(chinese).not.toBe(english);
    expect(chinese).toMatch(/\p{Script=Han}/u);
    expect(chinese).not.toContain("您");
    expect(chinese).not.toMatch(/[\p{Script=Han}][A-Za-z0-9]|[A-Za-z0-9][\p{Script=Han}]/u);
    expect(english).not.toContain("{count}");
    expect(chinese).not.toContain("{count}");
  });
});
