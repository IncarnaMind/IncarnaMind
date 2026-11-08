import { mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { createFakeOpenAI, signInAt } from "../tests/helpers/fakeOpenAI";
import {
  acceptPlainTextKeys,
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  interceptOpenExternal,
  launchApp,
  openDirectoryEntry,
  openPlanPage,
  openSettings,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  urlsOpened,
  useLocalChatModel,
} from "./app";

/*
 * Settings › AI (#2835): every AI job, account and key on one page. What each job uses, one picker
 * per job; Accounts and keys, one row per company or plan, saying what it does today and whether it
 * works; and Limits. Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const SONIOX_KEY = "soniox-test-key-0123456789";

/** An OpenAI-compatible server on this computer that lists `models`. */
async function modelServer(models: string[]): Promise<{ url: string; server: Server }> {
  const server = createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, server };
}

let dataDir: string;
let app: ElectronApplication | null = null;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await app?.close();
  app = null;
  await removeDataFolder(dataDir);
});

async function launch(options: Parameters<typeof launchApp>[1] = {}, width = 1440) {
  const launched = await launchApp(dataDir, options);
  app = launched.app;
  await setWindowSize(launched.app, launched.window, width, 900);
  await dismissChatSetup(launched.window);
  await acceptPlainTextKeys(launched.window);
  return launched.window;
}

/** An OpenAI key for Answers and an Anthropic key nothing uses, both made up: nothing is sent. */
async function twoKeys(window: Page) {
  return window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const openai = await bridge.saveChatProvider({
      kind: "openai",
      apiKey: "sk-proj-a-made-up-key",
      modelId: "gpt-6-luna",
    });
    const anthropic = await bridge.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-api03-a-made-up-key",
      modelId: "claude-haiku-5-5",
      keepDefault: true,
    });
    return { openai: openai.id, anthropic: anthropic.id };
  });
}

const route = (window: Page) =>
  window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await bridge.getSettings()).device.transcriptionRoute;
  });

/** A provider's row, by the name it shows: another row's line may name it too. */
const row = (settings: Locator, name: string) =>
  settings.locator(`[data-testid="provider-row"]:has(span[title="${name}"])`);

const TITLES = {
  en: ["What each job uses", "Accounts and keys", "Limits"],
  "zh-CN": ["各项任务使用的模型", "账户和密钥", "限制"],
} as const;

const JOBS = {
  en: [
    "Answers and writing",
    "Quick tasks",
    "Reading images",
    "Organize and Tags",
    "Meeting transcription",
    "Document search",
    "Search the web in Answers",
  ],
  "zh-CN": [
    "回答和写作",
    "快速任务",
    "读取图片",
    "整理和标签",
    "会议转写",
    "文档搜索",
    "回答时搜索网页",
  ],
} as const;

// protects=each section of the page, in both languages and at a narrow and a wide window, holds its rows inside the page with each row's words clear of its controls; fails_when=a section or job is missing, a row's line runs under its state or buttons, or the page scrolls sideways; no_claim=pixel sizes.
for (const width of [1440, 900] as const) {
  for (const language of ["en", "zh-CN"] as const) {
    test(`its three sections, each job once, at ${width} px in ${language}`, async () => {
      const window = await launch({}, width);
      await twoKeys(window);
      await window.evaluate(async (apiKey) => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await bridge.setTranscriptionKey({ route: "soniox", apiKey });
      }, SONIOX_KEY);
      const settings = await openSettings(window, "ai");
      await setLanguage(window, language);
      const page = settings.getByTestId("settings-page-ai");
      await expect(settings.getByTestId("settings-page-title")).toHaveText("AI");
      await expect(page.locator("section > h4")).toHaveText([...TITLES[language]]);

      // What each job uses: one row per job, each with one picker, and no other job row anywhere.
      const jobs = page.getByTestId("ai-jobs");
      for (const label of JOBS[language]) {
        await expect(jobs.getByText(label, { exact: true })).toHaveCount(1);
      }
      await expect(page.getByTestId("models-sorting")).toHaveCount(1);
      await expect(page.getByTestId("meetings-route")).toHaveCount(1);
      await expect(page.getByTestId("model-default-chatModel")).toHaveCount(1);

      // Each account's words end before its state, which stays inside the row; no sideways scroll.
      for (const each of await page.getByTestId("provider-row").all()) {
        const words = await each.getByTestId("provider-row-status").boundingBox();
        const state = await each.getByTestId("account-state").boundingBox();
        const box = await each.boundingBox();
        expect(words && state && words.x + words.width <= state.x + 1).toBe(true);
        expect(box && state && state.x + state.width <= box.x + box.width).toBe(true);
      }
      const keyRow = page.getByTestId("transcription-key-row");
      const words = await keyRow.getByTestId("transcription-key-status").boundingBox();
      const change = await keyRow.getByTestId("transcription-key-change").boundingBox();
      expect(words && change && words.x + words.width <= change.x).toBe(true);
      expect(await page.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await shot(window, `after-ai-${language}-${width}`);
      await page.getByTestId("ai-limits").scrollIntoViewIfNeeded();
      await shot(window, `after-ai-${language}-${width}-limits`);
    });
  }
}

