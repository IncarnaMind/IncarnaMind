import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  dismissChatSetup,
  expectMarksAsChecked,
  firstTranscriptLine,
  launchApp,
  panelOf,
  panelOpen,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  setLanguage,
  setMeetingKeys,
  setWindowSize,
  startRecording,
  useLocalChatModel,
} from "./app";

/**
 * In call help, a Citation shows ✓ only beside a line the sentence check passed (#2847), on the
 * scripted chat model, whose check passes a sentence unless it says a thing is already done. Each
 * chip's ✓ is read against what the core recorded of the check; an option resting on a plain line
 * of the price sheet takes ✓, one whose line says more stays plain with the ✓'s place kept, in
 * English and Chinese. Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(page: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

const CALLS = [
  {
    language: "English",
    interface: "en" as const,
    buyer: [
      "Can you do thirty-five dollars a seat for Enterprise?",
      "How much is the Enterprise plan per seat, and does it include single sign-on?",
    ],
    // The option cites the line that shares the most words with their newest one: a plain one.
    sheet:
      "Price sheet 2026\n\nTeam plan: $25 per seat a month.\nEnterprise plan: $45 per seat a month, single sign-on included.\n",
    answer: "Answer their question",
    answerPasses: true,
    want: "What do they want?",
    showPanel: "Show the call help panel",
  },
  {
    language: "Chinese",
    interface: "zh-CN" as const,
    buyer: ["企业版能不能每个席位 35 美元？", "企业版每个席位多少钱，含不含单点登录？"],
    // A Chinese line shares no word the scripted model counts, so the option cites the first,
    // which says the thing is already done.
    sheet: "企业版：每个席位每月 45 美元，开通这件事已经完成。\n团队版：每个席位每月 25 美元。\n",
    answer: "回答对方的问题",
    answerPasses: false,
    want: "对方想要什么？",
    showPanel: "显示通话助手浮窗",
  },
];

/** Holds the scripted model's sentence checks until set false, which lets every held one go. */
async function holdChecks(app: ElectronApplication, hold: boolean): Promise<void> {
  await app.evaluate((_electron, held) => {
    const slow = (
      globalThis as unknown as { incarnamindSlowCheck: { hold: boolean; release(): void } }
    ).incarnamindSlowCheck;
    slow.hold = held;
    if (!held) slow.release();
  }, hold);
}

async function pressIn(page: Page, name: string): Promise<Locator> {
  await pointAndClick(page, page.getByTestId("help-button").filter({ hasText: name }));
  const suggestion = page.getByTestId("help-suggestion").last();
  await expect(suggestion).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  await expect(suggestion.getByTestId("help-heading")).toContainText(name);
  return suggestion;
}

for (const call of CALLS) {
  test(`call help in ${call.language}: a ✓ only beside a sentence the check passed, the Citation plain otherwise, in its place`, async () => {
    const { app, window } = await launchApp(dataDir, {
      fakeChat: true,
      transcriber: { theirLines: call.buyer },
    });
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await setLanguage(window, call.interface);
    await setMeetingKeys(window);
    await useLocalChatModel(window);
    // Documents wait while a meeting records: the price sheet is added first.
    const sheet = join(sources, "Price sheet.txt");
    await writeFile(sheet, call.sheet);
    const bridge = await window.evaluateHandle(
      () => (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind,
    );
    await bridge.evaluate((core, path) => core.addDocuments([path]), sheet);
    await expect
      .poll(() =>
        bridge.evaluate(async (core) =>
          (await core.listDocuments()).map((document) => document.status),
        ),
      )
      .toEqual(["ready"]);
    await startRecording(window, await recordMeeting(window), { notice: true });
    await firstTranscriptLine(window);
    const panel = await panelOf(app);

    // An option resting on the price sheet, its check held: the chip shows its number alone.
    await holdChecks(app, true);
    const answer = await pressIn(panel, call.answer);
    const chip = answer.getByTestId("help-citation").first();
    await expect(chip).toHaveAttribute("data-check", "checking");
    await expect(chip).toHaveAttribute("data-passed", "false");
    const before = { chip: await chip.boundingBox(), reply: await answer.boundingBox() };
    await shot(panel, `call-help-marks-checking-${call.interface}`);

    // Its check ends: ✓ only if it passed that line, and nothing moves when the mark comes.
    await holdChecks(app, false);
    const answerMarks = await expectMarksAsChecked(window, answer);
    expect(answerMarks[0]).toMatchObject(
      call.answerPasses
        ? { passed: true, check: "found" }
        : { passed: false, check: "unsupported" },
    );
    const after = { chip: await chip.boundingBox(), reply: await answer.boundingBox() };
    if (!before.chip || !after.chip || !before.reply || !after.reply) {
      throw new Error("The reply isn't drawn.");
    }
    expect(Math.abs(after.chip.width - before.chip.width)).toBeLessThan(0.5);
    expect(Math.abs(after.chip.x - before.chip.x)).toBeLessThan(0.5);
    expect(Math.abs(after.reply.height - before.reply.height)).toBeLessThan(0.5);
    await shot(panel, `call-help-marks-answer-${call.interface}`);

    // A reading of what they said: its moment's chip shows what the check gave that line.
    const want = await pressIn(panel, call.want);
    const wantMarks = await expectMarksAsChecked(window, want);
    expect(wantMarks.length).toBeGreaterThan(0);
    test.info().annotations.push({
      type: "reading's moment",
      description: JSON.stringify(wantMarks),
    });
    await shot(panel, `call-help-marks-want-${call.interface}`);

    // Closed and shown again, the panel shows the latest reply with the marks its check gave.
    const close = panel.getByTestId("panel-close");
    await close.hover();
    // The window goes as the click lands, which a click Playwright waits on would call a failure.
    await close.evaluate((button) => setTimeout(() => (button as HTMLElement).click(), 0));
    await expect.poll(() => panelOpen(app)).toBe(false);
    await window.keyboard.press("ControlOrMeta+k");
    await window.keyboard.type(call.showPanel);
    await window.keyboard.press("Enter");
    const shown = await panelOf(app);
    const again = shown.getByTestId("help-suggestion").last();
    await expect(again.getByTestId("help-heading")).toContainText(call.want);
    expect(await expectMarksAsChecked(window, again)).toEqual(wantMarks);

    await app.close();
  });
}
