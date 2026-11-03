import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge, EmbeddingSettings } from "../src/core/api";
import {
  acceptPlainTextKeys,
  addDocuments,
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  openSettings,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  showSettingsPage,
} from "./app";

type Page = typeof globalThis & { incarnamind: CoreBridge };

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

test("embeddings are off by default; turning them on with a cloud provider warns that every Document is embedded and sent, and cancelling changes nothing", async () => {
  const path = join(sources, "Plant notes.txt");
  await writeFile(path, "Photosynthesis turns light into chemical energy.\n");
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await addDocuments(window, [path]);

  // Settings → Search: off, searching by words, on this computer.
  await openSettings(window, "search");
  const section = window.getByTestId("embedding-settings");
  const current = section.getByTestId("embedding-current");
  await expect(current).toHaveText("Search model: Off");
  await expect(section).toContainText("Documents are searched by their words.");

  // "Turn on…": Off is chosen, and the line says what an embedding model adds and costs.
  await section.getByTestId("embedding-change").click();
  const form = section.getByTestId("embedding-form");
  await expect(form.getByLabel("Off", { exact: true })).toBeChecked();
  await expect(form.getByTestId("embedding-trade-off")).toHaveText(
    "Finds passages worded differently, but reads slower.",
  );
  // Choose OpenAI, with a key; its suggested model is filled in.
  await form.getByLabel("OpenAI", { exact: true }).check();
  await form.getByLabel("API key").fill("sk-smoke-test-key");
  await expect(form.getByLabel("Model name")).toHaveValue("text-embedding-3-small");
  await acceptPlainTextKeys(window, form);
  await form.getByTestId("embedding-switch").click();

  // The warning: every Document is embedded, and OpenAI would receive all their text.
  const confirm = window.getByTestId("embedding-confirm");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("Turn on OpenAI · text-embedding-3-small?");
  await expect(confirm).toContainText("Reads all 1 Documents; search matches words until then.");
  await expect(confirm.getByTestId("embedding-confirm-cloud")).toHaveText(
    "OpenAI will receive the full text of all your Documents, and every search you make.",
  );

  // Cancelling changes nothing: no consent is asked, nothing is saved, nothing is embedded.
  await confirm.getByTestId("embedding-confirm-cancel").click();
  await expect(confirm).toBeHidden();
  await expect(window.getByTestId("consent-dialog")).toBeHidden();
  await expect(current).toHaveText("Search model: Off");
  const settings = await window.evaluate(
    (): Promise<EmbeddingSettings> => (globalThis as Page).incarnamind.getEmbeddingSettings(),
  );
  expect(settings).toEqual({
    provider: {
      kind: "off",
      baseUrl: null,
      modelId: "",
      hasApiKey: false,
      dimensions: null,
      service: null,
    },
    localOnly: false,
    rebuild: null,
    error: null,
  });
  await closeSettings(window);
  await expect(window.getByTestId("document-list-item")).toHaveAttribute("data-status", "ready");
  await expect(window.getByTestId("embedding-rebuild-notice")).toHaveCount(0);
  await app.close();
});

test("turned on with the built-in model, Documents are embedded; turned off again, search goes by words", async () => {
  const path = join(sources, "Plant notes.txt");
  await writeFile(path, "Photosynthesis turns light into chemical energy.\n");
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await addDocuments(window, [path]);
  await openSettings(window, "search");
  const section = window.getByTestId("embedding-settings");
  const current = section.getByTestId("embedding-current");
  const confirm = window.getByTestId("embedding-confirm");

  await section.getByTestId("embedding-change").click();
  const form = section.getByTestId("embedding-form");
  await form.getByLabel("Built-in model", { exact: true }).check();
  await form.getByTestId("embedding-switch").click();
  await expect(confirm).toContainText("Turn on Built-in model?");
  await expect(confirm).toContainText("Everything stays on this computer.");
  await confirm.getByTestId("embedding-confirm-switch").click();

  await expect(current).toHaveText("Search model: Built-in model");
  const vector = () =>
    window.evaluate(() =>
      (globalThis as Page).incarnamind.searchPassages("light into energy", { mode: "vector" }),
    );
  await expect.poll(async () => (await vector()).length).toBeGreaterThan(0);

  await section.getByTestId("embedding-change").click();
  await form.getByLabel("Off", { exact: true }).check();
  await expect(form).toContainText("Searches words only. Nothing is downloaded.");
  await form.getByTestId("embedding-switch").click();
  await expect(confirm).toContainText("Turn off search by meaning?");
  await expect(confirm).toContainText("What it read is kept");
  await confirm.getByTestId("embedding-confirm-switch").click();

  await expect(current).toHaveText("Search model: Off");
  await expect(vector()).rejects.toThrow(/Search by meaning is off/);
  await app.close();
});

