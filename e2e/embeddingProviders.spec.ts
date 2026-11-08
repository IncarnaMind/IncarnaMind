import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page as Window } from "@playwright/test";
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
} from "./app";

/*
 * Settings › AI › Document search (#2835): off until Turn on…, then its model, in one picker grouped
 * by who pays; a company's own API uses the key of the User's account with it. Every change asks
 * first. Its option, Best results first, sits under it.
 */

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

const embeddingOf = (window: Window) =>
  window.evaluate(
    (): Promise<EmbeddingSettings> => (globalThis as Page).incarnamind.getEmbeddingSettings(),
  );

test("off by default; Turn on… and a switch to a cloud model each ask first, and cancelling changes nothing", async () => {
  const path = join(sources, "Plant notes.txt");
  await writeFile(path, "Photosynthesis turns light into chemical energy.\n");
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await acceptPlainTextKeys(window);
  await window.evaluate(() =>
    (globalThis as Page).incarnamind.saveChatProvider({
      kind: "openai",
      apiKey: "sk-proj-a-made-up-key",
      modelId: "gpt-6-luna",
    }),
  );
  await addDocuments(window, [path]);

  const settings = await openSettings(window, "ai");
  const row = settings.getByTestId("ai-document-search");
  await expect(row.getByTestId("embedding-state")).toHaveText(
    "Finds passages by meaning · 135 MB, on this computer",
  );

  // Turn on… asks first, for the built-in model; cancelling changes nothing.
  await row.getByTestId("embedding-change").click();
  const confirm = window.getByTestId("embedding-confirm");
  await expect(confirm).toContainText("Turn on Built-in model?");
  await expect(confirm).toContainText("Everything stays on this computer.");
  await confirm.getByTestId("embedding-confirm-cancel").click();
  await expect(confirm).toBeHidden();
  expect((await embeddingOf(window)).provider.kind).toBe("off");

  await row.getByTestId("embedding-change").click();
  await confirm.getByTestId("embedding-confirm-switch").click();
  const picker = row.getByTestId("embedding-model");
  await expect(picker).toHaveValue("built-in");

  // OpenAI, on the OpenAI account's key: switching warns what it receives; cancelling keeps it.
  await expect(picker.locator('optgroup[label="Your keys · billed to the key"] option')).toHaveText(
    ["OpenAI · text-embedding-3-small"],
  );
  await picker.selectOption("openai");
  await expect(confirm).toContainText("Switch to OpenAI · text-embedding-3-small?");
  await expect(confirm.getByTestId("embedding-confirm-cloud")).toHaveText(
    "OpenAI will receive the full text of all your Documents, and every search you make.",
  );
  await confirm.getByTestId("embedding-confirm-cancel").click();
  await expect(picker).toHaveValue("built-in");
  expect((await embeddingOf(window)).provider.kind).toBe("built-in");
  await expect(window.getByTestId("consent-dialog")).toBeHidden();
  await app.close();
});

test("turned on with the built-in model, Documents are embedded; turned off again, search goes by words", async () => {
  const path = join(sources, "Plant notes.txt");
  await writeFile(path, "Photosynthesis turns light into chemical energy.\n");
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await addDocuments(window, [path]);
  const settings = await openSettings(window, "ai");
  const row = settings.getByTestId("ai-document-search");
  const confirm = window.getByTestId("embedding-confirm");

  await row.getByTestId("embedding-change").click();
  await confirm.getByTestId("embedding-confirm-switch").click();
  await expect(row.getByTestId("embedding-model")).toHaveValue("built-in");
  const vector = () =>
    window.evaluate(() =>
      (globalThis as Page).incarnamind.searchPassages("light into energy", { mode: "vector" }),
    );
  await expect.poll(async () => (await vector()).length).toBeGreaterThan(0);

  await row.getByTestId("embedding-model").selectOption("off");
  await expect(confirm).toContainText("Turn off search by meaning?");
  await expect(confirm).toContainText("What it read is kept");
  await confirm.getByTestId("embedding-confirm-switch").click();

  await expect(row.getByTestId("embedding-change")).toBeVisible();
  await expect(vector()).rejects.toThrow(/Search by meaning is off/);
  await app.close();
});

