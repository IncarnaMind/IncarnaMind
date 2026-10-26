import { writeSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  powerMonitor,
  protocol,
} from "electron";
import {
  type ChatModelFactory,
  type Core,
  coreApiMethods,
  createCore,
  resolveLanguage,
  type Settings,
  type TaskKind,
} from "../core";
import { DataFromNewerVersionError } from "../core/errors";
import type { Language } from "../core/language";
import { defaultOllamaUrl } from "../core/providers/kinds";
import { installedOllamaModels } from "../core/providers/ollama";
import { channelFor, EVENT_CHANNEL } from "../shared/bridge";
import { translate } from "../shared/i18n";
import { ANALYSIS_SCHEME_PRIVILEGES } from "./analysis";
import { showDevelopmentDockIcon, windowIcon } from "./appIcon";
import { DOCUMENT_SCHEME_PRIVILEGES, serveDocumentFiles } from "./documentProtocol";
import { serveFileActions } from "./files";
import { handle } from "./ipc";
import { startLogging } from "./logging";
import { isCaptureWindow } from "./meetings/capture";
import { isGuideWindow, servePermissionGuide } from "./meetings/guide";
import { isPanelWindow, serveMeetingPanel } from "./meetings/panel";
import { installAppMenu } from "./menu";
import { createSystemNotifications } from "./notifications";
import { chooseExecutor, createElectronAdapters, homeFolder, systemBrowser } from "./platform";
import { acquireInstance } from "./singleInstance";
import { reopenAfterQuit, restartAfterFailedUpdate, startAgainIfStalled } from "./startDuringQuit";
import { DOWNLOAD_BUTTON, RELEASES_PAGE, startupDialog, startupProblem } from "./startupError";
import { realHomeProblem } from "./testHome";
import { reportFullScreen, titleBarOptions } from "./titleBar";
import { guardQuit } from "./unsavedChanges";
import { canReopenAfterUpdate, registerUpdateCheck, startAutoUpdates } from "./updater";
import { keepWindowPlace, windowPlace } from "./windowState";

// A test build refuses the real home folder before anything is written. It says why on stderr and
// exits: a dialog would leave the smoke test waiting.
if (import.meta.env.MODE === "test") {
  const problem = realHomeProblem(homeFolder());
  if (problem) {
    writeSync(2, `${problem}\n`);
    process.exit(1);
  }
}

// Points the app at another data folder: the smoke test uses a temporary one.
// Set before anything reads `userData`, so Chromium's own data moves there too.
const dataDirOverride = process.env.INCARNAMIND_DATA_DIR;
if (dataDirOverride) app.setPath("userData", resolve(dataDirOverride));

// The log in the data folder's `logs/`, from the start, so it has what goes wrong at startup too.
const logger = startLogging(app.getPath("userData"));

const reportLock = (what: string, error: unknown) => logger.exception(what, error);
const systemLanguage = () => resolveLanguage("system", app.getPreferredSystemLanguages());
const instance = acquireInstance(
  app.getPath("userData"),
  { args: process.argv, cwd: process.cwd() },
  reportLock,
);
const ownsDataFolder = instance.kind === "owner";
if (instance.kind === "busy") {
  logger.error("app.dataFolderBusy", { folder: app.getPath("userData") });
  // Before `ready`, Linux writes an error box to stderr and shows nothing (#1493).
  app.whenReady().then(() => {
    const { title, detail } = startupProblem(systemLanguage(), "busy");
    try {
      dialog.showErrorBox(title, detail);
    } finally {
      app.exit(0);
    }
  });
} else if (!ownsDataFolder) {
  logger.info("app.anotherCopyRunning");
  // Not `quit`: its `app.quit` line in the log would read as the running copy's.
  app.exit(0);
}
if (instance.kind === "owner") {
  // Only the data owner creates a native singleton; contenders cannot later unlink its files (#1448).
  app.requestSingleInstanceLock();
  app.on("quit", () => instance.owner.quitting());
  startAgainIfStalled(
    app,
    () => {
      const { title, detail } = startupProblem(systemLanguage(), "stalled");
      dialog.showErrorBox(title, detail);
    },
    logger,
    instance.owner.previousOwner,
  );
}
const startWaitsForQuit = reopenAfterQuit(app, canReopenAfterUpdate, logger);

// Whether Skill scripts run in the OS sandbox, found out while Electron starts.
const scriptExecutor = ownsDataFolder ? chooseExecutor(logger) : Promise.resolve(undefined);

/** Set by electron-vite in development; absent in a built app. */
const rendererUrl = process.env.ELECTRON_RENDERER_URL;

/** Test-only launch flag: lets the smoke tests drive UI directly, e.g. open the Document viewer at a page. */
const testHooks = process.env.INCARNAMIND_TEST_HOOKS === "1";

// The smoke tests sample painted frames to check that nothing moves. Chromium stops painting a
// window it takes for hidden or covered, which a busy CI runner's windows often are, so a check saw
// no frames at all while the page was right.
if (testHooks) {
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-background-timer-throttling");
}

