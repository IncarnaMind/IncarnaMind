/**
 * The words of the lasting answer on the card for a question of the User's own AI (#3653): one
 * thing it grants is the button's words; several are a short button and every one of them, whole,
 * under it.
 */
import { describe, expect, test } from "vitest";
import type { NoteSuggested } from "../../src/core/api";
import type { Language } from "../../src/core/language";
import { lastingWords } from "../../src/renderer/src/components/noteAsk/ownAskWords";
import { translate } from "../../src/shared/i18n";

const said = (language: Language, suggested: NoteSuggested[]) =>
  lastingWords((key, params) => translate(language, key, params), language, suggested);

const COMMANDS: NoteSuggested = {
  kind: "rules",
  kept: "conversation",
  rules: [{ kind: "commands", start: "python3 late_crossings.py" }],
};
const EDITS: NoteSuggested = { kind: "mode", kept: "request", mode: "acceptEdits" };
const FOLDER: NoteSuggested = { kind: "folders", kept: "request", folders: [""] };

describe("the lasting answer's words", () => {
  // protects=one grant is the button's own words, whole, with nothing under it; fails_when=a single "Allow all edits" gets a second line, or its words are cut
  test.each([
    ["en", "Allow all edits for this request"],
    ["zh-CN", "本次请求内允许所有修改"],
  ] as const)("one grant, %s", (language, label) => {
    expect(said(language, [EDITS])).toEqual({ label, grants: null });
  });

  // protects=two or three grants make a short button saying the widest place they are kept, and every grant, whole and in Claude Code's order, in the line under it; fails_when=a grant is dropped, cut, or only in a tooltip, or the button claims a narrower place than one of its grants
  test.each([
    [
      "en",
      [EDITS, COMMANDS],
      "Don’t ask again in this conversation",
      "Don’t ask again for python3 late_crossings.py commands in this conversation; allow all edits for this request",
    ],
    [
      "en",
      [FOLDER, EDITS, COMMANDS],
      "Don’t ask again in this conversation",
      "Don’t ask again for python3 late_crossings.py commands in this conversation; allow all edits for this request; allow access to this conversation’s folder for this request",
    ],
    [
      "en",
      [EDITS, FOLDER],
      "Don’t ask again for this request",
      "Allow all edits for this request; allow access to this conversation’s folder for this request",
    ],
    [
      "en",
      [EDITS, { ...COMMANDS, kept: "everywhere" }],
      "Don’t ask again anywhere",
      "Don’t ask again for python3 late_crossings.py commands anywhere; allow all edits for this request",
    ],
    [
      "zh-CN",
      [FOLDER, EDITS, COMMANDS],
      "本对话内不再询问",
      "本对话内不再询问：python3 late_crossings.py 命令；本次请求内允许所有修改；本次请求内允许访问：这个对话的文件夹",
    ],
  ] as const)("several grants, %s", (language, suggested, label, grants) => {
    expect(said(language, [...suggested])).toEqual({ label, grants });
  });
});
