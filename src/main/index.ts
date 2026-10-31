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
import { DataFromNewerVersionError, isRecord } from "../core/errors";
import type { Language } from "../core/language";
import { defaultOllamaUrl } from "../core/providers/kinds";
import { installedOllamaModels } from "../core/providers/ollama";
import { channelFor, EVENT_CHANNEL, SERVED_CHANNEL } from "../shared/bridge";
import { translate } from "../shared/i18n";
import { ANALYSIS_SCHEME_PRIVILEGES } from "./analysis";
import { showDevelopmentDockIcon, windowIcon } from "./appIcon";
import { DOCUMENT_SCHEME_PRIVILEGES, serveDocumentFiles } from "./documentProtocol";
import { CHECK_ENGINES_SWITCH, engineCheckDataFolder, runEngineCheck } from "./engineCheck";
import { serveFileActions } from "./files";
import {
  failUpdate,
  prepareUpdate,
  type UpdateHandoff,
  updateAccess,
  updateRecoveryId,
} from "./instanceUpdate";
import { handle } from "./ipc";
import { startLogging } from "./logging";
import { isCaptureWindow } from "./meetings/capture";
import { isGuideWindow, servePermissionGuide } from "./meetings/guide";
import { isPanelWindow, serveMeetingPanel } from "./meetings/panel";
import { installAppMenu } from "./menu";
import { createSystemNotifications } from "./notifications";
import { chooseExecutor, createElectronAdapters, homeFolder, systemBrowser } from "./platform";
import { acquireInstance } from "./singleInstance";
import {
  exitAfterFailedUpdate,
  reopenAfterQuit,
  restartAfterFailedUpdate,
  startAgainIfStalled,
} from "./startDuringQuit";
import {
  DOWNLOAD_BUTTON,
  RELEASES_PAGE,
  startupDialog,
  startupProblem,
  updateStartupDialog,
} from "./startupError";
import { migrateOffThread } from "./storageStart";
import { showMessageBox } from "./systemDialogs";
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

/** Where the engine check (./engineCheck) writes its report: given, the app does nothing else. */
const engineCheckReport = app.commandLine.getSwitchValue(CHECK_ENGINES_SWITCH);

// Points the app at another data folder: the smoke test uses a temporary one, and the engine check
// one of its own. Set before anything reads `userData`, so Chromium's own data moves there too.
const dataDirOverride =
  process.env.INCARNAMIND_DATA_DIR ?? (engineCheckReport ? engineCheckDataFolder() : undefined);
if (dataDirOverride) app.setPath("userData", resolve(dataDirOverride));

// The log in the data folder's `logs/`, from the start, so it has what goes wrong at startup too.
const logger = startLogging(app.getPath("userData"));

