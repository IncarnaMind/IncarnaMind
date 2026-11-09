import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  dismissChatSetup,
  expectMarksAsChecked,
  firstTranscriptLine,
  launchApp,
  panelOf,
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
  },
];

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

    // An option resting on the price sheet: ✓ only if the check passed its line.
    const answer = await pressIn(panel, call.answer);
    const answerMarks = await expectMarksAsChecked(window, answer);
    expect(answerMarks[0]).toMatchObject(
      call.answerPasses
        ? { passed: true, check: "found" }
        : { passed: false, check: "unsupported" },
    );
    const answerBox = await answer.getByTestId("help-citation").first().boundingBox();
    await shot(panel, `call-help-marks-answer-${call.interface}`);

    // A reading of what they said: its moment's chip shows what the check gave that line.
    const want = await pressIn(panel, call.want);
    const wantMarks = await expectMarksAsChecked(window, want);
    expect(wantMarks.length).toBeGreaterThan(0);
    test.info().annotations.push({
      type: "reading's moment",
      description: JSON.stringify(wantMarks),
    });
    const wantBox = await want.getByTestId("help-citation").first().boundingBox();
    await shot(panel, `call-help-marks-want-${call.interface}`);

    // The ✓ keeps its place whether it shows or not, so nothing moves when one comes.
    if (!answerBox || !wantBox) throw new Error("A Citation isn't drawn.");
    expect(Math.abs(answerBox.width - wantBox.width)).toBeLessThan(0.5);

    await app.close();
  });
}
