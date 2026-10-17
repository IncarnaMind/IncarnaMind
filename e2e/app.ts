import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import type { Editor } from "@tiptap/core";
import * as Y from "yjs";
import {
  type AssistantPlace,
  CHOSEN_PROVIDER_FLOWS,
  type CoreBridge,
  type ExportFormat,
  type SaveChatProviderInput,
} from "../src/core/api";
import type { FakeTranscriberOptions } from "../src/core/transcription/fake";
import type { DocumentLocation } from "../src/shared/documentViewer";
import type { TestHooks } from "../src/shared/testHooks";
import { type FakeOpenAIServer, signInAt } from "../tests/helpers/fakeOpenAI";
import { homeEnv } from "../tests/helpers/home";

const appDir = resolve(__dirname, "..");

/**
 * The apps this test launched that are still open, by the data folder each
 * runs on: `removeDataFolder` closes them, keeping a picture of the window if
 * the test failed.
 */
const openApps = new Map<ElectronApplication, string>();

export interface RunningApp {
  app: ElectronApplication;
  window: Page;
}

export interface LaunchOptions {
  /**
   * Every chat model is the scripted one in `src/main/fakeChat/`, so
   * Questions are answered with no network or keys. Needs a test build
   * (`npm run test:smoke` makes one).
   */
  fakeChat?: boolean;
  /**
   * Where Ollama is: a local server standing in for it (the app's `OLLAMA_HOST`).
   */
  ollama?: string;
  /**
   * Set, the app really asks the Ollama at `ollama` whether it runs, and opening Ollama's app
   * only counts (`ollamaAppOpened`). Without it, the scripted chat model's Ollama always runs.
   */
  ollamaApp?: "installed" | "missing";
  /** The LM Studio and Unsloth Studio on this computer are never asked: those named here, by catalog id, run and list these models. */
  localServers?: Record<string, string[]>;
  /**
   * Where crash reports go: a test build offers them only with this, and
   * ignores the DSN a real build is made with. Point it at a local server.
   */
  sentryDsn?: string;
  /**
   * Where usage data goes: a test build sends it only with this, to a local
   * server standing in for PostHog, and ignores the project a real build is
   * made with. `testerBuild`: as a test build (for invited testers) would, on until the
   * User turns it off.
   */
  usageData?: { host: string; testerBuild?: boolean };
  /**
   * The app ships its examples (`resources/examples`), so a first run opens
   * on the example Mind with "Get started". Without, a test build ships none.
   */
  examples?: boolean;
  /**
   * The app's home folder, for a test that looks at what the app writes there. Without one,
   * each launch gets its own temporary home, so nothing the app writes there is the User's.
   */
  home?: string;
  /**
   * Where Look up asks Crossref and arXiv: a local server standing in for
   * both (tests/helpers/referenceServices.ts). A test build honours it.
   */
  referenceLookup?: string;
  /**
   * Where Find sources asks its providers: a local server standing in for
   * all of them (tests/helpers/sourceServices.ts). A test build honours it.
   */
  sources?: string;
  /**
   * A JSON file of Connectors directory entries in place of the list that
   * ships with the app, e.g. one served by a local stand-in. A test build honours it.
   */
  connectorDirectory?: string;
  /** Where the Connectors search asks the MCP Registry: a local stand-in. A test build honours it. */
  connectorRegistry?: string;
  /**
   * Where the ChatGPT plan signs in and asks: the origin of a local server
   * standing in for OpenAI (tests/helpers/fakeOpenAI.ts). A test build honours it.
   */
  chatGpt?: string;
  /** A local stand-in for GitHub and Copilot at this origin, where the Copilot plan signs in and asks. */
  copilot?: string;
  /**
   * Where the Claude account signs in and asks: the origin of a local server
   * standing in for Anthropic (tests/helpers/fakeAnthropic.ts). A test build honours it.
   */
  claude?: string;
  /** How long the Claude sign-in waits for its code, in milliseconds. A test build honours it. */
  claudeSignInMs?: number;
  /**
   * Leaves the window at the size and place it opened at, instead of making
   * it `WINDOW_SIZE`: for a test of how the window opens.
   */
  keepWindow?: boolean;
  /**
   * What a Meeting's fake capture does with the computer's sound: plays a
   * tone (by default), is denied, or gives only silence. The microphone is
   * always a fake that makes a tone: no test opens a device.
   */
  computerSound?: "allowed" | "denied" | "silent";
  /** What a Meeting's fake speech-to-text engine does: slow, failing to read stretches, failing over. */
  transcriber?: FakeTranscriberOptions;
  /**
   * The port of a local server standing in for the web (#128): web search's
   * fetcher connects there for every host, its guard still deciding. A test
   * build honours it.
   */
  web?: number;
  /** How long keeping a page as it looks may take, in milliseconds. A test build honours it. */
  lookLimit?: number;
  /**
   * What the fake text recognition model reads on each scanned page (#397):
   * a JSON file of a `FakeScanScript`. Without, it reads nothing on them.
   */
  scans?: string;
  /**
   * The scripted Task that asks for approval and writes files (src/main/scriptedTask.ts),
   * started with `startScriptedTask`. Needs a test build.
   */
  scriptedTasks?: boolean;
  /**
   * How long after a new version of a Document contradiction watch checks its
   * Folder's Minds (#112), instead of 30 seconds. Needs a test build.
   */
  contradictionWatchDelayMs?: number;
}

/**
 * The window every spec runs in, the same on every machine, and a height that
 * fits the smallest screen the specs run on. The app opens no bigger than the
 * screen, and GitHub's macOS runners have a 1024 × 768 one (677px high once
 * the menu bar and the Dock are off it), where a window opened 1024 wide folds
 * the Mind's margins away. macOS lets a window be wider than its screen, but
 * not taller, so each launch sets this size and checks the page got it, and
 * says so if a screen is too short for it. It is the page's size, the window's
 * content: on Linux the window also holds the menu bar, above the page.
 *
 * It is wider than the app's default (1280): the assistant docked on the right
 * takes 328px (#253), and this leaves the card about the room a 1280px window
 * gave it before, so groups sit side by side and the Mind keeps its margins.
 */
export const WINDOW_SIZE = { width: 1600, height: 660 };

/** The default Output location in Chinese, as the system names Documents: 文稿 on macOS, 文档 elsewhere. */
export const DEFAULT_FOLDER_ZH = `${process.platform === "darwin" ? "文稿" : "文档"} › IncarnaMind`;

/**
 * The key that, held with an arrow, moves the caret a word at a time, and with
 * Shift too selects by word: Option on macOS, Ctrl on Windows and Linux.
 */
export const WORD_KEY = process.platform === "darwin" ? "Alt" : "Control";

/**
 * Launches the built app (`out/`) on the given data folder, with test hooks on
 * and the fake embedding model, which needs no download, in a window of
 * `WINDOW_SIZE` whatever the screen's.
 */