test("in Local mode, no cloud model is offered, a server elsewhere is turned down as it's typed, and reranking stays on this computer", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await acceptPlainTextKeys(window);
  await window.evaluate(() =>
    (globalThis as Page).incarnamind.saveChatProvider({
      kind: "openai",
      apiKey: "sk-proj-a-made-up-key",
      modelId: "gpt-6-luna",
    }),
  );
  const settings = await openSettings(window, "ai");
  await settings.getByTestId("local-only").check();
  const row = settings.getByTestId("ai-document-search");
  await row.getByTestId("embedding-change").click();
  await window.getByTestId("embedding-confirm").getByTestId("embedding-confirm-switch").click();
  const picker = row.getByTestId("embedding-model");
  await expect(picker.locator('option[value="openai"]')).toHaveCount(0);

  await picker.selectOption("server");
  const form = row.getByTestId("embedding-form");
  await form.getByLabel("Server", { exact: true }).selectOption("openai-compatible");
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

  // Reranking: only the built-in model, on this computer, and nothing to set up.
  const rerank = settings.getByTestId("rerank-choice");
  await expect(rerank).toHaveValue("built-in");
  await expect(rerank.locator("option[value^='set-up:']")).toHaveCount(0);
  await expect(rerank.locator("option[value='cohere']")).toHaveCount(0);
  await app.close();
});

test("reranking is on by default with the built-in model, can be turned off, and stays off after a restart", async () => {
  const launched = await launchApp(dataDir);
  await dismissChatSetup(launched.window);
  const first = await openSettings(launched.window, "ai");
  const choice = first.getByTestId("rerank-choice");
  await expect(choice).toHaveValue("built-in");
  // The smoke tests' fake model has nothing to download: it is ready at once.
  await expect(first.getByTestId("rerank-model-state")).toHaveCount(0);
  expect(
    await launched.window.evaluate(() => (globalThis as Page).incarnamind.getRerankSettings()),
  ).toMatchObject({ enabled: true, byDefault: true, kind: "built-in", service: null });

  await choice.selectOption("off");
  await expect(choice).toHaveValue("off");
  await launched.app.close();

  const { app, window } = await launchApp(dataDir);
  const settings = await openSettings(window, "ai");
  const again = settings.getByTestId("rerank-choice");
  await expect(again).toHaveValue("off");

  // Chosen again, it is the User's choice now, not the default.
  await again.selectOption("built-in");
  await expect
    .poll(() => window.evaluate(() => (globalThis as Page).incarnamind.getRerankSettings()))
    .toMatchObject({ enabled: true, byDefault: false, kind: "built-in" });
  await app.close();
});

test("once the built-in model has reranked, its row says where it runs", async () => {
  const tides = join(sources, "Tides.txt");
  const moon = join(sources, "Moon.txt");
  await writeFile(tides, "The tides rise and fall twice a day.\n");
  await writeFile(moon, "The moon pulls the tides.\n");
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await addDocuments(window, [tides, moon]);
  const settings = await openSettings(window, "ai");
  const rerank = settings.getByTestId("rerank-settings");
  await expect(rerank.getByTestId("rerank-runs-on")).toHaveCount(0);
  await closeSettings(window);

  await window.evaluate(() => (globalThis as Page).incarnamind.searchEvidence("tides"));

  // The smoke tests' fake model runs on the CPU.
  const again = await openSettings(window, "ai");
  await expect(again.getByTestId("rerank-runs-on")).toHaveText("On this computer · CPU");
  await app.close();
});

for (const [language, width] of [
  ["en", 900],
  ["en", 1600],
  ["zh-CN", 900],
  ["zh-CN", 1600],
] as const) {
  test(`Document search and Best results first say what they do in plain words (${language}, ${width}px)`, async () => {
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setWindowSize(app, window, width, 900);
    const settings = await openSettings(window, "ai");
    await setLanguage(window, language);
    const words =
      language === "en"
        ? {
            state: "Finds passages by meaning · 135 MB, on this computer",
            turnOn: "Turn on…",
            rerank: "Puts the most relevant passages first.",
          }
        : {
            state: "按含义查找段落 · 135 MB，在这台电脑上",
            turnOn: "开启…",
            rerank: "把最相关的段落排在前面。",
          };
    const row = settings.getByTestId("ai-document-search");
    await expect(row.getByTestId("embedding-state")).toHaveText(words.state);
    await expect(row.getByTestId("embedding-change")).toHaveText(words.turnOn);
    const rerank = settings.getByTestId("rerank-settings");
    await expect(rerank).toContainText(words.rerank);
    for (const part of [row, rerank]) {
      expect(await part.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
        true,
      );
    }
    await app.close();
  });
}
