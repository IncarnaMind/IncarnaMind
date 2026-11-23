import { delimiter, join } from "node:path";

/**
 * The folders this computer installs apps in, to tell which agents are installed (#3644): the
 * Applications folders on macOS; on Windows the per-User and the system-wide program folders; on
 * Linux the folders of launchers (`.desktop` files) that packages, Flatpak and Snap install.
 */
export function appFolders(
  platform: NodeJS.Platform,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  if (platform === "darwin") return ["/Applications", join(home, "Applications")];
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || join(home, "AppData", "Local");
    return [local, join(local, "Programs"), env.ProgramFiles, env["ProgramFiles(x86)"]].filter(
      (folder): folder is string => Boolean(folder),
    );
  }
  // https://specifications.freedesktop.org/basedir-spec/latest/: XDG_DATA_DIRS, else these two.
  const shared = (env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter(Boolean);
  const own = env.XDG_DATA_HOME || join(home, ".local", "share");
  return [
    own,
    ...shared,
    join(own, "flatpak", "exports", "share"),
    "/var/lib/flatpak/exports/share",
    "/var/lib/snapd/desktop",
  ].map((folder) => join(folder, "applications"));
}

/** The folders on `env`'s PATH. */
export function pathFolders(env: Readonly<Record<string, string | undefined>>): string[] {
  const path = Object.entries(env).find(([name]) => name.toUpperCase() === "PATH")?.[1] ?? "";
  return path.split(delimiter).filter(Boolean);
}
