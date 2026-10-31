import { expect, test } from "vitest";
import { endedInOneNote, lastRunLine } from "../../src/renderer/src/lastRunLine";
import { translate } from "../../src/shared/i18n";

const said = (state: Parameters<typeof lastRunLine>[0]) => {
  const line = lastRunLine(state);
  return (
    line && {
      en: translate("en", line.key, line.params),
      zh: translate("zh-CN", line.key, line.params),
      ...(line.open && { open: line.open }),
    }
  );
};

const unknown = {
  en: "IncarnaMind closed unexpectedly. Your last changes may not have been saved.",
  zh: "IncarnaMind 意外关闭，你最后的改动可能没有保存。",
};

// protects=an unexpected end never claims everything was kept, as changes sent while the app hung are never counted (#2309); fails_when=a count of 0 or none reads as all kept; no_claim=which run ended.
test("a crash never says everything was kept: with no count, or a count of 0, the last changes may not have been saved", () => {
  expect(said({ lost: 0, ended: { kind: "app" } })).toEqual(unknown);
  expect(said({ lost: null, ended: { kind: "app" } })).toEqual(unknown);
  expect(said({ lost: 3, ended: { kind: "app" } })).toEqual({
    en: "3 changes made before IncarnaMind closed couldn’t be saved",
    zh: "IncarnaMind 关闭前有 3 处改动没能保存",
  });
});

test("Windows ending the session before its changes were stored says how many, and in which Note when one", () => {
  const minds = [
    { mindId: "mind-1", count: 1 },
    { mindId: "mind-2", count: 1 },
  ];
  expect(said({ lost: 2, ended: { kind: "session", unsaved: 2, minds } })).toEqual({
    en: "When Windows shut down or signed out, 2 changes hadn’t been saved yet. Everything else was kept.",
    zh: "Windows 关机或注销时，有 2 处改动还没保存，其余内容都已保留。",
  });
  expect(said({ lost: null, ended: { kind: "session", unsaved: 1, minds: [] } })).toEqual({
    en: "When Windows shut down or signed out, 1 change hadn’t been saved yet. Everything else was kept.",
    zh: "Windows 关机或注销时，有 1 处改动还没保存，其余内容都已保留。",
  });
  const note = { mindId: "mind-1", name: "Lease review" };
  expect(
    said({
      lost: 2,
      ended: { kind: "session", unsaved: 2, minds: [{ mindId: "mind-1", count: 2 }] },
      note,
    }),
  ).toEqual({
    en: "When Windows shut down or signed out, 2 changes to “Lease review” hadn’t been saved yet. Everything else was kept.",
    zh: "Windows 关机或注销时，“Lease review”有 2 处改动还没保存，其余内容都已保留。",
    open: "mind-1",
  });
  expect(
    said({
      lost: 1,
      ended: { kind: "session", unsaved: 1, minds: [{ mindId: "mind-1", count: 1 }] },
      note,
    }),
  ).toEqual({
    en: "When Windows shut down or signed out, 1 change to “Lease review” hadn’t been saved yet. Everything else was kept.",
    zh: "Windows 关机或注销时，“Lease review”有 1 处改动还没保存，其余内容都已保留。",
    open: "mind-1",
  });
});

test("a session's end names a Note only when it left every change in that one Note", () => {
  const one = (mindId: string, count: number) => ({ mindId, count });
  expect(endedInOneNote({ kind: "session", unsaved: 2, minds: [one("mind-1", 2)] })).toBe("mind-1");
  expect(
    endedInOneNote({ kind: "session", unsaved: 2, minds: [one("mind-1", 1), one("mind-2", 1)] }),
  ).toBeNull();
  // The other change was in a deleted Note, which isn't listed.
  expect(endedInOneNote({ kind: "session", unsaved: 2, minds: [one("mind-1", 1)] })).toBeNull();
  expect(endedInOneNote({ kind: "session", unsaved: 2, minds: [] })).toBeNull();
  expect(endedInOneNote({ kind: "app" })).toBeNull();
});

// protects=a reloaded page says only what it knows: changes typed as it crashed may be gone, and when changes wait, their own notice says so (#2309); fails_when=the window line claims everything was kept, or contradicts the notice of changes waiting; no_claim=what the notice says.
test("a page loaded again says its last changes may not have been saved, or only that it reopened while changes wait", () => {
  expect(said({ lost: null, ended: { kind: "window" } })).toEqual({
    en: "This window stopped unexpectedly and reopened. Your last changes may not have been saved.",
    zh: "这个窗口意外停止，已重新打开。你最后的改动可能没有保存。",
  });
  expect(said({ lost: null, ended: { kind: "window" }, waiting: true })).toEqual({
    en: "This window stopped unexpectedly and reopened.",
    zh: "这个窗口意外停止，已重新打开。",
  });
});

test("a run that quit says nothing unless changes were lost", () => {
  expect(said({ lost: 0, ended: null })).toBeNull();
  expect(said({ lost: null, ended: null })).toBeNull();
  expect(said({ lost: 1, ended: null })?.en).toBe(
    "1 change made before IncarnaMind closed couldn’t be saved",
  );
});