// protects=each job's picker saves the User's choice for that job alone, and it is still chosen when Settings opens again; fails_when=a choice isn't kept, lands in another job, or Document search changes without asking first; no_claim=which models a provider lists.
test("each job's picker chooses, and keeps it", async () => {
  const window = await launch();
  const ids = await twoKeys(window);
  const local = await modelServer(["local-a", "local-b"]);
  try {
    const server = await window.evaluate(async (baseUrl) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return (
        await bridge.saveChatProvider({
          kind: "openai-compatible",
          baseUrl,
          modelId: "local-a",
          keepDefault: true,
        })
      ).id;
    }, local.url);
    const settings = await openSettings(window, "ai");
    const jobs = settings.getByTestId("ai-jobs");
    const choose = async (picker: Locator, value: string) => {
      await picker.selectOption(value);
      await expect(picker).toHaveValue(value);
    };

    // Answers, grouped by who pays: the User's keys, then this computer.
    const answers = jobs.getByTestId("model-default-chatModel");
    await expect(answers.locator("optgroup")).toHaveText([/GPT-6 Luna/, /local-a/]);
    await expect(answers.locator("optgroup").first()).toHaveAttribute(
      "label",
      "Your keys · billed to the key",
    );
    await choose(answers, `${server}\nlocal-b`);
    // The jobs that follow Answers say so, and each can have its own.
    const quick = jobs.getByTestId("model-default-quickTasksModel");
    await expect(quick.locator("option:checked")).toHaveText(/^Follows Answers · /);
    await choose(quick, `${server}\nlocal-a`);

    const organize = jobs.getByTestId("models-sorting");
    const sortingValue = await organize
      .locator("option:not([value='']):not([value^='set-up:'])")
      .last()
      .getAttribute("value");
    if (!sortingValue) throw new Error("Nothing can sort.");
    await choose(organize, sortingValue);

    await choose(jobs.getByTestId("meetings-route"), "openai");

    // Document search asks before it reads every Document again.
    await pointAndClick(window, jobs.getByTestId("embedding-change"));
    const confirm = window.getByTestId("embedding-confirm");
    await expect(confirm).toBeVisible();
    await confirm.getByTestId("embedding-confirm-switch").click();
    const search = jobs.getByTestId("embedding-model");
    await expect(search).toHaveValue("built-in");
    await search.selectOption("openai");
    await expect(confirm.getByTestId("embedding-confirm-cloud")).toContainText("OpenAI");
    await confirm.getByTestId("embedding-confirm-switch").click();
    await expect(search).toHaveValue("openai");

    await jobs.getByTestId("web-search-switch").check();

    await closeSettings(window);
    const kept = await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const settings = await bridge.getSettings();
      return {
        answers: settings.user.chatModel,
        quick: settings.user.quickTasksModel,
        route: settings.device.transcriptionRoute,
        web: settings.user.webSearch,
        sorting: (await bridge.getLibrary()).settings.classifier,
        search: (await bridge.getEmbeddingSettings()).provider,
      };
    });
    expect(kept).toMatchObject({
      answers: { providerId: server, modelId: "local-b" },
      quick: { providerId: server, modelId: "local-a" },
      route: "openai",
      web: true,
      search: { kind: "openai", hasApiKey: true },
    });
    expect(JSON.stringify(kept.sorting)).toBe(sortingValue);

    const again = (await openSettings(window, "ai")).getByTestId("ai-jobs");
    await expect(again.getByTestId("model-default-chatModel")).toHaveValue(`${server}\nlocal-b`);
    await expect(again.getByTestId("model-default-quickTasksModel")).toHaveValue(
      `${server}\nlocal-a`,
    );
    await expect(again.getByTestId("models-sorting")).toHaveValue(sortingValue);
    await expect(again.getByTestId("meetings-route")).toHaveValue("openai");
    await expect(again.getByTestId("embedding-model")).toHaveValue("openai");
    await expect(again.getByTestId("web-search-switch")).toBeChecked();

    // One row for OpenAI says what its one key does now: it transcribes and searches too.
    const openai = row(window.getByTestId("settings"), "OpenAI").getByTestId("provider-row-status");
    await expect(openai).toHaveText(/^Your key · Used for /);
    await expect(openai).toContainText("meeting transcription");
    await expect(openai).toContainText("Document search");
    await expect(window.getByTestId("search-key-row")).toHaveCount(0);
    expect(ids.anthropic).not.toBe(server);
  } finally {
    local.server.close();
  }
});