// Electron takes every privileged scheme in one call: a second would replace the first.
protocol.registerSchemesAsPrivileged([DOCUMENT_SCHEME_PRIVILEGES, ANALYSIS_SCHEME_PRIVILEGES]);

/**
 * The scripted chat model the smoke tests answer Questions with. Only a test
 * build (`electron-vite build --mode test`) has it: in any other build this
 * condition is false at build time, so the model isn't bundled at all.
 */
async function testChatModel(): Promise<ChatModelFactory | undefined> {
  if (import.meta.env.MODE === "test" && process.env.INCARNAMIND_FAKE_CHAT === "1") {
    const { createFakeChatModel } = await import("./fakeChatModel");
    return createFakeChatModel;
  }
  return undefined;
}

/**
 * The smoke tests' scripted Task, which asks for approval and writes files
 * (see ./scriptedTask). Only a test build has it, as it has the scripted chat
 * model; a test starts it through `globalThis.incarnamindScriptedTask`.
 */
async function testTaskKinds(): Promise<TaskKind[]> {
  if (import.meta.env.MODE === "test" && process.env.INCARNAMIND_TEST_TASKS === "1") {
    const { scriptedTask } = await import("./scriptedTask");
    return [scriptedTask];
  }
  return [];
}

let core: Core | undefined;

/** The app's windows: not the hidden one that records a Meeting's audio, nor the floating panel. */
const appWindows = () =>
  BrowserWindow.getAllWindows().filter(
    (window) => !isCaptureWindow(window) && !isPanelWindow(window) && !isGuideWindow(window),
  );

/** The windows that hear the core's events: the app's, and the floating panel during a call. */
const listeningWindows = () =>
  BrowserWindow.getAllWindows().filter((window) => !isCaptureWindow(window));

function showFront(): void {
  const [front] = appWindows();
  if (!front) {
    // Before the core is there, the start in progress makes the first window itself.
    if (core) createWindow();
    return;
  }
  if (front.isMinimized()) front.restore();
  front.show();
  front.focus();
  app.focus({ steal: true });
}

const secondLaunch = () => {
  const waits = startWaitsForQuit();
  logger.info("app.secondLaunch", { quitting: waits });
  if (!waits) showFront();
  return !waits;
};
app.on("second-instance", secondLaunch);

function isFromOurRenderer(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const url = event.senderFrame?.url ?? "";
  return rendererUrl ? url.startsWith(rendererUrl) : url.startsWith("file://");
}

/**
 * Serves the core's public interface to the renderer: one IPC channel per method,
 * and every core event pushed to every window on one event channel.
 */
function exposeCore(core: Core): void {
  for (const method of coreApiMethods) {
    handle(channelFor(method), (event, ...args) => {
      if (!isFromOurRenderer(event)) throw new Error("Refused a call from an unknown page.");
      return Reflect.apply(core[method], core, args) as Promise<unknown>;
    });
  }
  core.onAnyEvent((name, payload) => {
    // An outside agent asked to show a Citation (#351): the app comes in front to show it, in
    // a new window once loaded if none is open.
    if (name === "agents.citationShown" && appWindows().length === 0) {
      const window = createWindow();
      window.webContents.once("did-finish-load", () =>
        window.webContents.send(EVENT_CHANNEL, name, payload),
      );
      return;
    }
    for (const window of listeningWindows()) {
      if (!window.isDestroyed()) window.webContents.send(EVENT_CHANNEL, name, payload);
    }
    if (name === "agents.citationShown") showFront();
  });
}

function createWindow(): BrowserWindow {
  const dataDir = app.getPath("userData");
  const place = windowPlace(dataDir, { width: 1280, height: 800 }, { width: 900, height: 560 });
  const window = new BrowserWindow({
    ...(place.x !== undefined && place.y !== undefined ? { x: place.x, y: place.y } : {}),
    width: place.width,
    height: place.height,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: "IncarnaMind",
    // The frame (DESIGN.md), as the approved canvas has it: the sidebar's colour, which the
    // first paint shows at the top left, under macOS's traffic lights.
    backgroundColor: "#F4F5F7",
    // No title row of the system's: its window buttons sit in the app's top band.
    ...titleBarOptions(process.platform),
    ...windowIcon(),
    // A test build's window takes the size a smoke test sets: macOS keeps a window no taller
    // than the screen otherwise, and CI's Mac has a small one.
    ...(import.meta.env.MODE === "test" && { enableLargerThanScreen: true }),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.once("ready-to-show", () => {
    if (place.maximized) window.maximize();
    window.show();
  });
  keepWindowPlace(window, dataDir);
  reportFullScreen(window);
  // A Meeting's hidden capture window doesn't keep the app running once its last window
  // closes, where closing the last window quits (Windows, Linux): quitting saves the recording.
  window.on("closed", () => {
    if (process.platform !== "darwin" && appWindows().length === 0) app.quit();
  });

  // Links open in the User's browser, never inside the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    systemBrowser.open(url).catch(() => undefined);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => {
    if (event.url !== window.webContents.getURL()) event.preventDefault();
  });

  // The window's name: the core keeps each window's tabs and groups under it.
  const query: Record<string, string> = { window: "main", ...(testHooks && { testHooks: "1" }) };
  if (rendererUrl) {
    const url = new URL(rendererUrl);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    void window.loadURL(url.href);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"), { query });
  }
  return window;
}