export async function launchApp(
  dataDir: string,
  {
    fakeChat = false,
    ollama,
    ollamaApp,
    localServers,
    sentryDsn,
    usageData,
    examples = false,
    home,
    referenceLookup,
    sources,
    connectorDirectory,
    connectorRegistry,
    chatGpt,
    claude,
    claudeSignInMs,
    copilot,
    keepWindow = false,
    computerSound = "allowed",
    transcriber,
    scans,
    web,
    lookLimit,
    scriptedTasks = false,
    contradictionWatchDelayMs,
  }: LaunchOptions = {},
): Promise<RunningApp> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value;
  }
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.OLLAMA_HOST;
  if (ollama) env.OLLAMA_HOST = ollama;
  delete env.INCARNAMIND_TEST_OLLAMA_APP;
  if (ollamaApp) env.INCARNAMIND_TEST_OLLAMA_APP = ollamaApp;
  delete env.INCARNAMIND_TEST_LOCAL_SERVERS;
  if (localServers) env.INCARNAMIND_TEST_LOCAL_SERVERS = JSON.stringify(localServers);
  delete env.INCARNAMIND_TEST_SENTRY_DSN;
  delete env.INCARNAMIND_TEST_EXAMPLES;
  delete env.INCARNAMIND_TEST_POSTHOG_KEY;
  delete env.INCARNAMIND_TEST_POSTHOG_HOST;
  delete env.INCARNAMIND_TEST_TESTER_BUILD;
  delete env.POSTHOG_CAPTURE_MODE;
  delete env.INCARNAMIND_TEST_REFERENCE_LOOKUP;
  delete env.INCARNAMIND_TEST_SOURCES;
  delete env.INCARNAMIND_TEST_CONNECTOR_DIRECTORY;
  delete env.INCARNAMIND_TEST_CONNECTOR_REGISTRY;
  delete env.INCARNAMIND_TEST_CHATGPT;
  delete env.INCARNAMIND_TEST_CLAUDE;
  delete env.INCARNAMIND_TEST_CLAUDE_SIGN_IN_MS;
  delete env.INCARNAMIND_TEST_COPILOT;
  delete env.INCARNAMIND_TEST_TRANSCRIBER_OPTIONS;
  delete env.INCARNAMIND_TEST_SCANS;
  delete env.INCARNAMIND_TEST_WEB;
  delete env.INCARNAMIND_TEST_LOOK_LIMIT;
  delete env.INCARNAMIND_TEST_TASKS;
  delete env.INCARNAMIND_TEST_CONTRADICTION_DELAY_MS;
  // A test never uses the ChatGPT sign-in an agent's shell may point at for checks by hand.
  delete env.INCARNAMIND_CHATGPT_PROFILE;
  env.INCARNAMIND_TEST_AUDIO = "fake";
  env.INCARNAMIND_TEST_AUDIO_SYSTEM = computerSound;
  if (examples) env.INCARNAMIND_TEST_EXAMPLES = "1";
  if (sentryDsn) env.INCARNAMIND_TEST_SENTRY_DSN = sentryDsn;
  if (usageData) {
    env.INCARNAMIND_TEST_POSTHOG_KEY = "test-project-key";
    env.INCARNAMIND_TEST_POSTHOG_HOST = usageData.host;
    if (usageData.testerBuild) env.INCARNAMIND_TEST_TESTER_BUILD = "1";
  }
  const appHome = home ?? (await mkdtemp(join(tmpdir(), "incarnamind-home-")));
  Object.assign(env, homeEnv(appHome));
  if (referenceLookup) env.INCARNAMIND_TEST_REFERENCE_LOOKUP = referenceLookup;
  if (sources) env.INCARNAMIND_TEST_SOURCES = sources;
  if (connectorDirectory) env.INCARNAMIND_TEST_CONNECTOR_DIRECTORY = connectorDirectory;
  // Nowhere, unless a test serves one: a search in a test never reaches the real Registry.
  env.INCARNAMIND_TEST_CONNECTOR_REGISTRY = connectorRegistry ?? "http://127.0.0.1:9";
  if (chatGpt) env.INCARNAMIND_TEST_CHATGPT = chatGpt;
  if (claude) env.INCARNAMIND_TEST_CLAUDE = claude;
  if (claudeSignInMs) env.INCARNAMIND_TEST_CLAUDE_SIGN_IN_MS = String(claudeSignInMs);
  if (copilot) env.INCARNAMIND_TEST_COPILOT = copilot;
  if (scans) env.INCARNAMIND_TEST_SCANS = scans;
  if (web) env.INCARNAMIND_TEST_WEB = String(web);
  if (lookLimit) env.INCARNAMIND_TEST_LOOK_LIMIT = String(lookLimit);
  if (scriptedTasks) env.INCARNAMIND_TEST_TASKS = "1";
  if (contradictionWatchDelayMs !== undefined) {
    env.INCARNAMIND_TEST_CONTRADICTION_DELAY_MS = String(contradictionWatchDelayMs);
  }
  env.INCARNAMIND_DATA_DIR = dataDir;
  env.INCARNAMIND_TEST_HOOKS = "1";
  if (fakeChat) env.INCARNAMIND_FAKE_CHAT = "1";
  env.INCARNAMIND_TEST_EMBEDDER = "fake";
  env.INCARNAMIND_TEST_TRANSCRIBER = "fake";
  if (transcriber) env.INCARNAMIND_TEST_TRANSCRIBER_OPTIONS = JSON.stringify(transcriber);

  const app = await electron.launch({ args: [appDir], env });
  openApps.set(app, dataDir);
  app.on("close", () => {
    openApps.delete(app);
    if (!home) void rm(appHome, { recursive: true, force: true, maxRetries: 3 });
  });
  const window = await app.firstWindow();
  await window.getByTestId("plus-menu").waitFor();
  if (!keepWindow) {
    await resizeContent(app, window, WINDOW_SIZE.width, WINDOW_SIZE.height, {
      waitForHeight: true,
      message: `the window is ${WINDOW_SIZE.width} × ${WINDOW_SIZE.height}: is the screen too short for it?`,
    });
  }
  return { app, window };
}

/**
 * Starts the scripted Task (`LaunchOptions.scriptedTasks`) in a Mind: for each
 * file it asks for approval, then writes the file into `folder`. Returns its id.
 */
export const startScriptedTask = (
  app: ElectronApplication,
  mindId: string,
  input: { folder: string; files: string[] },
) =>
  app.evaluate(
    (_electron, [mind, given]) =>
      (
        globalThis as unknown as {
          incarnamindScriptedTask: { start(mindId: string, input: unknown): string };
        }
      ).incarnamindScriptedTask.start(mind, given),
    [mindId, input] as const,
  );

/**
 * Returns once everything the app captured for usage data so far has reached
 * the server `LaunchOptions.usageData` names, so a test can say nothing else
 * did without waiting a while for it.
 */
export const flushUsageData = (app: ElectronApplication) =>
  app.evaluate(async () => {
    const hooks = (globalThis as { incarnamindUsageData?: { flush(): Promise<void> } })
      .incarnamindUsageData;
    if (!hooks)
      throw new Error("Launch with `usageData`: only then has the app a usage data sender.");
    await hooks.flush();
  });

/**
 * Stands in for the system's notifications: each one shown is recorded
 * instead (`notificationsShown`, `clickNotification`). Notifications made
 * before this aren't.
 */
export const recordNotifications = (app: ElectronApplication) =>
  app.evaluate(({ Notification }) => {
    const shown: { title: string; body: string }[] = [];
    const held: Electron.Notification[] = [];
    Object.assign(globalThis, { notificationsShown: shown, notificationsHeld: held });
    Notification.isSupported = () => true;
    Notification.prototype.show = function show(this: Electron.Notification) {
      shown.push({ title: this.title, body: this.body });
      held.push(this);
    };
  });

/** Clicks the notification recorded `index`th, as the User would in the system's list. */
export const clickNotification = (app: ElectronApplication, index: number) =>
  app.evaluate((_electron, at) => {
    const held = (globalThis as { notificationsHeld?: Electron.Notification[] }).notificationsHeld;
    const notification = held?.[at];
    if (!notification) throw new Error(`No notification ${at} was shown.`);
    notification.emit("click");
  }, index);

export const notificationsShown = (app: ElectronApplication) =>
  app.evaluate(
    () =>
      (globalThis as { notificationsShown?: { title: string; body: string }[] })
        .notificationsShown ?? [],
  );

/** Force-quits the app as a crash would: its process killed, nothing saved on the way out. */
export async function forceQuit(app: ElectronApplication): Promise<void> {
  const exited = new Promise<void>((resolve) => app.process().once("exit", () => resolve()));
  app.process().kill("SIGKILL");
  await exited;
}

/** Chooses the Edit menu's Undo or Redo, as the application menu has it now. */
export const clickEditItem = (app: ElectronApplication, id: "edit.undo" | "edit.redo") =>
  app.evaluate(({ Menu }, itemId) => {
    Menu.getApplicationMenu()?.getMenuItemById(itemId)?.click();
  }, id);

/**
 * "New Mind" from the sidebar header's "+" menu, the one place to add: a Mind
 * in no Folder. Returns once its first line has the cursor: keys a test
 * presses a millisecond apart can outrun the editor while frames are busy.
 */
export async function newMind(window: Page): Promise<void> {
  const before = await (await coreOf(window)).evaluate(async (core) =>
    (await core.listMinds()).map((mind) => mind.id),
  );
  await window.getByTestId("plus-menu").click();
  await window.getByTestId("plus-new-mind").click();
  await motionSettled(window);
  // Until the new Mind's text has the cursor, keys and names go to the Mind open before it.
  await expect
    .poll(async () => {
      const id = await window.evaluate(
        () =>
          document.activeElement
            ?.closest('[data-testid="mind-pane"]')
            ?.getAttribute("data-mind-id") ?? null,
      );
      return id !== null && !before.includes(id);
    })
    .toBe(true);
}

/** A Folder's row in the sidebar's Folders view, with what is listed in it, by its name. */
export const sidebarFolder = (window: Page, name: string) =>
  window
    .getByTestId("library-folders")
    .getByTestId("library-folder")
    .filter({
      has: window.locator(':scope > div [data-testid="row-text"]', { hasText: name }),
    });

/** Opens a Folder's page in the Library's tab, from its menu in the sidebar: "Open in the Library". */
export async function openFolderInLibrary(window: Page, name: string): Promise<void> {
  const folder = sidebarFolder(window, name);
  await folder.getByTestId("folder-row").hover();
  await folder.getByTestId("folder-menu").click();
  await folder.getByTestId("folder.open").click();
  await expect(window.getByTestId("library")).toBeVisible();
}

/**
 * Opens a Folder's form (its name, description and evidence choice) under its
 * section in the Library, from its menu in the sidebar: "Edit Description…".
 */
export async function editFolderInLibrary(window: Page, name: string): Promise<Locator> {
  const folder = sidebarFolder(window, name);
  await folder.getByTestId("folder-row").hover();
  await folder.getByTestId("folder-menu").click();
  await folder.getByTestId("folder.editDescription").click();
  const form = window.getByTestId("library").getByTestId("folder-form");
  await expect(form).toBeVisible();
  return form;
}

/**
 * Shows the sidebar's Folders on disk view: each Linked folder with its
 * folders as on disk, and "Other Documents".
 */
export async function showSourceLocations(window: Page): Promise<void> {
  const button = window.getByTestId("browse-views").getByRole("button", {
    name: "Folders on disk",
  });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

/** Shows the sidebar's Folders view: the User's Folders with their Minds and Documents. */
export async function showFolders(window: Page): Promise<void> {
  const button = window
    .getByTestId("browse-views")
    .getByRole("button", { name: "Folders", exact: true });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

/**
 * First run asks for no model (#103): the setup shows in the composer at the first own Question,
 * so there is nothing to dismiss. Kept so a spec says where the old dialog used to be.
 */
export async function dismissChatSetup(window: Page): Promise<void> {
  await expect(window.getByTestId("chat-setup")).toHaveCount(0);
}

/**
 * An Ollama server that lists models, for the model chip's menu, after
 * `delayMs` as a slow provider does. It answers nothing else.
 */
export async function ollamaListing(models: string[], { delayMs = 0 }: { delayMs?: number } = {}) {
  const server: Server = createServer((request, response) => {
    request.resume();
    if (request.url === "/api/tags") {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ models: models.map((name) => ({ name, model: name })) }));
      }, delayMs);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

/**
 * Sets up a local chat model (Ollama's, so nothing needs consent), through the
 * core's bridge as the setup screen would. With `fakeChat`, the scripted model answers.
 */
export async function useLocalChatModel(window: Page, modelId = "fake-model"): Promise<void> {
  await window.evaluate(async (model) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.saveChatProvider({ kind: "ollama", modelId: model });
  }, modelId);
}

