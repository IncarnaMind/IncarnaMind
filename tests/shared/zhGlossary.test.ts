import { describe, expect, test } from "vitest";
import { zhCN } from "../../src/shared/i18n/zh-CN";

const NOT_ALLOWED: readonly [string, string][] = [
  ["搜索网络", "联网搜索"],
  ["在网页上搜索", "联网搜索"],
  ["网页搜索", "联网搜索"],
  ["查找来源", "查找资料"],
];

describe("Chinese strings keep to the glossary", () => {
  test.each(NOT_ALLOWED)("no string says %s; it is %s", (wrong) => {
    // The one name of the results themselves, rather than the act (#2240): the card names them.
    const found = Object.entries(zhCN).filter(
      ([key, message]) => key !== "commands.ask.readText.webSearch" && message.includes(wrong),
    );
    expect(found.map(([key]) => key)).toEqual([]);
  });
});