const reportLock = (what: string, error: unknown) => logger.exception(what, error);
const systemLanguage = () => resolveLanguage("system", app.getPreferredSystemLanguages());
delete process.env.APPIMAGE_SILENT_INSTALL;
const instance = acquireInstance(
  app.getPath("userData"),
  { args: process.argv, cwd: process.cwd() },
  reportLock,
  { currentVersion: app.getVersion(), recoveryId: updateRecoveryId(process.argv) },
);
const ownsDataFolder = instance.kind === "owner";
if (instance.kind === "update") {
  app.whenReady().then(async () => {
    try {
      await showUpdateProblem(systemLanguage(), instance.currentVersion, instance.targetVersion);
    } catch (error) {
      logger.exception("app.updateProblemFailed", error);
    } finally {
      app.exit(0);
    }
  });
} else if (instance.kind === "busy") {
  logger.error("app.dataFolderBusy", { folder: app.getPath("userData") });
  // Before `ready`, Linux writes an error box to stderr and shows nothing (#1493).
  app.whenReady().then(() => {
    const { title, detail } = startupProblem(
      systemLanguage(),
      instance.phase === "quitting" ||
        instance.phase === "starting" ||
        instance.phase === "installing"
        ? instance.phase
        : "busy",
    );
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

if (engineCheckReport && ownsDataFolder) {
  app.whenReady().then(() => {
    app.dock?.hide();
    return runEngineCheck(engineCheckReport, logger);
  });
}

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

/** The window that watches each comparison table's Mind, by the content it came from. */
const comparisonClients = new Map<number, string>();
/** The window that asked the assistant, by the content it came from: it runs the Answer's commands. */
const commandClients = new Map<number, string>();
const ASKS_IN_A_WINDOW = new Set<string>(["askInConversation", "regenerateConversationAnswer"]);
/** The window planning a Check, by the content it came from: its Note is free once it is gone. */
const checkClients = new Map<number, string>();

/** The window's page is gone: the commands the assistant asked it to run won't be done there (#1421). */
function forgetCommandWindow(contentsId: number): void {
  const clientId = commandClients.get(contentsId);
  if (!clientId) return;
  commandClients.delete(contentsId);
  core
    ?.forgetCommandWindow({ clientId })
    .catch((error: unknown) => logger.exception("app.commandWindowForgotten", error));
}

/** The window's page is gone: a Check it was planning for a Note that never ran holds nothing (#2240). */
function forgetCheckWindow(contentsId: number): void {
  const clientId = checkClients.get(contentsId);
  if (!clientId) return;
  checkClients.delete(contentsId);
  core
    ?.forgetCheckWindow({ clientId })
    .catch((error: unknown) => logger.exception("app.checkWindowForgotten", error));
}

// Any window that shows a Note can watch its comparison tables: when it is gone, the core
// stops waiting for it.
app.on("browser-window-created", (_event, created) => {
  const contentsId = created.webContents.id;
  created.on("closed", () => {
    forgetCommandWindow(contentsId);
    forgetCheckWindow(contentsId);
    const clientId = comparisonClients.get(contentsId);
    if (!clientId) return;
    comparisonClients.delete(contentsId);
    core
      ?.forgetComparisonWindow({ clientId })
      .catch((error: unknown) => logger.exception("app.comparisonWindowForgotten", error));
  });
  created.webContents.on("render-process-gone", () => {
    forgetCommandWindow(contentsId);
    forgetCheckWindow(contentsId);
  });
  created.webContents.on("did-start-navigation", (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    forgetCommandWindow(contentsId);
    forgetCheckWindow(contentsId);
  });
});
let startupComplete = false;
let instanceReady = false;
let closingForUpdate = false;
let onReadyToUse: (() => Promise<void>) | undefined;
const shownWindows = new WeakSet<BrowserWindow>();
const served = Promise.withResolvers<void>();
handle(SERVED_CHANNEL, () => served.promise);

/** The app's windows: not the hidden one that records a Meeting's audio, nor the floating panel. */
const appWindows = () =>
  BrowserWindow.getAllWindows().filter(
    (window) => !isCaptureWindow(window) && !isPanelWindow(window) && !isGuideWindow(window),
  );

/** The windows that hear the core's events: the app's, and the floating panel during a call. */
const listeningWindows = () =>
  BrowserWindow.getAllWindows().filter((window) => !isCaptureWindow(window));

function showFront(): void {
  if (closingForUpdate) return;
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
  if (closingForUpdate) return false;
  const waits = startWaitsForQuit();
  logger.info("app.secondLaunch", { quitting: waits });
  if (!waits) showFront();
  return !waits;
};
app.on("second-instance", secondLaunch);

function finishStartup(): void {
  if (
    !startupComplete ||
    instanceReady ||
    closingForUpdate ||
    !appWindows().some((window) => shownWindows.has(window))
  )
    return;
  instanceReady = true;
  if (instance.kind === "owner") instance.owner.ready(secondLaunch);
  // The keyword index an older version built is rewritten in the background, off this
  // thread, once the window has been shown (#2042).
  setImmediate(() => core?.upgradeKeywordIndex());
  void onReadyToUse?.().catch((error: unknown) =>
    logger.exception("app.updateStartupFailed", error),
  );
}

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
      const input = args[0];
      if (
        method === "watchComparisonMind" &&
        isRecord(input) &&
        typeof input.clientId === "string"
      ) {
        comparisonClients.set(event.sender.id, input.clientId);
      }
      if (ASKS_IN_A_WINDOW.has(method) && isRecord(input) && typeof input.clientId === "string") {
        commandClients.set(event.sender.id, input.clientId);
      }
      if (method === "holdMindCheck" && isRecord(input) && typeof input.clientId === "string") {
        checkClients.set(event.sender.id, input.clientId);
      }
      return Reflect.apply(core[method], core, args) as Promise<unknown>;
    });
  }
  core.onAnyEvent((name, payload) => {
    // An outside agent asked to show a Citation (#351): the app comes in front to show it, in
    // a new window once loaded if none is open.
    if (name === "agents.citationShown" && closingForUpdate) return;
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
    if (closingForUpdate) return;
    if (place.maximized) window.maximize();
    window.show();
    shownWindows.add(window);
    finishStartup();
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

/** Settles once the window has painted its page, or once it never can. */
function firstPaint(window: BrowserWindow): Promise<void> {
  return new Promise((resolve) => {
    window.once("ready-to-show", () => resolve());
    window.once("closed", () => resolve());
    window.webContents.once("render-process-gone", () => resolve());
  });
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

async function showUpdateProblem(
  language: Language,
  currentVersion?: string,
  targetVersion?: string,
): Promise<void> {
  const options = updateStartupDialog(language, currentVersion, targetVersion);
  const { response } = await dialog.showMessageBox({ type: "error", ...options });
  if (response === DOWNLOAD_BUTTON) {
    await systemBrowser.open(RELEASES_PAGE).catch((error: unknown) => {
      logger.exception("app.updateDownloadFailed", error);
    });
  }
}

app.whenReady().then(async () => {
  if (!ownsDataFolder || engineCheckReport) return;
  if (instance.kind === "owner") instance.owner.starting();
  showDevelopmentDockIcon();
  const createChatModel = await testChatModel();
  const taskKinds = await testTaskKinds();
  const executor = await scriptExecutor;
  if (instance.kind === "owner") instance.owner.starting();
  // A page's frame takes the scheme handlers there are when it loads, so this one is in place
  // before the window, and answers once the core has started.
  const started = Promise.withResolvers<Core>();
  serveDocumentFiles(started.promise, rendererUrl ? new URL(rendererUrl).origin : null);
  const storage = migrateOffThread(app.getPath("userData"), logger, () => {
    if (instance.kind === "owner") instance.owner.starting();
  }).catch((error: unknown) => logger.exception("storage.migrateOffThreadFailed", error));
  const first = createWindow();
  logger.info("app.startup.windowReturned");
  // The core's start holds this thread, for seconds on a slow disk, and the page can neither load
  // nor show while it does (#2104): the window shows its frame first, and the page's calls wait
  // until everything is served.
  await firstPaint(first);
  logger.info("app.startup.windowPainted");
  await storage;
  try {
    const adapters = createElectronAdapters(logger);
    logger.info("app.startup.adaptersReady");
    core = createCore({
      ...adapters,
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
    logger.info("app.startup.coreReady");
  } catch (error) {
    for (const window of BrowserWindow.getAllWindows()) window.hide();
    await showStartupError(error);
    app.quit();
    return;
  }
  started.resolve(core);
  exposeCore(core);
  const settleQuit = guardQuit(
    core,
    () => BrowserWindow.getFocusedWindow() ?? appWindows()[0] ?? null,
  );
  if (instance.kind === "owner") {
    app.on("before-quit", (event) => instance.owner.quitting(event.defaultPrevented));
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
  const startedCore = core;
  onReadyToUse = async () => {
    if (testHooks) return;
    if (instance.kind === "owner" && instance.owner.pendingUpdate) {
      const { language } = await startedCore.getSettings();
      await showMessageBox(BrowserWindow.getFocusedWindow() ?? appWindows()[0] ?? null, {
        type: "info",
        message: translate(language, "update.pending.detail"),
        buttons: [translate(language, "update.pending.dismiss")],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
    }
    let handoff: UpdateHandoff | undefined;
    startAutoUpdates(
      startedCore,
      settleQuit,
      (error, language, reopens) => {
        closingForUpdate = true;
        logger.exception("app.updateInstallFailed", error);
        let recoveryId: string | undefined;
        try {
          if (handoff) {
            if (!failUpdate(app.getPath("userData"), handoff.id))
              throw new Error("The failed install no longer owns its update handoff.");
            recoveryId = handoff.id;
          } else if (updateAccess(app.getPath("userData"), app.getVersion()).kind !== "empty") {
            throw new Error("The failed install could not confirm its update handoff.");
          }
        } catch (recoveryError) {
          logger.exception("app.updateRecoveryFailed", recoveryError);
          for (const window of BrowserWindow.getAllWindows()) window.hide();
          if (!reopens) return;
          void showUpdateProblem(language, app.getVersion(), handoff?.targetVersion)
            .catch((problemError: unknown) =>
              logger.exception("app.updateProblemFailed", problemError),
            )
            .finally(() => exitAfterFailedUpdate(app, () => core?.close(), null));
          return;
        }
        // Automatic installation is already inside Electron’s terminal quit event.
        if (!reopens) return;
        restartAfterFailedUpdate(
          app,
          () => {
            for (const window of BrowserWindow.getAllWindows()) window.hide();
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
          recoveryId,
        );
      },
      (reopens) => {
        closingForUpdate = true;
        if (instance.kind === "owner") instance.owner.installing(reopens);
      },
      (version, reopens) => {
        if (instance.kind !== "owner")
          throw new Error("Only the data owner can install an update.");
        handoff = prepareUpdate(
          app.getPath("userData"),
          instance.owner.identity,
          app.getVersion(),
          version,
          reopens,
        );
        closingForUpdate = true;
        instance.owner.quitting();
        for (const window of BrowserWindow.getAllWindows()) window.hide();
      },
    );
  };

  app.on("activate", () => {
    if (!closingForUpdate && !startWaitsForQuit() && appWindows().length === 0) createWindow();
  });

  // A Meeting saves what it has before the computer sleeps, and records again when it wakes.
  powerMonitor.on("suspend", () => core?.systemSleeping());
  powerMonitor.on("resume", () => core?.systemAwake());
  served.resolve();
  startupComplete = true;
  finishStartup();
  logger.info("app.startup.hostReady");
});

// Electron would answer a site's request with the first certificate in the system's store: on
// a managed Mac, an identity with the User's name. No page of IncarnaMind's needs one.
app.on("select-client-certificate", (event, _contents, _url, _list, callback) => {
  event.preventDefault();
  callback();
});

app.on("window-all-closed", () => {
  // The engine check's only window, the hidden Analyses one, may close and open again.
  if (process.platform !== "darwin" && !engineCheckReport) app.quit();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  core?.close();
});
