import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { appFolders, pathFolders } from "../../src/main/agentPlaces";

describe("where this computer installs agents (#3644)", () => {
  // protects=each system's apps are looked for where its installers put them: the Applications folders, Windows' per-User and system-wide program folders, Linux's launchers from packages, Flatpak and Snap; fails_when=a system's usual install folder is left out, so an app installed there is never found
  it("names each system's folders of apps", () => {
    const home = join("/", "home", "ada");
    expect(appFolders("darwin", home, {})).toEqual(["/Applications", join(home, "Applications")]);
    const local = join("C:", "Users", "ada", "AppData", "Local");
    expect(
      appFolders("win32", home, {
        LOCALAPPDATA: local,
        ProgramFiles: "C:\\Program Files",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
      }),
    ).toEqual([local, join(local, "Programs"), "C:\\Program Files", "C:\\Program Files (x86)"]);
    expect(appFolders("linux", home, {})).toEqual(
      [
        join(home, ".local", "share"),
        "/usr/local/share",
        "/usr/share",
        join(home, ".local", "share", "flatpak", "exports", "share"),
        "/var/lib/flatpak/exports/share",
        "/var/lib/snapd/desktop",
      ].map((folder) => join(folder, "applications")),
    );
    expect(appFolders("linux", home, { XDG_DATA_DIRS: "/opt/share" })).toContain(
      join("/opt/share", "applications"),
    );
  });

  // protects=commands are looked for on the PATH as a terminal has it, whatever case Windows gives its name; fails_when=Windows' Path is not read, so no command is found there
  it("reads the PATH, as Windows spells it too", () => {
    expect(pathFolders({ PATH: ["/usr/bin", "", "/opt/bin"].join(delimiter) })).toEqual([
      "/usr/bin",
      "/opt/bin",
    ]);
    expect(pathFolders({ Path: "/usr/bin" })).toEqual(["/usr/bin"]);
    expect(pathFolders({})).toEqual([]);
  });
});
