import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import {
  ANTHROPIC_KEY,
  acceptPlainTextKeys,
  addDocuments,
  assistantAnswers,
  controlReads,
  createDataFolder,
  dismissChatSetup,
  firstTranscriptLine,
  launchApp,
  newMind,
  openSettings,
  paletteOffers,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  runCommand,
  useCloudChatModel as setCloudChatModel,
  setLanguage,
  useLocalChatModel as setLocalChatModel,
  setWindowSize,
  showSettingsPage,
} from "./app";

/*
 * A model set up in IncarnaMind (#1922), as a profile from before #3767 has it: no model is set up
 * in the interface any more, so each spec sets one up through the core. Settings › AI says what
 * each choice sends (ADR-0022). Meeting transcription and sorting are chosen where they are used.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const bridge = (window: Page) => ({
  settings: () =>
    window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getSettings(),
    ),
  library: () =>
    window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return (await core.getLibrary()).settings;
    }),
});

for (const language of ["en", "zh-CN"] as const) {
  test(`after the first Answer the composer is there, ⌘J takes it and a follow-up is asked, with no setup step in the way (${language}, 1280 × 800) (#2310, #3767)`, async () => {
    const { app, window } = await launchApp(dataDir, {
      fakeChat: true,
      ollama: "http://127.0.0.1:9",
    });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      // A model is no longer set up in the interface (#3767): the profile has one.
      await setCloudChatModel(window, { cap: false });
      await newMind(window);
      const composer = window.getByTestId("composer-input");
      if (!(await composer.isVisible())) await window.keyboard.press("ControlOrMeta+Shift+O");
      await composer.click();
      await window.keyboard.type("What is in my Documents?");
      await window.keyboard.press("Enter");
      await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
        timeout: 20_000,
      });

      // Nothing waits above the composer.
      await expect(composer).toBeVisible();

      // ⌘J puts the cursor in the composer, from the Mind.
      await window.getByTestId("mind-editor").click();
      await window.keyboard.press("ControlOrMeta+j");
      await expect(composer).toBeFocused();

      // A follow-up is typed and sent, with no setup step ever taken.
      const followUp = language === "zh-CN" ? "再说得具体一点？" : "Tell me more about that?";
      await window.keyboard.type(followUp);
      await window.keyboard.press("Enter");
      await expect(assistantAnswers(window)).toHaveCount(2, { timeout: 20_000 });
      await expect(window.getByTestId("assistant-question").last()).toContainText(followUp);
      await expect(composer).toBeVisible();
    } finally {
      await app.close();
    }
  });
}

const failReads = async (app: ElectronApplication, channel: string, failing: boolean) => {
  await controlReads(app, channel, { failing });
};

/** Lets the page paint `count` times, so what a settled read changes has been drawn. */
function paints(window: Page, count = 15): Promise<void> {
  return window.evaluate(
    (times) =>
      new Promise<void>((done) => {
        let seen = 0;
        const next = () => (++seen >= times ? done() : requestAnimationFrame(next));
        next();
      }),
    count,
  );
}

// A model on this computer and a cloud model Ollama forwards to ollama.com, on one server.
const OLLAMA_MODELS = [
  { modelId: "qwen3.5:4b", shown: "Qwen 3.5 4B", cloud: false },
  { modelId: "gpt-oss:120b-cloud", shown: "gpt-oss:120b-cloud", cloud: true },
] as const;

/** Saves `modelId` on the saved Ollama server for sorting, as the Other model form does. */
async function saveSortingOnOllama(window: Page, modelId: string): Promise<void> {
  await window.evaluate(async (model) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const ollama = (await core.listChatProviders()).find((each) => each.kind === "ollama");
    if (!ollama) throw new Error("No Ollama server is saved.");
    await core.saveLibrarySettings({
      ...(await core.getLibrary()).settings,
      classifier: { kind: "chat", choice: { providerId: ollama.id, modelId: model } },
    });
  }, modelId);
}

/** Makes `modelId` on the saved Ollama server the chat default. */
async function saveOllamaDefault(window: Page, modelId: string): Promise<void> {
  await window.evaluate(async (model) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await core.saveChatProvider({ kind: "ollama", modelId: model });
  }, modelId);
}

async function removeOllama(window: Page): Promise<void> {
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    for (const provider of await core.listChatProviders()) {
      if (provider.kind === "ollama") await core.deleteChatProvider(provider.id);
    }
  });
}

/** Saves Anthropic with `modelId`, which makes that model the chat default. */
async function saveAnthropicAsDefault(window: Page, modelId: string): Promise<void> {
  await window.evaluate(
    async ({ id, key }) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.saveChatProvider({ kind: "anthropic", apiKey: key, modelId: id });
    },
    { id: modelId, key: ANTHROPIC_KEY },
  );
}

/** Saves OpenAI, which makes OpenAI the chat default. */
async function saveOpenAiAsDefault(window: Page): Promise<void> {
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await core.saveChatProvider({ kind: "openai", apiKey: "sk-test-b", modelId: "gpt-6-luna" });
  });
}

/** Removes Anthropic's provider and its key, so a choice saved on it names a model that is gone. */
async function removeAnthropic(window: Page): Promise<void> {
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    for (const provider of await core.listChatProviders()) {
      if (provider.kind === "anthropic") await core.deleteChatProvider(provider.id);
    }
  });
}

