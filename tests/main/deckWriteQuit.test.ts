import { access, chmod, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import { hashBytes } from "../../src/core/documents/files";
import { createTempDataFolder, startCore } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  linkWithoutFolderAndProcess,
} from "../helpers/documents";
import { refuseWrites } from "../helpers/failingStorage";
import { note } from "../helpers/minds";
import { plainDeck } from "../helpers/pptx";

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return { app: Object.assign(new EventEmitter(), { getPath: () => "" }) };
});

/** The questions asked, and the answers given in turn by button; Keep open, the default, once none is left. */
const dialogs = vi.hoisted(() => ({
  asked: [] as { message: string; detail: string; buttons: string[] }[],
  answers: [] as string[],
  savedTo: null as string | null,
}));
vi.mock("../../src/main/systemDialogs", () => ({
  showMessageBox: async (
    _window: unknown,
    options: { message: string; detail?: string; buttons: string[]; cancelId: number },
  ) => {
    dialogs.asked.push({
      message: options.message,
      detail: options.detail ?? "",
      buttons: options.buttons,
    });
    const answer = dialogs.answers.shift();
    const at = answer === undefined ? -1 : options.buttons.indexOf(answer);
    return { response: at >= 0 ? at : options.cancelId };
  },
  showSaveDialog: async () =>
    dialogs.savedTo ? { canceled: false, filePath: dialogs.savedTo } : { canceled: true },
}));

