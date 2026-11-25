import { describe, expect, it } from "vitest";
import { DataFromNewerVersionError } from "../../src/core/errors";
import { startupDialog, startupProblem, updateStartupDialog } from "../../src/main/startupError";
import { DatabaseHeldError } from "../../src/main/storageStart";

describe("startupDialog", () => {
  const newer = new DataFromNewerVersionError(58);

  it("tells English users to update, with no schema number", () => {
    const dialog = startupDialog(newer, "en");
    expect(dialog.title).toBe("Update IncarnaMind to open your data");
    expect(dialog.detail).toBe(
      "A newer IncarnaMind saved this data. Update to open it; nothing changed.",
    );
    expect(dialog.buttons).toEqual(["Download the latest version", "Quit"]);
    expect(`${dialog.message}${dialog.detail}`).not.toMatch(/58|migration/);
  });

  it("tells Chinese users to update, with no schema number", () => {
    const dialog = startupDialog(newer, "zh-CN");
    expect(dialog.title).toBe("更新 IncarnaMind 才能打开你的数据");
    expect(dialog.detail).toBe(
      "较新版本的 IncarnaMind 保存了这些数据。更新后即可打开，数据未改动。",
    );
    expect(dialog.buttons).toEqual(["下载最新版本", "退出"]);
    expect(`${dialog.message}${dialog.detail}`).not.toMatch(/58|migration/);
  });

  it.each(["en", "zh-CN"] as const)("gives the next step and native detail (%s)", (language) => {
    const dialog = startupDialog(new Error("disk I/O error"), language);
    expect(dialog.title).toBe(
      language === "en" ? "IncarnaMind couldn’t start" : "IncarnaMind 无法启动",
    );
    expect(dialog.detail).toBe(
      language === "en"
        ? "Your data folder couldn’t be opened. Open IncarnaMind again.\n\ndisk I/O error"
        : "无法打开你的数据文件夹。请重新打开 IncarnaMind。\n\ndisk I/O error",
    );
    expect(dialog.buttons).toEqual([]);
  });

  const sqliteError = (errcode: number, message: string) =>
    Object.assign(new Error(message), { code: "ERR_SQLITE_ERROR", errcode });
  const native = (message: string) =>
    `Your data folder couldn’t be opened. Open IncarnaMind again.\n\n${message}`;
  const onPlatform = (value: NodeJS.Platform, run: () => void) => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    if (!platform) throw new Error("The test could not read the native platform.");
    Object.defineProperty(process, "platform", { configurable: true, value });
    try {
      run();
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  };

  it.each([
    ["a -shm another process maps on Windows (#2067)", sqliteError(1546, "disk I/O error")],
    ["a lock SQLite met", sqliteError(5, "database is locked")],
    ["a lock the migration worker met", new DatabaseHeldError(sqliteError(517, "x"))],
  ])("says another program holds the data, and that it is safe, for %s", (_name, error) => {
    onPlatform("win32", () => {
      expect(startupDialog(error, "en").detail).toBe(
        "Another program is using IncarnaMind’s data. Nothing is lost: open it again in a moment.",
      );
      expect(startupDialog(error, "zh-CN").detail).toBe(
        "另一个程序正在使用 IncarnaMind 的数据。数据不会丢失，请稍后重新打开。",
      );
    });
  });

  it("keeps SQLite's words for a disk that really failed, and for a failed truncate off Windows", () => {
    onPlatform("win32", () => {
      expect(startupDialog(sqliteError(10, "disk I/O error"), "en").detail).toBe(
        native("disk I/O error"),
      );
    });
    onPlatform("darwin", () => {
      expect(startupDialog(sqliteError(1546, "disk I/O error"), "en").detail).toBe(
        native("disk I/O error"),
      );
      expect(startupDialog(sqliteError(5, "database is locked"), "en").detail).toBe(
        "Another program is using IncarnaMind’s data. Nothing is lost: open it again in a moment.",
      );
    });
  });

  it("says in plain words that another copy may still be starting, in both languages", () => {
    expect(startupProblem("en", "busy").detail).toBe(
      "Another copy may still be starting. Try again in a moment.",
    );
    expect(startupProblem("zh-CN", "busy").detail).toBe("可能另一个副本仍在启动，请稍后再试。");
  });

  it("says in plain words that another copy was quitting and the data is safe, in both languages", () => {
    expect(startupProblem("en", "stalled")).toEqual({
      title: "IncarnaMind couldn’t start",
      detail: "Another copy was quitting. Open IncarnaMind again; your data is unchanged.",
    });
    expect(startupProblem("zh-CN", "stalled")).toEqual({
      title: "IncarnaMind 无法启动",
      detail: "另一个副本正在退出。请重新打开 IncarnaMind，数据未改动。",
    });
  });
});

describe("an update that has not produced the expected version", () => {
  it("gives the versions and the next step in English", () => {
    const dialog = updateStartupDialog("en", "1.9.0", "1.10.0");
    expect(dialog.title).toBe("IncarnaMind needs the latest version");
    expect(dialog.detail).toBe(
      "The update to 1.10.0 may not have finished, so this copy (1.9.0) won’t open your data.",
    );
    expect(dialog.buttons).toEqual(["Download the latest version", "Quit"]);
  });

  it("gives the same next step in Chinese", () => {
    const dialog = updateStartupDialog("zh-CN", "1.9.0", "1.10.0");
    expect(dialog.title).toBe("需要安装最新版本");
    expect(dialog.detail).toBe("更新到 1.10.0 可能没有完成，当前版本（1.9.0）不会打开你的数据。");
    expect(dialog.buttons).toEqual(["下载最新版本", "退出"]);
  });

  for (const language of ["en", "zh-CN"] as const) {
    it(`omits unknown versions without losing the action (${language})`, () => {
      const withoutTarget = updateStartupDialog(language, "1.9.0");
      const withoutCurrent = updateStartupDialog(language, undefined, "1.10.0");
      const withoutBoth = updateStartupDialog(language);
      expect(withoutTarget.detail).toContain("1.9.0");
      expect(withoutTarget.detail).not.toContain("1.10.0");
      expect(withoutCurrent.detail).toContain("1.10.0");
      expect(withoutCurrent.detail).not.toContain("1.9.0");
      expect(withoutBoth.detail).not.toMatch(/1\.9\.0|1\.10\.0|undefined|\{old\}|\{new\}/);
      for (const dialog of [withoutTarget, withoutCurrent, withoutBoth]) {
        expect(dialog.buttons).toEqual(
          language === "en" ? ["Download the latest version", "Quit"] : ["下载最新版本", "退出"],
        );
        expect(dialog.defaultId).toBe(0);
        expect(dialog.cancelId).toBe(1);
      }
    });
  }
});
