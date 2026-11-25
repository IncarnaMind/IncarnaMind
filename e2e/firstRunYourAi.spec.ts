import { chmod, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { ALL_SHARED_ID, type CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import { translate } from "../src/shared/i18n";
import { installAgent } from "../tests/helpers/agentInstalls";
import {
  acceptPlainTextKeys,
  catchCopies,
  createDataFolder,
  exampleRow,
  frontMind,
  interceptOpenExternal,
  interceptOpenPath,
  launchApp,
  pathsOpened,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
  urlsOpened,
} from "./app";
import { type InstallerStandIn, startInstallerStandIn } from "./claudeInstaller";

test.skip(!SHOW_AGENT_CONNECTION, "Agents are hidden while SHOW_AGENT_CONNECTION is false.");
test.skip(process.platform === "win32", "The stand-in for Claude Code starts from a shell script.");

/*
 * First run's Your AI step (#3791): the AI apps found on this computer are one list, one tick each,
 * the first of them ticked; one sentence says what connecting lets them read; Connect moves on by
 * itself once every app chosen works, and stays where one still needs the User, its row saying
 * what is left. Finish opens the example, whose foot is the input a Note of the User's own has. The
 * apps are found in the test's own folders, Claude Code's command is a Node script, and the
 * one-press install is a local stand-in, so nothing of this computer's is found, run or opened.
 */

type Language = "en" | "zh-CN";
const LANGUAGES: readonly Language[] = ["en", "zh-CN"];
const STAND_INS = { ollama: "http://127.0.0.1:9", decisions: "http://127.0.0.1:9" };
const EIGHT = [
  "claude-desktop",
  "codex",
  "claude-code",
  "cursor",
  "vscode",
  "opencode",
  "zed",
  "gemini-cli",
] as const;

let dataDir: string;
let home: string;
let apps: string;
let bin: string;
let app: ElectronApplication | null = null;
let installer: InstallerStandIn | null = null;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await realpath(await createDataFolder());
  apps = await realpath(await createDataFolder());
  bin = await realpath(await createDataFolder());
  await writeFile(
    join(bin, "claude"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(__dirname, "fixtures", "fakeClaudeCode.mjs")}" "$@"\n`,
  );
  await chmod(join(bin, "claude"), 0o755);
});
test.afterEach(async () => {
  await app?.close();
  app = null;
  await installer?.close();
  installer = null;
  for (const folder of [dataDir, home, apps, bin]) await removeDataFolder(folder);
});

const say = (language: Language, key: Parameters<typeof translate>[1], params = {}) =>
  translate(language, key, params);

const bridge = (window: Page) => ({
  agents: () =>
    window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getAgents(),
    ),
  language: (language: Language) =>
    window.evaluate(
      (chosen) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
          user: { language: chosen },
        }),
      language,
    ),
});

/** The app on a fresh profile, these apps found on this computer, in `language`. */
async function launch(
  found: readonly string[],
  language: Language,
  options: { installer?: InstallerStandIn } = {},
): Promise<Page> {
  for (const id of found) {
    if (id === "claude-code") {
      await installAgent(id, { applications: apps, commands: apps, home }, "command");
      await writeFile(join(home, ".claude.json"), "{}\n");
    } else await installAgent(id, { applications: apps, commands: apps, home });
  }
  const launched = await launchApp(dataDir, {
    ...STAND_INS,
    firstRunSetup: true,
    home,
    agentApps: [apps],
    ownAi: join(bin, "claude"),
    extraEnv: { INCARNAMIND_TEST_OWN_AI_MODE_FILE: join(bin, "mode") },
    ...(options.installer && { claudeInstaller: options.installer.origin }),
  });
  app = launched.app;
  // Connecting Claude's app or Cursor opens them: here nothing of this computer's opens.
  await interceptOpenPath(launched.app);
  await interceptOpenExternal(launched.app);
  await setWindowSize(launched.app, launched.window, 1440, 900);
  await acceptPlainTextKeys(launched.window);
  await catchCopies(launched.window);
  await bridge(launched.window).language(language);
  return launched.window;
}

async function atStep(window: Page, step: string): Promise<Locator> {
  const panel = window.getByTestId("setup-panel");
  await expect(panel).toHaveAttribute("data-step", step);
  return panel;
}

/** Your work skipped: the Your AI step, as it opens. */
async function yourAi(window: Page): Promise<Locator> {
  await (await atStep(window, "work")).getByTestId("setup-skip").click();
  return atStep(window, "ai");
}

