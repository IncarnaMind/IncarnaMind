import { describe, expect, test } from "vitest";
import type { ApprovalReadText, CommandDone } from "../../src/core/api";
import {
  commandCallText,
  doneText,
  readTextLine,
  runText,
  undoable,
  YOURS_WORDS,
} from "../../src/renderer/src/commandFacts";
import { commands } from "../../src/renderer/src/commands/registry";
import { gap, type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

/*
 * The words of what the assistant's commands did (#1110, #1421), on their card and the undo line,
 * from what the calls returned, in English and Chinese.
 */

const en = (key: MessageKey, params?: MessageParams) => translate("en", key, params);
const zh = (key: MessageKey, params?: MessageParams) => translate("zh-CN", key, params);
const enGap = (before: string, after: string) => gap("en", before, after);
const zhGap = (before: string, after: string) => gap("zh-CN", before, after);

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

  // protects="Checked by me" and "Mark as mine" are the User's own word, said as decided, in both languages, with no button since each is done on the thing itself; fails_when=the words drift from the menu's, or a button opens a page; no_claim=the line's layout.
  test("Checked by me and Mark as mine say where the User does them, with no button", () => {
    const signOff = done({ command: "citation.signOff", yours: "signOff" });
    const mine = done({ command: "edit.markAsMine", yours: "authorship" });
    expect(doneText(en, signOff)).toBe(
      "“Checked by me” is yours to give, not mine. It’s on each Citation’s card.",
    );
    expect(doneText(zh, signOff)).toBe("“我已核对”只能由你来标，我不能标。在每个引用的卡片上。");
    expect(doneText(en, mine)).toBe(
      "Only you can mark text as yours. Select it and choose “Mark as mine”.",
    );
    expect(doneText(zh, mine)).toBe("只有你能把文字标为你写的。选中文字后选择“标为我写的”。");
    expect(doneText(en, mine)).toContain(`“${en("editor.ai.markAsMine")}”`);
    expect(doneText(zh, mine)).toContain(`“${zh("editor.ai.markAsMine")}”`);
    expect(doneText(en, signOff)).toContain(`“${en("signOff.action")}”`);
    expect(doneText(zh, signOff)).toContain(`“${zh("signOff.action")}”`);
    expect(YOURS_WORDS.signOff.open).toBeNull();
    expect(YOURS_WORDS.authorship.open).toBeNull();
  });

  // protects=a window command the window never answered says so as a whole line, naming the command as the interface does; fails_when=it reads as "Didn't run:" with the raw id; no_claim=when the window is gone.
  test("a window command not answered says it wasn't done, by its name", () => {
    const remove = commands.register({
      id: "test.unanswered",
      label: "mind.open",
      group: "main",
      reversible: true,
      run: () => undefined,
    });
    const call = {
      id: "call",
      tool: "run_command",
      source: "commands",
      input: { command: "test.unanswered" },
      status: "failed",
      commandProblem: {
        command: "test.unanswered",
        message: "The window didn't answer in time, so test.unanswered wasn't done.",
        wording: { key: "commands.window.unanswered", values: { command: "test.unanswered" } },
      },
    } as unknown as Parameters<typeof commandCallText>[1];
    try {
      expect(commandCallText(en, call)).toBe(
        `The window didn’t answer: “${en("mind.open")}” wasn’t done.`,
      );
      expect(commandCallText(zh, call)).toBe(`窗口没有回应：“${zh("mind.open")}”没有完成。`);
    } finally {
      remove();
    }
  });

  const read = (what: Partial<ApprovalReadText>): ApprovalReadText => ({
    documents: [],
    webPages: [],
    connectors: [],
    transcript: false,
    ...what,
  });

  // protects=a command asked about after its Answer read text the User didn't write names what it read: one Document by name, more by their number, a web page by its host, a Connector by its name, this meeting's Transcript, in English and Chinese; fails_when=a form reads wrong, or names a source; no_claim=what the core read.
  test("what the Answer read, each kind", () => {
    const one = read({ documents: ["Q3 board pack.pdf"] });
    const many = read({ documents: ["Q3 board pack.pdf", "Minutes"] });
    const page = read({ webPages: ["files.example"] });
    const pages = read({ webPages: ["files.example", "news.example"] });
    const connector = read({ connectors: ["Gmail"] });
    const heard = read({ transcript: true });
    expect(readTextLine(en, one, enGap)).toBe(
      "This Answer read text you didn’t write: “Q3 board pack.pdf”.",
    );
    expect(readTextLine(en, many, enGap)).toBe(
      "This Answer read text you didn’t write: 2 Documents.",
    );
    expect(readTextLine(en, page, enGap)).toBe(
      "This Answer read text you didn’t write: a web page on files.example.",
    );
    expect(readTextLine(en, pages, enGap)).toBe(
      "This Answer read text you didn’t write: 2 web pages.",
    );
    expect(readTextLine(en, connector, enGap)).toBe(
      "This Answer read text you didn’t write: results from Gmail.",
    );
    expect(readTextLine(en, heard, enGap)).toBe(
      "This Answer read text you didn’t write: this meeting’s Transcript.",
    );
    expect(readTextLine(zh, one, zhGap)).toBe("这次回答读过不是你写的内容：“Q3 board pack.pdf”。");
    expect(readTextLine(zh, many, zhGap)).toBe("这次回答读过不是你写的内容：2 个文档。");
    expect(readTextLine(zh, page, zhGap)).toBe(
      "这次回答读过不是你写的内容：files.example 上的一个网页。",
    );
    expect(readTextLine(zh, pages, zhGap)).toBe("这次回答读过不是你写的内容：2 个网页。");
    expect(readTextLine(zh, connector, zhGap)).toBe(
      "这次回答读过不是你写的内容：Gmail 返回的内容。",
    );
    expect(readTextLine(zh, heard, zhGap)).toBe("这次回答读过不是你写的内容：本次会议的转写稿。");
  });

  // protects=the kinds join as the design's worked example says: two take "and"/和, three or more take commas and a last "and", or 、 and a last 和, in the order Documents, web pages, Connectors, Transcript; fails_when=a comma is missing or doubled, or 和 comes too early; no_claim=what the core read.
  test("two, three and four kinds join as the card says", () => {
    const two = read({ documents: ["Q3 board pack.pdf"], webPages: ["files.example"] });
    const three = read({
      documents: ["Q3 board pack.pdf"],
      webPages: ["files.example", "news.example"],
      transcript: true,
    });
    const four = read({
      documents: ["Q3 board pack.pdf"],
      webPages: ["files.example", "news.example"],
      connectors: ["Gmail"],
      transcript: true,
    });
    expect(readTextLine(en, two, enGap)).toBe(
      "This Answer read text you didn’t write: “Q3 board pack.pdf” and a web page on files.example.",
    );
    expect(readTextLine(en, three, enGap)).toBe(
      "This Answer read text you didn’t write: “Q3 board pack.pdf”, 2 web pages and this meeting’s Transcript.",
    );
    expect(readTextLine(en, four, enGap)).toBe(
      "This Answer read text you didn’t write: “Q3 board pack.pdf”, 2 web pages, results from Gmail and this meeting’s Transcript.",
    );
    expect(readTextLine(zh, two, zhGap)).toBe(
      "这次回答读过不是你写的内容：“Q3 board pack.pdf”和 files.example 上的一个网页。",
    );
    expect(readTextLine(zh, three, zhGap)).toBe(
      "这次回答读过不是你写的内容：“Q3 board pack.pdf”、2 个网页和本次会议的转写稿。",
    );
    expect(readTextLine(zh, four, zhGap)).toBe(
      "这次回答读过不是你写的内容：“Q3 board pack.pdf”、2 个网页、Gmail 返回的内容和本次会议的转写稿。",
    );
  });

  // protects=a web page is named by its host even when the host itself looks like a file, and the title it wrote is never on the card; fails_when=the line shows a title that could pass for the User's file; no_claim=the page's words.
  test("a web page shows its host, never a title", () => {
    const imitating = read({ webPages: ["q3-board-pack.pdf.example"] });
    expect(readTextLine(en, imitating, enGap)).toBe(
      "This Answer read text you didn’t write: a web page on q3-board-pack.pdf.example.",
    );
    expect(readTextLine(zh, imitating, zhGap)).toBe(
      "这次回答读过不是你写的内容：q3-board-pack.pdf.example 上的一个网页。",
    );
  });

  // protects=what the list can't name says no line at all, so the card shows its general line instead; fails_when=the card hides that line behind an empty one; no_claim=which kinds the list can name.
  test("nothing the list can name: no line, in either language", () => {
    const nothing = read({});
    expect(readTextLine(en, nothing, enGap)).toBeNull();
    expect(readTextLine(zh, nothing, zhGap)).toBeNull();
  });

  // protects=a window command that didn't finish before a quit, or that found a Check already running, says so as its whole line; fails_when=it reads "Didn't run:" with a raw id; no_claim=when it happens.
  test("didn't finish, and already checking, each say so as the whole line", () => {
    const failed = (wording: { key: string; values: Record<string, string> }) =>
      ({
        id: "call",
        tool: "run_command",
        source: "commands",
        input: {},
        status: "failed",
        commandProblem: { command: "mind.check", message: "", wording },
      }) as unknown as Parameters<typeof commandCallText>[1];
    const unfinished = failed({
      key: "commands.window.unfinished",
      values: { command: "test.unanswered" },
    });
    const checking = failed({
      key: "commands.window.alreadyChecking",
      values: { name: "Deal notes" },
    });
    expect(commandCallText(en, checking)).toBe("Already checking “Deal notes”");
    expect(commandCallText(zh, checking)).toBe("正在核对“Deal notes”");
    expect(commandCallText(en, unfinished)).toMatch(
      /^Didn’t finish: IncarnaMind closed while “.+” was going on$/,
    );
    expect(commandCallText(zh, unfinished)).toMatch(/^未完成：“.+”进行时 IncarnaMind 已关闭$/);
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
