import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { startFakeRegistry } from "../tests/helpers/fakeRegistry";
import { type FakeRemote, startFakeRemote } from "../tests/helpers/remoteMcp";
import {
  acceptPlainTextKeys,
  createDataFolder,
  dismissChatSetup,
  interceptOpenExternal,
  launchApp,
  openSettings,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  showSettingsPage,
  urlsOpened,
} from "./app";

/** The tiny MCP server the core tests use: `lookup_tide` is read-only, `book_boat` isn't. */
const TIDE_SERVER = resolve(__dirname, "../tests/fixtures/mcp-server.mjs");

/** The User approves in the browser, which comes back to the app's loopback redirect. */
async function approveInBrowser(fake: FakeRemote, authorizeUrl: string | undefined, name: string) {
  const page = await fetch(fake.approve(authorizeUrl ?? ""), {
    signal: AbortSignal.timeout(15_000),
  }).catch((error: unknown) => {
    throw new Error("The app's loopback redirect didn't answer the approval within 15 s.", {
      cause: error,
    });
  });
  expect(page.status).toBe(200);
  expect(await page.text()).toContain(`Signed in to ${name}`);
}

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

test("a local Connector added in Settings starts and reaches ready, and turning it off stops it", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);

  await openSettings(window, "connectors");
  const page = window.getByTestId("settings-page-connectors");
  await expect(page.getByTestId("connectors-connected")).toHaveCount(0);
  await page.getByTestId("connector-add-custom").click();
  await page.getByRole("tab", { name: "Command" }).click();
  const form = page.getByTestId("connector-form");
  await form.getByLabel("Name", { exact: true }).fill("Tides");
  // Node, the way the test runs it; the app starts it with the login-shell environment.
  await form.getByLabel(/^Command/).fill(process.execPath);
  await form.getByLabel("Arguments, one per line").fill(TIDE_SERVER);
  await form.getByLabel(/^Environment variables/).fill("TIDE_TOKEN=smoke-secret");
  // Its variables are kept with the keys: on Linux with no keyring, once the User accepts it.
  await acceptPlainTextKeys(window, form);
  await form.getByRole("button", { name: "Add Connector" }).click();

  // Added, its page opens: its state, and its Tools, each with what it claims and whether it asks.
  await expect(page.getByTestId("connector-name")).toHaveText("Tides");
  await expect(page.getByTestId("connector-detail")).toContainText("Added by you · Not reviewed");
  const connector = page.getByTestId("connector");
  await expect(connector).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await expect(connector.getByTestId("connector-state")).toHaveText("Connected");
  await expect(connector).toContainText(TIDE_SERVER);
  const tools = page.getByTestId("connector-tools");
  const lookup = tools.locator('[data-tool="lookup_tide"]');
  const book = tools.locator('[data-tool="book_boat"]');
  await expect(lookup).toHaveAttribute("data-read-only", "true");
  await expect(lookup.getByTestId("connector-tool-claim")).toHaveText("Reads");
  await expect(lookup.getByRole("radio", { name: "Always allow" })).toBeChecked();
  await expect(book).toHaveAttribute("data-read-only", "false");
  await expect(book.getByTestId("connector-tool-claim")).toHaveText("May change things");
  await expect(book.getByRole("radio", { name: "Ask every time" })).toBeChecked();

  // The claim is only a hint: the read-only Tool can be switched to ask every time, which the
  // Privacy page lists, and revoking it there goes back to the default.
  const approvals = window.getByTestId("approvals-settings");
  await showSettingsPage(window, "privacy");
  await expect(approvals).toContainText("Nothing changed from the default.");
  await showSettingsPage(window, "connectors");
  await lookup.getByText("Ask every time").click();
  await expect(lookup).toHaveAttribute("data-asks", "true");
  await showSettingsPage(window, "privacy");
  const policy = approvals.getByTestId("approval-policy");
  await expect(policy).toHaveCount(1);
  await expect(policy).toContainText("Tides · lookup_tide");
  await expect(policy.getByTestId("approval-policy-value")).toHaveText("Ask every time");
  const reset = policy.getByRole("button", { name: "Reset Tides · lookup_tide to its default" });
  await expect(reset).toHaveText("Reset");
  // Not 撤销, which is Undo's word (#763).
  await setLanguage(window, "zh-CN");
  await expect(policy.getByRole("button", { name: "将 Tides · lookup_tide 恢复默认" })).toHaveText(
    "恢复默认",
  );
  await setLanguage(window, "en");
  await reset.click();
  await expect(policy).toHaveCount(0);
  await showSettingsPage(window, "connectors");
  await expect(lookup).toHaveAttribute("data-asks", "false");
  await expect(lookup.getByRole("radio", { name: "Always allow" })).toBeChecked();

  // A Tool turned off isn't offered to Answers; the Privacy page lists it too.
  await book.getByText("Off", { exact: true }).click();
  await expect(book).toHaveAttribute("data-off", "true");
  await showSettingsPage(window, "privacy");
  await expect(policy).toContainText("Tides · book_boat");
  await expect(policy.getByTestId("approval-policy-value")).toHaveText("Off");
  await showSettingsPage(window, "connectors");

  // Back on the list, where the focus was, it is under Connected; Manage opens its page again.
  await page.getByTestId("connectors-back").click();
  await expect(page.getByTestId("connector-add-custom")).toBeFocused();
  const row = page.getByTestId("connected-connector");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Tides");
  await expect(row.getByTestId("connected-connector-state")).toHaveText("Connected");
  await row.getByTestId("connector-manage").click();

  // Off: its process stops, and it says so.
  await connector.getByRole("switch", { name: "Use Tides" }).uncheck();
  await expect(connector).toHaveAttribute("data-state", "off");
  await expect(connector.getByTestId("connector-state")).toHaveText("Off");
  await app.close();
});

