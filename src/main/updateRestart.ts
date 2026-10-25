/**
 * Restarts to install an update, once quitting is certain: the User may keep the app open
 * (unsaved changes), and then nothing is released or installed. The Linux AppImage starts the new
 * copy before this one has quit, so this one lets go of the data folder only then, and just
 * before, or the new copy would find it taken and quit at once (#1352).
 */
export async function restartToInstall(
  updater: { quitAndInstall(): void },
  settleQuit: () => Promise<boolean>,
  releaseDataFolder: () => void,
): Promise<void> {
  if (!(await settleQuit())) return;
  releaseDataFolder();
  updater.quitAndInstall();
}
