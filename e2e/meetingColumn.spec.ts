import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge, Meeting } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import {
  acceptPlainTextKeys,
  boxBottom,
  boxesOverlap,
  boxOf,
  boxRight,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  openMeetingSheet,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

test.skip(!SHOW_AGENT_CONNECTION, "Your AI is hidden while SHOW_AGENT_CONNECTION is false.");
test.skip(process.platform === "win32", "The stand-in for Claude Code starts from a shell script.");

/*
 * A recorded meeting's Note with its conversation in the window's column (#3762): the meeting's
 * control stays at the Note's foot, centred on its text, and the sheet it raises rises over the
 * Note alone; a Citation pressed in a reply, in the column or opened upward at 900 wide, raises the
 * sheet at the line cited, washed as a found quote, with the reply still in view. A Node script
 * stands in for `claude`, answering from the meeting's Transcript with Citations, and reaching
 * IncarnaMind only through the settings it was given.
 */

let dataDir: string;
let home: string;
let bin: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await realpath(await createDataFolder());
  bin = await realpath(await createDataFolder());
  await writeFile(
    join(bin, "claude"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(__dirname, "audit", "meetingClaudeCode.mjs")}" "$@"\n`,
  );
  await chmod(join(bin, "claude"), 0o755);
});
test.afterEach(async () => {
  for (const folder of [dataDir, home, bin]) await removeDataFolder(folder);
});

/** What each side of the call says, the line the stand-in cites first among the other side's. */
const WORDS = {
  en: {
    mine: [
      "When do the ramp works start?",
      "Is that the contractor's date?",
      "What does the dredging add?",
      "Can the early ferry keep running?",
      "Who confirms the tide tables?",
      "Will the contractor work at weekends?",
      "Who tells the ferry passengers?",
      "Should we put a sign on the quay as well?",
      "How many spaces do we lose?",
      "Anything else before we close?",
      "Thanks, everyone.",
      "Bye for now.",
    ],
    theirs: [
      "The ramp works start on the third of March and close the slipway for six weeks.",
      "The 07:40 crossing moves to 07:55 while the works last.",
      "We checked the tide tables last week.",
      "The dredging adds about two hundred thousand pounds.",
      "That was the figure in the tender.",
      "The harbour master confirms the tide tables by Friday.",
      "The café owner asked for two weeks' notice.",
      "Weekend work costs more.",
      "The ferry company will put it on the timetable.",
      "A sign on the quay would help.",
      "We lose twenty spaces.",
      "Nothing more from us.",
    ],
    question: "When do the ramp works start?",
    cited: "third of March",
    reply: "The ramp works start on 3 March.",
  },
  "zh-CN": {
    mine: [
      "坡道工程什么时候开工？",
      "这是承包商定的日期吗？",
      "疏浚要增加多少费用？",
      "早班渡轮还能开吗？",
      "潮汐表由谁确认？",
      "承包商周末施工吗？",
      "谁来通知渡轮乘客？",
      "码头上也立个牌子吧？",
      "会少多少个车位？",
      "散会前还有别的事吗？",
      "谢谢大家。",
      "先这样。",
    ],
    theirs: [
      "坡道工程三月三日开工，滑道关闭六周。",
      "施工期间，七点四十的班次改到七点五十五。",
      "上周我们核对过潮汐表。",
      "疏浚大约增加二十万英镑。",
      "这是招标里的数字。",
      "港务长周五前确认潮汐表。",
      "咖啡馆老板希望提前两周通知。",
      "周末施工费用更高。",
      "渡轮公司会写进时刻表。",
      "码头上立个牌子会有帮助。",
      "会少二十个车位。",
      "我们这边没有别的了。",
    ],
    question: "坡道工程什么时候开工？",
    cited: "三月三日",
    reply: "坡道工程3月3日开工。",
  },
} as const;

type Language = keyof typeof WORDS;

async function shot(window: Page, name: string) {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  await window.screenshot({ path: join(folder, `${name}.png`), animations: "disabled" });
}

const meetingsOf = (window: Page): Promise<Meeting[]> =>
  window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listMeetings(),
  );

/**
 * The app at 1,440 wide with the stand-in as the User's own AI, recording a meeting filed in the
 * folder it may read, asked about the call once its Transcript has the line it cites, and the
 * conversation moved to the window's column.
 */