test("in Local mode a Connector on another computer is paused and says why, in English and Chinese; its page offers no sign-in", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    // Added in Local mode, it is never connected to: the address need not exist.
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.setLocalOnly(true);
      await bridge.addConnector({ name: "Wiki", url: "https://wiki.example.test/mcp" });
    });

    await openSettings(window, "connectors");
    const page = window.getByTestId("settings-page-connectors");
    const row = page.getByTestId("connected-connector");
    await expect(row).toHaveAttribute("data-state", "paused");
    await expect(row.getByTestId("connected-connector-state")).toHaveText(
      "Not used while everything stays on this computer",
    );
    await setLanguage(window, "zh-CN");
    await expect(row.getByTestId("connected-connector-state")).toHaveText(
      "所有内容都留在这台电脑上时不会使用",
    );
    await setLanguage(window, "en");

    // Its page says the same, and offers no sign-in to a server that would hear of it.
    await row.getByTestId("connector-manage").click();
    const connector = page.getByTestId("connector");
    await expect(connector).toHaveAttribute("data-state", "paused");
    await expect(connector.getByTestId("connector-state")).toHaveText(
      "Not used while everything stays on this computer",
    );
    await expect(connector.getByTestId("connector-sign-in")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("in Local mode a Connector on this computer whose sign-in is on another waits and says why, in English and Chinese; its page offers no sign-in", async () => {
  // The service is on this computer, but its metadata names a sign-in server on another one.
  const fake = await startFakeRemote();
  fake.authorizationServer = "https://auth.example.test";
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await window.evaluate(async (url) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.setLocalOnly(true);
      await bridge.addConnector({ name: "Wiki", url });
    }, fake.url);

    await openSettings(window, "connectors");
    const page = window.getByTestId("settings-page-connectors");
    const row = page.getByTestId("connected-connector");
    await expect(row).toHaveAttribute("data-state", "needs-sign-in");
    await expect(row.getByTestId("connected-connector-state")).toHaveText(
      "Not used while everything stays on this computer",
    );
    await setLanguage(window, "zh-CN");
    await expect(row.getByTestId("connected-connector-state")).toHaveText(
      "所有内容都留在这台电脑上时不会使用",
    );
    await setLanguage(window, "en");

    // Its page says why, and offers no sign-in to a server that would hear of it.
    await row.getByTestId("connector-manage").click();
    const connector = page.getByTestId("connector");
    await expect(connector.getByTestId("connector-state")).toHaveText(
      "Not used while everything stays on this computer",
    );
    const why = connector.getByTestId("connector-sign-in-held-back");
    await expect(why).toContainText("Paused: its sign-in server is on another computer.");
    await why.getByTestId("connector-sign-in-held-back-details").click();
    await expect(why.getByTestId("connector-sign-in-held-back-list")).toContainText(
      "“Keep everything on this computer” is on",
    );
    await setLanguage(window, "zh-CN");
    await expect(why).toContainText("已暂停：它的登录服务在另一台电脑上。");
    await expect(why.getByTestId("connector-sign-in-held-back-list")).toContainText(
      "已开启“所有内容都留在这台电脑上”",
    );
    await expect(connector.getByTestId("connector-sign-in")).toHaveCount(0);

    // Nothing reached the sign-in server, or its address.
    expect(fake.requests.filter((request) => request.path.startsWith("auth:"))).toEqual([]);
  } finally {
    await app.close();
    await fake.close();
  }
});

