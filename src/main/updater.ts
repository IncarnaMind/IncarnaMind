/**
 * Auto-update from GitHub Releases, with electron-updater.
 *
 * A packaged app checks the latest published release once, at startup. Development and
 * the tests run the app unpackaged, so they never check.
 *
 * - Where an update can install itself (Windows, the Linux AppImage, a macOS build signed
 *   with a Developer ID), it downloads in the background and installs when the User quits.
 *   Once it's downloaded, the User can restart to install it straight away.
 * - An unsigned macOS build can't install updates: Squirrel.Mac refuses to update an app
 *   that isn't signed with a Developer ID. The Linux .deb doesn't either: electron-updater
 *   installs it as root through `pkexec bash -c 'dpkg -i …'` (#1178). In both, the User is
 *   told that a new version is out and offered its download page instead.
 *
 * The check sends nothing of the User's, so it needs no consent; the Privacy page lists
 * it, and the User can turn automatic checks off there. They are on by default.
 */
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { app, BrowserWindow, autoUpdater as nativeUpdater } from "electron";
import type { Core, ExternalService, Language, PrivacySettings, Settings } from "../core";
import { translate } from "../shared/i18n";
import { systemBrowser } from "./platform";
import { RELEASES_PAGE } from "./startupError";
import { showMessageBox } from "./systemDialogs";
import { restartToInstall } from "./updateRestart";

/** Where update checks go. */
const GITHUB_RELEASES: Readonly<ExternalService> = {
  id: "https://github.com",
  name: "GitHub Releases",
};

interface SettingsSource {
  getSettings(): Promise<Pick<Settings, "language">>;
  getPrivacySettings(): Promise<Pick<PrivacySettings, "automaticUpdateChecks">>;
}

let installing = false;
let quittingToInstall = false;
let reopening = false;

export function canReopenAfterUpdate(): boolean {
  if (installing || quittingToInstall) return false;
  reopening = true;
  return true;
}

/** Lists the update check on the Privacy page, on or off as the User chose. */
export function registerUpdateCheck(core: Pick<Core, "networkTraffic" | "getPrivacySettings">) {
  core.networkTraffic.register({
    id: "update-check",
    service: GITHUB_RELEASES,
    enabled: async () => (await core.getPrivacySettings()).automaticUpdateChecks,
  });
}

/**
 * Starts this run's update check in the background. Does nothing in an
 * unpackaged app, or when the User turned automatic update checks off.
 */
export function startAutoUpdates(
  core: SettingsSource,
  settleQuit: () => Promise<boolean>,
  installFailed: (error: unknown, language: Language, reopens: boolean) => void,
  installStarted: (reopens: boolean) => void,
  prepareInstall: (targetVersion: string, reopens: boolean) => void,
): void {
  if (!app.isPackaged) return;
  let preparedReopens: boolean | undefined;
  const prepare = (version: string, reopens: boolean): boolean => {
    if (preparedReopens !== undefined) return false;
    prepareInstall(version, reopens);
    quittingToInstall = true;
    preparedReopens = reopens;
    return true;
  };
  const beginInstall = (reopens: boolean) => {
    if (installing) return;
    installing = true;
    installStarted(reopens);
  };
  nativeUpdater.on("before-quit-for-update", () => {
    if (preparedReopens !== undefined) beginInstall(preparedReopens);
  });
  checkForUpdates(core, settleQuit, installFailed, beginInstall, prepare).catch(
    (error: unknown) => {
      // Offline, rate-limited, or no release yet: the next start tries again.
      console.warn("The update check failed:", error);
    },
  );
}