let core: Core | null = null;
const restores: (() => void)[] = [];
afterEach(async () => {
  const { app } = await import("electron");
  app.removeAllListeners("before-quit");
  for (const restore of restores.splice(0)) restore();
  dialogs.asked.length = 0;
  dialogs.answers = [];
  dialogs.savedTo = null;
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

/**
 * A deck "Plan.pptx" whose hand edit waits (the file is read-only), the quit guarded, and with
 * `note` a Note whose change storage refuses too, as a full disk does both at once.
 */
async function waiting(options: { note: boolean }) {
  const { guardQuit } = await import("../../src/main/unsavedChanges");
  const dataDir = await createTempDataFolder();
  const folder = await createSourceFolder();
  const path = join(folder, "Plan.pptx");
  await writeFile(path, new Uint8Array(plainDeck([{ title: "One" }])));
  const started = startCore(dataDir);
  core = started;
  const [document] = await addAndProcess(started, [path]);
  if (!document) throw new Error("not added");
  if (options.note) {
    const mind = await started.createMind({ title: "Plan notes" });
    restores.push(refuseWrites(dataDir));
    await started.addToNote({
      mindId: mind.id,
      blocks: [note("Ask Ana")],
      origin: null,
      model: null,
    });
  }
  await chmod(path, 0o444);
  const edit = await started.editDeck({
    documentId: document.id,
    sittingId: null,
    shown: document.contentHash,
    edits: [{ kind: "box", slide: 1, shape: "2", box: { x: 200, y: 96, w: 192, h: 96 } }],
  });
  expect(edit.kind).toBe("unwritable");
  const quit = vi.fn();
  guardQuit(started, () => null, quit);
  return { core: started, dataDir, folder, quit };
}

/** Asks to quit, and waits until the question has been answered `answers.length` times or more. */
async function quitAnswering(answers: string[], asked = answers.length, timeout = 1000) {
  const { app } = await import("electron");
  dialogs.answers = [...answers];
  const event = { defaultPrevented: false, preventDefault: () => (event.defaultPrevented = true) };
  app.emit("before-quit", event);
  expect(event.defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(dialogs.asked.length).toBeGreaterThanOrEqual(asked), { timeout });
  // What the answer does next (a copy, a quit) settles before the test looks.
  await new Promise((done) => setTimeout(done, 200));
}

describe("Quitting with a hand edit of a deck that waits to be saved", () => {
  // protects=a deck's change that waits isn't dropped at quit without a word, and the question says why in one sentence (#149); fails_when=the quit goes on unasked, or the words send the User off to do it by hand; no_claim=the system dialog's look.
  test("asks, saying why it isn't saved, and Keep open keeps it", async () => {
    const { core, quit } = await waiting({ note: false });
    await quitAnswering([]);
    expect(dialogs.asked).toEqual([
      {
        message: "1 change to a deck isn’t saved",
        detail: "“Plan.pptx” is read-only.",
        buttons: ["Save a copy beside it", "Quit anyway", "Keep open"],
      },
    ]);
    expect(quit).not.toHaveBeenCalled();
    expect(core.deckChangesWaiting()).toHaveLength(1);
  });

  // protects=Save a copy in the quit question saves the deck's change as its own line does, and then quits (#149); fails_when=the change is still waiting, or the app stays open with nothing left; no_claim=the copy's name.
  test("Save a copy beside it saves the change beside the file, then quits", async () => {
    const { core, folder, quit } = await waiting({ note: false });
    await quitAnswering(["Save a copy beside it"]);
    expect(dialogs.asked).toHaveLength(1);
    expect(quit).toHaveBeenCalledOnce();
    expect(core.deckChangesWaiting()).toHaveLength(0);
    expect((await readdir(folder)).filter((name) => name.endsWith(".pptx")).sort()).toEqual([
      "Plan 2.pptx",
      "Plan.pptx",
    ]);
  });

  // protects=a copy that never finishes (a stalled share) doesn't hold the quit with nothing on screen (#149 review); fails_when=the quit waits on it for ever; no_claim=the copy, which may still land later.
  test("a copy that doesn't finish within 10 seconds is said as failed, and the app stays open", async () => {
    const { core, quit } = await waiting({ note: false });
    vi.spyOn(core, "saveDeckCopyUnasked").mockReturnValue(new Promise(() => undefined));
    await quitAnswering(["Save a copy beside it"], 2, 15_000);
    expect(dialogs.asked[1]?.detail).toBe(
      "The copy of “Plan.pptx” couldn’t be saved. Its folder didn’t answer within 10 seconds.",
    );
    expect(quit).not.toHaveBeenCalled();
  }, 30_000);

  // protects=Quit anyway quits, as the User chose (#149); fails_when=the app stays open; no_claim=none.
  test("Quit anyway quits", async () => {
    const { quit } = await waiting({ note: false });
    await quitAnswering(["Quit anyway"]);
    expect(quit).toHaveBeenCalledOnce();
  });

  // protects=a copy the disk refuses is said in plain words and the app stays open (#149 review); fails_when=it quits with the change still waiting; no_claim=the system's own words, under Details.
  test("a copy that can't be saved says so, and keeps the app open", async () => {
    const { core, dataDir, quit } = await waiting({ note: false });
    restores.push(refuseWrites(dataDir, { tables: ["documents"] }));
    await quitAnswering(["Save a copy beside it"], 2);
    expect(dialogs.asked[1]?.message).toBe("1 change to a deck isn’t saved");
    expect(dialogs.asked[1]?.detail).toBe(
      "The copy of “Plan.pptx” couldn’t be saved. The disk is full.",
    );
    expect(quit).not.toHaveBeenCalled();
    expect(core.deckChangesWaiting()).toHaveLength(1);
  });
});

describe("Quitting with an unsaved Note and a deck's change that waits", () => {
  // protects=one question covers both, and Save a copy saves each in turn, then quits (#149 review); fails_when=the Note's copy is saved and the app quits with the deck's change still waiting; no_claim=the Note's .docx contents.
  test("Save a copy… saves the Note's copy and the deck's, then quits with nothing waiting", async () => {
    const { core, folder, quit } = await waiting({ note: true });
    dialogs.savedTo = join(folder, "Plan notes.docx");
    await quitAnswering(["Save a copy…"]);
    expect(dialogs.asked).toEqual([
      {
        message: "2 changes aren’t saved",
        detail: "“Plan.pptx” is read-only.",
        buttons: ["Save a copy…", "Quit anyway", "Keep open"],
      },
    ]);
    await access(join(folder, "Plan notes.docx"));
    expect(core.deckChangesWaiting()).toHaveLength(0);
    expect(quit).toHaveBeenCalledOnce();
  });

  // protects=a cancelled save panel keeps the app open, the deck's change still waiting (#149 review); fails_when=it quits; no_claim=none.
  test("a cancelled save panel keeps the app open, and the deck's change still waits", async () => {
    const { core, quit } = await waiting({ note: true });
    await quitAnswering(["Save a copy…"]);
    expect(quit).not.toHaveBeenCalled();
    expect(core.deckChangesWaiting()).toHaveLength(1);
  });

  // protects=Quit anyway and Keep open do as they say with both waiting (#149 review); fails_when=either does the other; no_claim=none.
  test("Quit anyway quits, and Keep open keeps both", async () => {
    const both = await waiting({ note: true });
    await quitAnswering(["Keep open"]);
    expect(both.quit).not.toHaveBeenCalled();
    dialogs.asked.length = 0;
    await quitAnswering(["Quit anyway"]);
    expect(both.quit).toHaveBeenCalledOnce();
  });
});

describe("Quitting where a deck's copy can't go beside it", () => {
  // protects=each deck's copy is tried on its own, and the one that fails is named (#149 review); fails_when=the first failure stops the others, so a deck whose copy would save never can; no_claim=the system's own words, under Details.
  test("with two decks waiting and one copy failing, the other is saved and the failed one is named", async () => {
    const { guardQuit } = await import("../../src/main/unsavedChanges");
    const dataDir = await createTempDataFolder();
    const good = await createSourceFolder();
    const shut = await createSourceFolder();
    const nowhere = await createSourceFolder();
    await writeFile(join(good, "Plan.pptx"), new Uint8Array(plainDeck([{ title: "One" }])));
    await writeFile(join(shut, "Budget.pptx"), new Uint8Array(plainDeck([{ title: "Two" }])));
    const started = startCore(dataDir);
    core = started;
    // The deck whose copy fails is first: the one after it is still saved.
    const documents = await addAndProcess(started, [
      join(shut, "Budget.pptx"),
      join(good, "Plan.pptx"),
    ]);
    // The budget's folder takes nothing, and nor does the Output location its copy then goes to.
    await started.setOutputLocation(nowhere);
    await chmod(join(good, "Plan.pptx"), 0o444);
    await chmod(shut, 0o555);
    await chmod(nowhere, 0o555);
    restores.push(() => {
      void chmod(shut, 0o755);
      void chmod(nowhere, 0o755);
    });
    for (const document of documents) {
      const edit = await started.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: document.contentHash,
        edits: [{ kind: "box", slide: 1, shape: "2", box: { x: 200, y: 96, w: 192, h: 96 } }],
      });
      expect(edit.kind).toBe("unwritable");
    }
    const quit = vi.fn();
    guardQuit(started, () => null, quit);
    await quitAnswering(["Save a copy beside it"], 2);
    expect(dialogs.asked[1]?.detail).toContain("The copy of “Budget.pptx” couldn’t be saved.");
    expect(dialogs.asked[1]?.detail).not.toContain("Plan.pptx");
    expect((await readdir(good)).sort()).toEqual(["Plan 2.pptx", "Plan.pptx"]);
    expect(started.deckChangesWaiting().map((deck) => deck.name)).toEqual(["Budget.pptx"]);
    expect(quit).not.toHaveBeenCalled();
  });

  // protects=the quit never waits on a question no window can show (#149 review); fails_when=a copy into a Linked folder whose new-files question was never answered waits for it, and the quit hangs with nothing on screen; no_claim=the Output location's name.
  test("with no window open, a copy whose Linked folder was never asked goes to the Output location, said, and the app quits", async () => {
    const { guardQuit } = await import("../../src/main/unsavedChanges");
    const dataDir = await createTempDataFolder();
    const files = await createSourceFolder();
    const output = await createSourceFolder();
    await writeFile(join(files, "Plan.pptx"), new Uint8Array(plainDeck([{ title: "One" }])));
    const started = startCore(dataDir);
    core = started;
    const [document] = await linkWithoutFolderAndProcess(started, files);
    if (!document) throw new Error("not linked");
    await started.setOutputLocation(output);
    await chmod(join(files, "Plan.pptx"), 0o444);
    const edit = await started.editDeck({
      documentId: document.id,
      sittingId: null,
      shown: document.contentHash,
      edits: [{ kind: "box", slide: 1, shape: "2", box: { x: 200, y: 96, w: 192, h: 96 } }],
    });
    expect(edit.kind).toBe("unwritable");
    const quit = vi.fn();
    guardQuit(started, () => null, quit);
    await quitAnswering(["Save a copy beside it"], 2);
    expect(dialogs.asked[1]?.message).toBe(
      `The copy of “Plan.pptx” is in “${output.split(/[\\/]/).at(-1)}”.`,
    );
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    expect(await readdir(output)).toEqual(["Plan.pptx"]);
    expect(started.deckChangesWaiting()).toHaveLength(0);
  });
});