test("a remote Connector added by URL needs a sign-in, which goes through the browser", async () => {
  // A local stand-in for the service: an OAuth authorization server and an MCP server.
  const fake = await startFakeRemote();
  try {
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    // The system browser opens nothing: the test plays the User on the sign-in page.
    await interceptOpenExternal(app);

    await openSettings(window, "connectors");
    const page = window.getByTestId("settings-page-connectors");
    await page.getByTestId("connector-add-custom").click();
    const form = page.getByTestId("connector-form");
    await form.getByLabel("Name", { exact: true }).fill("Wiki");
    await form.getByLabel("Server URL").fill(fake.url);
    await form.getByRole("button", { name: "Add Connector" }).click();

    const connector = page.getByTestId("connector");
    await expect(connector).toHaveAttribute("data-state", "needs-sign-in", { timeout: 15_000 });
    await expect(connector.getByTestId("connector-state")).toHaveText("Needs sign-in");
    await expect(connector.getByTestId("connector-location")).toHaveText(fake.url);
    await expect(connector.getByTestId("connector-sign-in-notice")).toContainText(
      "This server needs you to sign in.",
    );
    // Nothing opened in the browser, and IncarnaMind didn't register itself, until the User asks.
    expect(await urlsOpened(app)).toEqual([]);
    expect(fake.registrations).toEqual([]);

    // The service's tokens are kept with the keys: on Linux with no keyring, the User has
    // accepted that first (in a form that saves a key; the sign-in doesn't offer it yet, #342).
    await acceptPlainTextKeys(window);
    // Signing in opens the authorization request and waits for the browser.
    await connector.getByTestId("connector-sign-in").click();
    await expect(connector).toHaveAttribute("data-state", "signing-in");
    await expect(page.getByTestId("connector-signing-in")).toContainText(
      "Finish signing in in your browser",
    );
    await expect.poll(async () => (await urlsOpened(app)).length).toBe(1);
    const [authorizeUrl] = await urlsOpened(app);
    expect(authorizeUrl?.startsWith(`${fake.issuer}/authorize?`)).toBe(true);

    // The User approves; the browser comes back to the loopback redirect.
    await approveInBrowser(fake, authorizeUrl, "Wiki");

    await expect(connector).toHaveAttribute("data-state", "ready");
    await expect(connector.getByTestId("connector-state")).toHaveText("Connected");
    await expect(connector.getByTestId("connector-sign-out")).toBeVisible();
    await expect(page.getByTestId("connector-tool")).toHaveCount(2);
    await app.close();
  } finally {
    await fake.close();
  }
});

/** Marks a field Chromium would show its own bubble for: one whose `invalid` event nothing handled. */
async function markBrowserBubble(field: Locator): Promise<void> {
  await field.evaluate((element) =>
    element.addEventListener("invalid", (event) => {
      if (!event.defaultPrevented) element.setAttribute("data-browser-bubble", "");
    }),
  );
}