async function checkForUpdates(
  core: SettingsSource,
  settleQuit: () => Promise<boolean>,
  installFailed: (error: unknown, language: Language, reopens: boolean) => void,
  beginInstall: (reopens: boolean) => void,
  prepare: (version: string, reopens: boolean) => boolean,
): Promise<void> {
  if (!(await core.getPrivacySettings()).automaticUpdateChecks) return;
  const { language } = await core.getSettings();
  const { autoUpdater } = await import("./autoUpdater");
  let downloaded: { version: string; language: Language } | undefined;
  let failureHandled = false;
  const failed = (error: unknown, language: Language, reopens: boolean) => {
    if (failureHandled) return;
    failureHandled = true;
    beginInstall(reopens);
    installFailed(error, language, reopens);
  };
  app.on("quit", () => {
    const update = downloaded;
    if (!update) return;
    const reopens = reopening;
    try {
      if (prepare(update.version, reopens)) {
        beginInstall(reopens);
        autoUpdater.once("error", (error: unknown) => failed(error, update.language, reopens));
      }
    } catch (error) {
      failed(error, update.language, reopens);
    }
  });
  const installable = await canInstallUpdates();
  autoUpdater.autoDownload = installable;
  const preparing = process.platform === "darwin" && installable ? nativePreparation() : null;
  const onDownloaded = (info: { version: string }) => {
    downloaded = { version: info.version, language };
  };
  if (installable) autoUpdater.on("update-downloaded", onDownloaded);
  try {
    // Null when the updater is inactive, e.g. on Linux outside an AppImage and a .deb.
    const result = await autoUpdater.checkForUpdates();
    if (!result?.isUpdateAvailable) return;
    const { version } = result.updateInfo;

    if (!installable) {
      if (await ask(language, "available", version)) {
        await systemBrowser.open(`${RELEASES_PAGE}/tag/v${version}`);
      }
      return;
    }

    await Promise.all([
      result.downloadPromise,
      preparing?.result.then((failure) => {
        if (failure) {
          throw failure.error;
        }
      }),
    ]);
    const targetVersion = downloaded?.version;
    if (!targetVersion)
      throw new Error("The update download completed without its target version.");
    if (await ask(language, "ready", targetVersion)) {
      await restartToInstall(
        {
          quitAndInstall() {
            const onError = (error: unknown) => failed(error, language, true);
            try {
              prepare(targetVersion, true);
              if (process.platform !== "darwin") beginInstall(true);
              autoUpdater.once("error", onError);
              autoUpdater.quitAndInstall();
            } catch (error) {
              autoUpdater.removeListener("error", onError);
              failed(error, language, true);
            }
          },
        },
        settleQuit,
        app,
      );
    }
  } finally {
    autoUpdater.removeListener("update-downloaded", onDownloaded);
    preparing?.close();
  }
}

function nativePreparation() {
  const prepared = Promise.withResolvers<{ error: unknown } | null>();
  const close = () => {
    nativeUpdater.removeListener("update-downloaded", downloaded);
    nativeUpdater.removeListener("error", failed);
  };
  const downloaded = () => {
    close();
    prepared.resolve(null);
  };
  const failed = (error: unknown) => {
    close();
    prepared.resolve({ error });
  };
  nativeUpdater.once("update-downloaded", downloaded);
  nativeUpdater.once("error", failed);
  return { result: prepared.promise, close };
}

/**
 * Squirrel.Mac only installs updates into an app signed with a Developer ID, and on Linux only
 * an AppImage replaces itself (the AppImage runtime sets APPIMAGE).
 */
function canInstallUpdates(): Promise<boolean> {
  if (process.platform === "linux") return Promise.resolve(Boolean(process.env.APPIMAGE));
  if (process.platform !== "darwin") return Promise.resolve(true);
  // …/IncarnaMind.app/Contents/MacOS/IncarnaMind → …/IncarnaMind.app
  const bundle = resolve(process.execPath, "../../..");
  return new Promise((done) => {
    execFile("/usr/bin/codesign", ["--display", "--verbose=2", bundle], (error, _out, details) => {
      done(!error && /^Authority=Developer ID Application:/m.test(details));
    });
  });
}

/** Asks the User whether to act on the update now. True if they agree. */
async function ask(
  language: Language,
  prompt: "available" | "ready",
  version: string,
): Promise<boolean> {
  const options = {
    type: "info" as const,
    message: translate(language, `update.${prompt}.message`, { version }),
    detail: translate(language, `update.${prompt}.detail`),
    buttons: [translate(language, `update.${prompt}.confirm`), translate(language, "update.later")],
    defaultId: 0,
    cancelId: 1,
  };
  const window = BrowserWindow.getAllWindows().find((it) => it.isVisible());
  const { response } = await showMessageBox(window ?? null, options);
  return response === 0;
}
