/**
 * The app's own links' scheme (#3534, ADR-0033) is one name: the one the app reads, the one the
 * installers register, and the one the Windows uninstaller takes out again.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_LINK_SCHEME } from "../../src/shared/appLinks";
import { REPO_ROOT } from "../helpers/skills";

describe("the app's own links' scheme", () => {
  // protects=the scheme macOS and Linux register, and Windows' uninstaller removes, is the one the app reads its links in (#3534); fails_when=a rename in one place leaves links the system hands over unread, or a registration left behind on Windows
  it("is the same name where the app reads it, registers it and takes it out", async () => {
    const builder = await readFile(join(REPO_ROOT, "electron-builder.yml"), "utf8");
    const protocols = /^protocols:\n((?:[ -].*\n)+)/m.exec(builder)?.[1] ?? "";
    expect([...protocols.matchAll(/^\s+- (\S+)$/gm)].map((match) => match[1])).toEqual([
      APP_LINK_SCHEME,
    ]);
    const uninstall = await readFile(join(REPO_ROOT, "build", "installer.nsh"), "utf8");
    expect(uninstall).toContain(`DeleteRegKey HKCU "Software\\Classes\\${APP_LINK_SCHEME}"`);
  });
});