test("an empty or wrong field of a custom Connector says why under it in the interface's language, not the system's, and the focus goes to the first, in English and Chinese (#1456)", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await openSettings(window, "connectors");
    const page = window.getByTestId("settings-page-connectors");
    await page.getByTestId("connector-add-custom").click();
    await setLanguage(window, "zh-CN");
    const form = page.getByTestId("connector-form");
    const name = form.getByLabel(/^名称/);
    const url = form.getByLabel(/^服务器 URL/);
    await markBrowserBubble(name);
    await markBrowserBubble(url);

    await form.getByRole("button", { name: "添加连接器" }).click();
    await expect(name).toBeFocused();
    await expect(name).toHaveAttribute("aria-invalid", "true");
    await expect(name).toHaveAccessibleDescription("连接器名称不能为空。");
    await expect(url).toHaveAttribute("aria-invalid", "true");
    await expect(url).toHaveAccessibleDescription("输入服务器 URL。");

    // A line goes once its field is right; Enter takes the focus to the field still wrong.
    await name.fill("Wiki");
    await expect(name).not.toHaveAttribute("aria-invalid");
    await url.fill("wiki.example.test");
    await expect(url).toHaveAccessibleDescription("“wiki.example.test”不是有效的 URL。");
    await name.press("Enter");
    await expect(url).toBeFocused();
    await setLanguage(window, "en");
    const urlInEnglish = form.getByLabel(/^Server URL/);
    await expect(urlInEnglish).toHaveAccessibleDescription(
      "“wiki.example.test” isn’t a valid URL.",
    );
    await urlInEnglish.fill("https://wiki.example.test/mcp");
    await expect(urlInEnglish).not.toHaveAttribute("aria-invalid");
    await expect(form.getByRole("alert")).toHaveCount(0);
    await expect(urlInEnglish).not.toHaveAttribute("data-browser-bubble");
    await expect(form.getByLabel(/^Name/)).not.toHaveAttribute("data-browser-bubble");

    await page.getByRole("tab", { name: "Command" }).click();
    const localName = form.getByLabel(/^Name/);
    const command = form.getByLabel(/^Command/);
    await markBrowserBubble(localName);
    await markBrowserBubble(command);
    await form.getByRole("button", { name: "Add Connector" }).click();
    await expect(localName).toBeFocused();
    await expect(localName).toHaveAccessibleDescription("A Connector’s name can’t be empty.");
    await expect(command).toHaveAttribute("aria-invalid", "true");
    await expect(command).toHaveAccessibleDescription(
      "Enter the command that starts the Connector.",
    );
    await expect(localName).not.toHaveAttribute("data-browser-bubble");
    await expect(command).not.toHaveAttribute("data-browser-bubble");
  } finally {
    await app.close();
  }
});

test("a long address in a Connector's URL problem is cut in the middle, and the line's mark shares a line with its words at the narrowest window, in English and Chinese (#1456)", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 900, 760);
    await dismissChatSetup(window);
    await openSettings(window, "connectors");
    const page = window.getByTestId("settings-page-connectors");
    await page.getByTestId("connector-add-custom").click();
    const form = page.getByTestId("connector-form");
    const address = `wiki.example.test/${"a-long-path/".repeat(8)}end`;
    await form.getByLabel(/^Name/).fill("Wiki");
    await form.getByLabel(/^Server URL/).fill(address);
    await form.getByRole("button", { name: "Add Connector" }).click();

    for (const language of ["en", "zh-CN"] as const) {
      await setLanguage(window, language);
      const line = form.getByRole("alert");
      await expect(line).toHaveCount(1);
      await expect(line).toContainText(/wiki\.example\.test\/\S*…\S*end/);
      await expect(line).not.toContainText(address);
      const shape = await line.evaluate((element) => {
        const mark = element.querySelector("svg")?.getBoundingClientRect();
        const words = Array.from(element.childNodes).find((node) => node.nodeType === 3);
        if (!mark || !words) return null;
        const range = document.createRange();
        range.selectNodeContents(words);
        const first = range.getClientRects()[0];
        if (!first) return null;
        return {
          markMiddle: mark.top + mark.height / 2,
          firstTop: first.top,
          firstBottom: first.bottom,
          rows: element.getBoundingClientRect().height / first.height,
        };
      });
      expect(shape, `${language}: the line has a mark and words`).not.toBeNull();
      expect(shape?.markMiddle).toBeGreaterThan(shape?.firstTop ?? Infinity);
      expect(shape?.markMiddle).toBeLessThan(shape?.firstBottom ?? -Infinity);
      expect(shape?.rows).toBeLessThan(2);
    }
  } finally {
    await app.close();
  }
});

