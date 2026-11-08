import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CloudTranscriptionRoute, CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  openSettings,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
  showSettingsPage,
  useOutputLocation,
} from "./app";

/**
 * Meeting transcription's keys live in Settings › AI: a service with a key of its own is set
 * up in place from the foot of the Meeting transcription picker, in Defaults or in Settings ›
 * Meetings, and its key is then a row of Your providers, "For meeting transcription", with Change
 * key and Remove key. The pretend cloud service of every smoke test's fake transcriber takes any
 * key but one that says it's wrong. Set INCARNAMIND_SCREENSHOTS to a folder to also save
 * screenshots.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const CLOUDFLARE =
  "https://api.cloudflare.com/client/v4/accounts/0f0e0d/ai/run/@cf/deepgram/nova-3";
const SONIOX_KEY = "soniox-test-key-0123456789";

const bridge = (window: Page) =>
  window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return {
      route: (await core.getSettings()).device.transcriptionRoute,
      flows: (await core.listDataFlows()).map((each) => ({
        id: each.flow.id,
        service: each.flow.service.id,
        consent: each.consent,
      })),
      meetings: (await core.listMeetings()).map((each) => ({
        cloud: each.transcript?.cloud ?? null,
      })),
    };
  });

const setKey = (window: Page, route: CloudTranscriptionRoute, apiKey: string) =>
  window.evaluate(
    async (input) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.setTranscriptionKey(input);
    },
    { route, apiKey },
  );

const choose = (window: Page, route: CloudTranscriptionRoute) =>
  window.evaluate(async (transcriptionRoute) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await core.updateSettings({ device: { transcriptionRoute } });
  }, route);

/** The picker's own routes, then the services its foot sets up, whether it groups them or not. */
const routesOf = (picker: Locator) =>
  picker.locator("option:not([hidden]):not([value^='set-up:'])");
const setUpRowsOf = (picker: Locator) => picker.locator("option[value^='set-up:']");

const keyRow = (settings: Locator, route: CloudTranscriptionRoute) =>
  settings
    .getByTestId("your-providers")
    .locator(`[data-testid="transcription-key-row"][data-host="${route}"]`);

/** Starts recording a meeting, past the first recording's sheet, which names the route chosen. */
async function recordOn(window: Page, provider: string): Promise<void> {
  const start = await recordMeeting(window);
  await start.getByTestId("meeting-start-record").click();
  const sheet = window.getByTestId("meeting-notice");
  await expect(sheet.getByTestId("meeting-route")).toContainText(`Transcribe with ${provider}`);
  await sheet.getByTestId("meeting-notice-start").click();
  await expect(sheet).toBeHidden();
  await expect(window.getByTestId("meeting-bar")).toHaveAttribute("data-status", "recording");
}

