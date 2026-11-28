/**
 * What either command-line AI reads as its own is looked for without reaching another computer
 * (#3653): on Windows, a home of its own on a share (a CODEX_HOME of `\\server\share`) isn't
 * looked at while a card is made, before the User answers.
 */

import * as fs from "node:fs";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentSteering } from "../../src/main/ownPlaces";

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return { ...real, lstatSync: vi.fn(real.lstatSync) };
});

const platform = process.platform;

afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform });
});

describe("a home of its own on another computer (#3653)", () => {
  // protects=a card for a file on this computer never looks at a Codex home on a share, on Windows; fails_when=making the card touches the share, which reaches that computer and may send it the User's Windows sign-in before they answer
  it("isn't looked at while a card is made", () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "own-places-")));
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      const steering = agentSteering({
        folders: [folder],
        home: folder,
        codexHome: "\\\\harbour-server\\share\\codex",
      });
      vi.mocked(fs.lstatSync).mockClear();
      expect(steering.mark(join(folder, "notes.md"), folder)).toEqual({});
      const looked = vi.mocked(fs.lstatSync).mock.calls.map(([path]) => String(path));
      expect(looked.length).toBeGreaterThan(0);
      expect(looked.filter((path) => /^[\\/]{2}/.test(path))).toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", { value: platform });
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