test("a reviewed Connector in the directory connects in one click, signing in in the browser", async () => {
  const fake = await startFakeRemote();
  // The directory as shipped would list real services: this one lists the stand-in.
  const directory = join(dataDir, "directory.json");
  await writeFile(
    directory,
    JSON.stringify([
      {
        id: "wiki",
        name: "Wiki",
        publisher: "Wiki Inc.",
        group: "files",
        summary: { en: "Search the team wiki", "zh-CN": "搜索团队维基" },
        subscription: { product: "Wiki Pro" },
        url: fake.url,
        signIn: "browser",
        tools: [
          { title: { en: "Search the wiki", "zh-CN": "搜索维基" }, changes: false },
          { title: { en: "Edit a wiki page", "zh-CN": "编辑维基页面" }, changes: true },
        ],
      },
    ]),
  );
  try {
    const { app, window } = await launchApp(dataDir, { connectorDirectory: directory });
    await dismissChatSetup(window);
    await interceptOpenExternal(app);

    await openSettings(window, "connectors");
    const page = window.getByTestId("settings-page-connectors");
    const group = page.locator('[data-testid="connectors-group"][data-group="files"]');
    await expect(group).toContainText("Where your files are");
    const card = group.getByTestId("connector-entry");
    await expect(card).toContainText("Wiki");
    await expect(card).toContainText("Search the team wiki");
    await expect(card).toContainText("Needs your Wiki Pro subscription");
    // Search finds it; a letter nothing has says so. One letter doesn't ask the MCP Registry.
    const search = page.getByTestId("connectors-search");
    await search.fill("q");
    await expect(page).toContainText("No connector matches “q”.");
    await search.fill("w");
    await expect(page.getByTestId("connector-entry")).toHaveCount(1);
    await expect(page.getByTestId("connectors-registry")).toHaveCount(0);
    // Looking at the directory reaches no service.
    expect(fake.requests).toEqual([]);

    await page.getByTestId("connector-entry").click();
    const detail = page.getByTestId("connector-detail");
    await expect(page.getByTestId("connector-name")).toHaveText("Wiki");
    await expect(detail).toContainText(
      "By Wiki Inc. · Reviewed by IncarnaMind · Needs your Wiki Pro subscription",
    );
    await expect(detail).toContainText("Browser sign-in. Needs a Wiki Pro subscription.");
    await expect(page.getByTestId("connectors-back")).toBeFocused();
    // Its Tools as reviewed, before connecting: what each does, with no choice yet.
    const reviewed = page.getByTestId("connector-reviewed-tool");
    await expect(reviewed).toHaveCount(2);
    await expect(reviewed.first()).toContainText("Search the wiki");
    await expect(reviewed.first()).toContainText("Reads");
    await expect(reviewed.last()).toContainText("May change things");
    expect(fake.requests).toEqual([]);

    await acceptPlainTextKeys(window);
    await page.getByTestId("connector-connect").click();
    await expect(page.getByTestId("connector-signing-in")).toContainText(
      "Finish signing in in your browser",
    );
    await expect.poll(async () => (await urlsOpened(app)).length).toBe(1);
    const [authorizeUrl] = await urlsOpened(app);
    await approveInBrowser(fake, authorizeUrl, "Wiki");

    const done = page.getByTestId("connector-connected");
    await expect(done).toContainText("Connected to Wiki.");
    await expect(page.getByTestId("connector-tool")).toHaveCount(2);
    await expect(fake.registrations).toHaveLength(1);

    // Try it in the assistant: Settings closes, and the cursor is in the composer.
    await done.getByRole("button", { name: "Try it in the assistant" }).click();
    await expect(window.getByTestId("settings")).toBeHidden();
    await expect(window.getByTestId("composer-input")).toBeFocused();

    // Settings opens again on the list, the Connector under Connected.
    await openSettings(window, "connectors");
    const row = page.getByTestId("connected-connector");
    await expect(row).toContainText("Wiki");
    await expect(row.getByTestId("connected-connector-state")).toHaveText("Connected");
    await app.close();
  } finally {
    await fake.close();
  }
});