test("in local mode, a server elsewhere and reranking are turned down as they're chosen, saying why", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  const settings = await openSettings(window, "privacy");
  await settings.getByTestId("local-only").check();
  await showSettingsPage(window, "search");
  const section = window.getByTestId("embedding-settings");
  await expect(section.getByTestId("local-only")).toHaveCount(0);

  await section.getByTestId("embedding-change").click();
  const form = section.getByTestId("embedding-form");
  await expect(form.getByLabel("OpenAI", { exact: true })).toBeDisabled();
  await form.getByLabel("OpenAI-compatible server").check();
  const server = form.getByLabel("Server URL");
  const why = form.getByTestId("embedding-local-only");
  await server.fill("https://api.deepseek.com/v1");
  await form.getByLabel("Model name").fill("embed-small");
  await expect(why).toBeVisible();
  await expect(form.getByTestId("embedding-switch")).toBeDisabled();
  await expect(form.getByRole("button", { name: "Test connection" })).toBeDisabled();
  // A server on this computer is fine.
  await server.fill("http://127.0.0.1:1234/v1");
  await expect(why).toBeHidden();
  await expect(form.getByTestId("embedding-switch")).toBeEnabled();

  // Reranking: only the built-in model, on this computer, can be chosen, and it stays on.
  const rerank = window.getByTestId("rerank-settings");
  await expect(rerank.getByTestId("rerank-current")).toContainText(
    "the built-in model puts the best results first",
  );
  await rerank.getByTestId("rerank-change").click();
  const rerankForm = rerank.getByTestId("rerank-form");
  await expect(rerankForm.getByLabel("Cohere", { exact: true })).toBeDisabled();
  await expect(rerankForm.getByLabel("Voyage AI", { exact: true })).toBeDisabled();
  await expect(rerankForm.getByLabel("On this computer (built-in model)")).toBeChecked();
  await expect(rerankForm.getByTestId("rerank-local-only")).toBeVisible();
  await app.close();
});

test("reranking is on by default with the built-in model, can be turned off, and stays off after a restart", async () => {
  const launched = await launchApp(dataDir);
  await dismissChatSetup(launched.window);
  await openSettings(launched.window, "search");
  const current = () => launched.window.getByTestId("rerank-settings");

  // The smoke tests' fake model has nothing to download: it is ready at once.
  await expect(current().getByTestId("rerank-current")).toHaveText(
    "By default, the built-in model puts the best results first.",
  );
  await expect(current()).toContainText("Each search takes a little longer.");
  await expect(current().getByTestId("rerank-model-state")).toHaveCount(0);
  expect(
    await launched.window.evaluate(() => (globalThis as Page).incarnamind.getRerankSettings()),
  ).toMatchObject({ enabled: true, byDefault: true, kind: "built-in", service: null });

  await current().getByTestId("rerank-remove").click();
  await expect(current()).toContainText("Off");
  await launched.app.close();

  const { app, window } = await launchApp(dataDir);
  await openSettings(window, "search");
  const rerank = window.getByTestId("rerank-settings");
  await expect(rerank).toContainText("Off");
  await expect(rerank.getByTestId("rerank-current")).toHaveCount(0);

  // Chosen again, it is the User's choice now, not the default.
  await rerank.getByTestId("rerank-set-up").click();
  const form = rerank.getByTestId("rerank-form");
  await form.getByLabel("On this computer (built-in model)").check();
  await expect(form.getByTestId("rerank-built-in-note")).toContainText("runs on this computer.");
  await expect(form.getByLabel("API key")).toHaveCount(0);
  await form.getByRole("button", { name: "Use for ordering results" }).click();

  await expect(rerank.getByTestId("rerank-current")).toHaveText(
    "The built-in model puts the best results first.",
  );
  const settings = await window.evaluate(() =>
    (globalThis as Page).incarnamind.getRerankSettings(),
  );
  expect(settings).toMatchObject({ enabled: true, byDefault: false, kind: "built-in" });
  await app.close();
});