/** What Settings › AI's Organize and Tags switch says each new Document sends, and to whom. */
function organizeWords(settings: Locator): Promise<string> {
  return settings
    .getByTestId("tagging-automatic-sends")
    .evaluate((line) => (line as HTMLElement).innerText);
}

// A role model, one that is no role, and one the User added: each saved for sorting.
const SORTING_MODELS = [
  { modelId: "claude-haiku-5-5", model: "Claude Haiku 5.5" },
  { modelId: "claude-sonnet-5-5", model: "Claude Sonnet 5.5" },
  { modelId: "claude-added-by-the-user", model: "claude-added-by-the-user" },
] as const;

for (const language of ["en", "zh-CN"] as const) {
  for (const { modelId, model } of SORTING_MODELS) {
    test(`Settings › AI says the same of ${model} saved for sorting when it isn't the chat default (${language})`, async () => {
      const { app, window } = await launchApp(dataDir, { fakeChat: true });
      try {
        await setWindowSize(app, window, 1280, 800);
        await acceptPlainTextKeys(window);
        await saveAnthropicAsDefault(window, modelId);
        await window.evaluate(async () => {
          const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          const chosen = (await core.getSettings()).user.chatModel;
          const library = (await core.getLibrary()).settings;
          if (chosen)
            await core.saveLibrarySettings({
              ...library,
              classifier: { kind: "chat", choice: chosen },
            });
        });
        await saveOpenAiAsDefault(window);
        await dismissChatSetup(window);
        // The button that opens Settings is named in English until the language is changed inside it.
        const settings = await openSettings(window, "ai");
        await setLanguage(window, language);
        await expect(
          settings.getByTestId("models-sorting").locator("option", {
            hasText: translate(language, "models.sorting.chat", { model: "GPT-6 Luna" }),
          }),
        ).toHaveCount(1);
        await expect(settings.getByTestId("models-sorting").locator("option:checked")).toHaveText(
          model,
        );
        const words = await organizeWords(settings);
        expect(words).toContain(
          translate(language, "setup.sorting.sendsWhenOn", { service: "Anthropic" }),
        );
        expect(words).not.toContain(translate(language, "setup.sorting.chatHere", { model }));

        // Anthropic is removed with Settings open: sorting goes back to Automatic (#2693), and the
        // line names Automatic's pick, never the model that is gone.
        await removeAnthropic(window);
        await expect
          .poll(() => organizeWords(settings))
          .toContain(translate(language, "setup.sorting.sendsWhenOn", { service: "OpenAI" }));
        await expect(
          settings.getByTestId("models-sorting").locator("option:checked"),
        ).not.toHaveText(model);
        const after = await organizeWords(settings);
        expect(after).not.toContain(model);
        expect(after).not.toContain("Anthropic");
        const classifier = await window.evaluate(async () => {
          const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          return (await core.getLibrary()).settings.classifier;
        });
        expect(classifier).toEqual({ kind: "automatic" });
      } finally {
        await app.close();
      }
    });
  }

  for (const { modelId, shown, cloud } of OLLAMA_MODELS) {
    for (const chatDefault of ["the same", "another"] as const) {
      test(`Settings › AI: a sorting choice on ${modelId}, ${cloud ? "a cloud model" : "a model on this computer"} of one Ollama server, with ${chatDefault} chat default, says what the core says of where it goes (${language})`, async () => {
        const { app, window } = await launchApp(dataDir, { fakeChat: true });
        try {
          await setWindowSize(app, window, 1280, 800);
          await acceptPlainTextKeys(window);
          await setLocalChatModel(window);
          await saveSortingOnOllama(window, modelId);
          if (chatDefault === "the same") await saveOllamaDefault(window, modelId);
          else await saveOpenAiAsDefault(window);
          await dismissChatSetup(window);
          // The button that opens Settings is named in English until the language is changed inside it.
          const settings = await openSettings(window, "ai");
          await setLanguage(window, language);
          await expect(settings.getByTestId("models-sorting")).toBeEnabled();
          await expect.poll(() => organizeWords(settings)).not.toBe("");
          const words = await organizeWords(settings);
          // The core's own answer: where the saved choice goes, and what it registers for tagging.
          const told = await window.evaluate(async () => {
            const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
            const answer = (await core.getTaggingModels()).saved?.destination;
            const flows = await core.listRegisteredDataFlows();
            return {
              answer,
              registered: flows
                .find((flow) => flow.id === "tagging")
                ?.services.map((each) => each.flow.service.id),
            };
          });
          if (cloud) {
            if (told.answer?.kind !== "service") throw new Error("The core says nothing leaves.");
            expect(told.registered).toContain(told.answer.service.id);
            expect(words).toContain(
              translate(language, "setup.sorting.sendsWhenOn", {
                service: told.answer.service.name,
              }),
            );
            expect(words).not.toContain(
              translate(language, "setup.sorting.chatHere", { model: shown }),
            );
          } else {
            expect(told.answer?.kind).toBe("here");
            // The same model as Answers reads as "Use {model}"; another, by its name.
            await expect(
              settings.getByTestId("models-sorting").locator("option:checked"),
            ).toContainText(
              chatDefault === "the same"
                ? translate(language, "models.sorting.chat", { model: shown })
                : shown,
            );
            expect(words).toBe(translate(language, "tagging.automatic.local"));
          }

          // Its provider is removed: sorting goes back to Automatic (#2693), and the line names
          // Automatic's pick, never the model that is gone.
          if (chatDefault === "another") {
            await removeOllama(window);
            await expect
              .poll(async () => (await bridge(window).library()).classifier.kind)
              .toBe("automatic");
            await expect
              .poll(() => organizeWords(settings))
              .toContain(translate(language, "setup.sorting.sendsWhenOn", { service: "OpenAI" }));
            expect(await organizeWords(settings)).not.toContain(shown);
          }
        } finally {
          await app.close();
        }
      });
    }
  }
}

