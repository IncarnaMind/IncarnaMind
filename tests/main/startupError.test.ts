import { describe, expect, it } from "vitest";
import { DataFromNewerVersionError } from "../../src/core/errors";
import { startupDialog, startupProblem, updateStartupDialog } from "../../src/main/startupError";

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

  it("keeps the message of any other start-up failure", () => {
    const dialog = startupDialog(new Error("disk full"), "en");
    expect(dialog.title).toBe("IncarnaMind couldn’t start");
    expect(dialog.detail).toContain("disk full");
    expect(dialog.buttons).toEqual([]);
  });

  it("says in plain words that another copy may still be starting, in both languages", () => {
    expect(startupProblem("en", "busy").detail).toBe(
      "IncarnaMind couldn’t open its data folder. Another copy may still be starting. Try again in a moment.",
    );
    expect(startupProblem("zh-CN", "busy").detail).toBe(
      "IncarnaMind 无法打开数据文件夹。可能另一个副本仍在启动，请稍后再试。",
    );
  });

  it("says in plain words that another copy was quitting and the data is safe, in both languages", () => {
    expect(startupProblem("en", "stalled")).toEqual({
      title: "IncarnaMind couldn’t start",
      detail:
        "IncarnaMind couldn’t open its window while another copy was quitting. Your data is unchanged. Open IncarnaMind again.",
    });
    expect(startupProblem("zh-CN", "stalled")).toEqual({
      title: "IncarnaMind 无法启动",
      detail: "另一个副本正在退出，IncarnaMind 无法打开窗口。数据未改动，请重新打开 IncarnaMind。",
    });
  });
});

describe("an update that has not produced the expected version", () => {
  it("gives the versions and the next step in English", () => {
    const dialog = updateStartupDialog("en", "1.9.0", "1.10.0");
    expect(dialog.title).toBe("IncarnaMind needs the latest version");
    expect(dialog.detail).toBe(
      "The update to 1.10.0 may not have finished. This copy is 1.9.0, so it won’t open your data folder. Download and install the latest version, then open IncarnaMind again.",
    );
    expect(dialog.buttons).toEqual(["Download the latest version", "Quit"]);
  });

  it("gives the same next step in Chinese", () => {
    const dialog = updateStartupDialog("zh-CN", "1.9.0", "1.10.0");
    expect(dialog.title).toBe("需要安装最新版本");
    expect(dialog.detail).toBe(
      "更新到 1.10.0 可能没有完成。当前版本是 1.9.0，所以不会打开你的数据文件夹。下载并安装最新版本后，再打开 IncarnaMind。",
    );
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