/** The apps the list shows, in its order. */
const listed = (ai: Locator) =>
  ai
    .getByTestId("setup-app")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-value")));

/** The main button is on screen without scrolling, at 1440 × 900 and 900 wide. */
async function mainButtonInView(window: Page, button: Locator): Promise<void> {
  for (const width of [1440, 900]) {
    await setWindowSize(app as ElectronApplication, window, width, 900);
    await expect(button, `at ${width} px`).toBeInViewport({ ratio: 1 });
    const scrolls = await window
      .getByTestId("first-run-setup")
      .evaluate((page) => page.scrollTop > 0 || page.scrollWidth > page.clientWidth);
    expect(scrolls, `at ${width} px`).toBe(false);
  }
  await setWindowSize(app as ElectronApplication, window, 1440, 900);
}

/** What the stand-in for Claude Code does at its next start. */
const nextRun = (mode: string) => writeFile(join(bin, "mode"), mode);

for (const language of LANGUAGES) {
  // protects=the first run of a User with Claude Code: one row, ticked, one sentence of consent, Connect moves on by itself, and Finish lands in the example with the Note's own input, where a typed line gets the AI's work into the Note, no window opened; fails_when=all found apps start ticked, the step stays after Connect, Finish lands on Home, the example has no input, or asking there opens another app
  test(`one app found: Claude Code ticked, Connect moves on, Finish opens the example with its input (${language})`, async () => {
    test.setTimeout(180_000);
    const window = await launch(["claude-code"], language);
    const ai = await yourAi(window);
    expect(await listed(ai)).toEqual(["claude-code"]);
    const tick = ai.getByTestId("setup-app-tick");
    await expect(tick).toBeChecked();
    await expect(tick).toBeFocused();
    await expect(ai.getByTestId("setup-consent")).toContainText(
      say(language, "setupPage.ai.consent.one"),
    );
    await expect(ai.getByTestId("setup-another-app")).toContainText(
      say(language, "setupPage.ai.another"),
    );
    await expect(ai.getByTestId("setup-sorting-model-open")).toBeVisible();
    // Gone from the step: the search, the second list, each app's technical line, a model here.
    for (const gone of ["setup-agents-search", "setup-agent", "setup-in-app-open", "setup-key"]) {
      await expect(ai.getByTestId(gone), gone).toHaveCount(0);
    }
    const connect = ai.getByTestId("setup-connect");
    await expect(connect).toHaveText(say(language, "setupPage.ai.connect"));
    await mainButtonInView(window, connect);
    // Details holds what else it reads, that it may write, and the change to its settings file.
    await ai.getByTestId("setup-consent-details").click();
    await expect(ai.getByTestId("setup-consent-more")).toContainText(
      say(language, "agents.connect.body", { agent: "Claude Code" }),
    );
    await expect(ai.getByTestId("setup-consent-propose")).toBeChecked();
    expect((await bridge(window).agents()).pairings).toEqual([]);

    await connect.click();
    const meetings = await atStep(window, "meetings");
    const [pairing] = (await bridge(window).agents()).pairings;
    expect(pairing).toMatchObject({
      client: "claude-code",
      folderIds: [ALL_SHARED_ID],
      propose: true,
    });
    const settings = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
    expect(settings.mcpServers.incarnamind).toMatchObject({ type: "stdio" });
    // Notes after a call and help during it work with the User's own AI: no line says otherwise.
    await expect(meetings.getByTestId("setup-meetings-needs-model")).toHaveCount(0);
    await meetings.getByTestId("setup-next").click();
    await expect(window.getByTestId("setup-panel")).toHaveCount(0);

    // The example is in front, its wrong figure marked, the one line above the input, no card.
    const note = frontMind(window);
    await expect(note).toBeVisible();
    await expect(window.getByTestId("example-line")).toBeVisible();
    await expect(window.getByTestId("home")).toBeHidden();
    await expect(note.getByTestId("claim-mark")).toHaveAttribute("data-check", "contradicted", {
      timeout: 30_000,
    });
    await expect(window.getByTestId("example-line")).toHaveText(
      `${say(language, "examples.line.credit")}${language === "en" ? " " : ""}${say(language, "examples.line.add")}`,
    );
    await expect(window.getByTestId("first-open-steps")).toHaveCount(0);
    await expect(window.getByTestId("ask-pill")).toHaveCount(0);
    await expect(note).not.toContainText("⌘J");
    const input = window.locator(
      '[data-testid="tab-group"][data-focused] [data-testid="note-ask-input"]',
    );
    await expect(input).toBeVisible();

    // A line typed there and Enter: the User's AI reads the example and writes in it, here.
    await nextRun("summary");
    await pointAndClick(window, input);
    await window.keyboard.type(language === "en" ? "Summarize this for me" : "帮我总结一下");
    await window.keyboard.press("Enter");
    await expect(note).toContainText(
      language === "en"
        ? "The 07:40 crossing from Kestrel Bay leaves late"
        : "红隼湾工作日 07:40 的班次大多晚点",
      { timeout: 30_000 },
    );
    expect(await urlsOpened(app as ElectronApplication)).toEqual([]);
  });

  // protects=two apps found start with one ticked, and an app that still needs the User keeps the step with its row saying what is left and its one button, Continue held until it is done or the User goes on; fails_when=both start ticked, the main button falls below the window, the step moves on with an app unfinished, or a raw command shows on the row
  test(`two apps found: one ticked, and the one left says what to do (${language})`, async () => {
    test.setTimeout(180_000);
    const window = await launch(["claude-desktop", "claude-code"], language);
    const ai = await yourAi(window);
    expect(await listed(ai)).toEqual(["claude-code", "claude-desktop"]);
    const row = (id: string) => ai.locator(`[data-testid="setup-app"][data-value="${id}"]`);
    await expect(row("claude-code").getByTestId("setup-app-tick")).toBeChecked();
    await expect(row("claude-desktop").getByTestId("setup-app-tick")).not.toBeChecked();
    await mainButtonInView(window, ai.getByTestId("setup-connect"));

    await row("claude-desktop").getByTestId("setup-app-tick").check();
    await expect(ai.getByTestId("setup-consent")).toContainText(
      say(language, "setupPage.ai.consent.many"),
    );
    await ai.getByTestId("setup-connect").click();
    // Claude Code works at once; Claude waits for Install in its own window, which opened.
    const done = ai.getByTestId("setup-done");
    const claude = done.locator('[data-testid="setup-done-row"][data-client="claude-desktop"]');
    await expect(claude).toHaveAttribute("data-left", "true");
    await expect(claude).toContainText(
      say(language, "setupPage.ai.row.install", { agent: "Claude" }),
    );
    await expect(
      done.locator('[data-testid="setup-done-row"][data-client="claude-code"]'),
    ).toContainText(say(language, "setupPage.ai.connected"));
    await expect(ai.locator("#setup-title + p")).toHaveText(
      say(language, "setupPage.ai.left.one", { agent: "Claude" }),
    );
    await expect(ai.getByTestId("setup-next")).toBeDisabled();
    const opened = (await pathsOpened(app as ElectronApplication)).length;
    expect(opened).toBeGreaterThan(0);
    await claude.getByTestId("setup-done-open").click();
    await expect
      .poll(async () => (await pathsOpened(app as ElectronApplication)).length)
      .toBe(opened + 1);
    expect((await bridge(window).agents()).pairings.map((each) => each.client).sort()).toEqual([
      "claude-code",
      "claude-desktop",
    ]);
    // The User may go on with it left.
    await ai.getByTestId("setup-skip").click();
    await atStep(window, "meetings");
  });

  // protects=a computer with eight AI apps keeps the step short: three rows, the rest folded into one row that opens in place, the main button in view, Claude Code first and alone ticked, and an app not found reached only through Another app…; fails_when=all eight show or start ticked, the button falls below the window, or an app not found is offered as found
  test(`eight apps found: three shown, the rest one row, one ticked (${language})`, async () => {
    test.setTimeout(180_000);
    const window = await launch(EIGHT, language);
    const ai = await yourAi(window);
    expect(await listed(ai)).toEqual(["claude-code", "codex", "claude-desktop"]);
    await expect(ai.locator('[data-testid="setup-app-tick"]:checked')).toHaveCount(1);
    await expect(
      ai.locator(
        '[data-testid="setup-app"][data-value="claude-code"] [data-testid="setup-app-tick"]',
      ),
    ).toBeChecked();
    const more = ai.getByTestId("setup-apps-more");
    await expect(more).toHaveText(`+5${say(language, "setupPage.ai.moreFound", { count: 5 })}`);
    await mainButtonInView(window, ai.getByTestId("setup-connect"));
    await more.click();
    expect((await listed(ai)).sort()).toEqual([...EIGHT].sort());
    await expect(ai.locator('[data-testid="setup-app-tick"]:checked')).toHaveCount(1);

    // Another app… lists the apps not found here, and Other agent, none of the eight.
    await ai.getByTestId("setup-another-app").click();
    const another = window.getByTestId("setup-another");
    await expect(another).toBeVisible();
    const offered = await another
      .getByTestId("setup-another-app")
      .evaluateAll((rows) => rows.map((each) => each.getAttribute("data-value")));
    expect(offered).toContain("other");
    for (const id of EIGHT) expect(offered).not.toContain(id);
    await window.keyboard.press("Escape");
    await expect(ai.getByTestId("setup-apps")).toBeVisible();
  });

  // protects=with no AI app found, the step offers Claude Code's install as its one row and Another app…, downloads nothing unasked, and Set up later still ends in the example, where the input's place says to connect an AI, as Home does; fails_when=an app not on this computer shows as found, the install starts unasked, Set up later lands on Home, or the example offers a model in IncarnaMind
  test(`none found, then Set up later: the example says to connect an AI (${language})`, async () => {
    test.setTimeout(180_000);
    installer = await startInstallerStandIn({ install: "hold" });
    const window = await launch([], language, { installer });
    const ai = await yourAi(window);
    await expect(ai.locator("#setup-title + p")).toHaveText(
      say(language, "setupPage.ai.lead.none"),
    );
    expect(await listed(ai)).toEqual([]);
    const offer = ai.getByTestId("setup-install-row");
    await expect(offer).toContainText(say(language, "setupPage.ai.install.line"));
    await expect(offer.getByTestId("setup-install-claude-code")).toHaveText(
      say(language, "setupPage.ai.install"),
    );
    await expect(ai.getByTestId("setup-another-app")).toBeVisible();
    await expect(ai.getByTestId("setup-connect")).toHaveCount(0);
    expect(installer.installCalls).toBe(0);

    await ai.getByTestId("setup-skip").click();
    await (await atStep(window, "meetings")).getByTestId("setup-skip").click();
    await expect(window.getByTestId("setup-panel")).toHaveCount(0);
    expect(installer.installCalls).toBe(0);
    const note = frontMind(window);
    await expect(note).toBeVisible();
    const noAi = window.getByTestId("note-ask-no-ai");
    await expect(noAi).toContainText(say(language, "noteAsk.connectToAsk"));
    await expect(window.getByTestId("note-ask-input")).toHaveCount(0);
    await expect(window.getByTestId("ask-pill")).toHaveCount(0);
    await expect(window.getByTestId("example-line")).toBeVisible();

    // Home: one input's place, the same line, and the three ways to start.
    await pointAndClick(window, window.getByTestId("sidebar-home"));
    const home = window.getByTestId("home-ask");
    await expect(home.getByTestId("home-ask-no-ai")).toContainText(
      say(language, "noteAsk.connectToAsk"),
    );
    await expect(home.getByTestId("home-add-files")).toBeVisible();
    await expect(home.getByTestId("home-link-folder")).toBeVisible();
    await expect(home.getByTestId("home-new-mind")).toBeVisible();

    // Its button opens Settings › AI, where the AI is connected.
    await pointAndClick(window, exampleRow(window).first());
    await window.getByTestId("note-ask-connect").click();
    await expect(window.getByTestId("settings")).toHaveAttribute("data-page", "ai");
  });

  // protects=a User with only the Claude app is told on its row that Connect installs Claude Code too, and the same press installs it and connects it once signed in, with nothing installed before the press and nothing in Local mode; fails_when=the row says nothing first, the install starts unasked or in Local mode, or Claude Code isn't connected after its sign-in
  test(`only the Claude app found: Connect also installs Claude Code (${language})`, async () => {
    test.setTimeout(180_000);
    installer = await startInstallerStandIn({ signIn: "signed-in", auth: "signed-in" });
    const window = await launch(["claude-desktop"], language, { installer });
    const ai = await yourAi(window);
    expect(await listed(ai)).toEqual(["claude-desktop"]);
    const row = ai.locator('[data-testid="setup-app"][data-value="claude-desktop"]');
    await expect(row.getByTestId("setup-app-tick")).toBeChecked();
    await expect(row.getByTestId("setup-app-installs")).toHaveText(
      say(language, "setupPage.ai.alsoInstalls"),
    );
    // In Local mode nothing installs, and the row says nothing of it.
    const localOnly = (on: boolean) =>
      window.evaluate(
        (value) =>
          (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.setLocalOnly(value),
        on,
      );
    await localOnly(true);
    await expect(row.getByTestId("setup-app-installs")).toHaveCount(0);
    await localOnly(false);
    await expect(row.getByTestId("setup-app-installs")).toBeVisible();
    expect(installer.installCalls).toBe(0);

    await ai.getByTestId("setup-connect").click();
    await expect.poll(() => installer?.installCalls).toBe(1);
    const done = ai.getByTestId("setup-done");
    await expect(
      done.locator('[data-testid="setup-done-row"][data-client="claude-code"]'),
    ).toContainText(say(language, "setupPage.ai.connected"), { timeout: 30_000 });
    await expect(
      done.locator('[data-testid="setup-done-row"][data-client="claude-desktop"]'),
    ).toContainText(say(language, "setupPage.ai.row.install", { agent: "Claude" }));
    await expect
      .poll(async () => (await bridge(window).agents()).pairings.map((each) => each.client).sort())
      .toEqual(["claude-code", "claude-desktop"]);
  });

  // protects=a User whose Anthropic plan has no Claude Code is told so on Claude Code's row, and the step waits for them; fails_when=the row says nothing of the plan, or the step moves on by itself
  test(`only the Claude app found, a plan without Claude Code: its row says so (${language})`, async () => {
    test.setTimeout(180_000);
    installer = await startInstallerStandIn({ signIn: "no-plan", auth: "signed-out" });
    const window = await launch(["claude-desktop"], language, { installer });
    const ai = await yourAi(window);
    await ai.getByTestId("setup-connect").click();
    const claudeCode = ai.locator('[data-testid="setup-done-row"][data-client="claude-code"]');
    await expect(claudeCode).toHaveAttribute("data-state", "no-plan", { timeout: 30_000 });
    await expect(claudeCode).toContainText(say(language, "agents.install.noPlan.title"));
    await expect(claudeCode.getByTestId("setup-install-other-account")).toBeVisible();
    await expect(ai).toHaveAttribute("data-step", "ai");
    expect((await bridge(window).agents()).pairings.map((each) => each.client)).toEqual([
      "claude-desktop",
    ]);
  });
}

// protects=connecting an app again never widens what it may read or write unasked: the sheet for an app already connected starts from the connection's own Folders and its may-propose setting; fails_when=the sheet starts from all of the User's Documents or with changes allowed
test("the sheet for an app already connected starts from what its connection allows", async () => {
  test.setTimeout(180_000);
  const window = await launch([], "en");
  const folderId = await window.evaluate(async () => {
    const made = await (
      globalThis as unknown as { incarnamind: CoreBridge }
    ).incarnamind.createLibraryGroup({
      name: "Kestrel Bay",
      description: "",
    });
    return made.id;
  });
  const ai = await yourAi(window);
  const sheetFor = async (id: string) => {
    await ai.getByTestId("setup-another-app").click();
    await window.locator(`[data-testid="setup-another-app"][data-value="${id}"]`).click();
    return window.getByTestId("setup-another-connect");
  };
  let sheet = await sheetFor("cursor");
  await sheet.getByTestId("agent-share-folders").check();
  await sheet.locator(`[data-testid="agent-folder"][data-folder="${folderId}"]`).check();
  await sheet.getByTestId("agent-propose").uncheck();
  await sheet.getByTestId("setup-another-allow").click();
  await expect(window.getByTestId("setup-done")).toBeVisible();
  const [cursor] = (await bridge(window).agents()).pairings;
  expect(cursor).toMatchObject({ client: "cursor", folderIds: [folderId], propose: false });

  await window.getByTestId("setup-skip").click();
  await (await atStep(window, "meetings")).getByTestId("setup-back").click();
  await atStep(window, "ai");
  sheet = await sheetFor("cursor");
  await expect(sheet.getByTestId("agent-share-folders")).toBeChecked();
  await expect(
    sheet.locator(`[data-testid="agent-folder"][data-folder="${folderId}"]`),
  ).toBeChecked();
  await expect(sheet.getByTestId("agent-propose")).not.toBeChecked();
});