// What Settings › AI reads to say what sorts: the core's models, with its answer for the
// saved choice. The core is the only thing it asks, so it is the one read that can fail.
const SORTING_READS = [
  { channel: "core:getTaggingModels", name: "the models that can sort", atFirst: true },
] as const;

for (const language of ["en", "zh-CN"] as const) {
  for (const { channel, name, atFirst } of SORTING_READS) {
    test(`Settings › AI says in place when ${name} can't be read, ${atFirst ? "at first and " : ""}on a read again (${language})`, async () => {
      const { app, window } = await launchApp(dataDir, { fakeChat: true });
      try {
        await setWindowSize(app, window, 1280, 800);
        await acceptPlainTextKeys(window);
        await window.evaluate(async () => {
          const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          await core.saveChatProvider({
            kind: "anthropic",
            apiKey: "sk-ant-test-a",
            modelId: "claude-haiku-5-5",
          });
        });
        await dismissChatSetup(window);
        const problem = window.getByTestId("models-sorting-problem");
        const words = translate(language, "setup.sorting.failed");

        // At first: Settings opens while the core can't answer.
        // The button that opens Settings is named in English until the language is changed inside it.
        if (atFirst) await failReads(app, channel, true);
        const settings = await openSettings(window, "ai");
        await setLanguage(window, language);
        if (atFirst) {
          await expect(problem).toContainText(words);
          await expect(settings.getByTestId("models-sorting")).toHaveCount(0);
          await expect(settings.getByTestId("models-sorting-line")).toHaveCount(0);
          await failReads(app, channel, false);
          await pointAndClick(window, settings.getByTestId("models-sorting-problem-retry"));
        }
        await expect(settings.getByTestId("models-sorting")).toBeEnabled();
        await expect(problem).toHaveCount(0);

        // Read again: another model becomes the default while the core can't answer.
        await failReads(app, channel, true);
        await saveOpenAiAsDefault(window);
        await expect(problem).toContainText(words);
        await expect(settings.getByTestId("models-sorting")).toHaveCount(0);
        await failReads(app, channel, false);
        await pointAndClick(window, settings.getByTestId("models-sorting-problem-retry"));
        await expect(settings.getByTestId("models-sorting")).toBeEnabled();
      } finally {
        await app.close();
      }
    });
  }
}

