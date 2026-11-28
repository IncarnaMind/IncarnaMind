import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import {
  acceptPlainTextKeys,
  createDataFolder,
  launchApp,
  openSettings,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  useLocalChatModel as setLocalChatModel,
  setWindowSize,
} from "./app";

/*
 * Decision models in Settings › AI's sorting picker (#2615, #1907): the picker sets no sorting
 * model up (#3767), but one a profile already has stays a choice there, with what
 * choosing it sends, and its key stays in Accounts and keys, where it can be changed or removed.
 * One stand-in plays TypeSafe and every other host here.
 */

const JEV_KEY = "jev-smoke-key";

/** A stand-in for TypeSafe's hosted Jev: it counts what reaches it and refuses any other key. */
async function startFakeTypeSafe() {
  const requests: string[] = [];
  const server: Server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    requests.push(request.headers.authorization ?? "");
    if (request.headers.authorization !== `Bearer ${JEV_KEY}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: "Invalid API key." }));
      return;
    }
    const { questions } = JSON.parse(text) as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(questions).map((id) => [id, { type: "noul", noul: 0.02 }]),
    );
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ model: "jev-1.14.0", answers, usage: {} }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, url, requests };
}

let dataDir: string;
let typeSafe: Awaited<ReturnType<typeof startFakeTypeSafe>>;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  typeSafe = await startFakeTypeSafe();
});
test.afterEach(async () => {
  typeSafe.server.closeAllConnections();
  await new Promise((resolve) => typeSafe.server.close(resolve));
  await removeDataFolder(dataDir);
});

const library = (window: Page) =>
  window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await core.getLibrary()).settings;
  });

/** The rows that would set a sorting model up from the picker, which offers none (#3767). */
const setUpRows = (picker: Locator) => picker.locator("option[value^='set-up:']");

/** Whether the element fits inside `container` sideways, as the layout holds at any width. */
async function fitsIn(element: Locator, container: Locator): Promise<boolean> {
  const [inner, outer] = await Promise.all([element.boundingBox(), container.boundingBox()]);
  if (!inner || !outer) throw new Error("Not on screen.");
  return inner.x >= outer.x - 0.5 && inner.x + inner.width <= outer.x + outer.width + 0.5;
}

async function launch(language: "en" | "zh-CN", width: number, height: number) {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    jev: typeSafe.url,
    decisions: typeSafe.url,
  });
  await setWindowSize(app, window, width, height);
  await acceptPlainTextKeys(window);
  await setLanguage(window, language);
  return { app, window };
}

for (const [language, width, height] of [
  ["en", 1440, 900],
  ["zh-CN", 900, 800],
] as const) {
  test(`Settings › AI sets no sorting model up from the picker; Jev set up before stays a choice, listed first, and choosing it allows nothing by itself (${language}, ${width} × ${height}) (#2615, #3767)`, async () => {
    const { app, window } = await launch("en", width, height);
    try {
      await setLocalChatModel(window);
      // A profile with Jev's key kept.
      await window.evaluate(
        (apiKey) =>
          (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.saveJevSettings({
            apiKey,
          }),
        JEV_KEY,
      );
      // The button that opens Settings is named in English until the language is changed inside it.
      const settings = await openSettings(window, "ai");
      await setLanguage(window, language);
      const row = settings.getByTestId("model-default-row-sorting");
      const picker = row.getByTestId("models-sorting");
      // Jev is the picker's first choice, and nothing in it sets a model up.
      await expect(picker.locator("option").first()).toHaveText("TypeSafe Jev");
      await expect(setUpRows(picker)).toHaveCount(0);
      await expect(row.getByTestId("jev-form")).toHaveCount(0);
      await picker.selectOption({ label: "TypeSafe Jev" });
      await expect(picker.locator("option:checked")).toHaveText("TypeSafe Jev");
      // Choosing it allows nothing by itself: the switch asks before the first Document goes (#3353).
      await expect(settings.getByTestId("tagging-automatic-organize")).toBeChecked();
      await expect(settings.getByTestId("tagging-automatic-asks")).toHaveText(
        translate(language, "ai.organize.automatic.asks", { service: "TypeSafe Jev" }),
      );
      expect(await fitsIn(settings.getByTestId("tagging-automatic-asks"), settings)).toBe(true);
      expect((await library(window)).classifier).toEqual({ kind: "jev" });
    } finally {
      await app.close();
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`Settings › AI: a host set up before stays a choice for sorting and joins Accounts and keys; Change key edits it in place, and Remove key gives sorting back to Automatic (${language}) (#1907, #3767)`, async () => {
    const { app, window } = await launch("en", 900, 800);
    try {
      await setLocalChatModel(window);
      // A profile that kept Liquid AI's key: the host checks it as it is saved.
      await window.evaluate(
        (apiKey) =>
          (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.setDecisionKey({
            host: "liquid",
            apiKey,
          }),
        JEV_KEY,
      );
      expect(typeSafe.requests).toEqual([`Bearer ${JEV_KEY}`]);
      const settings = await openSettings(window, "ai");
      await setLanguage(window, language);
      // No list of hosts: the sorting row chooses, and Accounts and keys holds the keys.
      const providers = settings.getByTestId("your-providers");
      await expect(providers.getByTestId("provider-row")).toHaveCount(1);
      await expect(settings.getByTestId("decision-hosts")).toHaveCount(0);
      const row = settings.getByTestId("model-default-row-sorting");
      const picker = row.getByTestId("models-sorting");
      await expect(picker.locator("option:checked")).toBeAttached();
      await expect(setUpRows(picker)).toHaveCount(0);
      const chosen = await picker.locator("option:checked").textContent();

      await picker.selectOption({ label: "d1-ultra · Liquid AI" });
      await expect(picker.locator("option:checked")).toHaveText("d1-ultra · Liquid AI");
      // As for Jev, choosing here allows nothing: the switch asks before the first Document goes.
      await expect(settings.getByTestId("tagging-automatic-organize")).toBeChecked();
      await expect(settings.getByTestId("tagging-automatic-asks")).toHaveText(
        translate(language, "ai.organize.automatic.asks", { service: "Liquid AI" }),
      );
      expect(await fitsIn(settings.getByTestId("tagging-automatic-asks"), settings)).toBe(true);
      const liquidKey = providers.locator('[data-testid="sorting-key-row"][data-host="liquid"]');
      await expect(liquidKey).toContainText("Liquid AI");
      await expect(liquidKey).toContainText(translate(language, "ai.uses.organize"));
      expect((await library(window)).classifier).toEqual({
        kind: "decision",
        host: "liquid",
        modelId: "d1-ultra",
      });
      expect(typeSafe.requests).toEqual([`Bearer ${JEV_KEY}`]);

      // Change key opens its form in place; Esc puts it away.
      await pointAndClick(window, liquidKey.getByTestId("sorting-key-change"));
      const keyField = liquidKey.getByTestId("decision-key-input");
      await expect(keyField).toBeFocused();
      await keyField.press("Escape");
      await expect(liquidKey.getByTestId("decision-key-form-liquid")).toHaveCount(0);

      // Remove key: sorting goes back to Automatic's pick, and nothing offers to set the host up.
      await pointAndClick(window, liquidKey.getByTestId("sorting-key-remove"));
      await expect(liquidKey).toHaveCount(0);
      await expect(picker.locator("option:checked")).toHaveText(chosen ?? "");
      await expect(setUpRows(picker)).toHaveCount(0);
      expect((await library(window)).classifier).toEqual({ kind: "automatic" });
      expect(typeSafe.requests).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`Settings › AI: Decider through OpenRouter names the OpenRouter key it uses, and Accounts and keys adds no row for it (${language}) (#1907)`, async () => {
    const { app, window } = await launch("en", 900, 800);
    try {
      await window.evaluate(async () => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await core.saveChatProvider({
          kind: "openrouter",
          apiKey: "sk-or-smoke-key",
          modelId: "anthropic/claude-sonnet-5.5",
        });
      });
      const settings = await openSettings(window, "ai");
      await setLanguage(window, language);
      const row = settings.getByTestId("model-default-row-sorting");
      await expect(row.getByTestId("models-sorting-key")).toHaveCount(0);
      await row.getByTestId("models-sorting").selectOption({ label: "Decider v1.2 · OpenRouter" });

      const line = row.getByTestId("models-sorting-key");
      await expect(line).toContainText("OpenRouter");
      const words = (text: string | null) => (text ?? "").replace(/\s/g, "");
      expect(words(await line.textContent())).toBe(
        words(translate(language, "decisions.usesKey", { provider: "OpenRouter" })),
      );
      const providers = settings.getByTestId("your-providers");
      await expect(providers.getByTestId("provider-row")).toHaveCount(1);
      await expect(providers.getByTestId("sorting-key-row")).toHaveCount(0);
      // Choosing sorts nothing: the one read is OpenRouter's public list of decision models.
      expect(typeSafe.requests.filter((each) => each !== "")).toEqual([]);
    } finally {
      await app.close();
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`Settings › AI: Alibaba's workspace sits on its own Qwen row; Change workspace… edits it in place, and Remove gives sorting back to Automatic (${language}) (#1907)`, async () => {
    const { app, window } = await launch("en", 900, 800);
    try {
      const modelId = await window.evaluate(async (key) => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await core.saveChatProvider({
          kind: "qwen",
          endpoint: "cn",
          apiKey: key,
          modelId: "qwen3.7-plus",
        });
        const hosts = await core.setDecisionKey({ host: "alibaba", account: "llm-test" });
        const alibaba = hosts.find((each) => each.host === "alibaba");
        const chosen = alibaba?.models[0]?.id ?? "";
        await core.saveLibrarySettings({
          ...(await core.getLibrary()).settings,
          classifier: { kind: "decision", host: "alibaba", modelId: chosen },
        });
        return chosen;
      }, JEV_KEY);
      const settings = await openSettings(window, "ai");
      await setLanguage(window, language);
      const providers = settings.getByTestId("your-providers");
      const qwen = providers.locator('[data-testid="sorting-key-row"][data-host="alibaba"]');
      await expect(qwen).toContainText(
        language === "zh-CN" ? "通义千问（阿里云百炼）" : "Qwen (Alibaba Cloud Model Studio)",
      );
      await expect(qwen.getByTestId("sorting-key-status")).toContainText(
        translate(language, "ai.uses.organize"),
      );
      await expect(qwen.getByTestId("sorting-key-status")).toContainText(
        translate(language, "ai.uses.workspace", { id: "llm-test" }),
      );
      // The picker offers no host to set up (#3767).
      const picker = settings
        .getByTestId("model-default-row-sorting")
        .getByTestId("models-sorting");
      await expect(setUpRows(picker)).toHaveCount(0);

      await pointAndClick(window, qwen.getByTestId("sorting-key-change"));
      const field = qwen.getByTestId("decision-account-input");
      await expect(field).toBeFocused();
      await expect(field).toHaveValue("llm-test");
      await field.fill("llm-two");
      await pointAndClick(window, qwen.getByTestId("decision-key-save"));
      await expect(qwen.getByTestId("sorting-key-status")).toContainText(
        translate(language, "ai.uses.workspace", { id: "llm-two" }),
      );
      expect((await library(window)).classifier).toEqual({
        kind: "decision",
        host: "alibaba",
        modelId,
      });

      await pointAndClick(window, qwen.getByTestId("sorting-key-remove"));
      await expect(qwen).toHaveCount(0);
      expect((await library(window)).classifier).toEqual({ kind: "automatic" });
      // The Qwen key stays for chat, and nothing offers Alibaba's workspace again (#3767).
      await expect(providers.getByTestId("provider-row")).toHaveCount(1);
      await expect(setUpRows(picker)).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
}