test("once the built-in model has reranked, Advanced says where it runs", async () => {
  const tides = join(sources, "Tides.txt");
  const moon = join(sources, "Moon.txt");
  await writeFile(tides, "The tides rise and fall twice a day.\n");
  await writeFile(moon, "The moon pulls the tides.\n");
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await addDocuments(window, [tides, moon]);
  await openSettings(window, "search");
  const rerank = window.getByTestId("rerank-settings");
  await rerank.getByTestId("rerank-advanced-toggle").click();
  await expect(rerank.getByTestId("rerank-current")).toBeVisible();
  await expect(rerank.getByTestId("rerank-runs-on")).toHaveCount(0);

  await window.evaluate(() => (globalThis as Page).incarnamind.searchEvidence("tides"));

  // The smoke tests' fake model runs on the CPU.
  await expect(rerank.getByTestId("rerank-runs-on")).toHaveText("On this computer · CPU");
  await app.close();
});

for (const [language, width] of [
  ["en", 900],
  ["en", 1600],
  ["zh-CN", 900],
  ["zh-CN", 1600],
] as const) {
  test(`Settings > Search says what its sections do in plain words, with the model names under Advanced (${language}, ${width}px)`, async () => {
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setWindowSize(app, window, width, 900);
    await openSettings(window, "search");
    await setLanguage(window, language);
    const words =
      language === "en"
        ? {
            plain: "Find Documents by meaning, not only words",
            download: "Off · 135 MB download",
            turnOn: "Turn on…",
            advanced: "Advanced",
            model: "Search model: Off",
            rerank: "Puts the most relevant passages first.",
            rerankOn: "On this computer",
          }
        : {
            plain: "按含义查找文档，而不只是按字词",
            download: "关闭 · 需下载 135 MB",
            turnOn: "开启…",
            advanced: "高级",
            model: "搜索模型：关闭",
            rerank: "把最相关的段落排在前面。",
            rerankOn: "在这台电脑上",
          };

    // The section's one plain line and its action; no model name until Advanced opens.
    const section = window.getByTestId("embedding-settings");
    await expect(section.getByTestId("embedding-plain")).toHaveText(words.plain);
    await expect(section.getByTestId("embedding-state")).toHaveText(words.download);
    await expect(section.getByTestId("embedding-change")).toHaveText(words.turnOn);
    for (const text of [words.plain, words.download]) {
      expect(text).not.toMatch(/embedding|rerank|index|passage/i);
    }
    const advanced = section.getByTestId("embedding-advanced");
    const toggle = advanced.getByTestId("embedding-advanced-toggle");
    await expect(toggle).toHaveText(words.advanced);
    await expect(section.getByTestId("embedding-current")).toBeHidden();
    await toggle.focus();
    await window.keyboard.press("Enter");
    await expect(section.getByTestId("embedding-current")).toBeVisible();
    await expect(section.getByTestId("embedding-current")).toContainText(words.model);

    // Best results first: its plain sentence says what it does; the model and where it runs
    // wait under Advanced.
    const rerank = window.getByTestId("rerank-settings");
    await expect(rerank.getByTestId("rerank-settings-body")).toContainText(words.rerank);
    await expect(rerank.getByTestId("rerank-state")).toHaveText(words.rerankOn);
    await expect(rerank.getByTestId("rerank-current")).toBeHidden();
    await rerank.getByTestId("rerank-advanced-toggle").click();
    await expect(rerank.getByTestId("rerank-current")).toBeVisible();

    // Everything holds, with its buttons whole, at this width.
    for (const part of [section, rerank]) {
      await expect(part.getByRole("button").first()).toBeVisible();
      expect(await part.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
        true,
      );
    }
    await app.close();
  });
}
