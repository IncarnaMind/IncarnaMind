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
    webPageTitles: [],
    webSearchResults: false,
    connectors: [],
    scriptOutput: false,
    transcript: false,
    otherText: false,
    ...what,
  });

  // protects=a command asked about after its Answer read text the User didn't write names each kind: Documents by name or count, web pages by host, web search's results, Connectors by name or count, a script's output, the Transcript, in English and Chinese; fails_when=a form reads wrong, or a Connector count names one instead of counting; no_claim=what the core read.
  test("what the Answer read, each kind alone", () => {
    const one = read({ documents: ["Q3 board pack.pdf"] });
    const many = read({ documents: ["Q3 board pack.pdf", "Minutes"] });
    const same = read({ documents: ["Q3 board pack.pdf", "Q3 board pack.pdf"] });
    const page = read({ webPages: ["files.example"] });
    const pages = read({ webPages: ["files.example", "news.example"] });
    const title = read({ webPageTitles: ["files.example"] });
    const titles = read({ webPageTitles: ["files.example", "news.example", "court.example"] });
    const search = read({ webSearchResults: true });
    const connector = read({ connectors: ["Gmail"] });
    const connectors = read({ connectors: ["Gmail", "飞书"] });
    const script = read({ scriptOutput: true });
    const heard = read({ transcript: true });
    expect(readTextLine(en, one, enGap)).toBe(
      "This Answer read text you didn’t write: “Q3 board pack.pdf”.",
    );
    expect(readTextLine(en, many, enGap)).toBe(
      "This Answer read text you didn’t write: 2 Documents.",
    );
    expect(readTextLine(en, same, enGap)).toBe(
      "This Answer read text you didn’t write: 2 Documents.",
    );
    expect(readTextLine(en, page, enGap)).toBe(
      "This Answer read text you didn’t write: a web page on files.example.",
    );
    expect(readTextLine(en, pages, enGap)).toBe(
      "This Answer read text you didn’t write: 2 web pages.",
    );
    expect(readTextLine(en, title, enGap)).toBe(
      "This Answer read text you didn’t write: the title of a web page on files.example.",
    );
    expect(readTextLine(en, titles, enGap)).toBe(
      "This Answer read text you didn’t write: 3 web page titles.",
    );
    expect(readTextLine(en, search, enGap)).toBe(
      "This Answer read text you didn’t write: web search results.",
    );
    expect(readTextLine(en, connector, enGap)).toBe(
      "This Answer read text you didn’t write: results from Gmail.",
    );
    expect(readTextLine(en, connectors, enGap)).toBe(
      "This Answer read text you didn’t write: results from 2 Connectors.",
    );
    expect(readTextLine(en, script, enGap)).toBe(
      "This Answer read text you didn’t write: a script’s output.",
    );
    expect(readTextLine(en, heard, enGap)).toBe(
      "This Answer read text you didn’t write: this meeting’s Transcript.",
    );
    expect(readTextLine(zh, one, zhGap)).toBe("这次回答读过不是你写的内容：“Q3 board pack.pdf”。");
    expect(readTextLine(zh, many, zhGap)).toBe("这次回答读过不是你写的内容：2 个文档。");
    expect(readTextLine(zh, same, zhGap)).toBe("这次回答读过不是你写的内容：2 个文档。");
    expect(readTextLine(zh, page, zhGap)).toBe(
      "这次回答读过不是你写的内容：files.example 上的一个网页。",
    );
    expect(readTextLine(zh, pages, zhGap)).toBe("这次回答读过不是你写的内容：2 个网页。");
    expect(readTextLine(zh, title, zhGap)).toBe(
      "这次回答读过不是你写的内容：files.example 上一个网页的标题。",
    );
    expect(readTextLine(zh, titles, zhGap)).toBe("这次回答读过不是你写的内容：3 个网页标题。");
    expect(readTextLine(zh, search, zhGap)).toBe("这次回答读过不是你写的内容：网页搜索结果。");
    expect(readTextLine(zh, connector, zhGap)).toBe(
      "这次回答读过不是你写的内容：Gmail 返回的内容。",
    );
    expect(readTextLine(zh, connectors, zhGap)).toBe(
      "这次回答读过不是你写的内容：2 个连接器返回的内容。",
    );
    expect(readTextLine(zh, script, zhGap)).toBe("这次回答读过不是你写的内容：脚本的输出。");
    expect(readTextLine(zh, heard, zhGap)).toBe("这次回答读过不是你写的内容：本次会议的转写稿。");
  });

  // protects=the kinds join as the design's worked example says, in this order: Documents, web pages, web page titles, web search results, Connectors, a script's output, the Transcript, other text; two take "and"/和, more take commas and a last "and" or 、 and a last 和; fails_when=a comma is missing or doubled, or 和 comes too early; no_claim=what the core read.
  test("kinds joined in the card's order", () => {
    const worked = read({
      documents: ["Q3 board pack.pdf", "Minutes"],
      webSearchResults: true,
      transcript: true,
    });
    expect(readTextLine(en, worked, enGap)).toBe(
      "This Answer read text you didn’t write: 2 Documents, web search results and this meeting’s Transcript.",
    );
    expect(readTextLine(zh, worked, zhGap)).toBe(
      "这次回答读过不是你写的内容：2 个文档、网页搜索结果和本次会议的转写稿。",
    );
    const all = read({
      documents: ["Q3 board pack.pdf"],
      webPages: ["files.example"],
      webSearchResults: true,
      connectors: ["Gmail"],
      scriptOutput: true,
      transcript: true,
      otherText: true,
    });
    expect(readTextLine(en, all, enGap)).toBe(
      "This Answer read text you didn’t write: “Q3 board pack.pdf”, a web page on files.example, web search results, results from Gmail, a script’s output, this meeting’s Transcript and other text.",
    );
    expect(readTextLine(zh, all, zhGap)).toBe(
      "这次回答读过不是你写的内容：“Q3 board pack.pdf”、files.example 上的一个网页、网页搜索结果、Gmail 返回的内容、脚本的输出、本次会议的转写稿和其他内容。",
    );
    const titled = read({
      documents: ["Budget"],
      webPages: ["files.example", "news.example"],
      webPageTitles: ["a.example", "b.example", "c.example"],
      connectors: ["Tides"],
    });
    expect(readTextLine(en, titled, enGap)).toBe(
      "This Answer read text you didn’t write: “Budget”, 2 web pages, 3 web page titles and results from Tides.",
    );
    expect(readTextLine(zh, titled, zhGap)).toBe(
      "这次回答读过不是你写的内容：“Budget”、2 个网页、3 个网页标题和 Tides 返回的内容。",
    );
  });

  // protects=the three branches of other text: named kinds only never say it; named kinds with unclassified text say it last; unclassified text alone is the bare sentence, with no colon and no list; fails_when=the card claims a read nobody made, or hides an unclassified one; no_claim=what the core read.
  test("other text: absent when all named, last when beside kinds, the bare stem alone", () => {
    const named = read({ documents: ["Q3 board pack.pdf"], transcript: true });
    expect(readTextLine(en, named, enGap)).not.toContain("other text");
    expect(readTextLine(zh, named, zhGap)).not.toContain("其他内容");
    const beside = read({ documents: ["Q3 board pack.pdf", "Minutes"], otherText: true });
    expect(readTextLine(en, beside, enGap)).toBe(
      "This Answer read text you didn’t write: 2 Documents and other text.",
    );
    expect(readTextLine(zh, beside, zhGap)).toBe(
      "这次回答读过不是你写的内容：2 个文档和其他内容。",
    );
    const only = read({ otherText: true });
    expect(readTextLine(en, only, enGap)).toBe("This Answer read text you didn’t write.");
    expect(readTextLine(zh, only, zhGap)).toBe("这次回答读过不是你写的内容。");
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
    const titled = read({ webPageTitles: ["q3-board-pack.pdf.example"] });
    expect(readTextLine(en, titled, enGap)).toBe(
      "This Answer read text you didn’t write: the title of a web page on q3-board-pack.pdf.example.",
    );
    expect(readTextLine(zh, titled, zhGap)).toBe(
      "这次回答读过不是你写的内容：q3-board-pack.pdf.example 上一个网页的标题。",
    );
  });

  // protects=nothing read says no line at all, so the card shows its general line instead; fails_when=the card hides that line behind an empty one; no_claim=which kinds the list can name.
  test("nothing read: no line, in either language", () => {
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

  // protects=a Check that stopped, found nothing, was not allowed, or could not run says so as its whole line; fails_when=it reads "Didn't run:" before a sentence; no_claim=the Check.
  test("a Check that stopped, found nothing, or was not allowed says so plainly", () => {
    const ended = (wording: { key: string; values: Record<string, string> }) =>
      ({
        id: "call",
        tool: "run_command",
        source: "commands",
        input: {},
        status: "failed",
        commandProblem: { command: "mind.check", message: "", wording },
      }) as unknown as Parameters<typeof commandCallText>[1];
    expect(commandCallText(en, ended({ key: "run.stopped.cancelled", values: {} }))).toBe(
      "Stopped",
    );
    expect(commandCallText(zh, ended({ key: "run.stopped.cancelled", values: {} }))).toBe("已停止");
    expect(commandCallText(en, ended({ key: "mindCheck.nothingToCheck", values: {} }))).toBe(
      "Nothing to check",
    );
    expect(commandCallText(zh, ended({ key: "mindCheck.nothingToCheck", values: {} }))).toBe(
      "没有需要核对的内容",
    );
    expect(commandCallText(en, ended({ key: "commands.denied", values: {} }))).toBe(
      "Not allowed, so nothing changed",
    );
    expect(commandCallText(zh, ended({ key: "commands.denied", values: {} }))).toBe(
      "未允许，没有改动",
    );
    expect(commandCallText(en, ended({ key: "checks.problem.no-claims", values: {} }))).toBe(
      "This note has no claims to check.",
    );
    expect(commandCallText(zh, ended({ key: "checks.problem.local-mode", values: {} }))).toBe(
      "未核对：已开启“所有内容都留在这台电脑上”。",
    );
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
