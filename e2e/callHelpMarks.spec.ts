import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  dismissChatSetup,
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
 * In call help, a Citation shows ✓ only beside a sentence the sentence check passed (#2847), on the
 * scripted chat model, whose check passes a sentence its quote states and not one that says a
 * thing is already done. A reading of what they said rests on their line and passes; an option
 * whose line says more doesn't, and its Citation stays plain, the ✓'s place kept, in English and
 * Chinese. Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
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
    // The option cites the line that shares the most words with their newest one.
    sheet:
      "Price sheet 2026\n\nTeam plan: $25 per seat a month.\nEnterprise plan: $45 per seat a month, and setting it up for you it is already done.\n",
    want: "What do they want?",
    answer: "Answer their question",
  },
  {
    language: "Chinese",
    interface: "zh-CN" as const,
    buyer: ["企业版能不能每个席位 35 美元？", "企业版每个席位多少钱，含不含单点登录？"],
    // A Chinese line shares no word the scripted model counts, so the option cites the first.
    sheet: "企业版：每个席位每月 45 美元，开通这件事已经完成。\n团队版：每个席位每月 25 美元。\n",
    want: "对方想要什么？",
    answer: "回答对方的问题",
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

    // A reading rests on their own line, which the check passes: ✓ comes after the reply.
    const want = await pressIn(panel, call.want);
    const passed = want.getByTestId("help-option-note").first().getByTestId("help-citation");
    await expect(passed).toHaveAttribute("data-passed", "true");
    await expect(passed.getByTestId("help-citation-check")).toBeVisible();
    const passedBox = await passed.boundingBox();
    await shot(panel, `call-help-marks-passed-${call.interface}`);

    // An option whose line says more: its quote is found, the check doesn't pass it, no ✓.
    const answer = await pressIn(panel, call.answer);
    const plain = answer.getByTestId("help-option-say").first().getByTestId("help-citation");
    await expect(plain).toHaveAttribute("data-check", "unsupported");
    await expect(plain).toHaveAttribute("data-passed", "false");
    await expect(plain.getByTestId("help-citation-check")).toBeHidden();
    await expect(answer.getByTestId("help-source")).toHaveCount(1);
    // The ✓ keeps its place whether it shows or not, so nothing moves when one comes.
    const plainBox = await plain.boundingBox();
    if (!plainBox || !passedBox) throw new Error("A Citation isn't drawn.");
    expect(Math.abs(plainBox.width - passedBox.width)).toBeLessThan(0.5);
    await shot(panel, `call-help-marks-plain-${call.interface}`);

    await app.close();
  });
}
