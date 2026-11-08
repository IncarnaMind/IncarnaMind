import { describe, expect, test } from "vitest";
import { InvalidInputError, NotFoundError, TranslatableError } from "../../src/core/errors";
import type { Language } from "../../src/core/language";
import { describeError, errorMessage, providerErrorText } from "../../src/renderer/src/errors";
import { errorForWindow } from "../../src/shared/errorWording";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

/*
 * What a failed call to the core says (#157). Electron rejects it with the error written out,
 * "Error invoking remote method 'core:x': InvalidInputError: …"; no line the User reads shows that
 * wrapping or a stack, and "Details" says it in plain words (`errorDetails`) while the technical
 * text goes to the log.
 */

const ipc = (method: string, name: string, message: string) =>
  new Error(`Error invoking remote method '${method}': ${name}: ${message}`);

const words = (language: Language) => (key: MessageKey, params?: MessageParams) =>
  translate(language, key, params);
const english = words("en");

describe("an error from the core", () => {
  test("says the core's own sentence, without Electron's wrapping or the class's name", () => {
    const failure = ipc(
      "core:renameDocument",
      "InvalidInputError",
      "A Document’s name can’t be empty.",
    );
    expect(errorMessage(failure, english)).toBe("A Document’s name can’t be empty.");
    expect(describeError(failure).reason).toBeNull();
  });

  test("keeps the call for the Details' words, and the call and the class for the log, not the wrapping", () => {
    const { call, log } = describeError(
      ipc("core:renameDocument", "InvalidInputError", "A Document’s name can’t be empty."),
    );
    expect(call).toBe("renameDocument");
    expect(log).toBe("core:renameDocument\nInvalidInputError: A Document’s name can’t be empty.");
    expect(log).not.toContain("Error invoking remote method");
  });

  test("a failure that never crossed the bridge has no call", () => {
    expect(describeError(new TypeError("Cannot read properties of undefined")).call).toBeNull();
  });

  test("a programming failure of this window's is marked for the plain words, its stack for the log", () => {
    const failure = new TypeError("core.startOrganize is not a function");
    const { programError, stale, message, log } = describeError(failure);
    expect(programError).toBe(true);
    expect(stale).toBe(true);
    expect(message).toBe("core.startOrganize is not a function");
    expect(log).toContain("core.startOrganize is not a function");
    expect(log).toMatch(/\n\s+at /);
  });

  test("a TypeError with no missing method asks a plain try again, not a restart", () => {
    const { programError, stale } = describeError(new TypeError("Cannot read properties of null"));
    expect(programError).toBe(true);
    expect(stale).toBe(false);
  });

  test("a plain error of this window's, and one the core worded, stay as they are", () => {
    expect(describeError(new Error("The picture wasn’t drawn.")).programError).toBe(false);
    const worded = new TranslatableError({ key: "mindCheck.nothingToCheck" });
    expect(describeError(worded).programError).toBe(false);
    expect(describeError(ipc("core:x", "TypeError", "It can’t be done.")).programError).toBe(false);
  });

  test("keeps the cause of a wrapped failure for the log, not the line", () => {
    const failure = new Error("The area couldn’t be captured. Try it again.", {
      cause: new Error("The area came out empty."),
    });
    expect(errorMessage(failure, english)).toBe("The area couldn’t be captured. Try it again.");
    const { log } = describeError(failure);
    expect(log).toContain("Caused by: The area came out empty.");
  });

  test("is as readable in Chinese", () => {
    const failure = ipc("core:moveToFolder", "NotFoundError", "这个文件夹已被删除。");
    expect(errorMessage(failure, english)).toBe("这个文件夹已被删除。");
  });

  test("never shows a stack, even one written into the message", () => {
    const failure = ipc(
      "core:addDocuments",
      "Error",
      "Couldn’t read it.\n    at read (/app/core.js:10:5)\n    at async run (/app/core.js:20:3)",
    );
    const { message, log } = describeError(failure);
    expect(message).toBe("Couldn’t read it.");
    expect(log).not.toMatch(/\n\s+at /);
  });

  test("keeps a message that runs over several lines", () => {
    const failure = ipc("core:x", "InvalidInputError", "First line.\nSecond line.");
    expect(errorMessage(failure, english)).toBe("First line.\nSecond line.");
  });
});

/*
 * An error the core gave a wording (#627) crosses as the main process throws it to the window:
 * Electron writes the error out with `toString()`, which is all the window receives.
 */
const crossed = (method: string, error: Error) =>
  new Error(`Error invoking remote method '${method}': ${String(errorForWindow(error))}`);

const TOO_LONG = "A Document’s name can’t be longer than 500 characters.";
const tooLong = () =>
  new InvalidInputError({ key: "error.document.nameTooLong", values: { max: 500 } });

