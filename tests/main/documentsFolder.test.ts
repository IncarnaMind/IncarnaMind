import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { documentsFolder } from "../../src/main/documentsFolder";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { note, writeMind } from "../helpers/minds";

describe("The Documents folder", () => {
  test("keeps the system's redirected folder", async () => {
    const home = await createTempDataFolder();
    const redirected = join(home, "OneDrive", "Documents");
    const log = { warn: vi.fn() };
    expect(documentsFolder(() => redirected, home, log)).toBe(redirected);
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("uses Documents in the isolated home when getPath throws, and logs the failure", async () => {
    const home = await createTempDataFolder();
    const getPath = vi.fn(() => {
      throw new Error("Failed to get Documents path");
    });
    const log = { warn: vi.fn() };
    expect(documentsFolder(getPath, home, log)).toBe(join(home, "Documents"));
    expect(log.warn).toHaveBeenCalledWith("output.documentsUnavailable", {
      error: "Error: Failed to get Documents path",
      fallback: join(home, "Documents"),
    });
  });

  test.each([false, true])(
    "the first save uses the fallback, or asks for another folder when blocked=%s",
    async (blocked) => {
      const home = await createTempDataFolder();
      if (blocked) await writeFile(join(home, "Documents"), "Not a folder");
      const getPath = vi.fn(() => {
        throw new Error("Failed to get Documents path");
      });
      const core = startCore(await createTempDataFolder(), {
        paths: {
          home,
          get documents() {
            return documentsFolder(getPath, home, { warn: vi.fn() });
          },
        },
      });
      const mind = await core.createMind({ title: "Tides" });
      const client = await connectToMind(core, mind.id);
      writeMind(client, [note("Spring tides come twice a month.")]);
      await client.settled();
      expect(getPath).not.toHaveBeenCalled();
      const saving = core.saveMindExport(mind.id, { format: "markdown" });
      let folder = join(home, "Documents", "IncarnaMind");
      if (blocked) {
        await vi.waitFor(async () =>
          expect(await core.listFileWriteRequests()).toMatchObject([
            { kind: "output-location", problem: "missing", fileName: "Tides.md" },
          ]),
        );
        folder = await createTempDataFolder();
        await core.setOutputLocation(folder);
      }
      const saved = await saving;
      if (saved.status !== "saved") throw new Error("The export was not saved");
      expect(saved.file.path).toBe(join(await realpath(folder), "Tides.md"));
      expect(await readFile(saved.file.path, "utf8")).toContain("Spring tides come twice a month.");
      expect(await core.listFileWriteRequests()).toEqual([]);
    },
  );
});