for (const language of ["en", "zh-CN"] as const) {
  test(`Settings › Meetings says a failed read of the services in place, and keeps the saved cloud route (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await saveOpenAiAsDefault(window);
      await window.evaluate(async () => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await core.updateSettings({ device: { transcriptionRoute: "openai" } });
      });
      await dismissChatSetup(window);
      // The button that opens Settings is named in English until the language is changed inside it.
      const dialog = await openSettings(window, "meetings");
      await setLanguage(window, language);
      const settings = dialog.getByTestId("meetings-settings");
      const line = settings.getByTestId("meetings-route-line");
      await expect(line).toContainText(
        translate(language, "meetings.route.cloudLine", { provider: "OpenAI" }),
      );

      // Settings is closed and opened again while the core can't list the services.
      await controlReads(app, "core:listTranscriptionServices", { failing: true });
      await closeSettingsDialog(window);
      const again = await settingsOnMeetings(window);
      const problem = again.getByTestId("meetings-settings").getByTestId("meetings-route-problem");
      await expect(problem).toContainText(translate(language, "setup.services.failed"));
      const meetings = again.getByTestId("meetings-settings");
      await expect(meetings.getByTestId("meetings-route-line")).toHaveCount(0);
      // The saved route is still OpenAI: nothing says it is on this computer.
      const route = await window.evaluate(async () => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        return (await core.getSettings()).device.transcriptionRoute;
      });
      expect(route).toBe("openai");
      await expect(meetings).not.toContainText(translate(language, "meetings.route.hereLine"));

      await controlReads(app, "core:listTranscriptionServices", { failing: false });
      await pointAndClick(window, meetings.getByTestId("meetings-route-problem-retry"));
      await expect(meetings.getByTestId("meetings-route-line")).toContainText(
        translate(language, "meetings.route.cloudLine", { provider: "OpenAI" }),
      );
      await expect(problem).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
}

const SERVICES = "core:listTranscriptionServices";
const OWN_KEY = "soniox-test-key";

/** Opens Settings on Meetings with the keyboard: its button is named in English only. */
async function settingsOnMeetings(window: Page): Promise<Locator> {
  await window.keyboard.press("ControlOrMeta+,");
  return showSettingsPage(window, "meetings");
}

/** Opens Settings on Models with the keyboard, where Your providers keeps the transcription keys. */
async function settingsOnModels(window: Page): Promise<Locator> {
  await window.keyboard.press("ControlOrMeta+,");
  return showSettingsPage(window, "ai");
}

const sonioxRow = (settings: Locator) =>
  settings.locator('[data-testid="transcription-key-row"][data-host="soniox"]');

async function closeSettingsDialog(window: Page): Promise<void> {
  await window.getByTestId("settings-close").click();
  await expect(window.getByTestId("settings")).toBeHidden();
}

test("Settings › AI offers a cloud route once a key is saved, says what choosing it sends before the choice, and this computer stays chosen until then", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await setWindowSize(app, window, 1100, 900);
    await acceptPlainTextKeys(window);
    await setLocalChatModel(window);
    await dismissChatSetup(window);
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.setTranscriptionKey({ route: "soniox", apiKey: "soniox-a-test-key" });
    });
    const settings = await openSettings(window, "ai");
    const route = settings
      .getByTestId("model-default-row-transcription")
      .getByTestId("meetings-route");
    await expect(route).toHaveValue("local");
    await expect
      .poll(() =>
        route.evaluate((select) =>
          [...(select as HTMLSelectElement).options]
            .filter((each) => !each.value.startsWith("set-up:"))
            .map((each) => each.textContent),
        ),
      )
      .toEqual(["Soniox", "On this computer"]);
    // Choosing a cloud route is the consent, so its group says what goes before it is chosen,
    // and nothing is chosen yet.
    await expect(route.locator("optgroup").first()).toHaveAttribute(
      "label",
      "Your keys · gets the meeting’s audio while you record",
    );
    const consent = settings.getByTestId("meetings-route-consent");
    await expect(consent).toHaveText(
      "Once you choose a cloud service, it gets the meeting’s audio while you record, with your name, your Words to know, the meeting’s folder name, and the names and other capitalised words in its note, calendar event and folder’s documents.",
    );
    expect((await bridge(window).settings()).device.transcriptionRoute).toBeNull();

    await route.selectOption("soniox");
    await expect(consent).toHaveText(
      "Audio goes to Soniox while you record, with your name, your Words to know, the meeting’s folder name, and the names and other capitalised words in its note, calendar event and folder’s documents.",
    );
    await expect
      .poll(async () => (await bridge(window).settings()).device.transcriptionRoute)
      .toBe("soniox");
  } finally {
    await app.close();
  }
});

const MEETING_ROUTE_LINES = {
  en: {
    once: "Once you choose a cloud service, it gets the meeting’s audio while you record, with your name, your Words to know, the meeting’s folder name, and the names and other capitalised words in its note, calendar event and folder’s documents.",
    sends:
      "Audio goes to Soniox while you record, with your name, your Words to know, the meeting’s folder name, and the names and other capitalised words in its note, calendar event and folder’s documents.",
    paused: "Paused: “Keep everything on this computer” is on.",
  },
  "zh-CN": {
    once: "选择云服务后，录音期间会议音频会发送给该服务，同时发送你的名字、要识别的词、会议所在文件夹的名称，以及会议笔记、日历事件和该文件夹文档里的名字和首字母大写的词。",
    sends:
      "录音期间，音频会发送给 Soniox，同时发送你的名字、要识别的词、会议所在文件夹的名称，以及会议笔记、日历事件和该文件夹文档里的名字和首字母大写的词。",
    paused: "已暂停：已开启“所有内容都留在这台电脑上”。",
  },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  test(`Settings › AI: Local mode pauses the Meeting transcription line instead of saying where the audio goes, and turning it off brings the line back (${language})`, async () => {
    const said = MEETING_ROUTE_LINES[language];
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1440, 900);
      await acceptPlainTextKeys(window);
      await setLocalChatModel(window);
      await dismissChatSetup(window);
      await window.evaluate(async () => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await core.setTranscriptionKey({ route: "soniox", apiKey: "soniox-a-test-key" });
      });
      const settings = await openSettings(window, "ai");
      await setLanguage(window, language);
      const row = settings.getByTestId("model-default-row-transcription");
      const route = row.getByTestId("meetings-route");
      const consent = row.getByTestId("meetings-route-consent");
      const localMode = (on: boolean) =>
        window.evaluate(
          (value) =>
            (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.setLocalOnly(value),
          on,
        );
      const fits = async (line: Locator) => {
        const fitsItsBox = await line.evaluate(
          (each) =>
            each.scrollWidth <= each.clientWidth &&
            each.scrollHeight <= each.clientHeight + 1 &&
            each.getBoundingClientRect().right <= document.documentElement.clientWidth &&
            document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        );
        expect(fitsItsBox).toBe(true);
      };

      // No service chosen: the line says what choosing one sends, and Local mode takes the choice away.
      await expect(consent).toHaveText(said.once);
      await localMode(true);
      await expect(consent).toHaveCount(0);
      await expect(row).not.toContainText(said.once);
      await localMode(false);
      await expect(consent).toHaveText(said.once);

      await route.selectOption("soniox");
      await expect(consent).toHaveText(said.sends);
      for (const [width, height] of [
        [1440, 900],
        [900, 720],
      ] as const) {
        await setWindowSize(app, window, width, height);
        await expect(consent).toHaveText(said.sends);
        await fits(consent);

        // Local mode: nothing is sent, so the line says it is paused and never names the service, on
        // this page and on Settings › Meetings. The choice itself is kept.
        await localMode(true);
        await expect(consent).toHaveText(said.paused);
        await expect(route).toHaveValue("local");
        await expect(row).not.toContainText("Soniox");
        await fits(consent);
        expect((await bridge(window).settings()).device.transcriptionRoute).toBe("soniox");
        const meetings = await showSettingsPage(window, "meetings");
        await expect(meetings.getByTestId("meetings-route-line")).toContainText(said.paused);
        await expect(meetings.getByTestId("meetings-route-line")).not.toContainText(said.sends);
        await showSettingsPage(window, "ai");

        await localMode(false);
        await expect(consent).toHaveText(said.sends);
        await expect(route).toHaveValue("soniox");
        await fits(consent);
      }
    } finally {
      await app.close();
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`Try again keeps the focus as a retry fails again (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      await saveOpenAiAsDefault(window);
      await dismissChatSetup(window);
      await controlReads(app, SERVICES, { failing: true });
      const meetings = (await settingsOnMeetings(window)).getByTestId("meetings-settings");
      const retry = meetings.getByTestId("meetings-route-problem-retry");
      await expect(retry).toBeVisible();

      // Focused, Try again disables itself while the retry runs, and that failing too gives it back
      // with the focus.
      await retry.focus();
      await controlReads(app, SERVICES, { failing: false, hold: 1 });
      await window.keyboard.press("Enter");
      await expect(retry).toBeDisabled();
      await controlReads(app, SERVICES, { settle: "reject" });
      await expect(retry).toBeEnabled();
      await expect(retry).toBeFocused();
      await expect(meetings.getByTestId("meetings-route-line")).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test(`a read that fails while the focus is elsewhere leaves it there, and the problem still shows (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await window.evaluate(async () => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await core.saveChatProvider({
          kind: "anthropic",
          apiKey: "sk-ant-test-a",
          modelId: "claude-haiku-5-5",
        });
      });
      await dismissChatSetup(window);

      // Settings › AI is open, and the User is on the meeting transcription row.
      const settings = await openSettings(window, "ai");
      await setLanguage(window, language);
      await expect(settings.getByTestId("models-sorting")).toBeEnabled();
      const elsewhere = settings
        .getByTestId("model-default-row-transcription")
        .getByTestId("meetings-route");
      await elsewhere.focus();
      await expect(elsewhere).toBeFocused();

      // The sorting read is made again, as another model becomes the default, and fails: the
      // problem shows, and the focus stays where the User put it.
      await controlReads(app, "core:getTaggingModels", { failing: true });
      await saveOpenAiAsDefault(window);
      await expect(settings.getByTestId("models-sorting-problem")).toContainText(
        translate(language, "setup.sorting.failed"),
      );
      await paints(window);
      await expect(elsewhere).toBeFocused();
      await expect(settings.getByTestId("models-sorting-problem-retry")).not.toBeFocused();
    } finally {
      await app.close();
    }
  });

  test(`a read of the services that was overtaken changes nothing when it fails after a newer one has landed (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      await saveOpenAiAsDefault(window);
      await window.evaluate(async () => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await core.updateSettings({ device: { transcriptionRoute: "openai" } });
      });
      await dismissChatSetup(window);

      // Meetings opens and its read, A, is held. Settings is closed and opened again, and the
      // read of this showing, B, lands. Then A fails, long after.
      await controlReads(app, SERVICES, { hold: 1 });
      await settingsOnMeetings(window);
      await closeSettingsDialog(window);
      const dialog = await settingsOnMeetings(window);
      const meetings = dialog.getByTestId("meetings-settings");
      const line = meetings.getByTestId("meetings-route-line");
      await expect(line).toContainText(
        translate(language, "meetings.route.cloudLine", { provider: "OpenAI" }),
      );
      await paints(window);
      const before = await meetings.boundingBox();

      await controlReads(app, SERVICES, { settle: "reject" });
      await paints(window);
      // The newer read stands: its list is drawn, nothing says a read failed, and nothing moved.
      await expect(line).toContainText(
        translate(language, "meetings.route.cloudLine", { provider: "OpenAI" }),
      );
      await expect(meetings.getByTestId("meetings-route-problem")).toHaveCount(0);
      expect(await meetings.boundingBox()).toEqual(before);
    } finally {
      await app.close();
    }
  });

  test(`a failed read stays with the view that asked: older reads landing with the list change neither its problem nor its Try again (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      await saveOpenAiAsDefault(window);
      await dismissChatSetup(window);

      // Meetings opens and its read is held. Settings goes to Models, whose own read is the one
      // that fails.
      await controlReads(app, SERVICES, { hold: 1 });
      const dialog = await settingsOnMeetings(window);
      await controlReads(app, SERVICES, { failNext: 1 });
      await showSettingsPage(window, "ai");
      const models = dialog.getByTestId("ai-jobs");
      const problem = models.getByTestId("meetings-route-problem");
      const retry = models.getByTestId("meetings-route-problem-retry");
      await expect(problem).toContainText(translate(language, "setup.services.failed"));
      await expect(retry).toBeEnabled();

      // The older read lands with the list: the problem is the view's own, and stays.
      await controlReads(app, SERVICES, { settle: "resolveAll" });
      await paints(window);
      await expect(problem).toBeVisible();
      await expect(retry).toBeEnabled();

      // Try again reads for this view, and the problem goes.
      await pointAndClick(window, retry);
      await expect(problem).toHaveCount(0);
      await expect(models.getByTestId("meetings-route")).toBeEnabled();
    } finally {
      await app.close();
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a view reads once for everything it shows, so its Try again brings back the line, the key rows and the alternatives together (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      await saveOpenAiAsDefault(window);
      await window.evaluate(async (apiKey) => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await core.setTranscriptionKey({ route: "soniox", apiKey });
        await core.updateSettings({ device: { transcriptionRoute: "soniox" } });
      }, OWN_KEY);
      await dismissChatSetup(window);
      // The picker's own routes, without the services its foot sets up.
      const offered = (scope: Locator) =>
        scope.getByTestId("meetings-route").evaluate((select) =>
          [...(select as HTMLSelectElement).options]
            .map((each) => each.value)
            .filter((value) => !value.startsWith("set-up:"))
            .sort(),
        );

      // Every read of the list fails as Settings opens: Meetings says so once.
      await controlReads(app, SERVICES, { failing: true });
      const dialog = await settingsOnMeetings(window);
      const meetings = dialog.getByTestId("meetings-settings");
      const problem = meetings.getByTestId("meetings-route-problem");
      await expect(problem).toContainText(translate(language, "setup.services.failed"));
      // Settings › AI reads once for its page when it is first shown, and fails as well: its
      // picker offers the saved route, and Your providers lists no transcription key.
      await showSettingsPage(window, "ai");
      const models = dialog.getByTestId("ai-jobs");
      const modelsProblem = models.getByTestId("meetings-route-problem");
      await expect(modelsProblem).toBeVisible();
      await expect.poll(() => offered(models)).toEqual(["local", "soniox"]);
      await expect(sonioxRow(dialog)).toHaveCount(0);
      await showSettingsPage(window, "meetings");

      // The core is back, and the one Try again brings back all of Meetings.
      await controlReads(app, SERVICES, { failing: false });
      await pointAndClick(window, meetings.getByTestId("meetings-route-problem-retry"));
      await expect(problem).toHaveCount(0);
      await expect(meetings.getByTestId("meetings-route-line")).toContainText(
        translate(language, "meetings.route.cloudLine", { provider: "Soniox" }),
      );

      // Settings › AI read for itself, so its failure stands until it is tried again; its
      // Try again brings back the picker and the key row together.
      await showSettingsPage(window, "ai");
      await expect(modelsProblem).toBeVisible();
      await expect.poll(() => offered(models)).toEqual(["local", "soniox"]);
      await pointAndClick(window, models.getByTestId("meetings-route-problem-retry"));
      await expect(modelsProblem).toHaveCount(0);
      await expect.poll(() => offered(models)).toEqual(["local", "openai", "soniox"]);
      await expect(sonioxRow(dialog)).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test(`a key saved while newer reads come back without it shows as saved when the save lands (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      const first = await settingsOnModels(window);
      await first
        .getByTestId("model-default-row-transcription")
        .getByTestId("meetings-route")
        .selectOption("set-up:soniox");
      const form = first.getByTestId("transcription-key-form-soniox");
      await form.getByTestId("transcription-key-input").fill(OWN_KEY);

      // Use this is pressed and held before the core has the key; Models is closed and opened
      // again, and its newer reads say there is no key.
      await controlReads(app, "core:setTranscriptionKey", { hold: 1 });
      await form.getByTestId("transcription-key-save").click();
      await expect.poll(() => controlReads(app, "core:setTranscriptionKey", {})).toBe(1);
      await closeSettingsDialog(window);
      const again = await settingsOnModels(window);
      // With no model and no key kept yet, there is no Accounts and keys (#3645).
      await expect(again.getByTestId("ai-limits")).toBeVisible();
      await expect(sonioxRow(again)).toHaveCount(0);

      // The core keeps the key: Your providers lists it, though the reads that came back are
      // newer. The form went with Settings, so nothing was chosen.
      await controlReads(app, "core:setTranscriptionKey", { settle: "resolve" });
      await expect(sonioxRow(again)).toBeVisible();
      await expect(
        again.getByTestId("model-default-row-transcription").getByTestId("meetings-route"),
      ).toHaveValue("local");
    } finally {
      await app.close();
    }
  });

  test(`a key removed while newer reads still have it shows as removed when the removal lands (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      await window.evaluate(async (apiKey) => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await core.setTranscriptionKey({ route: "soniox", apiKey });
      }, OWN_KEY);
      const first = await settingsOnModels(window);
      await expect(sonioxRow(first)).toBeVisible();

      // Remove key is pressed and held before the core has it; Models is closed and opened
      // again, and its newer reads still have the key.
      await controlReads(app, "core:removeTranscriptionKey", { hold: 1 });
      await sonioxRow(first).getByTestId("transcription-key-remove").click();
      await expect.poll(() => controlReads(app, "core:removeTranscriptionKey", {})).toBe(1);
      await closeSettingsDialog(window);
      const again = await settingsOnModels(window);
      await expect(sonioxRow(again)).toBeVisible();

      // The core forgets the key: its row goes.
      await controlReads(app, "core:removeTranscriptionKey", { settle: "resolve" });
      await expect(sonioxRow(again)).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a read the core answered before a removal changes nothing when it arrives after it (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      await window.evaluate(async (apiKey) => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await core.setTranscriptionKey({ route: "soniox", apiKey });
      }, OWN_KEY);
      const first = await settingsOnModels(window);
      await expect(sonioxRow(first)).toBeVisible();
      await closeSettingsDialog(window);

      // Models is opened again: the core answers its reads with the key, and they are held.
      await controlReads(app, SERVICES, { hold: 50, after: true });
      const again = await settingsOnModels(window);
      const row = sonioxRow(again);
      await expect.poll(() => controlReads(app, SERVICES, {})).toBeGreaterThanOrEqual(1);
      await row.getByTestId("transcription-key-remove").click();
      await expect(row).toHaveCount(0);

      // The held answers, older than the removal, arrive: nothing changes.
      await controlReads(app, SERVICES, { settle: "resolveAll" });
      await paints(window);
      await expect(row).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
}

test("Settings › AI shows the jobs, editable in place, with Quick tasks following Answers", async () => {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    ollama: "http://127.0.0.1:9",
  });
  try {
    await setWindowSize(app, window, 1100, 900);
    await acceptPlainTextKeys(window);
    await setLocalChatModel(window);
    await dismissChatSetup(window);
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.setTranscriptionKey({ route: "soniox", apiKey: "soniox-test-key" });
      await core.updateSettings({ device: { transcriptionRoute: "soniox" } });
    });
    const settings = await openSettings(window, "ai");

    await expect(settings.getByTestId("model-default-chatModel")).toBeVisible();
    await expect(
      settings.getByTestId("model-default-quickTasksModel").locator("option:checked"),
    ).toHaveText(/^Follows Answers/);
    // The model on this computer doesn't read images: the row says so rather than following it.
    await expect(
      settings.getByTestId("model-default-imageModel").locator("option:checked"),
    ).toHaveText("No model reads images yet");

    // Meeting transcription, changed where it is shown: one line tall, as a field in its row.
    const meetings = settings.getByTestId("meetings-route");
    await expect(meetings).toHaveValue("soniox");
    expect((await meetings.boundingBox())?.height ?? 0).toBeLessThan(48);
    await meetings.selectOption("local");
    await expect
      .poll(async () => (await bridge(window).settings()).device.transcriptionRoute)
      .toBe("local");

    // What sorts, saved where it is shown: the select is the setting, one line tall.
    const sorting = settings.getByTestId("models-sorting");
    // The model Answers use, by its name.
    const own = sorting.locator("option:checked");
    await expect(own).toHaveText(/^Use /);
    expect((await sorting.boundingBox())?.height ?? 0).toBeLessThan(48);
    await sorting.selectOption({ label: (await own.textContent()) ?? "" });
    await expect.poll(async () => (await bridge(window).library()).classifier.kind).toBe("chat");
  } finally {
    await app.close();
  }
});

test("Local mode offers only choices on this computer in Settings › AI, and nothing to set up (#3767)", async () => {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    ollama: "http://127.0.0.1:9",
  });
  try {
    await setWindowSize(app, window, 1100, 900);
    await acceptPlainTextKeys(window);
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.setLocalOnly(true);
    });
    await setLocalChatModel(window);
    const settings = await openSettings(window, "ai");
    await expect(settings.getByTestId("meetings-route").locator("option")).toHaveText([
      "On this computer",
    ]);
    // The picker chooses among what is set up: it offers no model to set up (#3767).
    await expect(settings.getByTestId("models-sorting").locator("option")).toHaveText([/^Use /]);
  } finally {
    await app.close();
  }
});

test("call help with no model offers no key field, and the buttons come once a model works (#3767)", async () => {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    ollama: "http://127.0.0.1:9",
  });
  try {
    await setWindowSize(app, window, 1440, 900);
    await acceptPlainTextKeys(window);
    await setLanguage(window, "en");
    const control = await recordMeeting(window);
    await expect(control).toBeVisible();
    await firstTranscriptLine(window);
    await window.getByTestId("mind-editor").click();
    // With no model, the assistant isn't shown, and nothing offers a key to set one up.
    await expect(window.getByTestId("meeting-needs-model")).toHaveCount(0);
    await expect(window.getByTestId("meeting-starters")).toHaveCount(0);
    await setLocalChatModel(window);
    await expect(window.getByTestId("meeting-starters")).toBeVisible();
  } finally {
    await app.close();
  }
});

test("Compare Documents isn't offered with no model, and runs once a model works (#3767)", async () => {
  const sources = await mkdtemp(join(tmpdir(), "incarnamind-1922-compare-"));
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    ollama: "http://127.0.0.1:9",
  });
  try {
    await setWindowSize(app, window, 1440, 900);
    await acceptPlainTextKeys(window);
    const corvane = join(sources, "Corvane.txt");
    const altmark = join(sources, "Altmark.txt");
    await writeFile(corvane, "Termination needs 90 days' notice.\n");
    await writeFile(altmark, "Termination needs 30 days' notice.\n");
    await addDocuments(window, [corvane, altmark]);

    await newMind(window);
    await window.keyboard.type("Shortlist: contract terms");
    await window.keyboard.press("Enter");
    await window.keyboard.type("Two suppliers made the shortlist.");
    await window.keyboard.press("Enter");
    // It fills by a model in IncarnaMind, which can't be set up here: neither ⌘K nor "/" offers it.
    expect(await paletteOffers(window, "comparison.start", "Compare Documents")).toBe(0);
    await window.keyboard.type("/");
    await expect(window.getByTestId("slash-menu")).toBeVisible();
    await window.keyboard.type("compare");
    await expect(window.getByTestId("slash-item-compare")).toHaveCount(0);
    await window.keyboard.press("Escape");
    for (let typed = 0; typed < "/compare".length; typed++)
      await window.keyboard.press("Backspace");

    await setLocalChatModel(window);
    await window.keyboard.type("/compare");
    await expect(window.getByTestId("slash-item-compare")).toBeVisible();
    await window.keyboard.press("Enter");
    const sheet = window.getByTestId("compare-sheet");
    await expect(sheet.getByTestId("compare-sheet-question").first()).toBeFocused();
    await window.keyboard.type("Termination notice");
    await pointAndClick(window, sheet.getByTestId("compare-sheet-make"));
    await expect(window.getByTestId("comparison-table")).toBeVisible({ timeout: 30_000 });
    await expect(sheet).toHaveCount(0);
  } finally {
    await app.close();
    await rm(sources, { recursive: true, force: true });
  }
});

// Choosing the model for Tags turns tagging on only where its line, saying what each new Document
// sends and to whom, is on screen before the choice (#2308, ADR-0022's amendment).
for (const language of ["en", "zh-CN"] as const) {
  test(`Settings › AI' choice for sorting says what goes once tagging is on, and leaves the switch where it was (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await saveAnthropicAsDefault(window, "claude-haiku-5-5");
      await window.evaluate(async () => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const chosen = (await core.getSettings()).user.chatModel;
        const library = (await core.getLibrary()).settings;
        if (chosen)
          await core.saveLibrarySettings({
            ...library,
            classifier: { kind: "chat", choice: chosen },
          });
      });
      await saveOpenAiAsDefault(window);
      await dismissChatSetup(window);
      const settings = await openSettings(window, "ai");
      await setLanguage(window, language);
      const select = settings.getByTestId("models-sorting");
      await expect(select.locator("option:checked")).toHaveText("Claude Haiku 5.5");
      await expect
        .poll(() => organizeWords(settings))
        .toContain(translate(language, "setup.sorting.sendsWhenOn", { service: "Anthropic" }));
      expect((await bridge(window).library()).automatic).toBe(false);

      await select.selectOption({
        label: translate(language, "models.sorting.chat", { model: "GPT-6 Luna" }),
      });
      await expect
        .poll(async () => (await bridge(window).library()).classifier)
        .toMatchObject({
          kind: "chat",
          choice: { modelId: "gpt-6-luna" },
        });
      expect((await bridge(window).library()).automatic).toBe(false);
    } finally {
      await app.close();
    }
  });
}