async function askedIntoColumn(language: Language) {
  const words = WORDS[language];
  const launch = await launchApp(dataDir, {
    home,
    ownAi: join(bin, "claude"),
    extraEnv: { INCARNAMIND_TEST_OWN_AI_MODE_FILE: join(bin, "mode") },
    transcriber: { lines: words.mine, theirLines: words.theirs },
  });
  const { app, window } = launch;
  await acceptPlainTextKeys(window);
  await dismissChatSetup(window);
  await setLanguage(window, language);
  await setWindowSize(app, window, 1440, 900);
  const folderId = await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const folder = await bridge.createLibraryGroup({ name: "Kestrel Bay", description: "" });
    await bridge.setAgentsEnabled(true);
    await bridge.connectAgent({
      name: "Claude Code",
      client: "claude-code",
      folderIds: [folder.id],
      propose: true,
    });
    return folder.id;
  });
  const control = await recordMeeting(window);
  await window.evaluate(async (folder) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const recording = (await bridge.listMeetings()).find((each) => each.status === "recording");
    if (!recording) throw new Error("No meeting is recording.");
    await bridge.moveToFolder({ mindIds: [recording.mindId], folderId: folder });
  }, folderId);
  const input = window.getByTestId("note-ask-input");
  await expect(input).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(async () => (await meetingsOf(window))[0]?.transcript?.lines ?? 0, { timeout: 60_000 })
    .toBeGreaterThanOrEqual(5);
  const documentId = (await meetingsOf(window))[0]?.transcript?.documentId;
  if (!documentId) throw new Error("The Transcript has no Document yet.");
  await writeFile(join(bin, "mode.doc"), documentId);
  await writeFile(join(bin, "mode"), "ask");

  await pointAndClick(window, input);
  await window.keyboard.insertText(words.question);
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("note-ask-pill-open")).toContainText(words.reply, {
    timeout: 60_000,
  });
  await pointAndClick(window, window.getByTestId("note-ask-handle-toggle"));
  const panel = window.getByTestId("note-ask-panel");
  await expect(panel).toBeVisible();
  await pointAndClick(window, panel.getByTestId("conversation-move-left"));
  const column = window.getByTestId("note-column");
  await expect(column).toBeVisible();
  return { ...launch, control, column, panel };
}

const middle = (box: { x: number; width: number }) => box.x + box.width / 2;

/** Whether nothing lies over the middle of `target`: a press there reaches it. */
const uncovered = (target: Locator) =>
  target.evaluate((element) => {
    const at = element.getBoundingClientRect();
    return element.contains(
      document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2),
    );
  });

/** The words a Citation chip in a reply quotes, as its title says them. */
async function quoteOf(chip: Locator): Promise<string> {
  const title = (await chip.getAttribute("title")) ?? "";
  return title.slice(title.lastIndexOf("“") + 1, title.lastIndexOf("”"));
}

/** The sheet is up at the cited line: its words washed as a found quote, in view in its body. */
async function shownAtQuote(window: Page, quote: string): Promise<Locator> {
  const sheet = window.getByTestId("meeting-sheet");
  await expect(sheet).toBeVisible();
  const washed = sheet.locator("[data-quote-highlight]");
  await expect(washed.first()).toBeVisible();
  // Each word is an element of its own (#138), so the wash comes in pieces that read as the line.
  await expect.poll(async () => (await washed.allTextContents()).join("")).toBe(quote);
  const line = sheet
    .getByTestId("transcript-line")
    .filter({ has: window.locator("[data-quote-highlight]") });
  await expect(line).toHaveCount(1);
  await expect(line).toBeInViewport();
  const body = await boxOf(sheet.locator(".meeting-sheet-body"));
  const mark = await boxOf(washed.first());
  expect(mark.y).toBeGreaterThanOrEqual(body.y);
  expect(boxBottom(mark)).toBeLessThanOrEqual(boxBottom(body));
  return sheet;
}

