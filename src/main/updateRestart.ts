/**
 * Restarts to install an update, once quitting is certain: the User may keep the app open
 * (unsaved changes), and then nothing is released or installed. The Linux AppImage starts the new
 * copy before this one has quit, so it needs the native lock early. SQLite ownership stays with
 * the old core until exit, including if the installer fails (#1448).
 */
export async function restartToInstall(
  updater: { quitAndInstall(): void },
  settleQuit: () => Promise<boolean>,
  app: { releaseSingleInstanceLock(): void },
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (!(await settleQuit())) return;
  if (platform === "linux") app.releaseSingleInstanceLock();
  updater.quitAndInstall();
}
