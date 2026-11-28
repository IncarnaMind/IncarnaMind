/**
 * An AI's change to a Note is written at once (#3839): no first-run line says a Note's change waits
 * for the User, and nothing in either language still offers to review one.
 */
import { describe, expect, test } from "vitest";
import { en } from "../../src/shared/i18n/en";
import { zhCN } from "../../src/shared/i18n/zh-CN";

const LANGUAGES = [
  ["English", en],
  ["Chinese", zhCN],
] as const;

const FIRST_RUN_KEYS = [
  "agents.propose.hint",
  "agents.propose.label",
  "agents.propose.label.all",
  "setupPage.ai.consent.one",
  "setupPage.ai.consent.one.write",
  "setupPage.ai.consent.many",
  "setupPage.ai.consent.many.write",
] as const;

// A Note's change that waits: "its changes to your notes wait for you", "你笔记的修改等你处理".
const NOTE_CHANGE_WAITS =
  /notes?\b[^.]*\bwait|wait[^.]*\bnotes?\b|笔记[^。；]*等你|等你[^。；]*笔记/i;

describe("the first-run text on what the User's AI writes", () => {
  test.each(LANGUAGES)("says no change to a Note waits for the User (%s)", (_name, strings) => {
    for (const key of FIRST_RUN_KEYS) {
      expect(strings[key], key).not.toMatch(NOTE_CHANGE_WAITS);
    }
  });
});

describe("the Review changes control on a Note", () => {
  test.each(LANGUAGES)("has no string left in the interface (%s)", (_name, strings) => {
    const named = Object.entries(strings).filter(
      ([key, value]) =>
        key !== "review.title" && /review changes|restore original|查看改动|恢复原文/i.test(value),
    );
    expect(named).toEqual([]);
    for (const key of [
      "edit.applied.review",
      "edit.review.undoAll",
      "edit.review.done",
      "edit.review.restore",
      "edit.review.restore.count",
      "edit.review.restored.one",
      "command.edit.reviewDone",
    ]) {
      expect(Object.keys(strings), key).not.toContain(key);
    }
  });
});