/**
 * Turns embeddings on with the built-in model (the smoke tests' fake), through
 * the core's bridge as Settings would: they are off by default.
 */
export async function turnOnEmbeddings(window: Page): Promise<void> {
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.saveEmbeddingProvider({ kind: "built-in" });
  });
}

/**
 * Keys are kept with the system's keyring. On Linux with none running, as on
 * CI's Linux runner, the User first accepts storing them in plain text, once
 * on this computer. With `form`, accepts it as the User does, in the notice a
 * form that saves a key shows ("No keyring is running"); without, through the
 * core's bridge, as that notice does. With a keyring there's nothing to accept.
 */
export async function acceptPlainTextKeys(window: Page, form?: Locator): Promise<void> {
  const { protection, plainTextAccepted } = await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getSecretStorage(),
  );
  if (protection !== "plain-text" || plainTextAccepted) return;
  if (!form) {
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.acceptPlainTextSecretStorage();
    });
    return;
  }
  const notice = form.getByTestId("plain-text-secrets");
  await notice.getByRole("checkbox").click();
  // Accepted, the key can be saved, and the notice goes.
  await expect(notice).toBeHidden();
}

/** The pages in Settings' list. */
export type SettingsPage =
  | "general"
  | "models"
  | "search"
  | "meetings"
  | "connectors"
  | "skills"
  | "agents"
  | "privacy";

/** Opens Settings from the sidebar, then one of the pages in its list. Returns the dialog. */
export async function openSettings(window: Page, page: SettingsPage): Promise<Locator> {
  await window.getByRole("button", { name: "Settings" }).click();
  return showSettingsPage(window, page);
}

/** In open Settings, shows one of the pages in its list. Returns the dialog. */
export async function showSettingsPage(window: Page, page: SettingsPage): Promise<Locator> {
  const settings = window.getByTestId("settings");
  await settings.getByTestId(`settings-nav-${page}`).click();
  await expect(settings).toHaveAttribute("data-page", page);
  return settings;
}

/** Closes Settings with its close button. */
export async function closeSettings(window: Page): Promise<void> {
  const settings = window.getByTestId("settings");
  await settings.getByRole("button", { name: "Close Settings" }).click();
  await expect(settings).toBeHidden();
}

/** Settings → Meetings → Record meetings, by its switch; `whileOpen` runs before Settings closes. */
export async function turnOnMeetings(window: Page, whileOpen?: () => Promise<void>): Promise<void> {
  const settings = await openSettings(window, "meetings");
  const recording = settings.getByTestId("meetings-enabled");
  await recording.hover();
  await recording.click();
  await expect(recording).toBeChecked();
  await whileOpen?.();
  await closeSettings(window);
}

/** The + menu's "Record a meeting": a new Mind with the start block. */
export async function recordMeeting(window: Page): Promise<Locator> {
  const plus = window.getByTestId("plus-menu");
  await plus.hover();
  await plus.click();
  await window.getByRole("menuitem", { name: "Record a meeting" }).click();
  const start = window.getByTestId("meeting-start");
  await expect(start).toBeVisible();
  return start;
}

/** Starts recording from the start block; the first time, through the one-time notice. */
export async function startRecording(window: Page, start: Locator, { notice = false } = {}) {
  const record = start.getByTestId("meeting-start-record");
  await record.hover();
  await record.click();
  if (notice) {
    const dialog = window.getByTestId("meeting-notice");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("meeting-notice-start").click();
    await expect(dialog).toBeHidden();
  }
  const bar = window.getByTestId("meeting-bar");
  await expect(bar).toHaveAttribute("data-status", "recording");
  return bar;
}

/** Opens Settings from the sidebar, on its Privacy page. */
export async function openPrivacySettings(window: Page): Promise<Locator> {
  await openSettings(window, "privacy");
  const privacy = window.getByTestId("privacy-settings");
  await privacy.waitFor();
  return privacy;
}

/** Opens a Document's "More" menu in the sidebar, for rename, its original file, and delete. */
export async function openDocumentMenu(item: Locator): Promise<void> {
  await item.hover();
  await item.getByTestId("document-file-menu").click();
}

/**
 * Opens a Document's Tags menu in the sidebar and returns the Tags it has
 * (each a checked item, with `data-source` and, if unsure, `data-needs-review`).
 * Esc closes the menu again.
 */
export async function openDocumentTags(item: Locator): Promise<Locator> {
  await item.hover();
  await item.getByTestId("document-tags-menu").click();
  const menu = item.getByTestId("document-tags-popover");
  await expect(menu).toBeVisible();
  // The Tags it has, in the picker's field.
  return menu.getByTestId("tag-token");
}

/**
 * Adds a Tag to the sidebar's filter (Documents with any Tag chosen show), or,
 * choosing a Tag already chosen, takes it out.
 */
export async function filterByTag(window: Page, name: string): Promise<void> {
  await window.getByTestId("tag-filter-menu").click();
  await window
    .getByTestId("tag-filters")
    .getByRole("menuitemcheckbox", { name, exact: true })
    .click();
}

/**
 * Sets where new files go (the Output location) through the core's bridge, as
 * Settings › General would, so the next save goes there without asking.
 */
export async function useOutputLocation(window: Page, folder: string): Promise<void> {
  await window.evaluate(async (path) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.setOutputLocation(path);
  }, folder);
}

/** What the result line says of a file saved in a folder, which it names as well as the file. */
export function savedLine(name: string, folder: string, language: "en" | "zh-CN" = "en"): string {
  return language === "zh-CN"
    ? `已保存“${name}”到“${basename(folder)}”`
    : `Saved “${name}” in ${basename(folder)}`;
}

/** The result line's saved file, once it says it saved one. */
export async function savedPath(window: Page, name: string): Promise<string> {
  const done = window.getByTestId("export-result").getByTestId("export-done");
  await expect(done).toContainText(`Saved “${name}” in `, { timeout: 30_000 });
  return (await done.getAttribute("title")) ?? "";
}

/** The menu of the Mind's tab, opened by a right-click on the tab, as a person opens it. */
export async function tabMenu(window: Page): Promise<Locator> {
  const tab = window.getByRole("tab", { selected: true }).first();
  await pointAndClick(window, tab, { button: "right" });
  const menu = tab.getByTestId("tab-actions");
  await expect(menu).toBeVisible();
  return menu;
}

/** "Import a Word file…" from the "+" menu; the test answers the system's open dialog first. */
export async function importWordFromMenu(window: Page): Promise<Locator> {
  await window.getByTestId("plus-menu").click();
  await window.getByTestId("plus-import-word").click();
  const dialog = window.getByTestId("word-import-dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Writes a Word file named `name` into `folder` and imports it from the + menu, as the User picks one. */
export async function importWordFile(
  app: ElectronApplication,
  window: Page,
  folder: string,
  name: string,
  bytes: Buffer,
): Promise<void> {
  const path = join(folder, name);
  await writeFile(path, bytes);
  await interceptOpenDialog(app, path);
  const dialog = await importWordFromMenu(window);
  await dialog.getByTestId("word-import-confirm").click();
  await expect(dialog).toBeHidden();
}

/** Export options…, from the tab's menu; resolves once the sheet shows `title`. */
export async function openOptions(window: Page, title: string): Promise<void> {
  await pointAndClick(window, (await tabMenu(window)).getByTestId("mind.exportOptions"));
  await expect(window.getByTestId("export-dialog").getByRole("heading")).toHaveText(title);
}

/**
 * Test hook for opening a folder in the system's file manager: from now on
 * the main process records the path instead (see `pathsOpened`).
 */
export async function interceptOpenPath(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { pathsOpened?: unknown }).pathsOpened = opened;
    shell.openPath = async (path: string) => {
      opened.push(path);
      return "";
    };
  });
}

/** The paths the intercepted file manager was asked to open. */
export function pathsOpened(app: ElectronApplication) {
  return app.evaluate(() => (globalThis as { pathsOpened?: string[] }).pathsOpened ?? []);
}

/**
 * Test hook for showing a file in the system's file manager: from now on the
 * main process records the path instead (see `pathsShown`).
 */
export async function interceptShowItemInFolder(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    const shown: string[] = [];
    (globalThis as { pathsShown?: unknown }).pathsShown = shown;
    shell.showItemInFolder = (path: string) => {
      shown.push(path);
    };
  });
}

/** The paths the intercepted file manager was asked to show. */
export function pathsShown(app: ElectronApplication) {
  return app.evaluate(() => (globalThis as { pathsShown?: string[] }).pathsShown ?? []);
}

/**
 * Test hook for the system's open dialog: from now on the main process
 * answers it with `path` instead of showing it, e.g. the folder to link.
 */
export async function interceptOpenDialog(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [picked],
    })) as unknown as typeof dialog.showOpenDialog;
  }, path);
}

/**
 * Test hook for the system browser: from now on the main process records the
 * URLs it would open (see `urlsOpened`), and opens nothing.
 */
export async function interceptOpenExternal(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { urlsOpened?: unknown }).urlsOpened = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
}