// protects=Reading images keeps a model of its own, apart from Answers; fails_when=it isn't kept, or Answers changes with it; no_claim=which models read images.
test("Reading images keeps its own choice", async () => {
  const window = await launch();
  const ids = await twoKeys(window);
  const settings = await openSettings(window, "ai");
  const images = settings.getByTestId("model-default-imageModel");
  await expect(images.locator("option:checked")).toHaveText("Follows Answers · GPT-6 Luna");
  await images.selectOption(`${ids.openai}\ngpt-6-luna`);
  await closeSettings(window);
  const again = await openSettings(window, "ai");
  await expect(again.getByTestId("model-default-imageModel")).toHaveValue(
    `${ids.openai}\ngpt-6-luna`,
  );
});

// protects=a key row says what it is used for today and whether it works, and one nothing uses says "not used yet" and what it can do, in both languages; fails_when=a row claims a use it doesn't have, or says nothing of its state; no_claim=the order of the rows.
test("a key's row says its use and its state, and “not used yet”", async () => {
  const window = await launch();
  await twoKeys(window);
  const settings = await openSettings(window, "ai");
  const openai = row(settings, "OpenAI");
  const anthropic = row(settings, "Anthropic");
  await expect(openai.getByTestId("provider-row-status")).toHaveText(
    /^Your key · Used for Answers/,
  );
  await expect(openai.getByTestId("account-state")).toHaveText("Key works");
  await expect(anthropic.getByTestId("provider-row-status")).toHaveText(
    "Your key · Not used yet · can answer",
  );
  await expect(anthropic.getByTestId("account-state")).toHaveText("Key works");
  await expect(settings.getByTestId("built-in-row-status")).toContainText(
    "On this computer · Used for meeting transcription",
  );
  await setLanguage(window, "zh-CN");
  await expect(anthropic.getByTestId("provider-row-status")).toHaveText(
    "你的密钥 · 尚未使用 · 可用于回答",
  );
  await expect(openai.getByTestId("account-state")).toHaveText("密钥可用");
});

