import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { createEventHub } from "../../src/core/events";
import { createOutputFiles } from "../../src/core/outputFiles";
import { createSettings } from "../../src/core/settings";
import { migrate, openDatabase } from "../../src/core/storage";
import { documentsFolder } from "../../src/main/documentsFolder";
import { createTempDataFolder } from "../helpers/core";

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
      const db = openDatabase(":memory:");
      onTestFinished(() => db.close());
      migrate(db);
      const now = () => "2026-10-26T00:00:00.000Z";
      const outputs = createOutputFiles({
        db,
        events: createEventHub(),
        now,
        settings: createSettings(db, now, () => ["en-US"], "none"),
        get suggested() {
          return join(documentsFolder(getPath, home, { warn: vi.fn() }), "IncarnaMind");
        },
        linkedFolders: () => [],
        recordOwnFile: () => undefined,
      });
      expect(getPath).not.toHaveBeenCalled();
      const saving = outputs.save({
        name: "Tides.md",
        data: new TextEncoder().encode("Tides"),
        ownFile: null,
      });
      let folder = join(home, "Documents", "IncarnaMind");
      if (blocked) {
        await vi.waitFor(() =>
          expect(outputs.requests()).toMatchObject([
            { kind: "output-location", problem: "missing", fileName: "Tides.md" },
          ]),
        );
        folder = await createTempDataFolder();
        await outputs.setLocation(folder);
      }
      const saved = await saving;
      expect(saved.path).toBe(join(await realpath(folder), "Tides.md"));
      expect(await readFile(saved.path, "utf8")).toBe("Tides");
      expect(outputs.requests()).toEqual([]);
    },
  );
});