/** The URLs the intercepted system browser was asked to open. */
export function urlsOpened(app: ElectronApplication) {
  return app.evaluate(() => (globalThis as { urlsOpened?: string[] }).urlsOpened ?? []);
}

export function ollamaAppOpened(app: ElectronApplication) {
  return app.evaluate(
    () =>
      (globalThis as { incarnamindOllamaApp?: { opened: number } }).incarnamindOllamaApp?.opened ??
      0,
  );
}

/**
 * Continue with ChatGPT in Settings → Models, as the User does, against the
 * local stand-in for OpenAI the app was launched with (`chatGpt`); then closes
 * Settings. With no chat model before, the plan's first model becomes the default.
 */
export async function signInWithChatGpt(
  app: ElectronApplication,
  window: Page,
  openai: FakeOpenAIServer,
): Promise<void> {
  await interceptOpenExternal(app);
  const plan = (await openSettings(window, "models")).getByTestId("chatgpt-settings");
  await acceptPlainTextKeys(window, plan);
  await plan.getByTestId("chatgpt-continue").click();
  await expect.poll(() => urlsOpened(app)).toHaveLength(1);
  const [authorize] = await urlsOpened(app);
  expect((await signInAt(openai, authorize ?? "")).status).toBe(200);
  await window.getByTestId("chatgpt-welcome-ok").click();
  await expect(plan.getByTestId("chatgpt-in-use")).toBeVisible();
  await closeSettings(window);
}

/**
 * "Link a folder…" from the sidebar's "+" menu (or `button`): the system's
 * folder picker (answered by the test with `path`), then the link dialog's
 * preview. Returns the dialog, with the preview counted. Choose a layout in
 * it, then `confirmLink`.
 */
export async function previewLink(
  app: ElectronApplication,
  window: Page,
  path: string,
  button?: Locator,
): Promise<Locator> {
  await interceptOpenDialog(app, path);
  if (button) await button.click();
  else {
    await window.getByTestId("plus-menu").click();
    await window.getByTestId("plus-link-folder").click();
  }
  const dialog = window.getByTestId("link-folder-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("link-folder-files")).toBeVisible();
  return dialog;
}

/** "Link folder" in the link dialog; it closes. */
export async function confirmLink(dialog: Locator): Promise<void> {
  await dialog.getByTestId("link-folder-confirm").click();
  await expect(dialog).toBeHidden();
}

/** Links a folder as the User does: "Link a folder…", the picker, then "Link folder" in the dialog. */
export async function linkFolderFromSidebar(
  app: ElectronApplication,
  window: Page,
  path: string,
): Promise<void> {
  await confirmLink(await previewLink(app, window, path));
}

/** A Linked folder's own row in the sidebar, by its folder's name on disk. */
export const linkedFolderRow = (window: Page, name: string) =>
  window.locator('[data-testid="folder-item"][data-root="true"]').filter({
    has: window.getByTestId("row-text").getByText(name, { exact: true }),
  });

/** Opens a Linked folder's "More" menu from its row. Returns the menu. */
export async function openLinkedFolderMenu(row: Locator): Promise<Locator> {
  await row.hover();
  await row.getByTestId("linked-folder-menu").click();
  const menu = row.getByTestId("linked-folder-actions");
  await expect(menu).toBeVisible();
  return menu;
}

/**
 * Opens the Library in a group beside the Mind, the focus staying in the
 * Mind, or closes every group but the Mind's, through the core's bridge: the
 * Mind then has half the card, as beside a Document, or all of it.
 */
export async function setGroupBeside(window: Page, open: boolean): Promise<void> {
  await window.evaluate(async (show) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const layout = await bridge.getLayout("main");
    if (show && layout.groups.length === 1) {
      await bridge.changeLayout("main", {
        type: "open",
        item: { kind: "library" },
        where: { in: "side" },
        focus: false,
      });
    } else if (!show) {
      for (const group of layout.groups.slice(1)) {
        await bridge.changeLayout("main", { type: "closeGroup", groupId: group.id });
      }
    }
  }, open);
  await expect(window.getByTestId("tab-group")).toHaveCount(open ? 2 : 1);
}

/**
 * Places the window's assistant (#253) through the core's bridge, as its ⋯
 * menu does: for a spec about something else that needs the card's room, such
 * as two groups side by side in a narrow window (docked at the bottom).
 */
export async function placeAssistant(window: Page, place: Partial<AssistantPlace>): Promise<void> {
  await window.evaluate(async (given) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.changeLayout("main", { type: "assistant", place: given });
  }, place);
  const assistant = window.getByTestId("assistant");
  if (place.dock) await expect(assistant).toHaveAttribute("data-chosen-dock", place.dock);
  if (place.folded !== undefined) {
    if (place.folded) await expect(assistant).toHaveAttribute("data-folded", "true");
    else await expect(assistant).not.toHaveAttribute("data-folded");
  }
}

/**
 * Opens a Document at a location as a Citation does, through the test hook: as a
 * preview in the group right of the Mind the User is in (made if needed); with
 * no Mind in front, as from the sidebar.
 */
export async function openDocumentAt(window: Page, location: DocumentLocation): Promise<void> {
  await window.evaluate((at) => {
    const hooks = (globalThis as { incarnamindTestHooks?: TestHooks }).incarnamindTestHooks;
    if (!hooks) throw new Error("Test hooks are off: launch with INCARNAMIND_TEST_HOOKS=1.");
    hooks.openDocument(at);
  }, location);
}

/**
 * The next Skill import in Settings gets this path instead of the system's
 * open dialog, which a test can't drive, through the test hook.
 */
export async function interceptSkillPicker(window: Page, path: string): Promise<void> {
  await window.evaluate((picked) => {
    const hooks = (globalThis as { incarnamindTestHooks?: TestHooks }).incarnamindTestHooks;
    if (!hooks) throw new Error("Test hooks are off: launch with INCARNAMIND_TEST_HOOKS=1.");
    hooks.interceptSkillPicker(picked);
  }, path);
}

/** Not in a Folder lists its first five Documents, then "Show N more Documents". */
const FIRST_LISTED = 5;

/**
 * Adds files through the sidebar's file picker and waits until each is
 * processed and ready. Each shows Not in a Folder (its first five, if more).
 */
export async function addDocuments(window: Page, paths: string[]): Promise<void> {
  await window.getByTestId("add-documents-input").setInputFiles(paths);
  const items = window.getByTestId("document-list-item");
  const listed = Math.min(paths.length, FIRST_LISTED);
  await expect(items).toHaveCount(listed);
  for (let index = 0; index < listed; index++) {
    await expect(items.nth(index)).toHaveAttribute("data-status", "ready");
  }
  if (paths.length > listed) await expectReadyDocuments(window, paths.length);
}

/**
 * Sizes the app's page, e.g. to its narrowest (900px wide, the minimum) or a
 * wide one, as `WINDOW_SIZE` is: its content, without Linux's menu bar. The
 * screen may not have room for the height (see `WINDOW_SIZE`), so only the
 * width is waited for.
 */
export async function setWindowSize(
  app: ElectronApplication,
  window: Page,
  width: number,
  height: number,
): Promise<void> {
  await resizeContent(app, window, width, height);
}

const SIZE_WAIT_MS = 30_000;
const REPORT_WAIT_MS = 2_000;

