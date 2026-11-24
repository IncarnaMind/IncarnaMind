import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import { hashBytes } from "../../src/core/documents/files";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder } from "../helpers/documents";
import { plainDeck } from "../helpers/pptx";

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return { app: Object.assign(new EventEmitter(), { getPath: () => "" }) };
});

let core: Core | null = null;
afterEach(() => {
  core?.close();
  core = null;
});

// protects=a hand edit of a deck the User made just before quitting is written whole, not lost half way (#149); fails_when=the quit goes on while the write is in progress; no_claim=a crash, which the write's temporary file covers.
test("quitting while a hand edit of a deck is being written waits until it is written", async () => {
  const { app } = await import("electron");
  const { guardQuit } = await import("../../src/main/unsavedChanges");
  const dataDir = await createTempDataFolder();
  const path = join(await createSourceFolder(), "Plan.pptx");
  await writeFile(path, new Uint8Array(plainDeck([{ title: "One" }])));
  core = startCore(dataDir);
  const [document] = await addAndProcess(core, [path]);
  if (!document) throw new Error("not added");
  const { readFile } = await import("node:fs/promises");
  let onDiskAtQuit = "";
  const quit = vi.fn(async () => {
    onDiskAtQuit = hashBytes(new Uint8Array(await readFile(path)));
  });
  guardQuit(core, () => null, quit);
  const editing = core.editDeck({
    documentId: document.id,
    sittingId: null,
    shown: document.contentHash,
    edits: [{ kind: "box", slide: 1, shape: "2", box: { x: 200, y: 96, w: 192, h: 96 } }],
  });
  const event = { defaultPrevented: false, preventDefault: () => (event.defaultPrevented = true) };
  app.emit("before-quit", event);
  expect(event.defaultPrevented).toBe(true);
  const edit = await editing;
  if (edit.kind !== "saved") throw new Error("not saved");
  await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(onDiskAtQuit).toBe(edit.contentHash));
});
