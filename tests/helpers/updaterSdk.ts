import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { AppAdapter } from "electron-updater/out/AppAdapter";
import type { DownloadExecutorResult } from "electron-updater/out/AppUpdater";
import { BaseUpdater, type InstallOptions } from "electron-updater/out/BaseUpdater";
import { DownloadedUpdateHelper } from "electron-updater/out/DownloadedUpdateHelper";
import type {
  ResolvedUpdateFileInfo,
  UpdateCheckResult,
  UpdateDownloadedEvent,
} from "electron-updater/out/types";

export class UpdaterAppFixture implements AppAdapter {
  readonly version = "1.0.0";
  readonly name = "IncarnaMind";
  readonly isPackaged = true;
  readonly appUpdateConfigPath: string;
  readonly userDataPath: string;
  readonly baseCachePath: string;
  relaunches = 0;

  constructor(
    folder: string,
    readonly events = new EventEmitter(),
  ) {
    this.appUpdateConfigPath = join(folder, "app-update.yml");
    this.userDataPath = join(folder, "data");
    this.baseCachePath = join(folder, "cache");
  }

  whenReady(): Promise<void> {
    return Promise.resolve();
  }

  relaunch(): void {
    this.relaunches += 1;
  }

  quit(): void {
    this.events.emit("quit", {}, 0);
  }

  onQuit(handler: (exitCode: number) => void): void {
    this.events.once("quit", (_event: unknown, exitCode: number) => handler(exitCode));
  }
}

export class UpdaterSdkFixture extends BaseUpdater {
  readonly installations: InstallOptions[] = [];
  readonly downloadedEvent: UpdateDownloadedEvent;
  installationError: Error | undefined;
  private readonly downloaded: DownloadedUpdateHelper;
  private readonly fileInfo: ResolvedUpdateFileInfo;

  constructor(
    app: AppAdapter,
    private readonly onInstall: (options: InstallOptions) => void = () => undefined,
    targetVersion = "1.1.0",
  ) {
    super(null, app);
    this.logger = null;
    this.downloaded = new DownloadedUpdateHelper(app.baseCachePath);
    this.downloadedUpdateHelper = this.downloaded;
    this.fileInfo = {
      url: new URL("https://example.invalid/fixture.exe"),
      info: { url: "fixture.exe", sha512: Buffer.from("fixture").toString("base64") },
    };
    this.downloadedEvent = {
      version: targetVersion,
      releaseDate: "2026-10-26T00:00:00.000Z",
      files: [this.fileInfo.info],
      path: this.fileInfo.info.url,
      sha512: this.fileInfo.info.sha512,
      downloadedFile: join(app.baseCachePath, "fixture.exe"),
    };
  }

  async completeFixtureDownload(): Promise<void> {
    await this.downloaded.setDownloadedFile(
      this.downloadedEvent.downloadedFile,
      null,
      this.downloadedEvent,
      this.fileInfo,
      "fixture.exe",
      false,
    );
    // Preserve the registration boundary: a later flag change cannot add its skipped handler (#2022).
    this.dispatchUpdateDownloaded(this.downloadedEvent);
    this.addQuitHandler();
  }

  override async checkForUpdates(): Promise<UpdateCheckResult> {
    const downloadPromise = this.completeFixtureDownload().then(() => [
      this.downloadedEvent.downloadedFile,
    ]);
    return {
      isUpdateAvailable: true,
      updateInfo: this.downloadedEvent,
      versionInfo: this.downloadedEvent,
      downloadPromise,
    };
  }

  protected override doDownloadUpdate(): Promise<DownloadExecutorResult> {
    return Promise.reject(new Error("The SDK fixture does not perform network downloads."));
  }

  protected override doInstall(options: InstallOptions): boolean {
    this.installations.push({ ...options });
    this.onInstall(options);
    if (this.installationError) throw this.installationError;
    return true;
  }
}
