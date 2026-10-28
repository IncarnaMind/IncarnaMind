import type { FileShell, Logger, ModelRuntimeFolder } from "./adapters";
import type { Database } from "./storage";

/**
 * The newest migration the build before this one (0.1.0-alpha.4) lacked. A database that already
 * existed when it was applied was made by an earlier build, which ran every model with the
 * runtime's usage telemetry on (#2145), so an install that old has added to the runtime's folder
 * if it ever used a built-in model. A new install applies every migration in its first start.
 */
const ADDED_AFTER_EARLIER_BUILDS = 110;

/** Far longer than a first start takes to apply every migration, far shorter than any upgrade. */
const FIRST_START_MS = 10 * 60_000;

export function createModelRuntimeFolderNotice(
  db: Database,
  folder: ModelRuntimeFolder | undefined,
  shell: FileShell | undefined,
  log: Logger | undefined,
) {
  function installPredatesThisBuild(): boolean {
    const first = db.get<{ at: string | null }>(
      "SELECT min(applied_at) AS at FROM schema_migrations",
    )?.at;
    const latest = db.get<{ at: string }>(
      "SELECT applied_at AS at FROM schema_migrations WHERE version = ?",
      [ADDED_AFTER_EARLIER_BUILDS],
    )?.at;
    return !!first && !!latest && Date.parse(latest) - Date.parse(first) > FIRST_START_MS;
  }

  async function present(): Promise<string | null> {
    if (!installPredatesThisBuild()) return null;
    try {
      return (await folder?.find()) ?? null;
    } catch (error) {
      log?.warn("modelRuntimeFolder.lookFailed", {
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  return {
    present,
    async show(): Promise<void> {
      const path = await present();
      if (path === null) return;
      if (!shell) throw new Error("This copy of IncarnaMind can't show files.");
      shell.showItemInFolder(path);
    },
  };
}
