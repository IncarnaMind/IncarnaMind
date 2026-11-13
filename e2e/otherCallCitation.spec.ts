import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  dismissChatSetup,
  firstTranscriptLine,
  launchApp,
  panelOf,
  panelOpen,
  pointAndClick,
  recordMeeting,
  recordMeetingNow,
  removeDataFolder,
  setLanguage,
  setMeetingKeys,
  setWindowSize,
  startRecording,
  useLocalChatModel,
} from "./app";

/**
 * A help button's reply in the assistant that keeps a Citation of another call (#3005): the Note
 * of the live call holds a Citation of the earlier call's Transcript, the scripted model's option
 * cites it, and the reply's check leaves that Transcript out. Its card says Not checked and why,
 * in English and Chinese. Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(page: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const CALLS = [
  {
    interface: "en" as const,
    buyer: ["Our data has to stay in Europe.", "Can we host it in Frankfurt?"],
    say: "What should I say?",
    reason:
      "The quote is from another call. A call help reply is checked against its own call and your Documents.",
  },
  {
    interface: "zh-CN" as const,
    buyer: ["我们的数据必须留在欧洲。", "能放在法兰克福吗？"],
    say: "我该怎么说？",
    reason: "引文出自另一场会议。通话助手的回复只对照这场会议和你的文档核对。",
  },
];

for (const call of CALLS) {
  // protects=#3005: a press's reply in the assistant that cites another call's Transcript, which its check leaves out, says so on the Citation's card; fails_when=the card gives the general "couldn't be checked" line, or the Citation shows ✓; no_claim=the panel's chip.
  test(`call help in ${call.interface}: a Citation of another call a press's reply keeps says why it isn't checked`, async () => {
    const { app, window } = await launchApp(dataDir, {
      fakeChat: true,
      transcriber: { theirLines: call.buyer },
    });
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await setLanguage(window, call.interface);
    await setMeetingKeys(window);
    await useLocalChatModel(window, "fake-model-cites-the-note");
    const bridge = await window.evaluateHandle(
      () => (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind,
    );

    // The earlier call, recorded and stopped.
    const earlier = await startRecording(window, await recordMeeting(window), { notice: true });
    await firstTranscriptLine(window);
    await earlier.getByTestId("meeting-stop").click();
    await expect
      .poll(
        () =>
          bridge.evaluate(async (core) =>
            (await core.listMeetings()).some(
              (meeting) => meeting.status === "stopped" && meeting.transcript?.state === "saved",
            ),
          ),
        { timeout: 30_000 },
      )
      .toBe(true);

    // The live call, in a Note of its own that keeps a Citation of the earlier call's line; the
    // recording notice read once, it records at once.
    await recordMeetingNow(window);
    await firstTranscriptLine(window);
    await bridge.evaluate(async (core, line) => {
      const meetings = await core.listMeetings();
      const before = meetings.find((meeting) => meeting.status === "stopped");
      const live = meetings.find((meeting) => meeting.status === "recording");
      const transcript = before?.transcript?.documentId;
      if (!live || !transcript) throw new Error("No earlier call or live call.");
      const found = await core.findPassages({ text: line, mindId: null, scope: null });
      const passage = found.find((each) => each.documentId === transcript);
      if (!passage) throw new Error("The earlier call's line isn't found.");
      const citation = await core.citePassage({ passageId: passage.passageId, text: line });
      if (!citation) throw new Error("The earlier call's line can't be cited.");
      await core.addToNote({
        mindId: live.mindId,
        blocks: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: `${citation.quote} ` },
              { type: "citation", attrs: citation },
            ],
          },
        ],
        origin: null,
        model: null,
        generated: false,
        recordUse: false,
      });
    }, call.buyer[0] ?? "");

    // The panel closed, the buttons sit at the top of the assistant, whose reply has its cards.
    const panel = await panelOf(app);
    const close = panel.getByTestId("panel-close");
    await close.hover();
    // The window goes as the click lands, which a click Playwright waits on would call a failure.
    await close.evaluate((button) => setTimeout(() => (button as HTMLElement).click(), 0));
    await expect.poll(() => panelOpen(app)).toBe(false);
    await pointAndClick(
      window,
      window.getByTestId("help-strip").getByTestId("help-button").filter({ hasText: call.say }),
    );
    const reply = window.getByTestId("assistant-answer").last();
    await expect(reply).toHaveAttribute("data-status", "done", { timeout: 20_000 });
    const chip = reply.getByTestId("citation-chip").first();
    await expect(chip).toHaveAttribute("data-check", "not-checked", { timeout: 20_000 });

    await pointAndClick(window, chip);
    const card = window.getByTestId("citation-card");
    await expect(card).toBeVisible();
    // The card fades in: the still is taken once it has.
    await expect
      .poll(() => card.evaluate((element) => getComputedStyle(element).opacity))
      .toBe("1");
    await shot(window, `other-call-citation-${call.interface}`);
    await expect(card.getByTestId("citation-reason")).toHaveText(call.reason);
    await expect(card.getByTestId("citation-check-again")).toHaveCount(0);
    await expect(card.getByTestId("citation-open")).toBeVisible();
    await app.close();
  });
}