async function within<T>(answer: Promise<T>, otherwise: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((settle) => {
    timer = setTimeout(() => settle(otherwise), REPORT_WAIT_MS);
  });
  try {
    return await Promise.race([answer, late]);
  } catch {
    return otherwise;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks for the content size once, waits until the page has it, then until the
 * page has drawn a frame at it. Chromium sends a page its next size only after
 * the page has drawn at the one before. On a runner's first launch the first
 * frames can take seconds, so a size asked right after the launch's waited
 * that long, while the page still reported the old one (#432). The launch also
 * waits for the height; `setWindowSize` only the width.
 */
async function resizeContent(
  app: ElectronApplication,
  window: Page,
  width: number,
  height: number,
  { message, waitForHeight = false }: { message?: string; waitForHeight?: boolean } = {},
): Promise<void> {
  const browserWindow = await app.browserWindow(window);
  await browserWindow.evaluate((win, asked) => win.setContentSize(asked.width, asked.height), {
    width,
    height,
  });
  const look = () =>
    window.evaluate(() => ({ width: globalThis.innerWidth, height: globalThis.innerHeight }));
  try {
    await expect
      .poll(
        async () => {
          const page = await look();
          return [page.width, waitForHeight ? page.height : height];
        },
        // A loaded runner can take far longer than expect's 5 s to draw the frame the size waits
        // for (#432); this still ends early enough in the test's 60 s to report what it saw.
        { message, timeout: SIZE_WAIT_MS },
      )
      .toEqual([width, height]);
  } catch (error) {
    // A window that has stopped answering must not take the report down with it.
    const [content, page, drawing] = await Promise.all([
      within(
        browserWindow.evaluate((win) => win.getContentSize().join(" × ")),
        "unknown (the app's main process isn't answering)",
      ),
      within(
        look().then((size) => `${size.width} × ${size.height}`),
        "unknown (the page isn't answering)",
      ),
      within(
        window.evaluate(
          () => new Promise<string>((drawn) => requestAnimationFrame(() => drawn("drawing"))),
        ),
        "not drawing frames",
      ),
    ]);
    throw new Error(
      `${message ?? "The window did not reach its size"}: asked ${width} × ${height}; the window's content is ${content}; the page is ${page}, ${drawing}.`,
      { cause: error },
    );
  }
  await window.evaluate(
    () =>
      new Promise((drawn) => requestAnimationFrame(() => requestAnimationFrame(() => drawn(null)))),
  );
}

/** What the page copies goes to `copied` instead of the machine's clipboard. */
export async function catchCopies(window: Page): Promise<void> {
  await window.evaluate(() => {
    const caught = globalThis as unknown as { copied?: string };
    navigator.clipboard.writeText = async (text: string) => {
      caught.copied = text;
    };
  });
}

/** What the page last copied since `catchCopies`. */
export const copied = (window: Page) =>
  window.evaluate(() => (globalThis as unknown as { copied?: string }).copied ?? "");

/** Switches the interface's language, as Settings does. */
export function setLanguage(window: Page, language: "en" | "zh-CN"): Promise<unknown> {
  return window.evaluate(
    (value) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { language: value },
      }),
    language,
  );
}

/** How many animations are running (src/renderer/src/motion.ts), leaving copies included. */
export function motionRunning(window: Page): Promise<number> {
  return window.evaluate(
    () =>
      (globalThis as { incarnamindTestHooks?: TestHooks }).incarnamindTestHooks?.motionRunning() ??
      0,
  );
}

/** The copies of closed menus and popovers still fading where they were, which nothing else can see. */
export function leavingCopies(window: Page) {
  return window.evaluate(
    () =>
      (globalThis as { incarnamindTestHooks?: TestHooks }).incarnamindTestHooks?.leavingCopies() ??
      [],
  );
}

/**
 * How an element shows now: its opacity, its transform's scale and vertical
 * shift, its transform origin, and where it is laid out without the transform.
 */
export function motionLook(target: Locator) {
  return target.evaluate((element) => {
    const style = getComputedStyle(element);
    const matrix = new DOMMatrixReadOnly(style.transform === "none" ? undefined : style.transform);
    const [originX = "0", originY = "0"] = style.transformOrigin.split(" ");
    const box = element.getBoundingClientRect();
    return {
      opacity: Number(style.opacity),
      scale: matrix.a,
      y: matrix.f,
      originX: Number.parseFloat(originX),
      originY: Number.parseFloat(originY),
      left: box.left - matrix.e - (1 - matrix.a) * Number.parseFloat(originX),
      top: box.top - matrix.f - (1 - matrix.d) * Number.parseFloat(originY),
    };
  });
}

/**
 * Waits until nothing moves (src/renderer/src/motion.ts): no animation
 * running, and no closed menu still fading where it was. For a test that
 * measures or pictures what just opened, closed or moved.
 */
export async function motionSettled(window: Page): Promise<void> {
  await expect
    .poll(() =>
      window.evaluate(
        () =>
          (
            globalThis as { incarnamindTestHooks?: TestHooks }
          ).incarnamindTestHooks?.motionRunning() ?? 0,
      ),
    )
    .toBe(0);
}

/**
 * Clicks `target` where it is now, as a person does, without waiting for it to
 * stop moving (a menu still growing from its button): the app takes a click
 * during an animation. For a test that races work in the background, which
 * waiting would let finish first.
 */
export async function clickNow(window: Page, target: Locator): Promise<void> {
  await expect(target).toBeVisible();
  const box = await target.boundingBox();
  if (!box) throw new Error("The element isn't on screen.");
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await window.mouse.down();
  await window.mouse.up();
}

/** How long an Answer may have no words before its line says how long it takes (15 seconds), so a test needn't wait that long. */
export async function setSilentWaitMs(window: Page, ms: number): Promise<void> {
  await window.evaluate(
    (value) =>
      (globalThis as { incarnamindTestHooks?: TestHooks }).incarnamindTestHooks?.setSilentWaitMs(
        value,
      ),
    ms,
  );
}

/** Plays every animation at `speed` (0.2: five times slower), so a test can look, or act, during one. */
export async function setMotionSpeed(window: Page, speed: number): Promise<void> {
  await window.evaluate(
    (value) =>
      (globalThis as { incarnamindTestHooks?: TestHooks }).incarnamindTestHooks?.setMotionSpeed(
        value,
      ),
    speed,
  );
}

/**
 * Waits until the core has this many Documents ready, wherever the sidebar
 * lists them (a Folder starts closed, and lists its first few).
 */
export async function expectReadyDocuments(window: Page, count: number): Promise<void> {
  await expect
    .poll(
      () =>
        window.evaluate(
          async () =>
            (
              await (
                globalThis as unknown as { incarnamind: CoreBridge }
              ).incarnamind.listDocuments()
            ).filter((each) => each.status === "ready").length,
        ),
      { timeout: 30_000 },
    )
    .toBe(count);
}

/** Ends the first open (hides its steps), so the shell shows everything, as it does for a returning User. */
export async function leaveFirstOpen(window: Page): Promise<void> {
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const { device } = await bridge.getSettings();
    await bridge.updateSettings({
      device: { gettingStarted: { ...device.gettingStarted, hidden: true } },
    });
  });
  await expect(window.getByTestId("first-open-steps")).toHaveCount(0);
}

/** The id of the Document listed in the sidebar under `name`. */
export async function documentIdOf(window: Page, name: string): Promise<string> {
  const id = await window
    .getByTestId("document-list-item")
    .filter({ hasText: name })
    .getAttribute("data-document-id");
  if (!id) throw new Error(`No Document named ${name} in the sidebar.`);
  return id;
}

/** How many of a canvas's pixels are dark: more than zero once something is drawn on it. */
export function darkPixels(canvas: Locator): Promise<number> {
  return canvas.evaluate((element) => {
    const drawing = element as unknown as {
      width: number;
      height: number;
      getContext(kind: "2d"): {
        getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
      };
    };
    const { data } = drawing.getContext("2d").getImageData(0, 0, drawing.width, drawing.height);
    let dark = 0;
    for (let index = 0; index < data.length; index += 4) {
      if ((data[index] as number) < 128 && (data[index + 3] as number) > 0) dark++;
    }
    return dark;
  });
}

/** The rendered width of an element, in CSS pixels. */
export async function widthOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("The element isn't visible.");
  return box.width;
}

/**
 * By geometry, for each part after the first of a line of parts joined by
 * dots (#684): its dot shows only where the part before it is on the same
 * line, and then sits between the two. A part draws its dot as a `.meta-dot`
 * or, as a flex item of the line, in a `::before` that is out in the gap
 * before it; a `::before` in the part's own text counts as shown, and not
 * between. `clips` is whether the row cuts off what sticks out of it: the dot
 * of a part that starts a row is hidden by that, not by where it is.
 */
export async function dotsOf(line: Locator) {
  return line.evaluate((element) => {
    const row = element.getBoundingClientRect();
    const clips = ["clip", "hidden"].includes(getComputedStyle(element).overflowX);
    const parts: Element[] = [];
    const collect = (parent: Element) => {
      for (const child of parent.children) {
        const { display, position } = getComputedStyle(child);
        if (display === "contents") collect(child);
        else if (display !== "none" && position !== "absolute" && child.tagName !== "UL")
          parts.push(child);
      }
    };
    collect(element);
    return parts.slice(1).map((part, index) => {
      const before = parts[index]?.getBoundingClientRect();
      const here = part.getBoundingClientRect();
      const dot = part.querySelector(":scope > .meta-dot")?.getBoundingClientRect();
      const pseudo = getComputedStyle(part, "::before");
      const inText = !dot && pseudo.content !== "none" && pseudo.position !== "absolute";
      const glyphCentre = dot
        ? dot.left + dot.width / 2
        : inText
          ? here.left + 1
          : here.left - Number.parseFloat(pseudo.width) / 2;
      return {
        clips,
        sameLine: before !== undefined && Math.abs(before.top - here.top) < 2,
        shown: inText || glyphCentre > row.left + 4,
        between:
          !inText &&
          before !== undefined &&
          glyphCentre >= before.right - 1 &&
          glyphCentre <= here.left + 1,
      };
    });
  });
}

/**
 * What copying the selected `within` (the whole row when left out) of a line
 * of parts puts on the clipboard as plain text, read from a copy event of our
 * own so the computer's clipboard is left alone; `taken` is whether the app
 * answered it, as it does for a selection across parts.
 */
