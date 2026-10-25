import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createTempDataFolder, startCore } from "../helpers/core";
import { fakePrinter } from "../helpers/printer";

/*
 * If one file of the check record can't be written, the line says which and why, and the other
 * file is kept (#971). The PDF failing is in checkRecord.test.ts; here the CSV does, which a
 * stand-in for the file writer makes happen after the PDF is saved.
 */

const disk = vi.hoisted(() => ({ full: false }));

vi.mock("../../src/core/fileNames", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/fileNames")>();
  return {
    ...actual,
    writeNewFile: (folder: string, name: string, data: Uint8Array) => {
      if (disk.full && name.endsWith(".csv")) {
        throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
          code: "ENOSPC",
        });
      }
      return actual.writeNewFile(folder, name, data);
    },
  };
});

describe("A check record whose CSV can't be written", () => {
  test("keeps the PDF and says the CSV wasn't saved, and why", async () => {
    const out = await createTempDataFolder();
    const core = startCore(await createTempDataFolder(), { printer: fakePrinter().printer });
    await core.setOutputLocation(out);
    const mind = await core.createMind({ title: "Harbour notes" });
    disk.full = true;

    const saved = await core.saveCheckRecord(mind.id);

    disk.full = false;
    expect(saved).toMatchObject({
      status: "saved",
      file: { name: "Check record – Harbour notes.pdf" },
      withCsv: false,
      failures: [{ format: "csv", message: "ENOSPC: no space left on device, write" }],
    });
    expect(readdirSync(out)).toEqual(["Check record – Harbour notes.pdf"]);
    expect(existsSync(join(out, "Check record – Harbour notes.csv"))).toBe(false);
  });
});