/**
 * The application menu, in the interface language, and again whenever it
 * changes. Reload and the developer tools only outside a packaged app.
 */
function installMenuInLanguage(core: Core): void {
  const developer = !app.isPackaged;
  let shown: Language | null = null;
  const install = (language: Language) => {
    if (language === shown) return;
    shown = language;
    installAppMenu(language, { developer, windows: appWindows });
  };
  install(resolveLanguage("system", app.getPreferredSystemLanguages()));
  core.getSettings().then(
    (settings) => install(settings.language),
    () => undefined,
  );
  core.onAnyEvent((name, payload) => {
    if (name === "settings.changed") install((payload as Settings).language);
  });
}

async function showStartupError(error: unknown): Promise<void> {
  logger.exception("app.startFailed", error);
  const language = resolveLanguage("system", app.getPreferredSystemLanguages());
  const options = startupDialog(error, language);
  if (!(error instanceof DataFromNewerVersionError)) {
    dialog.showErrorBox(options.title, options.detail);
    return;
  }
  const { response } = await dialog.showMessageBox({ type: "error", ...options });
  if (response === DOWNLOAD_BUTTON) {
    await systemBrowser.open(RELEASES_PAGE).catch((openError: unknown) => {
      logger.exception("app.startFailed", openError);
    });
  }
}

app.whenReady().then(async () => {
  if (!ownsDataFolder) return;
  showDevelopmentDockIcon();
  const createChatModel = await testChatModel();
  const taskKinds = await testTaskKinds();
  const executor = await scriptExecutor;
  // The window's page starts loading while the core starts. Its calls reach the core once
  // `exposeCore` has run, below: they wait until this synchronous run is done.
  createWindow();
  try {
    core = createCore({
      ...createElectronAdapters(logger),
      notifications: createSystemNotifications(appWindows),
      ...(executor && { executor }),
      ...(createChatModel && { createChatModel }),
      // A smoke test never reaches an Ollama that happens to run on the computer: only a
      // stand-in it starts at another address.
      ...(testHooks && {
        localModels: (baseUrl: string) =>
          baseUrl === defaultOllamaUrl() ? Promise.resolve([]) : installedOllamaModels(baseUrl),
      }),
      ...(taskKinds.length > 0 && { taskKinds }),
    });
  } catch (error) {
    await showStartupError(error);
    app.quit();
    return;
  }
  exposeCore(core);
  const settleQuit = guardQuit(
    core,
    () => BrowserWindow.getFocusedWindow() ?? appWindows()[0] ?? null,
  );
  if (instance.kind === "owner") {
    app.on("before-quit", (event) => instance.owner.quitting(event.defaultPrevented));
    instance.owner.ready(secondLaunch);
  }
  if (taskKinds.length > 0) {
    const started = core;
    (globalThis as { incarnamindScriptedTask?: unknown }).incarnamindScriptedTask = {
      start: (mindId: string, input: unknown) => started.startTask("scripted", mindId, input).id,
    };
  }
  registerUpdateCheck(core);
  serveFileActions(core, {
    dataDir: app.getPath("userData"),
    trusted: isFromOurRenderer,
    logger,
  });
  serveDocumentFiles(core, rendererUrl ? new URL(rendererUrl).origin : null);
  serveMeetingPanel(core, {
    rendererUrl,
    appWindows,
    trusted: isFromOurRenderer,
    mac: process.platform === "darwin",
    log: logger,
    testHooks,
  });
  servePermissionGuide({ rendererUrl, appWindows, trusted: isFromOurRenderer, testHooks });
  installMenuInLanguage(core);
  // Only a packaged app checks for updates; the smoke tests must never reach GitHub.
  if (!testHooks) {
    startAutoUpdates(core, settleQuit, (error, language) => {
      restartAfterFailedUpdate(
        app,
        () => {
          for (const window of BrowserWindow.getAllWindows()) window.hide();
          logger.exception("app.updateInstallFailed", error);
          dialog.showMessageBoxSync({
            type: "error",
            title: translate(language, "update.failed.title"),
            message: translate(language, "update.failed.title"),
            detail: translate(language, "update.failed.detail"),
            buttons: [translate(language, "update.failed.reopen")],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
        },
        () => core?.close(),
      );
    });
  }

  app.on("activate", () => {
    if (!startWaitsForQuit() && appWindows().length === 0) createWindow();
  });

  // A Meeting saves what it has before the computer sleeps, and records again when it wakes.
  powerMonitor.on("suspend", () => core?.systemSleeping());
  powerMonitor.on("resume", () => core?.systemAwake());
});

// Electron would answer a site's request with the first certificate in the system's store: on
// a managed Mac, an identity with the User's name. No page of IncarnaMind's needs one.
app.on("select-client-certificate", (event, _contents, _url, _list, callback) => {
  event.preventDefault();
  callback();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  core?.close();
});