export async function copyFrom(line: Locator, within?: string) {
  return line.evaluate((element, selector) => {
    const range = document.createRange();
    range.selectNodeContents((selector && element.querySelector(selector)) || element);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    const data = new DataTransfer();
    const event = new ClipboardEvent("copy", {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(event);
    return { text: data.getData("text/plain"), taken: event.defaultPrevented };
  }, within);
}

/**
 * No line of parts joined by dots starts or ends with a dot: a part's dot is
 * there only beside the part before it, and the row clips the rest. Returns
 * whether some part started a row, so a test can say it wrapped.
 */
export async function expectDotsBetweenParts(line: Locator): Promise<boolean> {
  let wrapped = false;
  for (const dot of await dotsOf(line)) {
    expect(dot.clips).toBe(true);
    expect(dot.shown).toBe(dot.sameLine);
    if (dot.shown) expect(dot.between).toBe(true);
    if (!dot.sameLine) wrapped = true;
  }
  expect((await line.innerText()).trimEnd().endsWith("·")).toBe(false);
  return wrapped;
}

/**
 * Checks that the window's first group's tabs start at the card's left edge:
 * flush with it on macOS, where the sidebar's button sits in the sidebar's
 * header beside the traffic lights; on Windows and Linux just after that
 * button, which starts the strip there (SidebarToggle), 8px in and 6px before
 * the first tab (styles.css).
 */
export async function expectFirstTabAtCardStart(window: Page, firstTab: Locator): Promise<void> {
  const card = await window.getByTestId("card").boundingBox();
  const tab = await firstTab.boundingBox();
  if (!card || !tab) throw new Error("The card or its first tab isn't visible.");
  const toggle = window.getByTestId("tab-strip").first().getByTestId("sidebar-toggle");
  if (process.platform === "darwin") {
    await expect(toggle).toHaveCount(0);
    expect(tab.x).toBeCloseTo(card.x, 0);
    return;
  }
  const button = await toggle.boundingBox();
  if (!button) throw new Error("The sidebar's button isn't at the start of the strip.");
  expect(button.x - card.x).toBeCloseTo(8, 0);
  expect(tab.x - (button.x + button.width)).toBeCloseTo(6, 0);
}

/**
 * Slides the mouse onto an element, in steps, as a person does, and clicks it:
 * with the left button, or the right to open its menu.
 */
export async function pointAndClick(
  window: Page,
  target: Locator,
  {
    button = "left",
    modifiers = [],
  }: { button?: "left" | "right"; modifiers?: readonly ("ControlOrMeta" | "Shift")[] } = {},
): Promise<void> {
  // A list that redraws as the click begins swaps the element for an equal one: look again.
  let box: Awaited<ReturnType<Locator["boundingBox"]>> = null;
  await expect(async () => {
    await target.scrollIntoViewIfNeeded();
    box = await target.boundingBox();
    if (!box) throw new Error("The element isn't visible.");
  }).toPass();
  if (!box) throw new Error("The element isn't visible.");
  const { x: left, y: top, width, height } = box;
  const x = left + width / 2;
  const y = top + height / 2;
  await window.mouse.move(x, y, { steps: 8 });
  for (const key of modifiers) await window.keyboard.down(key);
  try {
    await window.mouse.click(x, y, { button });
  } finally {
    for (const key of modifiers.toReversed()) await window.keyboard.up(key);
  }
}

/**
 * A Mind's check badge card (#909): open already, as a question opens it,
 * or opened as a person opens it: from the badge, or from ⌘K while no badge shows.
 */
export async function checkCard(window: Page, scope: Page | Locator = window): Promise<Locator> {
  const card = window.getByTestId("check-card");
  if (!(await card.isVisible())) {
    const badge = scope.getByTestId("check-badge-open").first();
    if (await badge.isVisible()) {
      // "Checking 2 of 2 · Stop" shrinks to the counts as a check ends: aim once it has.
      await expect(scope.getByTestId("badge-stop")).toHaveCount(0);
      await motionSettled(window);
      // The counts are worked out a moment after a change, and the badge can narrow under the pointer: aim again.
      await expect(async () => {
        if (!(await card.isVisible())) await pointAndClick(window, badge);
        await expect(card).toBeVisible({ timeout: 1000 });
      }).toPass();
    } else {
      const chinese = (await window.evaluate(() => document.documentElement.lang)) === "zh-CN";
      const command = chinese ? "句子和引用" : "Sentences and Citations";
      await window.keyboard.press("ControlOrMeta+k");
      await expect(window.getByTestId("palette-search")).toBeFocused();
      await window.keyboard.type(command);
      await pointAndClick(
        window,
        window.getByTestId("palette-item").filter({ hasText: command }).first(),
      );
    }
  }
  await expect(card).toBeVisible();
  // It grows from the badge: a click while it moves could land on the page behind.
  await motionSettled(window);
  return card;
}

/**
 * Drags an element horizontally by `dx` CSS pixels, as a person grabs it: a
 * few pixels off its centre (a divider is a 1px rule with a wider strip to
 * grab), after sliding the mouse there.
 */
export async function dragBy(window: Page, handle: Locator, dx: number): Promise<void> {
  const box = await handle.boundingBox();
  if (!box) throw new Error("The drag handle isn't visible.");
  const x = box.x + box.width / 2 - 3;
  const y = box.y + box.height / 2;
  await window.mouse.move(x - 30, y);
  await window.mouse.move(x, y, { steps: 6 });
  await window.mouse.down();
  await window.mouse.move(x + dx, y, { steps: 5 });
  await window.mouse.up();
}

/**
 * Drags a tab as a person does: slides onto it, presses, slides to (x, y) in
 * small steps, then, once `whileHeld` has looked at what the drag shows, lets go.
 */
export async function dragTabTo(
  window: Page,
  tab: Locator,
  to: { x: number; y: number },
  whileHeld?: () => Promise<void>,
): Promise<void> {
  const box = await tab.boundingBox();
  if (!box) throw new Error("The tab isn't visible.");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await window.mouse.move(x - 20, y + 30);
  await window.mouse.move(x, y, { steps: 5 });
  await window.mouse.down();
  try {
    await window.mouse.move(to.x, to.y, { steps: 16 });
    await whileHeld?.();
  } finally {
    await window.mouse.up();
  }
}

/**
 * Moves the mouse as a person does onto a Block's handle: onto the Block's
 * first line, then left across the margin in small steps (not a jump, which
 * would skip the margin in between), and returns the handle.
 */
export async function slideToHandle(window: Page, block: Locator): Promise<Locator> {
  const text = await block.boundingBox();
  if (!text) throw new Error("The Block isn't visible.");
  const y = text.y + Math.min(text.height, 28) / 2;
  await window.mouse.move(text.x + 8, y, { steps: 4 });
  const handle = window.getByTestId("block-handle");
  await expect(handle).toBeVisible();
  const grip = await handle.boundingBox();
  if (!grip) throw new Error("The block handle isn't visible.");
  await window.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2, { steps: 12 });
  await expect(handle).toBeVisible();
  return handle;
}

/**
 * Drags a Block by its handle, as a person does: slide onto the handle, press,
 * move straight up or down the margin to the top of `target`, and let go.
 */
export async function dragBlock(window: Page, block: Locator, target: Locator): Promise<void> {
  const handle = await slideToHandle(window, block);
  const grip = await handle.boundingBox();
  const to = await target.boundingBox();
  if (!grip || !to) throw new Error("The handle or the target isn't visible.");
  const x = grip.x + grip.width / 2;
  await window.mouse.down();
  await window.mouse.move(x, to.y + 4, { steps: 12 });
  await window.mouse.up();
}

/**
 * Where `words` are drawn in a line of text: their left and right edges, and
 * their middle line. They may run across marks (AI text and the User's, bold).
 */
async function wordsBox(line: Locator, words: string) {
  const box = await line.evaluate((element, wanted) => {
    const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
    const at = texts
      .map((text) => text.data)
      .join("")
      .indexOf(wanted);
    if (at < 0) return null;
    /** The text and offset `offset` characters in; an end falls at the end of a text, a start at the next. */
    const place = (offset: number, end: boolean) => {
      let start = 0;
      for (const text of texts) {
        if (offset < start + text.length || (end && offset === start + text.length)) {
          return { text, offset: offset - start };
        }
        start += text.length;
      }
      return null;
    };
    const from = place(at, false);
    const to = place(at + wanted.length, true);
    if (!from || !to) return null;
    const range = element.ownerDocument.createRange();
    range.setStart(from.text, from.offset);
    range.setEnd(to.text, to.offset);
    const rect = range.getBoundingClientRect();
    return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
  }, words);
  if (!box) throw new Error(`"${words}" isn't in the line.`);
  return box;
}

/**
 * Returns once ProseMirror has settled its selection with the page after the editor got the
 * focus. 20 ms after the focus it puts its own selection back into the page if the page's has
 * moved since, which undoes a key pressed in those 20 ms (⌘A, End). Called after the focus, a
 * 21 ms timer runs after the one ProseMirror set then.
 */
export const afterEditorFocus = (window: Page) =>
  window.evaluate(() => new Promise((done) => setTimeout(done, 21)));

/** Gives the editor the focus, and waits as `afterEditorFocus` says. */
export async function focusEditor(window: Page, editor: Locator): Promise<void> {
  await editor.focus();
  await afterEditorFocus(window);
}

/**
 * Selects `words` in a line of text as a person does with the mouse: slides to
 * the first letter, presses, slides along to the end of them and lets go. With
 * `to`, the drag goes on to the end of other words, in a line further down.
 */
export async function slideSelect(
  window: Page,
  line: Locator,
  words: string,
  to?: { line: Locator; words: string },
): Promise<void> {
  // On a busy machine a drag can stop a letter short; a person sees it and drags again, after a
  // click beside the words, as a press inside a selection would drag the text away.
  let tries = 0;
  await expect(async () => {
    const box = await wordsBox(line, words);
    const end = to ? await wordsBox(to.line, to.words) : box;
    if (tries++ > 0) await window.mouse.click(box.left - 6, box.y);
    await window.mouse.move(box.left - 6, box.y, { steps: 4 });
    await window.mouse.move(box.left + 1, box.y, { steps: 2 });
    await window.mouse.down();
    await window.mouse.move(end.right - 1, end.y, { steps: 12 });
    await window.mouse.up();
    // After a drag, ProseMirror puts its selection back into the page in a task queued as the
    // mouse comes up; a key pressed before that task runs is undone by it. This waits for it.
    await window.evaluate(() => new Promise((resolve) => setTimeout(resolve)));
    if (!to) expect(await window.evaluate(() => getSelection()?.toString())).toBe(words);
  }).toPass();
}

/**
 * Waits until the cursor is in the text of the Mind the User is in: a new
 * Mind's text comes a moment after the Mind, and only then can it be typed in.
 */
export async function enterContent(window: Page): Promise<void> {
  await expect(frontMind(window).getByTestId("mind-editor")).toBeFocused();
}

/**
 * Waits until a Mind's text has the focus and ProseMirror has finished taking
 * it. 20 ms after the focus it puts its own selection back into the page if
 * the page's differs, which undoes a key that moved the page's selection just
 * before. A timer started now with the same delay runs after that check.
 */
export async function focusSettled(window: Page, editor: Locator): Promise<void> {
  await expect(editor).toBeFocused();
  await window.evaluate(() => new Promise((resolve) => setTimeout(resolve, 20)));
}

/** The page of the Mind the User is in, in the group they are in. */
export const frontMind = (window: Page) =>
  window.locator('[data-testid="tab-group"][data-focused] [data-testid="mind-pane"]:visible');

/** The name of the Mind the User is in, as its tab shows it. */
export const frontMindName = (window: Page) =>
  window.locator(
    '[data-testid="tab-group"][data-focused] [data-testid="mind-tab"][aria-selected="true"] [data-testid="tab-title"]',
  );

/** The ⋯ button at the top right of the Mind's page in view (#908); one Mind in view only. */
export const pageMenuButton = (window: Page) => window.locator('[data-testid="page-menu"]:visible');

/** Opens the page's ⋯ menu with the mouse, and returns it. */
export async function openPageMenu(window: Page): Promise<Locator> {
  await pointAndClick(window, pageMenuButton(window));
  const menu = window.locator('[data-testid="page-actions"]:visible');
  await expect(menu).toBeVisible();
  return menu;
}

/** "Show word count while writing", in the page's ⋯ menu: the count is hidden until then. */
export async function showCountWhileWriting(window: Page): Promise<void> {
  const menu = await openPageMenu(window);
  const shown = menu.getByTestId("page-count-shown");
  await pointAndClick(window, shown);
  await expect(shown).toHaveAttribute("aria-checked", "true");
  await window.keyboard.press("Escape");
  await expect(menu).toBeHidden();
}

/** Renames the Mind the User is in from its tab, as a person does: double-click, a name, Enter. */
export async function renameInTab(window: Page, name: string): Promise<void> {
  await frontMindName(window).dblclick();
  const field = window.locator(
    '[data-testid="tab-group"][data-focused] [data-testid="tab-rename"]',
  );
  await expect(field).toBeFocused();
  await field.fill(name);
  await field.press("Enter");
  await expect(frontMindName(window)).toHaveText(name);
}

/**
 * Names the Mind the User is in, as Rename does, leaving its text and the
 * cursor as they are: a Mind's page has no title field (#908).
 */
export async function nameMind(window: Page, name: string): Promise<void> {
  // The tab changes before its page does: a Mind just opened is the tab's.
  const tab = window.locator(
    '[data-testid="tab-group"][data-focused] [data-testid="mind-tab"][aria-selected="true"]',
  );
  const mindId =
    (await tab.count()) > 0
      ? await tab.getAttribute("data-mind-id")
      : await frontMind(window).getAttribute("data-mind-id");
  if (!mindId) throw new Error("No Mind is in front.");
  await (await coreOf(window)).evaluate(
    (core, named) => core.renameMind(named.mindId, named.name),
    {
      mindId,
      name,
    },
  );
  await expect(frontMindName(window)).toHaveText(name);
}

/**
 * Puts the cursor at the end of a line of text as a person does: slides to
 * the right of its words and clicks there (Home and End don't move the
 * cursor on macOS).
 */
export async function clickEndOf(window: Page, line: Locator): Promise<void> {
  const box = await line.boundingBox();
  if (!box) throw new Error("The line isn't visible.");
  const x = box.x + box.width - 4;
  const y = box.y + box.height - 10;
  await window.mouse.move(x, y, { steps: 6 });
  await window.mouse.click(x, y);
  // A key pressed next acts where the editor's cursor is: wait until it is in the line.
  await expect
    .poll(() =>
      line.evaluate((element) => {
        const root = element.closest(".ProseMirror") as (Element & { editor?: Editor }) | null;
        const view = root?.editor?.view;
        if (!view) return false;
        const { from, empty } = view.state.selection;
        const at = view.domAtPos(from).node;
        return empty && element.contains(at);
      }),
    )
    .toBe(true);
}

/** Slides the mouse onto an element, in steps, as a person does, and leaves it there: returns where. */
export async function pointAt(window: Page, target: Locator): Promise<{ x: number; y: number }> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error("The element isn't visible.");
  const point = { x: box.x + Math.min(box.width / 2, 40), y: box.y + box.height / 2 };
  await window.mouse.move(point.x, point.y, { steps: 8 });
  return point;
}