// With a cloud model, sorting and tagging new Documents is on but tags nothing before the User's
// yes: its switch says what each new Document sends, and to which service, and that it asks first
// (#2308, #3353). Turned off there, it is the User's no, and ⌘K offers to turn it on again.
for (const language of ["en", "zh-CN"] as const) {
  test(`Settings › AI's Organize and Tags switch is on and asks first; off is kept, and ⌘K offers it again (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await saveAnthropicAsDefault(window, "claude-haiku-5-5");
      await dismissChatSetup(window);
      await setLanguage(window, language);
      expect(
        await paletteOffers(
          window,
          "tagging.turnOn",
          translate(language, "command.tagging.turnOn"),
        ),
      ).toBe(0);
      // The button that opens Settings is named in English until the language is changed inside it.
      await setLanguage(window, "en");
      const settings = await openSettings(window, "ai");
      await setLanguage(window, language);
      const toggle = settings.getByTestId("tagging-automatic-organize");
      const asks = settings.getByTestId("tagging-automatic-asks");
      await expect(toggle).toBeChecked();
      await expect(settings.getByTestId("tagging-automatic-sends")).toHaveText(
        translate(language, "setup.sorting.sendsWhenOn", { service: "Anthropic" }),
      );
      await expect(asks).toHaveText(
        translate(language, "ai.organize.automatic.asks", { service: "Anthropic" }),
      );
      expect((await bridge(window).library()).automatic).toBe(false);

      // By keyboard: Space on the switch turns it off, the User's no.
      await toggle.focus();
      await window.keyboard.press("Space");
      await expect(toggle).not.toBeChecked();
      await expect(asks).toHaveCount(0);
      expect((await bridge(window).library()).automatic).toBe(false);
      await closeSettingsDialog(window);
      expect(
        await paletteOffers(
          window,
          "tagging.turnOn",
          translate(language, "command.tagging.turnOn"),
        ),
      ).toBe(1);
    } finally {
      await app.close();
    }
  });

  test(`⌘K's Turn on tagging opens Settings › AI at the switch the User turned off, which stays off until pressed (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1280, 800);
      await acceptPlainTextKeys(window);
      await saveAnthropicAsDefault(window, "claude-haiku-5-5");
      await dismissChatSetup(window);
      await window.evaluate(async () => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await core.saveLibrarySettings({
          ...(await core.getLibrary()).settings,
          automatic: false,
          turnOn: false,
        });
      });
      await setLanguage(window, language);
      await runCommand(window, "tagging.turnOn", translate(language, "command.tagging.turnOn"));
      const toggle = window.getByTestId("tagging-automatic-organize");
      await expect(toggle).toBeFocused();
      await expect(toggle).not.toBeChecked();
      await expect(window.getByTestId("tagging-automatic-sends")).toHaveText(
        translate(language, "setup.sorting.sendsWhenOn", { service: "Anthropic" }),
      );
      expect((await bridge(window).library()).automatic).toBe(false);
    } finally {
      await app.close();
    }
  });
}
