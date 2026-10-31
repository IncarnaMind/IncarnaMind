import { expect, test } from "vitest";
import { lastRunLine } from "../../src/renderer/src/lastRunLine";
import { translate } from "../../src/shared/i18n";

const said = (lost: number | null, ended: Parameters<typeof lastRunLine>[1]) => {
  const line = lastRunLine(lost, ended);
  return (
    line && {
      en: translate("en", line.key, line.params),
      zh: translate("zh-CN", line.key, line.params),
    }
  );
};

test("a crash says everything was kept only when the last run's count says nothing was lost", () => {
  expect(said(0, { kind: "app" })).toEqual({
    en: "IncarnaMind closed unexpectedly. Everything up to then was kept.",
    zh: "IncarnaMind 意外关闭，关闭前的内容都已保留。",
  });
  expect(said(null, { kind: "app" })).toEqual({
    en: "IncarnaMind closed unexpectedly. Its last changes may not have been saved.",
    zh: "IncarnaMind 意外关闭，最后的改动可能没能保存。",
  });
  expect(said(3, { kind: "app" })).toEqual({
    en: "3 changes made before IncarnaMind closed couldn’t be saved",
    zh: "IncarnaMind 关闭前有 3 处改动没能保存",
  });
});

test("Windows ending the session before its changes were stored says how many, never that all was kept", () => {
  expect(said(2, { kind: "session", unsaved: 2 })).toEqual({
    en: "Windows ended IncarnaMind before 2 changes were saved. The rest was kept.",
    zh: "Windows 结束了 IncarnaMind，有 2 处改动没来得及保存，其余内容都已保留。",
  });
  expect(said(null, { kind: "session", unsaved: 1 })).toEqual({
    en: "Windows ended IncarnaMind before 1 change was saved. The rest was kept.",
    zh: "Windows 结束了 IncarnaMind，有 1 处改动没来得及保存，其余内容都已保留。",
  });
});

test("a page loaded again says so; a run that quit says nothing unless changes were lost", () => {
  expect(said(null, { kind: "window" })?.en).toBe(
    "This window stopped unexpectedly and reopened. Everything was kept.",
  );
  expect(said(0, null)).toBeNull();
  expect(said(null, null)).toBeNull();
  expect(said(1, null)?.en).toBe("1 change made before IncarnaMind closed couldn’t be saved");
});