/** Presses Tab, or Shift+Tab if `target` comes before the focus, until `target` has the focus. */
export async function tabTo(window: Page, target: Locator, max = 40): Promise<void> {
  const key = (await target.evaluate((element) => {
    const focused = document.activeElement;
    return (
      focused !== null &&
      focused !== document.body &&
      (focused.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_PRECEDING) !== 0
    );
  }))
    ? "Shift+Tab"
    : "Tab";
  for (let step = 0; step < max; step++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await window.keyboard.press(key);
  }
  await expect(target).toBeFocused();
}

/**
 * Whether the focused control shows DESIGN.md's ring: a solid 2px accent outline, its own or,
 * for the main button of a sidebar row, its row's.
 */
export const focusRingShows = (window: Page) =>
  window.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    if (!element) return false;
    const probe = document.createElement("span");
    probe.style.color = "var(--color-accent)";
    document.body.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    const rings = (holder: Element | null) => {
      if (!holder) return false;
      const style = getComputedStyle(holder);
      return (
        style.outlineStyle === "solid" &&
        Number.parseFloat(style.outlineWidth) >= 2 &&
        style.outlineColor === accent
      );
    };
    return (
      element.matches(":focus-visible") &&
      (rings(element) || (element.matches(".row-main") && rings(element.closest(".group"))))
    );
  });

/**
 * Types a name through an input method: the composition is open, its Enter
 * (the one that picks a candidate) changes nothing, and the next Enter saves.
 */
export async function typeWithInputMethod(
  window: Page,
  field: Locator,
  name: string,
): Promise<void> {
  const session = await window.context().newCDPSession(window);
  try {
    await session.send("Input.imeSetComposition", {
      text: "xinming",
      selectionStart: 7,
      selectionEnd: 7,
    });
    await field.dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true });
    await expect(field).toBeVisible();
    await session.send("Input.insertText", { text: name });
    await expect(field).toHaveValue(name);
  } finally {
    await session.detach();
  }
  await window.keyboard.press("Enter");
}

/** Sets the sidebar's width, as dragging its edge does (165 is the narrowest), and waits for it. */
export async function setSidebarWidth(window: Page, width: number): Promise<void> {
  await window.evaluate(
    (sidebarWidth) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        device: { sidebarWidth },
      }),
    width,
  );
  await expect
    .poll(async () => (await window.getByTestId("sidebar").boundingBox())?.width)
    .toBeCloseTo(width, 0);
}

/** The assistant's Answers (#201), in the conversation it shows. */
export const assistantAnswers = (window: Page) =>
  window.getByTestId("assistant").getByTestId("assistant-answer");

/**
 * Asks a Question as a person does: ⌘J, the words, Enter. It is asked in the
 * assistant's conversation (#201); resolves with its Answer there once it is
 * written (the scripted model's, with `fakeChat`).
 */
export async function askInAssistant(
  window: Page,
  question: string,
  { timeout = 15_000 }: { timeout?: number } = {},
): Promise<Locator> {
  const answers = assistantAnswers(window);
  const before = await answers.count();
  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type(question);
  await window.keyboard.press("Enter");
  const questions = window.getByTestId("assistant").getByTestId("assistant-question");
  await expect(questions.last()).toContainText(question);
  await expect(answers).toHaveCount(before + 1);
  const answer = answers.last();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout });
  return answer;
}

/** Gives the Citations of an Answer in the assistant a check (#96 will produce them for real). */
export const setCheck = (answer: Locator, patch: { check: string; verdict?: string | null }) =>
  answer.getByTestId("assistant-answer-text").evaluate((dom, attributes) => {
    const { view } = (dom as unknown as { editor: Editor }).editor;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name !== "citation") return true;
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attributes }));
      return false;
    });
  }, patch);

/** The tiny MCP server the core tests use: `lookup_tide` is read-only, `book_boat` isn't. */
const TIDE_SERVER = resolve(__dirname, "../tests/fixtures/mcp-server.mjs");

/**
 * Saves a chat provider through the core's bridge as it was left when
 * choosing it wasn't yet the consent (ADR-0022): nothing allowed, so the
 * first Question asks.
 */
export async function saveProviderUnasked(
  window: Page,
  input: SaveChatProviderInput,
): Promise<void> {
  await window.evaluate(
    async ({ provider, flows }) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const saved = await bridge.saveChatProvider(provider);
      const service = (await bridge.listChatProviders()).find(
        (each) => each.id === saved.id,
      )?.service;
      if (service) for (const flow of flows) await bridge.revokeConsent(flow, service.id);
    },
    { provider: input, flows: CHOSEN_PROVIDER_FLOWS },
  );
}

/** Adds the tiny server as a Connector through the core's bridge, waits until it's ready, and returns its id. */
export async function addTideConnector(window: Page): Promise<string> {
  return window.evaluate(
    async ({ node, server }) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const connector = await bridge.addConnector({ name: "Tides", command: node, args: [server] });
      for (let tries = 0; tries < 300; tries++) {
        const found = (await bridge.listConnectors()).find((each) => each.id === connector.id);
        if (found?.state === "ready") return connector.id;
        await new Promise((done) => setTimeout(done, 100));
      }
      throw new Error("The Connector didn't get ready.");
    },
    { node: process.execPath, server: TIDE_SERVER },
  );
}

/**
 * Unfolds an Answer's steps in the assistant (#391) with the mouse, unless
 * they are open, and returns their timeline: the reasoning, the searches,
 * the Skills and Connector calls it made, and the check.
 */
