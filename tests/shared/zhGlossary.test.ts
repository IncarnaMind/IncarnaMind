import { describe, expect, test } from "vitest";
import { zhCN } from "../../src/shared/i18n/zh-CN";

const NOT_ALLOWED: readonly [string, string][] = [
  ["搜索网络", "联网搜索"],
  ["在网页上搜索", "联网搜索"],
  ["网页搜索", "联网搜索"],
  ["查找来源", "查找资料"],
  ["聊天模型", "AI 模型"],
  ["对话模型", "AI 模型"],
  ["待核对", "未核对"],
];

describe("Chinese strings keep to the glossary", () => {
  test.each(NOT_ALLOWED)("no string says %s; it is %s", (wrong) => {
    // The one name of the results themselves, rather than the act (#2240): the card names them.
    // "等待核对" means waiting for a running check to finish, not the "Not checked" state.
    const found = Object.entries(zhCN).filter(([key, message]) => {
      if (key === "commands.ask.readText.webSearch") return false;
      const checked = wrong === "待核对" ? message.replaceAll("等待核对", "") : message;
      return checked.includes(wrong);
    });
    expect(found.map(([key]) => key)).toEqual([]);
  });

  test("the checks pill and card use 未核对 for the same unchecked state", () => {
    for (const key of [
      "health.toCheck.one",
      "health.toCheck",
      "health.state.notChecked",
      "health.state.needsCheck.one",
      "health.state.needsCheck",
      "health.state.needsCheck.short.one",
      "health.state.needsCheck.short",
      "checks.row.notChecked.one",
      "checks.row.notChecked",
      "claim.state.not-checked",
    ] as const) {
      expect(zhCN[key], key).toContain("未核对");
      expect(zhCN[key], key).not.toContain("待核对");
    }
  });
});
