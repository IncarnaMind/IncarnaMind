import { describe, expect, test } from "vitest";
import { coreApiMethods, type SaveFailureReason } from "../../src/core/api";
import type { Language } from "../../src/core/language";
import { errorDetails, errorDoing } from "../../src/renderer/src/errorDetails";
import { describeError } from "../../src/renderer/src/errors";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

/*
 * A notice's Details are plain words (#2731): what was said, what was being done and what to do.
 * They never show the name of a core call ("core:renameDocument", "renameDocument") or of an
 * error's class ("InvalidInputError"), for any call and in either language.
 */

const LANGUAGES = ["en", "zh-CN"] as const satisfies readonly Language[];
const wordsIn = (language: Language) => (key: MessageKey, params?: MessageParams) =>
  translate(language, key, params);

const failed = (call: string, name: string, message: string) =>
  new Error(`Error invoking remote method 'core:${call}': ${name}: ${message}`);

describe("what was being done", () => {
  test.each([
    ["renameDocument", "renaming Documents", "重命名文档"],
    ["deleteMind", "deleting notes", "删除笔记"],
    ["createLibraryGroup", "creating Folders", "新建文件夹"],
    ["addLinkedFolder", "adding Linked folders", "添加关联文件夹"],
    ["addDocumentTag", "adding Tags", "添加标签"],
    ["exportMind", "exporting notes", "导出笔记"],
    ["testChatConnection", "testing AI models", "测试 AI 模型"],
    ["moveComparisonColumn", "moving comparison tables", "移动对比表"],
    ["setMindCitationStyle", "changing the citation style", "更改引用格式"],
  ])("%s is %s, in Chinese %s", (call, english, chinese) => {
    expect(errorDoing(wordsIn("en"), "en", call)).toBe(english);
    expect(errorDoing(wordsIn("zh-CN"), "zh-CN", call)).toBe(chinese);
  });

  test("an object known and a verb not is worked with", () => {
    expect(errorDoing(wordsIn("en"), "en", "signInToConnector")).toBe("working with Connectors");
    expect(errorDoing(wordsIn("zh-CN"), "zh-CN", "signInToConnector")).toBe("处理连接器");
  });

  test("a call that names nothing a person uses says no more", () => {
    expect(errorDoing(wordsIn("en"), "en", "wallOfTurn")).toBeNull();
    expect(errorDoing(wordsIn("en"), "en", "backOnline")).toBeNull();
  });
});

describe("the Details of a notice", () => {
  test("say what was said, what was being done and what to do", () => {
    const notice = describeError(
      failed("renameDocument", "InvalidInputError", "A Document’s name can’t be empty."),
    );
    expect(errorDetails(wordsIn("en"), "en", notice)).toEqual([
      "A Document’s name can’t be empty.",
      "IncarnaMind was renaming Documents when this happened.",
      "Try again. If it keeps happening, restart IncarnaMind.",
    ]);
    expect(errorDetails(wordsIn("zh-CN"), "zh-CN", notice)[1]).toBe(
      "出错时，IncarnaMind 正在重命名文档。",
    );
    expect(errorDetails(wordsIn("zh-CN"), "zh-CN", notice)[2]).toBe(
      "请重试；如果仍然出错，请重启 IncarnaMind。",
    );
  });

  test("keep the whole sentence the notice cut short, in the interface language", () => {
    const long = "x".repeat(300);
    const notice = describeError(failed("renameDocument", "Error", long));
    expect(errorDetails(wordsIn("en"), "en", notice)[0]).toBe(long);
  });

  test("a failure of the system's says what to do about that", () => {
    const notice = describeError(
      failed("renameDocument", "Error", "ENOSPC: no space left on device, write"),
    );
    expect(errorDetails(wordsIn("en"), "en", notice)).toEqual([
      "The disk is full.",
      "IncarnaMind was renaming Documents when this happened.",
      "Free up some space on the disk, then try again.",
    ]);
    expect(errorDetails(wordsIn("zh-CN"), "zh-CN", notice)[2]).toBe(
      "请先腾出一些磁盘空间，然后重试。",
    );
  });

  test("a failure that never crossed the bridge says what was asked, not what failed", () => {
    const notice = describeError(new TypeError("Cannot read properties of undefined"));
    expect(errorDetails(wordsIn("en"), "en", notice)).toEqual([
      "Cannot read properties of undefined",
      "IncarnaMind was doing what you asked when this happened.",
      "Try again. If it keeps happening, restart IncarnaMind.",
    ]);
  });

  // protects=no Details line shows the name of a core call or of an error's class, for any call; fails_when=a method of the core's interface leaks into a line in either language; no_claim=none beyond protects.
  test.each(LANGUAGES)(
    "never show the name of a call or of a class, for any call, in %s",
    (language) => {
      const t = wordsIn(language);
      for (const call of coreApiMethods) {
        const notice = describeError(failed(call, "InvalidInputError", "It can’t be done."));
        const shown = errorDetails(t, language, notice).join("\n");
        expect(shown, call).not.toContain("core:");
        expect(shown, call).not.toContain(call);
        expect(shown, call).not.toMatch(/\b\w*Error\b/);
        expect(shown, call).not.toMatch(/\b[a-z]+[A-Z]\w*/);
      }
    },
  );
});

describe("the Details of changes storage refused", () => {
  const reasons: readonly SaveFailureReason[] = ["full", "io", "readOnly", "busy", "other"];

  test.each(LANGUAGES)("say what was tried and what to do for every reason, in %s", (language) => {
    for (const reason of reasons) {
      const said = translate(language, `unsaved.details.${reason}`);
      expect(said, reason).not.toMatch(/\{\w+\}/);
      expect(said, reason).not.toMatch(/\b\w*(Error|SQLITE)\w*\b/i);
    }
  });
});