// protects=with "Keep everything on this computer" on, no picker offers a cloud model and each cloud account says it is paused; turned off, they come back; fails_when=a cloud model can be chosen in Local mode, or a cloud row reads as working; no_claim=what Local mode stops elsewhere.
test("Local mode: the pickers offer only what runs here, and cloud rows are paused", async () => {
  const window = await launch();
  const ids = await twoKeys(window);
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.saveChatProvider({ kind: "ollama", modelId: "fake-model", keepDefault: true });
  });
  const settings = await openSettings(window, "ai");
  const jobs = settings.getByTestId("ai-jobs");
  const quick = jobs.getByTestId("model-default-quickTasksModel");
  const cloud = quick.locator(`option[value^="${ids.openai}"]`);
  await expect(cloud).toHaveCount(1);

  await pointAndClick(window, settings.getByTestId("local-only"));
  await expect(cloud).toHaveCount(0);
  await expect(jobs.getByTestId("meetings-route").locator("option")).toHaveText([
    "On this computer",
  ]);
  await expect(row(settings, "OpenAI").getByTestId("account-state")).toHaveText("Paused");
  await expect(row(settings, "Anthropic").getByTestId("account-state")).toHaveText("Paused");
  await shot(window, "after-ai-local-mode-en-1440");

  await pointAndClick(window, settings.getByTestId("local-only"));
  await expect(cloud).toHaveCount(1);
  await expect(row(settings, "OpenAI").getByTestId("account-state")).toHaveText("Key works");
});

for (const language of ["en", "zh-CN"] as const) {
  // protects=the add sheet's directory opens a service's own page, where a key the service refuses is said in plain words and nothing is kept, and the key it takes is kept, chosen for its job and listed as one row; fails_when=a refused key is kept or chosen, the error is the service's code, or the key shows in no row; no_claim=the service's own wording.
  test(`the add sheet adds a key, and says a refused one in plain words (${language})`, async () => {
    const window = await launch();
    const settings = await openSettings(window, "ai");
    await setLanguage(window, language);
    await settings.getByTestId("models-add-provider").click();
    const sheet = settings.getByTestId("ai-add-sheet");
    await expect(sheet.getByTestId("provider-directory-search")).toBeFocused();
    await window.keyboard.type("soniox");
    const entries = sheet.getByTestId("provider-directory-entry");
    await expect(entries).toHaveCount(1);
    await expect(entries.getByTestId("provider-directory-job")).toHaveText([
      language === "en" ? "Transcription" : "转写",
    ]);
    await shot(window, `after-ai-add-sheet-${language}-1440`);
    await pointAndClick(window, entries);
    await expect(sheet).toBeHidden();

    const page = settings.getByTestId("ai-entry-page");
    await expect(page.getByTestId("provider-page-title")).toHaveText("Soniox");
    const form = page.getByTestId("transcription-key-form-soniox");
    const input = form.getByTestId("transcription-key-input");
    await expect(input).toBeFocused();
    await input.fill("soniox-wrong-key");
    await pointAndClick(window, form.getByTestId("transcription-key-save"));
    await expect(form.getByTestId("transcription-key-problem")).toHaveText(
      language === "en"
        ? "Soniox didn’t accept this key. Copy it again and paste it here."
        : "Soniox 不接受这个密钥。请重新复制后粘贴到这里。",
    );
    expect(await route(window)).not.toBe("soniox");

    await input.fill(SONIOX_KEY);
    await pointAndClick(window, form.getByTestId("transcription-key-save"));
    await expect(page).toBeHidden();
    const key = settings.locator('[data-testid="transcription-key-row"][data-host="soniox"]');
    await expect(key.getByTestId("transcription-key-status")).toHaveText(
      language === "en" ? "Your key · Used for meeting transcription" : "你的密钥 · 用于会议转写",
    );
    await expect(key.getByTestId("account-state")).toHaveText(
      language === "en" ? "Key works" : "密钥可用",
    );
    await expect(settings.getByTestId("meetings-route")).toHaveValue("soniox");
  });
}