export async function openSteps(window: Page, answer: Locator): Promise<Locator> {
  const toggle = answer.getByTestId("answer-steps");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await pointAndClick(window, toggle);
  const timeline = answer.getByTestId("answer-timeline");
  await expect(timeline).toBeVisible();
  return timeline;
}

/**
 * Adds an Answer in the assistant to the Mind in focus, at its cursor (or
 * end), with the mouse, as a person keeps one (#201), and waits until it is in
 * and its wash has ended: the redraw that ends it undoes a key or click that
 * moved the selection a moment before, as ProseMirror rewrites the page's
 * selection from its own.
 */
export async function addToNote(window: Page, answer: Locator): Promise<void> {
  await pointAt(window, answer.getByTestId("assistant-answer-text"));
  await pointAndClick(window, answer.getByTestId("answer-add"));
  await expect(answer.getByTestId("answer-added")).toBeVisible();
  await expect(window.locator(".block-just-added")).toHaveCount(0);
}

export type MindChild = Y.XmlElement | string;

/** A node as the editor stores it in a Mind's Yjs document; strings are its text. */
export function mindNode(
  name: string,
  attributes: Record<string, unknown>,
  children: MindChild[] = [],
): Y.XmlElement {
  const element = new Y.XmlElement(name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, value as string);
  }
  element.insert(
    0,
    children.map((child) => (typeof child === "string" ? new Y.XmlText(child) : child)),
  );
  return element;
}

/** Blocks as one Yjs update, to apply to a Mind (`applyMindUpdate`), as an edit from another device arrives. */
export function blocksUpdate(blocks: Y.XmlElement[]): Uint8Array {
  const doc = new Y.Doc();
  doc.getXmlFragment("blocks").insert(0, blocks);
  return Y.encodeStateAsUpdate(doc);
}

/** A Block of a Mind as Minds held them before Questions went to the assistant (#201). */
export type BlockFromBefore =
  | { note: string }
  | { heading: string }
  | { question: string; answer: string };

/**
 * Makes a Mind as one written before Questions were asked in the assistant
 * (#201) holds them: its Questions and Answers in the note, among its Notes.
 * Made through the core's bridge, in the stored shape. Returns its id.
 */
export async function mindWrittenBefore(
  window: Page,
  title: string,
  blocks: BlockFromBefore[],
): Promise<string> {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("blocks");
  const element = (
    type: string,
    text: string,
    attributes: Record<string, number> = {},
    id: string = crypto.randomUUID(),
  ) => {
    const node = new Y.XmlElement(type);
    node.setAttribute("id", id);
    // Stored as the editor stores them: a heading's level is a number.
    for (const [key, value] of Object.entries(attributes)) {
      node.setAttribute(key, value as unknown as string);
    }
    if (text) node.insert(0, [new Y.XmlText(text)]);
    return node;
  };
  for (const block of blocks) {
    if ("note" in block) fragment.push([element("paragraph", block.note)]);
    else if ("heading" in block) fragment.push([element("heading", block.heading, { level: 2 })]);
    else {
      const questionId = crypto.randomUUID();
      const question = element("question", block.question, {}, questionId);
      const answer = new Y.XmlElement("answer");
      answer.setAttribute("id", crypto.randomUUID());
      answer.setAttribute("questionId", questionId);
      answer.setAttribute("status", "done");
      answer.insert(0, [element("paragraph", block.answer)]);
      fragment.push([question, answer]);
    }
  }
  const update = Array.from(Y.encodeStateAsUpdate(doc));
  return window.evaluate(
    async ([name, change]) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const mind = await core.createMind({ title: name });
      await core.applyMindUpdate(mind.id, new Uint8Array(change));
      await core.closeMind(mind.id);
      return mind.id;
    },
    [title, update] as const,
  );
}

/**
 * Stubs the window's clipboard, so a test can read what Copy wrote and the
 * computer's own clipboard stays as it was. `copied()` gives it, by type.
 */
export async function stubClipboard(window: Page) {
  await window.evaluate(() => {
    const copied: Record<string, string> = {};
    (globalThis as { copied?: unknown }).copied = copied;
    navigator.clipboard.write = async (items: ClipboardItem[]) => {
      for (const item of items) {
        for (const type of item.types) copied[type] = await (await item.getType(type)).text();
      }
    };
  });
  return () =>
    window.evaluate(() => (globalThis as { copied?: Record<string, string> }).copied ?? {});
}

/** A fresh, empty data folder. Remove it with `removeDataFolder`. */
export const createDataFolder = () => mkdtemp(join(tmpdir(), "incarnamind-smoke-"));

/** Closes an app, and kills it if it hasn't quit in 10 s, so one stuck app can't hold up the worker. */
async function closeOrKill(app: ElectronApplication): Promise<void> {
  const quit = app.close().catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const stuck = new Promise<"stuck">((resolve) => {
    timer = setTimeout(() => resolve("stuck"), 10_000);
  });
  if ((await Promise.race([quit, stuck])) === "stuck") app.process().kill("SIGKILL");
  clearTimeout(timer);
}

/**
 * Removes a data folder, after closing an app the test left open on it. If
 * the test failed, a screenshot of that app's window as the test left it is
 * kept first, as app-window.png with the test's results, which CI uploads
 * (Playwright's own screenshots and traces leave an Electron app's window out).
 */
export async function removeDataFolder(dataDir: string): Promise<void> {
  const info = test.info();
  for (const [app, folder] of [...openApps]) {
    if (folder !== dataDir) continue;
    openApps.delete(app);
    const window = app.windows()[0];
    if (info.status !== info.expectedStatus && window) {
      const path = info.outputPath("app-window.png");
      const shot = await window.screenshot({ path }).catch(() => undefined);
      if (shot) await info.attach("app-window", { path, contentType: "image/png" });
    }
    await closeOrKill(app);
  }
  // The app's log goes with a failed test's traces: what happened on CI's machine is gone after.
  const log = join(dataDir, "logs", "incarnamind.log");
  if (info.status !== info.expectedStatus && existsSync(log)) {
    await info.attach("app-log", { path: log, contentType: "text/plain" });
  }
  await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
}

/** The core's bridge in the page, for a test to set things up or read them: `(await coreOf(window)).evaluate(...)`. */
export const coreOf = (window: Page) =>
  window.evaluateHandle(() => (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind);

/**
 * What the core holds that a change to a Mind, Document, Folder, Tag, Linked folder or Recently
 * deleted touches, as plain data: a test compares it before and after, through the bridge and not
 * the screen. Dates are left out, as a change taken back is stamped again, and so is where a
 * Document's automatic tagging is, which moves on by itself when a Document changes Folder.
 */
export async function coreState(window: Page): Promise<unknown> {
  return (await coreOf(window)).evaluate(async (core) => {
    const [minds, documents, library, tags, linkedFolders, deleted] = await Promise.all([
      core.listMinds(),
      core.listDocuments(),
      core.getLibrary(),
      core.listTags(),
      core.listLinkedFolders(),
      core.listDeleted(),
    ]);
    const state = {
      minds,
      documents,
      folders: library.groups,
      assignments: library.assignments,
      tags,
      linkedFolders,
      deleted,
    };
    const progress = ["tagging", "taggingError"];
    return JSON.parse(
      JSON.stringify(state, (key, value) =>
        key.endsWith("At") || progress.includes(key) ? undefined : value,
      ),
    );
  });
}

/**
 * The commands a menu holds, in order, with its rules as "—": the menu's items by their test ids,
 * which are the commands' IDs.
 */
export async function menuCommands(menu: Locator): Promise<string[]> {
  await expect(menu).toBeVisible();
  // Its items draw a moment after the popover shows.
  await expect(menu.getByRole("menuitem").first()).toBeVisible();
  return menu.evaluate((element) =>
    Array.from(element.children).map((child) =>
      child.getAttribute("role") === "menuitem" ? (child.getAttribute("data-testid") ?? "") : "—",
    ),
  );
}

/** Clicks the empty foot of the sidebar's tree, so the focus isn't in text and ⌘Z goes to the app's changes. */
export async function leaveText(window: Page): Promise<void> {
  const box = await window.getByTestId("sidebar-tree").boundingBox();
  if (!box) throw new Error("The sidebar isn't showing.");
  await window.mouse.move(box.x + box.width / 2, box.y + box.height - 8, { steps: 8 });
  await window.mouse.down();
  await window.mouse.up();
}

/**
 * Exports the Mind in the shown tab from Export's menu: in `format`, or in the
 * one it lists first, the last one used.
 */
export async function exportFromMenu(window: Page, format?: ExportFormat): Promise<void> {
  await pointAndClick(window, window.getByTestId("export-mind"));
  const menu = window.getByTestId("export-menu");
  await expect(menu).toBeVisible();
  if (!format) {
    await pointAndClick(window, menu.getByRole("menuitem").first());
    return;
  }
  const item = window.getByTestId(`export-as-${format}`);
  if ((await menu.getByTestId(`export-as-${format}`).count()) === 0) {
    await pointAndClick(window, menu.getByTestId("export-more"));
    await expect(window.getByTestId("export-more-menu")).toBeVisible();
  }
  await pointAndClick(window, item);
}

/** The fonts Chromium drew an element's text with, by name, and whether each is bundled with the app. */
export async function fontsDrawing(window: Page, selector: string) {
  const session = await window.context().newCDPSession(window);
  try {
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const { root } = await session.send("DOM.getDocument", { depth: -1 });
    const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });
    return fonts
      .map((font) => ({
        family: font.familyName,
        name: font.postScriptName,
        bundled: font.isCustomFont,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    await session.detach();
  }
}
