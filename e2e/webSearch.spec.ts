import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  assistantAnswers,
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  openSettings,
  pointAndClick,
  removeDataFolder,
} from "./app";

/*
 * Web search through the model's provider (#128), on recorded pages: a local
 * server stands in for the web, for every host, and the scripted model's
 * provider search finds two of its pages. Turned on in Settings → Search, the
 * provider allowed when asked, an Answer saves the page it reads as a
 * Document and cites it by section and paragraph, found. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots there.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const fixture = (name: string) => readFileSync(join(__dirname, `../tests/fixtures/web/${name}`));
const TITLE = "Tea - The Open Encyclopedia";
const MODEL = "claude-haiku-5-5";
const MODEL_NAME = "Claude Haiku 5.5";

let dataDir: string;
let home: string;
let server: Server;
let port: number;
/** What the stand-in web was asked for: "host/path". */
let heard: string[];
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await createDataFolder();
  heard = [];
  server = createServer((request, response) => {
    heard.push(`${request.headers.host}${request.url}`);
    const page =
      request.url === "/tea"
        ? fixture("article.html")
        : request.url === "/members"
          ? fixture("login.html")
          : null;
    response.writeHead(page ? 200 : 404, { "Content-Type": "text/html; charset=utf-8" });
    response.end(page ?? "Not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
test.afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await removeDataFolder(dataDir);
  await removeDataFolder(home);
});

async function screenshot(target: Page | Locator, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await target.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

/** An Anthropic key: choosing it allows Questions and automatic tagging to go there. */
const useAnthropic = (window: Page) =>
  window.evaluate(async (modelId) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.saveChatProvider({ kind: "anthropic", apiKey: "sk-ant-test", modelId });
  }, MODEL);

test("asked to search the web, an Answer saves the page it reads as a Document and cites it by section and paragraph, found; a page it couldn't save says why", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home, web: port });
  await dismissChatSetup(window);
  await acceptPlainTextKeys(window);
  await useAnthropic(window);

  // Off by default; turned on in Settings → Search, it names the provider that will search.
  const settings = await openSettings(window, "search");
  const section = settings.getByTestId("web-search-settings");
  const toggle = section.getByTestId("web-search-switch");
  await expect(toggle).not.toBeChecked();
  await pointAndClick(window, toggle);
  await expect(toggle).toBeChecked();
  await expect(section.getByTestId("web-search-status")).toHaveText(
    `${MODEL_NAME} searches the web through Anthropic.`,
  );
  await expect(section.getByTestId("web-search-route")).toHaveText("The model’s own search");
  await section.scrollIntoViewIfNeeded();
  await screenshot(window, "web-search-settings");
  await closeSettings(window);

  await newMind(window);
  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type("Search the web: who first brought tea to Europe?");
  await window.keyboard.press("Enter");

  // The provider's search asks first, naming the provider.
  const consent = window.getByTestId("consent-dialog");
  await expect(consent).toContainText("Anthropic");
  await expect(consent).toContainText("What an Answer searches the web for");
  await screenshot(window, "web-search-consent");
  await pointAndClick(window, consent.getByTestId("consent-allow"));

  const answer = assistantAnswers(window).last();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  const citation = answer.getByTestId("citation");
  await expect(citation).toHaveAttribute("data-check", "found");

  // Its steps: the search, the page saved, and the page it couldn't save, saying why.
  const steps = answer.getByTestId("answer-steps");
  await expect(steps).toHaveText("Searched the web · 1 source");
  await pointAndClick(window, steps);
  const calls = answer.getByTestId("answer-web-call");
  await expect(calls).toHaveCount(3);
  await expect(calls.nth(0)).toHaveText(
    /^Searched the web for “Search the web: who first brought tea to Europe\?”\s*· 2 pages$/,
  );
  await expect(calls.nth(1)).toContainText(`Saved “${TITLE}”`);
  await expect(calls.nth(2)).toHaveText(
    "Couldn’t save http://news.test/members: the page needs a sign-in",
  );
  await screenshot(window, "web-search-answer");

  // The Citation points at the saved page's section and paragraph, and opens its snapshot.
  await pointAndClick(window, citation.getByTestId("citation-chip"));
  const card = window.getByTestId("citation-card");
  await expect(card.getByTestId("citation-badge")).toHaveText(/^Quote found in § History, ¶\s\d$/);
  await expect(card.getByTestId("citation-web-source")).toContainText("The Open Encyclopedia");
  await expect(
    window.getByTestId("viewer").locator("[data-quote-highlight]").first(),
  ).toBeVisible();

  // It is a Web page Document now, and nothing but the pages the search found, and the saved
  // page's picture (#756), was fetched.
  const documents = await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
  );
  expect(documents.map((each) => [each.kind, each.name, each.web?.address])).toEqual([
    ["web", TITLE, "http://encyclopedia.test/tea"],
  ]);
  expect([...heard].sort()).toEqual([
    "encyclopedia.test/tea",
    "images.example/tea-plantation.jpg",
    "news.test/members",
  ]);
  await app.close();
});
