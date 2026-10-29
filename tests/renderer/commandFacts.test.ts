import { describe, expect, test } from "vitest";
import type { CommandDone } from "../../src/core/api";
import { doneText, runText, undoable } from "../../src/renderer/src/commandFacts";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

/*
 * The words of what the assistant's commands did (#1110, #1421), on their card and the undo line,
 * from what the calls returned, in English and Chinese.
 */

const en = (key: MessageKey, params?: MessageParams) => translate("en", key, params);
const zh = (key: MessageKey, params?: MessageParams) => translate("zh-CN", key, params);

const leases = { kind: "folder" as const, id: "f1", name: "Leases" };
const documents = [
  { kind: "document" as const, id: "d1", name: "Lease Harbour Street" },
  { kind: "document" as const, id: "d2", name: "Lease Mill Lane" },
];
const done = (more: Partial<CommandDone> & Pick<CommandDone, "command">): CommandDone => ({
  run: "run",
  items: [],
  ...more,
});

describe("What the assistant's commands did, in words (#1421)", () => {
  // protects=a Folder made, then the leases moved into it, reads as one request, as a move that makes its Folder does; fails_when=it reads as two steps; no_claim=the card's layout.
  test("a new Folder and a move into it read as one line", () => {
    const run = [
      done({ command: "folder.new", items: [leases], into: { ...leases, made: true } }),
      done({ command: "document.moveTo", items: documents, into: { ...leases, made: false } }),
    ];
    expect(runText(en, run)).toBe("Made “Leases” and moved 2 Documents into it");
    expect(runText(zh, run)).toBe("已新建“Leases”，并把 2 个文档移了进去");
    expect(undoable(run)).toBe(true);
  });

  // protects=a command that only showed something says so in one line, and offers no Undo; fails_when=it offers Undo or names nothing; no_claim=other commands' words.
  test("one that opened beside says which, and has nothing to undo", () => {
    const opened = done({
      command: "document.openBeside",
      items: [{ kind: "document", id: "d2", name: "Lease Mill Lane" }],
      window: { changed: false },
    });
    expect(doneText(en, opened)).toBe("Opened “Lease Mill Lane” beside this one");
    expect(doneText(zh, opened)).toBe("已在旁边打开“Lease Mill Lane”");
    expect(undoable([opened])).toBe(false);
  });

  // protects=what only the User changes reads as theirs, with where it is, in both languages; fails_when=it says something changed; no_claim=the button, which the card holds.
  test("what is the User's alone says where they change it", () => {
    const privacy = done({ command: "settings.change", yours: "privacy" });
    expect(doneText(en, privacy)).toContain("Settings › Privacy");
    expect(doneText(zh, privacy)).toContain("“设置 › 隐私”");
    expect(undoable([privacy])).toBe(false);
  });

  // protects=what came back from Recently deleted says so, in both languages, and Undo can take it back; fails_when=it reads as a delete or offers no Undo; no_claim=which items.
  test("what came back from Recently deleted says so", () => {
    const restored = done({
      command: "deleted.restore",
      items: [{ kind: "deleted", id: "d3", name: "Q3 memo" }],
    });
    expect(runText(en, [restored])).toBe("Restored 1 item from Recently deleted");
    expect(runText(zh, [restored])).toBe("已从回收站恢复 1 项");
    expect(undoable([restored])).toBe(true);
    expect(doneText(zh, done({ command: "deleted.deletePermanently", yours: "permanent" }))).toBe(
      "彻底删除只能由你来做，我不能做。在“回收站”里。",
    );
  });

  // protects=a setting changed names the setting and its value as Settings shows them; fails_when=it shows the raw names; no_claim=every setting.
  test("a setting changed names it as Settings does", () => {
    const motion = done({
      command: "settings.change",
      setting: { name: "motion", from: "system", to: "reduced" },
    });
    expect(doneText(en, motion)).toBe("Changed “Motion” to “Reduced”");
    expect(undoable([motion])).toBe(true);
  });
});