let dataDir: string;
let sources: string;
let app: ElectronApplication | null = null;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
});
test.afterEach(async () => {
  await app?.close();
  app = null;
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

async function launch(options: Parameters<typeof launchApp>[1] = {}): Promise<Page> {
  const launched = await launchApp(dataDir, options);
  app = launched.app;
  await setWindowSize(launched.app, launched.window, 1440, 900);
  await dismissChatSetup(launched.window);
  await acceptPlainTextKeys(launched.window);
  return launched.window;
}

test("a Soniox key set up from Defaults' Meeting transcription is checked, chosen with where the audio goes, kept in Your providers, and used by the next meeting", async () => {
  const window = await launch();
  await useOutputLocation(window, sources);
  const settings = await openSettings(window, "ai");
  const row = settings.getByTestId("model-default-row-transcription");
  const picker = row.getByTestId("meetings-route");

  // Nothing set up: this computer, and the services with a key of their own at the picker's foot.
  await expect(routesOf(picker)).toHaveText(["On this computer"]);
  await expect(picker.locator("optgroup").last()).toHaveAttribute(
    "label",
    "Set up another transcription service",
  );
  await expect(setUpRowsOf(picker)).toHaveText([
    "Use Soniox…",
    "Use Deepgram…",
    "Use AssemblyAI…",
    "Use ElevenLabs…",
    "Use Speechmatics…",
    "Use Gladia…",
  ]);
  await expect(settings.getByTestId("transcription-key-row")).toHaveCount(0);

  // Choosing one sets it up in place: its key focused, what Save does, and where the audio goes.
  await picker.selectOption("set-up:soniox");
  const form = row.getByTestId("transcription-key-form-soniox");
  const input = form.getByTestId("transcription-key-input");
  await expect(input).toBeFocused();
  await expect(row.getByTestId("transcription-set-up-line")).toHaveText(
    "Transcribes meetings live with your Soniox key · names speakers live",
  );
  await expect(form.getByTestId("transcription-key-kept")).toContainText(
    "Saving it first checks it with Soniox, by a request that reads nothing of yours.",
  );
  await expect(form.getByTestId("transcription-set-up-consent")).toContainText(
    "Audio goes to Soniox while you record.",
  );
  await expect(form.getByTestId("transcription-key-save")).toHaveText("Use this");
  await shot(window, "after-models-set-up-soniox-en-1440");

  // A character keys don't use is said in place, in plain words, and nothing can be sent (#1357).
  await input.fill("soniox\u2013test-key");
  const stray = form.getByTestId("key-character-line");
  await expect(stray).toHaveText("This key has a character keys don’t use (–). Paste it again.");
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(form.getByTestId("transcription-key-save")).toBeDisabled();
  await setLanguage(window, "zh-CN");
  await expect(stray).toHaveText("密钥里有一个不该有的字符（–）。重新粘贴密钥。");
  await setLanguage(window, "en");

  // A key the service refuses is said where it was typed; nothing is kept or chosen.
  await input.fill("soniox-wrong-key");
  await input.press("Enter");
  await expect(form.getByTestId("transcription-key-problem")).toContainText(
    "Soniox didn’t accept this key.",
  );
  expect((await bridge(window)).route).not.toBe("soniox");
  await expect(settings.getByTestId("transcription-key-row")).toHaveCount(0);

  // The key it takes, pasted with blanks at its ends, which are cleaned off, is kept and Soniox
  // chosen in one press: the consent, named for Soniox.
  await input.fill(` ${SONIOX_KEY}\u200b\n`);
  await expect(stray).toHaveCount(0);
  await pointAndClick(window, form.getByTestId("transcription-key-save"));
  await expect(form).toHaveCount(0);
  await expect(picker).toHaveValue("soniox");
  await expect(picker).toBeFocused();
  const chosen = await bridge(window);
  expect(chosen.route).toBe("soniox");
  expect(chosen.flows).toContainEqual({
    id: "transcription",
    service: "https://stt-rt.soniox.com",
    consent: "accepted",
  });
  await expect(setUpRowsOf(picker)).not.toContainText(["Use Soniox…"]);
  const soniox = keyRow(settings, "soniox");
  await expect(soniox.getByTestId("transcription-key-status")).toHaveText(
    "Your key · Used for meeting transcription",
  );
  await expect(soniox.getByTestId("account-state")).toHaveText("Key works");
  await expect(soniox.getByTestId("transcription-key-change")).toHaveText("Change key");
  await expect(soniox.getByTestId("transcription-key-remove")).toHaveText("Remove key");

  // Settings › Meetings says where the audio goes, with no picker or key rows of its own.
  const meetings = (await showSettingsPage(window, "meetings")).getByTestId("meetings-settings");
  await expect(meetings.getByTestId("meetings-route")).toHaveCount(0);
  await expect(meetings.getByTestId("meetings-route-line")).toContainText(
    "Audio goes to Soniox while you record.",
  );
  await expect(meetings.getByTestId("transcription-key-row")).toHaveCount(0);
  await closeSettings(window);

  await recordOn(window, "Soniox");
  await expect.poll(async () => (await bridge(window)).meetings[0]?.cloud).toBe("soniox");
});

test("Deepgram set up from Meeting transcription's picker takes Cloudflare's address: the line above Use this names Cloudflare, and the next meeting uses it", async () => {
  const window = await launch();
  await useOutputLocation(window, sources);
  const settings = await openSettings(window, "ai");
  const meetings = settings.getByTestId("model-default-row-transcription");
  const picker = meetings.getByTestId("meetings-route");
  await expect(setUpRowsOf(picker)).toContainText(["Use Deepgram…"]);
  await picker.selectOption("set-up:deepgram");

  const form = meetings.getByTestId("transcription-key-form-deepgram");
  await expect(form.getByTestId("transcription-key-input")).toBeFocused();
  const server = form.getByRole("textbox", { name: "Server" });
  await expect(server).toHaveAttribute("placeholder", "Deepgram’s own");
  await expect(form).toContainText("Leave it empty for Deepgram.");
  const consent = form.getByTestId("transcription-set-up-consent");
  await expect(consent).toContainText("Audio goes to Deepgram while you record.");
  await expect(form.getByTestId("transcription-key-kept")).toContainText(
    "Saving it first checks it with Deepgram",
  );

  // Cloudflare's address: the key isn't sent to Deepgram, and the audio would go to Cloudflare.
  await server.fill(CLOUDFLARE);
  await expect(form.getByTestId("transcription-key-kept")).not.toContainText(
    "Saving it first checks it",
  );
  await expect(consent).toContainText("Audio goes to Cloudflare while you record.");
  await expect(consent).toContainText(
    "Cloudflare doesn’t train AI models on what Workers AI transcribes",
  );
  await expect(consent).not.toContainText("Deepgram");
  await shot(window, "after-meetings-set-up-deepgram-en-1440");
  await form.getByTestId("transcription-key-input").fill("cf-test-token-0123456789");
  await pointAndClick(window, form.getByTestId("transcription-key-save"));
  await expect(form).toHaveCount(0);
  await expect(picker).toHaveValue("deepgram");
  const line = (await showSettingsPage(window, "meetings")).getByTestId("meetings-route-line");
  await expect(line).toContainText("Audio goes to Cloudflare while you record.");
  expect((await bridge(window)).flows).toContainEqual({
    id: "transcription",
    service: "https://api.cloudflare.com",
    consent: "accepted",
  });

  // Its key is in Your providers, with the server it sends to.
  const models = await showSettingsPage(window, "ai");
  await expect(keyRow(models, "deepgram").getByTestId("transcription-key-status")).toHaveText(
    "Your key · Used for meeting transcription · sent to wss://api.cloudflare.com/client/v4/accounts/0f0e0d/ai/run/@cf/deepgram/nova-3",
  );
  await closeSettings(window);

  await recordOn(window, "Deepgram");
  await expect.poll(async () => (await bridge(window)).meetings[0]?.cloud).toBe("deepgram");
});

test("Remove key on the chosen service's row sends meetings back to this computer, and the service back to the picker's foot", async () => {
  const window = await launch();
  await setKey(window, "soniox", SONIOX_KEY);
  await choose(window, "soniox");

  const settings = await openSettings(window, "ai");
  const picker = settings
    .getByTestId("model-default-row-transcription")
    .getByTestId("meetings-route");
  await expect(picker).toHaveValue("soniox");
  const soniox = keyRow(settings, "soniox");
  await pointAndClick(window, soniox.getByTestId("transcription-key-remove"));
  await expect(soniox).toHaveCount(0);
  await expect(picker).toHaveValue("local");
  await expect(routesOf(picker)).toHaveText(["On this computer"]);
  await expect(setUpRowsOf(picker)).toContainText(["Use Soniox…"]);
  await expect(settings.getByTestId("your-providers")).toContainText("No provider yet");
  expect((await bridge(window)).route).toBe("local");

  const meetings = (await showSettingsPage(window, "meetings")).getByTestId("meetings-settings");
  await expect(meetings.getByTestId("meetings-route-line")).toHaveText("Private and free");
});

test("Change key edits the key in place; in Local mode it keeps the key without checking it, says nothing was sent, and the picker sets nothing up", async () => {
  const window = await launch();
  await setKey(window, "soniox", SONIOX_KEY);
  let settings = await openSettings(window, "ai");
  let soniox = keyRow(settings, "soniox");

  // Change key: the form in place, its key focused; Esc puts it away and keeps the key.
  await pointAndClick(window, soniox.getByTestId("transcription-key-change"));
  const form = soniox.getByTestId("transcription-key-form-soniox");
  await expect(form.getByTestId("transcription-key-input")).toBeFocused();
  await expect(form.getByTestId("transcription-key-save")).toHaveText("Save");
  await window.keyboard.press("Escape");
  await expect(form).toHaveCount(0);
  await expect(settings).toBeVisible();
  await expect(soniox.getByTestId("transcription-key-change")).toBeVisible();

  // Checked outside Local mode: a key the service refuses isn't kept.
  await pointAndClick(window, soniox.getByTestId("transcription-key-change"));
  await form.getByTestId("transcription-key-input").fill("soniox-wrong-key");
  await form.getByTestId("transcription-key-input").press("Enter");
  await expect(form.getByTestId("transcription-key-problem")).toContainText(
    "Soniox didn’t accept this key.",
  );
  await window.keyboard.press("Escape");
  await expect(form).toHaveCount(0);

  settings = await showSettingsPage(window, "ai");
  await settings.getByTestId("local-only").check();
  soniox = keyRow(settings, "soniox");
  const picker = settings
    .getByTestId("model-default-row-transcription")
    .getByTestId("meetings-route");
  await expect(routesOf(picker)).toHaveText(["On this computer"]);
  await expect(setUpRowsOf(picker)).toHaveCount(0);

  // In Local mode nothing is sent: the same refused key is kept, unchecked, and the row says so.
  await pointAndClick(window, soniox.getByTestId("transcription-key-change"));
  const kept = form.getByTestId("transcription-key-kept");
  await expect(kept).toContainText("Kept on this computer and never shown again.");
  await expect(kept).not.toContainText("Saving it first checks it");
  await form.getByTestId("transcription-key-input").fill("soniox-wrong-key");
  await pointAndClick(window, form.getByTestId("transcription-key-save"));
  await expect(form).toHaveCount(0);
  const unchecked = soniox.getByTestId("provider-key-not-checked");
  await expect(unchecked).toHaveText("Saved, not checked: nothing was sent to Soniox.");
  await shot(window, "after-models-key-local-mode-en-1440");
  await setLanguage(window, "zh-CN");
  await expect(unchecked).toHaveText("已保存，未验证：没有向 Soniox 发送任何内容。");
  await expect(soniox.getByTestId("transcription-key-status")).toHaveText(
    "你的密钥 · 尚未使用 · 可用于转写",
  );
});

test("a provider row whose key also transcribes says both uses, and ⌘K and a refused key's Check the key reach the new place", async () => {
  const window = await launch({ transcriber: { cloud: { refuse: true } } });
  await useOutputLocation(window, sources);
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await core.saveChatProvider({
      kind: "openai",
      apiKey: "sk-test-openai",
      modelId: "gpt-5.4-mini",
    });
    await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-api03-a-test-key",
      modelId: "claude-haiku-5-5",
    });
  });
  await setKey(window, "soniox", SONIOX_KEY);
  await choose(window, "soniox");

  // ⌘K: the Meeting transcription picker in Settings › AI, focused.
  await runCommand(window, "settings.transcription", "Set up meeting transcription…");
  const settings = window.getByTestId("settings");
  await expect(settings).toHaveAttribute("data-page", "ai");
  const picker = settings
    .getByTestId("model-default-row-transcription")
    .getByTestId("meetings-route");
  await expect(picker).toBeFocused();
  await expect(routesOf(picker)).toHaveText(["OpenAI", "Soniox", "On this computer"]);

  const rows = settings.getByTestId("provider-row");
  const status = (name: string) =>
    rows.filter({ hasText: name }).getByTestId("provider-row-status");
  // One row per company, saying what it does today: OpenAI answers, Soniox transcribes.
  await expect(status("OpenAI")).toContainText("Your key · Used for Answers");
  await expect(status("OpenAI")).not.toContainText("transcription");
  await expect(status("Anthropic")).toHaveText("Your key · Not used yet · can answer");
  await expect(keyRow(settings, "soniox").getByTestId("transcription-key-status")).toHaveText(
    "Your key · Used for meeting transcription",
  );
  await setLanguage(window, "zh-CN");
  await expect(status("OpenAI")).toContainText("你的密钥 · 用于回答");
  await setLanguage(window, "en");
  await closeSettings(window);

  // The pretend service turns the key away: Check the key opens its row, the key field focused.
  await recordOn(window, "Soniox");
  const refused = window.getByTestId("meeting-bar").getByTestId("meeting-line-cloud");
  await expect(refused).toContainText("Soniox didn’t accept the key.", { timeout: 20_000 });
  await refused.getByTestId("meeting-line-change-key").click();
  await expect(settings).toHaveAttribute("data-page", "ai");
  const form = keyRow(settings, "soniox").getByTestId("transcription-key-form-soniox");
  await expect(form.getByTestId("transcription-key-input")).toBeFocused();
});