for (const language of ["en", "zh-CN"] as const) {
  // protects=with the Note's conversation in the window's column, the meeting's control stays at the Note's foot centred on the text, only the input goes to the column, and the sheet the control raises rises over the Note alone on the text's edges, the column beside (#3762); fails_when=the control moves into the column or off the text's centre, a second input stays at the Note's foot, or the sheet covers the column or leaves the text's edges
  test(`with the conversation in the window's column, the control stays centred at the Note's foot and its sheet rises over the Note alone (${language})`, async () => {
    test.setTimeout(150_000);
    const { app, window, control, column } = await askedIntoColumn(language);
    try {
      const measure = window.getByTestId("mind-pane").locator(".mind-measure").first();
      const scroller = window.getByTestId("mind-scroller");
      const text = await boxOf(measure);
      const foot = await boxOf(control);
      expect(Math.abs(middle(foot) - middle(text))).toBeLessThanOrEqual(2);
      expect(foot.y).toBeGreaterThanOrEqual(boxBottom(await boxOf(scroller)) - 1);
      expect(foot.x).toBeGreaterThanOrEqual(boxRight(await boxOf(column)));

      // Only the input went to the column: the control and nothing else stays at the Note's foot.
      await expect(column.getByTestId("note-ask-input")).toBeVisible();
      await expect(window.getByTestId("note-ask-input")).toHaveCount(1);
      await expect(column.getByTestId("meeting-foot")).toHaveCount(0);
      expect(
        await window.locator(".meeting-foot-ask").evaluate((element) => element.matches(":empty")),
      ).toBe(true);
      await shot(window, `meeting-column-control-${language}-1440`);

      // Raised from the control, the sheet stands over the Note on the text's edges, above the
      // control; the column stays beside it, uncovered.
      const sheet = await openMeetingSheet(window);
      await expect(control.getByTestId("meeting-foot-transcript")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      const raised = await boxOf(sheet);
      expect(Math.abs(raised.x - text.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(boxRight(raised) - boxRight(text))).toBeLessThanOrEqual(1);
      expect(raised.y).toBeGreaterThanOrEqual((await boxOf(scroller)).y - 1);
      expect(boxBottom(raised)).toBeLessThanOrEqual(foot.y);
      await expect(column).toBeVisible();
      expect(boxesOverlap(raised, await boxOf(column))).toBe(false);
      expect(await uncovered(column.getByTestId("note-ask-input"))).toBe(true);
      expect(await boxOf(control)).toEqual(foot);
      await shot(window, `meeting-column-sheet-${language}-1440`);
    } finally {
      await app.close();
    }
  });

  // protects=a Citation chip pressed in a reply raises the sheet at the line it cites, washed as a found quote and scrolled into view, with the reply still in view: in the window's column at 1,440 the reply stays beside the sheet; opened upward at 900 the conversation folds to the reply's line below the sheet (#3762); fails_when=the chip opens anything else, the sheet opens away from the cited line or without its wash, or the sheet covers the reply
  test(`a Citation pressed in a reply raises the sheet at the cited line, washed, with the reply in view, in the column and upward at 900 (${language})`, async () => {
    test.setTimeout(150_000);
    const words = WORDS[language];
    const { app, window, column, panel } = await askedIntoColumn(language);
    try {
      // In the window's column: the reply stays beside the sheet.
      const reply = column.getByTestId("note-column-reply").last();
      const chip = reply.locator(".citation-marker[data-token]").first();
      await expect(chip).toBeVisible();
      const quote = await quoteOf(chip);
      expect(quote).toContain(words.cited);
      await pointAndClick(window, chip);
      const sheet = await shownAtQuote(window, quote);
      await expect(column).toBeVisible();
      await expect(reply).toBeInViewport();
      expect(boxesOverlap(await boxOf(sheet), await boxOf(column))).toBe(false);
      expect(await uncovered(chip)).toBe(true);
      await shot(window, `meeting-column-citation-${language}-1440`);
      await pointAndClick(window, sheet.getByTestId("meeting-sheet-hide"));
      await expect(sheet).toBeHidden();

      // At 900 the column can't stand: the conversation opens upward, and as the sheet rises from
      // its chip it folds to the reply's line, below the sheet.
      await setWindowSize(app, window, 900, 900);
      await expect(panel).toBeVisible();
      await expect(column).toHaveCount(0);
      const upward = panel.locator(".citation-marker[data-token]").first();
      await expect(upward).toBeVisible();
      expect(await quoteOf(upward)).toBe(quote);
      await pointAndClick(window, upward);
      const again = await shownAtQuote(window, quote);
      await expect(panel).toBeHidden();
      const line = window.getByTestId("note-ask-pill");
      await expect(line).toBeInViewport({ ratio: 1 });
      await expect(line.getByTestId("note-ask-pill-open")).toContainText(words.reply);
      expect(boxBottom(await boxOf(again))).toBeLessThanOrEqual((await boxOf(line)).y);
      expect(await uncovered(line)).toBe(true);
      await shot(window, `meeting-upward-citation-${language}-900`);
    } finally {
      await app.close();
    }
  });
}
