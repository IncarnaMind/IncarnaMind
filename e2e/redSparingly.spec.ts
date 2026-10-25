import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, type Locator, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  addProviderForm,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  openSettings,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  showSettingsPage,
  sidebarFolder,
} from "./app";

/*
 * Red, sparingly (DESIGN.md, Colors): an error reads in ink after the amber "!", or has the
 * attention dot; a field in error has a warning edge; Delete in a menu is ink. Red stays on the
 * button of a dialog that asks about what can't be undone.
 */

const INK = "rgb(23, 25, 28)";
const WARNING = "rgb(154, 74, 6)";
const ATTENTION = "rgb(217, 119, 6)";
const RED = "rgb(180, 35, 24)";

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

/** The error's words in ink, led by the amber mark on its first line. */
async function expectProblem(message: Locator): Promise<void> {
  await expect(message).toHaveAttribute("role", "alert");
  await expect(message).toHaveCSS("color", INK);
  const mark = message.locator("svg").first();
  await expect(mark).toHaveCSS("color", WARNING);
  const [line, box] = await Promise.all([message.boundingBox(), mark.boundingBox()]);
  expect(line && box).toBeTruthy();
  if (!line || !box) return;
  expect(box.x).toBeLessThanOrEqual(line.x + 4);
  expect(box.y).toBeGreaterThanOrEqual(line.y);
  expect(box.y + box.height).toBeLessThanOrEqual(line.y + 22);
}

test("a refused key and a variable with no name read in ink after the amber mark, in English and Chinese, and the field has a warning edge", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await acceptPlainTextKeys(window);
    await app.evaluate(() => {
      const original = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        return url.startsWith("https://api.openai.com")
          ? Promise.resolve(
              Response.json(
                { error: { message: "Incorrect API key provided.", code: "invalid_api_key" } },
                { status: 401 },
              ),
            )
          : original(input, init);
      };
    });

    const settings = await openSettings(window, "models");
    const form = await addProviderForm(settings, "openai");
    await form.getByLabel(/^API key/).fill("sk-proj-wrong-key");
    await form.getByTestId("provider-use-key").click();
    const refused = form.getByTestId("connection-test");
    await expect(refused).toContainText("This key isn’t valid for OpenAI");
    await expectProblem(refused);
    await setLanguage(window, "zh-CN");
    await expect(refused).toContainText("这个密钥对 OpenAI 无效");
    await expectProblem(refused);
    await setLanguage(window, "en");

    await showSettingsPage(window, "connectors");
    const page = window.getByTestId("settings-page-connectors");
    await page.getByTestId("connector-add-custom").click();
    await page.getByRole("tab", { name: "Command" }).click();
    const connector = page.getByTestId("connector-form");
    const variables = connector.getByLabel(/^Environment variables/);
    await variables.fill("not a variable");
    await connector.getByLabel("Name", { exact: true }).focus();
    await expect(variables).toHaveAttribute("aria-invalid", "true");
    await expect(variables).toHaveCSS("border-top-color", WARNING);
    await expectProblem(connector.getByRole("alert"));
    await variables.fill("TOKEN=value");
    await expect(variables).not.toHaveAttribute("aria-invalid", "true");
  } finally {
    await app.close();
  }
});

test("Delete in a menu is ink, like Rename; the button that deletes for good stays red", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await newMind(window);
    const mind = window.getByTestId("mind-row").first();
    await mind.hover();
    await mind.getByTestId("mind-menu").click();
    const menu = mind.getByTestId("mind-actions");
    await expect(menu.getByTestId("mind.delete")).toHaveCSS("color", INK);
    await expect(menu.getByTestId("mind.rename")).toHaveCSS("color", INK);
    await menu.getByTestId("mind.delete").click();

    await pointAndClick(window, window.getByTestId("open-library"));
    const head = window.getByTestId("deleted-section-head");
    if ((await head.getAttribute("data-open")) === "false") {
      await pointAndClick(window, head.getByTestId("deleted-heading"));
    }
    await window
      .getByTestId("recently-deleted")
      .getByTestId("deleted-item")
      .first()
      .getByTestId("deleted-delete")
      .click();
    const dialog = window.getByTestId("delete-permanently-dialog");
    await expect(dialog.getByTestId("confirm-delete-permanently")).toHaveCSS(
      "background-color",
      RED,
    );
    await expect(dialog.getByRole("button", { name: "Cancel" })).not.toHaveCSS(
      "background-color",
      RED,
    );
  } finally {
    await app.close();
  }
});

test("a link that can't be fetched puts the attention dot on the sidebar's status, not a red one", async () => {
  const site = createServer((_request, response) => {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not here");
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const address = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.createLibraryGroup({
        name: "Reading",
        description: "",
      }),
    );
    const folder = sidebarFolder(window, "Reading");
    await folder.getByTestId("folder-row").click();
    await folder.getByTestId("folder-row").focus();
    await window.evaluate((pasted) => {
      const data = new DataTransfer();
      data.setData("text/plain", pasted);
      const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true });
      (document.activeElement ?? document.body).dispatchEvent(event);
    }, `${address}/gone`);
    const status = window.locator('[data-testid^="web-page-problem"]');
    await expect(status).toHaveAttribute("role", "alert");
    await expect(status.getByTestId("status-label")).toHaveCSS("color", "rgb(101, 107, 116)");
    await expect(status.locator("span.rounded-full")).toHaveCSS("background-color", ATTENTION);
  } finally {
    await app.close();
    site.closeAllConnections();
    await new Promise((resolve) => site.close(resolve));
  }
});