// protects=a new User with nothing set up meets every section with plain empty states and no dead end: no model, only the built-in models, and the limits; fails_when=a picker offers a choice that does nothing, or a section is missing; no_claim=first run.
test("with no model at all, each job says so and Accounts holds only the built-in models", async () => {
  const window = await launch();
  const settings = await openSettings(window, "ai");
  const jobs = settings.getByTestId("ai-jobs");
  await expect(jobs.getByTestId("model-default-chatModel")).toBeDisabled();
  await expect(jobs.getByTestId("model-default-chatModel").locator("option:checked")).toHaveText(
    "No model yet",
  );
  await expect(jobs.getByTestId("models-sorting").locator("option:checked")).toHaveText(
    "No model yet",
  );
  await expect(jobs.getByTestId("ai-organize-automatic")).toHaveCount(0);
  await expect(settings.getByTestId("provider-row")).toHaveCount(0);
  await expect(settings.getByTestId("built-in-row")).toBeVisible();
  await expect(settings.getByTestId("ai-limits-privacy")).toContainText("No service allowed yet");
  await shot(window, "after-ai-empty-en-1440");
});

// protects=where a plan and a key both serve the Answers model, the row not used says which one is; fails_when=both rows read as used, or neither says which; no_claim=the plan's own sign-in, tested in settings.spec.ts.
test("a plan and a key for the same model: the key's row says the plan is the one used", async () => {
  const openai = await createFakeOpenAI();
  try {
    const window = await launch({ chatGpt: openai.endpoints.issuer });
    await interceptOpenExternal(app as ElectronApplication);
    const plan = await openPlanPage(window, "chatgpt");
    await plan.getByTestId("chatgpt-continue").click();
    await expect.poll(() => urlsOpened(app as ElectronApplication)).toHaveLength(1);
    const [authorize] = await urlsOpened(app as ElectronApplication);
    expect((await signInAt(openai, authorize ?? "")).status).toBe(200);
    await window.getByTestId("chatgpt-welcome-ok").click();
    await expect(plan.getByTestId("chatgpt-in-use")).toBeVisible();
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.saveChatProvider({
        kind: "openai",
        apiKey: "sk-proj-a-made-up-key",
        modelId: "gpt-6.1-sol",
        keepDefault: true,
      });
    });
    await closeSettings(window);
    const settings = await openSettings(window, "ai");
    await expect(row(settings, "ChatGPT plan").getByTestId("provider-row-status")).toHaveText(
      /^Used for Answers/,
    );
    await expect(row(settings, "ChatGPT plan").getByTestId("account-state")).toHaveText(
      "Signed in",
    );
    await expect(row(settings, "OpenAI").getByTestId("provider-row-status")).toContainText(
      "GPT-6.1 Sol goes through your ChatGPT plan",
    );
    await shot(window, "after-ai-plan-and-key-en-1440");
  } finally {
    await openai.close();
  }
});

// protects=an Ollama that has stopped is a row that says "Not running", where the User sees it; fails_when=it reads as working, or the row goes; no_claim=how Ollama is started.
test("a local runtime that stops says “Not running”", async () => {
  const window = await launch({ ollama: "http://127.0.0.1:9", ollamaApp: "installed" });
  await useLocalChatModel(window, "llama4");
  const settings = await openSettings(window, "ai");
  const ollama = row(settings, "Ollama");
  await expect(ollama.getByTestId("account-state")).toHaveText("Not running");
  await expect(ollama.getByTestId("provider-row-status")).toHaveText(
    /^On this computer · Used for Answers/,
  );
});

// protects=⌘K's Add an account or key opens the sheet, and Esc closes it with nothing changed; fails_when=it opens a page instead, or Esc closes Settings too; no_claim=the directory's groups, tested above.
test("Esc closes the add sheet and leaves Settings open", async () => {
  const window = await launch();
  const settings = await openSettings(window, "ai");
  await settings.getByTestId("models-add-provider").click();
  const sheet = settings.getByTestId("ai-add-sheet");
  await expect(sheet).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(settings).toBeVisible();
  await expect(settings.getByTestId("models-add-provider")).toBeFocused();
  await openDirectoryEntry(settings, "plan:chatgpt");
  await expect(settings.getByTestId("ai-entry-page").getByTestId("chatgpt-settings")).toBeVisible();
});