test("the search asks the MCP Registry only once the User types and agrees, and marks what it finds as not reviewed", async () => {
  const registry = await startFakeRegistry();
  try {
    const { app, window } = await launchApp(dataDir, { connectorRegistry: registry.url });
    await dismissChatSetup(window);
    await openSettings(window, "connectors");
    const page = window.getByTestId("settings-page-connectors");
    const search = page.getByTestId("connectors-search");
    await expect(search).toHaveAttribute("placeholder", "Search connectors and the MCP Registry");

    // One letter asks nothing.
    await search.fill("z");
    await expect(page.getByTestId("connectors-registry")).toHaveCount(0);
    expect(registry.requests).toEqual([]);

    // Two or more: the User is asked first, then the Registry is.
    await search.fill("zotero");
    const consent = window.getByTestId("consent-dialog");
    await expect(consent).toContainText("What you type in the Connectors search");
    expect(registry.requests).toEqual([]);
    await consent.getByTestId("consent-allow").click();
    const found = page.getByTestId("connectors-registry");
    await expect(found).toContainText("From the MCP Registry");
    await expect(found.getByTestId("connectors-registry-badge")).toHaveText(
      "Community · not reviewed",
    );
    await expect(found).toContainText("Community connectors aren’t reviewed.");
    await expect(found.getByTestId("registry-server")).toHaveCount(3);
    expect(registry.requests).toEqual(["/v0.1/servers?search=zotero&version=latest&limit=20"]);

    // A local one opens Add custom connector's command, filled in, for its key.
    await found.getByRole("button", { name: /Zotero library \(local\)/ }).click();
    const detail = page.getByTestId("registry-detail");
    await expect(detail).toContainText("Published as io.github.example");
    await expect(detail).toContainText("Community · not reviewed");
    await expect(detail).toContainText("Runs on this computer: uvx zotero-mcp-server@0.11.0 serve");
    await detail.getByTestId("registry-set-up").click();
    const form = page.getByTestId("connector-form");
    await expect(page.getByRole("tab", { name: "Command" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(form.getByLabel("Name", { exact: true })).toHaveValue("Zotero library (local)");
    await expect(form.getByLabel(/^Command/)).toHaveValue("uvx");
    await expect(form.getByLabel("Arguments, one per line")).toHaveValue(
      "zotero-mcp-server@0.11.0\nserve",
    );
    await expect(form.getByLabel(/^Environment variables/)).toHaveValue("ZOTERO_API_KEY=");
    await app.close();
  } finally {
    await registry.close();
  }
});

test("a whole command line pasted as the command is split into its arguments, and a broken Connector is fixed by changing it", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await openSettings(window, "connectors");
  const page = window.getByTestId("settings-page-connectors");

  // Pasted whole, the command keeps the program and its arguments go below.
  await page.getByTestId("connector-add-custom").click();
  await page.getByRole("tab", { name: "Command" }).click();
  const form = page.getByTestId("connector-form");
  await form.getByLabel("Name", { exact: true }).fill("Tides");
  const command = form.getByLabel(/^Command/);
  await command.fill(`"${process.execPath}" ${TIDE_SERVER}`);
  await form.getByLabel(/^Arguments, one per line/).focus();
  await expect(command).toHaveValue(process.execPath);
  await expect(form.getByLabel(/^Arguments, one per line/)).toHaveValue(TIDE_SERVER);
  await expect(form).toContainText("The rest went into Arguments");
  await form.getByRole("button", { name: "Cancel" }).click();

  // A Connector added with a command that isn't there fails; changing its command fixes it.
  await page.getByTestId("connector-add-custom").click();
  await page.getByRole("tab", { name: "Command" }).click();
  await form.getByLabel("Name", { exact: true }).fill("Tides");
  await form.getByLabel(/^Command/).fill("tide-runtime-not-installed");
  await form.getByLabel(/^Environment variables/).fill("TIDE_TOKEN=smoke-secret");
  await acceptPlainTextKeys(window, form);
  await form.getByRole("button", { name: "Add Connector" }).click();
  const connector = page.getByTestId("connector");
  await expect(connector).toHaveAttribute("data-state", "error", { timeout: 30_000 });

  await connector.getByTestId("connector-edit").click();
  const edit = connector.getByTestId("connector-form");
  await expect(edit.getByLabel("Name", { exact: true })).toHaveValue("Tides");
  await expect(edit).toContainText("Leave empty to keep the saved values of TIDE_TOKEN.");
  await edit.getByLabel(/^Command/).fill(process.execPath);
  await edit.getByLabel(/^Arguments, one per line/).fill(TIDE_SERVER);
  await edit.getByRole("button", { name: "Save and restart" }).click();
  await expect(edit).toBeHidden();
  await expect(connector).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await expect(connector).toContainText(TIDE_SERVER);
  await app.close();
});