// protects=the moved key rows and the picker's setup hold the layout at a narrow and a wide window, in both languages; fails_when=a row's buttons overlap its words, the form or a line runs out of its row, or the page scrolls sideways; no_claim=pixel sizes.
for (const width of [900, 1440] as const) {
  test(`Settings › AI and Settings › Meetings hold their layout at ${width} px in English and Chinese`, async () => {
    const window = await launch();
    await setKey(window, "soniox", SONIOX_KEY);
    await window.evaluate(async (server) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.setTranscriptionKey({ route: "deepgram", apiKey: "cf-test-token-0123", server });
      await core.saveChatProvider({
        kind: "openai",
        apiKey: "sk-test-openai",
        modelId: "gpt-5.4-mini",
      });
    }, CLOUDFLARE);
    await setWindowSize(app as ElectronApplication, window, width, 760);
    const settings = await openSettings(window, "ai");

    for (const language of ["en", "zh-CN"] as const) {
      await setLanguage(window, language);
      const models = await showSettingsPage(window, "ai");
      const page = models.locator('[data-testid="settings-page-ai"]');
      for (const route of ["soniox", "deepgram"] as const) {
        const row = keyRow(models, route);
        await row.scrollIntoViewIfNeeded();
        const words = await row.getByTestId("transcription-key-status").boundingBox();
        const change = await row.getByTestId("transcription-key-change").boundingBox();
        const box = await row.boundingBox();
        expect(words && change && words.x + words.width <= change.x).toBe(true);
        expect(box && change && change.x + change.width <= box.x + box.width).toBe(true);
      }
      await shot(window, `after-models-providers-${language}-${width}`);

      const transcription = models.getByTestId("model-default-row-transcription");
      await transcription.getByTestId("meetings-route").selectOption("set-up:assemblyai");
      const form = transcription.getByTestId("transcription-key-form-assemblyai");
      await expect(form.getByTestId("transcription-key-input")).toBeFocused();
      await transcription.scrollIntoViewIfNeeded();
      const row = await transcription.boundingBox();
      for (const part of [
        form.getByTestId("transcription-key-input"),
        form.getByTestId("transcription-set-up-consent"),
        form.getByTestId("transcription-key-save"),
      ]) {
        const inner = await part.boundingBox();
        expect(row && inner && inner.x + inner.width <= row.x + row.width).toBe(true);
      }
      await shot(window, `after-models-set-up-${language}-${width}`);
      await window.keyboard.press("Escape");
      await expect(form).toHaveCount(0);
      expect(await page.evaluate((each) => each.scrollWidth <= each.clientWidth)).toBe(true);

      const meetings = await showSettingsPage(window, "meetings");
      const section = meetings.getByTestId("meetings-settings");
      await expect(section.getByTestId("transcription-key-row")).toHaveCount(0);
      await shot(window, `after-meetings-${language}-${width}`);
      // Meetings says where the audio goes; the choice is made in Settings › AI, one press away.
      await expect(section.getByTestId("meetings-route")).toHaveCount(0);
      const change = section.getByTestId("meetings-route-change");
      const sectionBox = await section.boundingBox();
      const changeBox = await change.boundingBox();
      expect(
        sectionBox && changeBox && changeBox.x + changeBox.width <= sectionBox.x + sectionBox.width,
      ).toBe(true);
      const meetingsPage = meetings.locator('[data-testid="settings-page-meetings"]');
      expect(await meetingsPage.evaluate((each) => each.scrollWidth <= each.clientWidth)).toBe(
        true,
      );
      await change.click();
      await expect(settings).toHaveAttribute("data-page", "ai");
      await expect(transcription.getByTestId("meetings-route")).toBeFocused();
    }
    await expect(settings).toBeVisible();
  });
}