describe("an error the core gave a wording", () => {
  test("says it in the interface language, and keeps the English sentence for the log", () => {
    const failure = crossed("core:renameDocument", tooLong());
    expect(errorMessage(failure, words("zh-CN"))).toBe("文档名称不能超过 500 个字符。");
    expect(errorMessage(failure, english)).toBe(TOO_LONG);
    const { message, wording, log } = describeError(failure);
    expect(message).toBe(TOO_LONG);
    expect(wording).toEqual({ key: "error.document.nameTooLong", values: { max: 500 } });
    expect(log).toBe(`core:renameDocument\nInvalidInputError: ${TOO_LONG}`);
  });

  test("leaves the log its class, its English sentence on the first line, and its stack", () => {
    const error = tooLong();
    const thrown = errorForWindow(error);
    if (!(thrown instanceof Error)) throw new Error("No error was thrown.");
    expect(thrown.name).toBe("InvalidInputError");
    expect(thrown.message.split("\n")[0]).toBe(TOO_LONG);
    expect(thrown.stack).toBe(error.stack);
  });

  test("falls back to the sentence when this window's dictionary doesn't know its key", () => {
    const text = crossed("core:renameDocument", tooLong()).message;
    const unknown = new Error(text.replace("error.document.nameTooLong", "error.document.newer"));
    expect(errorMessage(unknown, words("zh-CN"))).toBe(TOO_LONG);
    expect(describeError(unknown).wording).toBeNull();
    const broken = new Error(text.replace('{"key"', "{key"));
    expect(errorMessage(broken, words("zh-CN"))).toBe(TOO_LONG);
    expect(describeError(broken).log).toBe(`core:renameDocument\nInvalidInputError: ${TOO_LONG}`);
  });

  test("an error with no wording crosses as it is, in its own words", () => {
    const error = new NotFoundError("It was deleted.");
    expect(errorForWindow(error)).toBe(error);
    expect(errorMessage(crossed("core:x", error), words("zh-CN"))).toBe("It was deleted.");
  });
});

describe("an error that did not cross the bridge", () => {
  test("says its wording in the interface language when this window threw it", () => {
    const thrown = new TranslatableError({ key: "mindCheck.nothingToCheck" });
    expect(errorMessage(thrown, words("zh-CN"))).toBe("没有需要核对的内容");
    expect(errorMessage(thrown, english)).toBe("Nothing to check");
    expect(describeError(thrown).message).toBe("Nothing to check");
  });

  test("loses its class's name in its message, and keeps it, with its stack, for the log", () => {
    const { message, log } = describeError(new TypeError("Cannot read properties of undefined"));
    expect(message).toBe("Cannot read properties of undefined");
    expect(log.split("\n")[0]).toBe("TypeError: Cannot read properties of undefined");
    expect(log).toMatch(/\n\s+at /);
  });

  test("is made of what it is given when it isn't an Error", () => {
    expect(errorMessage("The disk went away", english)).toBe("The disk went away");
    expect(describeError(42).message).toBe("42");
  });

  test("reads a class's name from its text, as Electron writes it", () => {
    expect(describeError(new Error("NotFoundError: It was deleted.")).message).toBe(
      "It was deleted.",
    );
  });
});

describe("a failure of the system's", () => {
  test.each([
    ["EACCES: permission denied, rename '/a/b.pdf' -> '/a/c.pdf'", "error.system.notAllowed"],
    ["EROFS: read-only file system, open '/a/b.pdf'", "error.system.notAllowed"],
    ["ENOSPC: no space left on device, write", "error.system.full"],
    ["ENOENT: no such file or directory, open '/a/b.pdf'", "error.system.gone"],
    ["ENAMETOOLONG: name too long, rename '/a/b.pdf' -> '/a/c'", "error.system.nameTooLong"],
    ["EEXIST: file already exists, mkdir '/a/b'", "error.system.exists"],
    ["database or disk is full", "error.system.full"],
    ["disk I/O error", "error.system.diskError"],
    ["attempt to write a readonly database", "error.system.notAllowed"],
    ["database is locked", "error.system.busy"],
  ])("%s gets plain words", (text, reason) => {
    const description = describeError(ipc("core:renameDocument", "Error", text));
    expect(description.reason).toBe(reason);
    // The system's own text, with the path in it, stays for the log.
    expect(description.log).toContain(text);
  });

  test("a sentence of the core's that names no code keeps its own words", () => {
    expect(describeError(new Error("Choose the folder that holds them now.")).reason).toBeNull();
  });
});

describe("a provider's error", () => {
  test("says its wording in the interface language, and its message when the core gave none", () => {
    const worded = {
      kind: "unknown",
      message: "Cloud tagging paused: “Keep everything on this computer” is on.",
      wording: { key: "error.tagging.cloudPaused" },
    } as const;
    expect(providerErrorText(worded, words("zh-CN"))).toBe(
      "云端打标签已暂停：已开启“所有内容都留在这台电脑上”。",
    );
    expect(providerErrorText(worded, english)).toBe(worded.message);
    const plain = { kind: "rate-limit", message: "Too many requests" } as const;
    expect(providerErrorText(plain, words("zh-CN"))).toBe("Too many requests");
  });
});
