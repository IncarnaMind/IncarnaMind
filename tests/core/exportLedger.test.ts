import { existsSync } from "node:fs";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ExportFormat } from "../../src/core";
import { silentLogger } from "../../src/core/activityLog";
import { InvalidInputError } from "../../src/core/errors";
import { createEventHub } from "../../src/core/events";
import { createExportLedger } from "../../src/core/exports/ledger";
import { createOutputFiles } from "../../src/core/outputFiles";
import { createSettings } from "../../src/core/settings";
import { migrate, openDatabase } from "../../src/core/storage";
import { createSourceFolder, sha256 } from "../helpers/documents";

const bytes = (text: string) => new TextEncoder().encode(text);
const NOW = "2026-11-09T10:00:00.000Z";

/**
 * The ledger over the real file writer and a temporary folder. "note-1" is in Folder "folder-1";
 * any other Note is in none.
 */
async function ledgerIn() {
  const db = openDatabase(":memory:");
  migrate(db);
  const folder = await createSourceFolder();
  const ownFiles: { text: string; kind: string; folderId: string | null }[] = [];
  const outputs = createOutputFiles({
    db,
    events: createEventHub(),
    now: () => NOW,
    settings: createSettings(
      db,
      () => NOW,
      () => ["en-US"],
      "none",
    ),
    suggested: folder,
    linkedFolders: () => [],
    recordOwnFile: (data, kind, folderId) =>
      ownFiles.push({ text: new TextDecoder().decode(data), kind, folderId }),
    log: silentLogger,
  });
  const ledger = createExportLedger({
    outputs,
    folderOf: (mindId) => (mindId === "note-1" ? "folder-1" : null),
  });
  /** Saves an export as the core does, and tells the ledger. */
  const save = async (text: string, mindId = "note-1", format: ExportFormat = "docx") => {
    const data = bytes(text);
    const file = await outputs.save({
      name: "Tides.docx",
      data,
      ownFile: "export",
      fromFolder: null,
      folder,
      approved: true,
    });
    ledger.saved({ mindId, path: file.path, format }, data);
    return { path: file.path, known: () => ledger.known(file.path, mindId, format) };
  };
  const holds = async (path: string) => (await readFile(path)).toString("utf8");
  return { ledger, folder, save, holds, ownFiles };
}

const windowsOrRoot = process.platform === "win32" || process.getuid?.() === 0;

describe("An export written again (#110, #2927)", () => {
  // protects=a Change writes the same file while it holds what IncarnaMind wrote, and the next Change knows the new bytes; fails_when=the file is left and a copy made, or the second Change takes the first's bytes for the User's; no_claim=what the bytes are.
  test("a Change writes in place, and the next one too", async () => {
    const { ledger, save, holds } = await ledgerIn();
    const saved = await save("first");

    const changed = await ledger.rewrite(saved.known(), bytes("second"), null);
    expect(changed.file.path).toBe(saved.path);
    expect(changed.changedFile).toBeUndefined();
    expect(await holds(saved.path)).toBe("second");

    const again = await ledger.rewrite(saved.known(), bytes("third"), null);
    expect(again.changedFile).toBeUndefined();
    expect(await holds(saved.path)).toBe("third");
    expect(again.step).not.toBe(changed.step);
  });

  // protects=a file the User changed since is never written over: the bytes go in a copy beside it, which is this Note's export from then on; fails_when=the User's file is replaced, or the copy can't be written again in place; no_claim=the copy's name beyond the next free one.
  test("a file the User changed is left as it is, and the bytes go in a copy beside it", async () => {
    const { ledger, folder, save, holds } = await ledgerIn();
    const saved = await save("first");
    await writeFile(saved.path, "the User's own words");

    const changed = await ledger.rewrite(saved.known(), bytes("second"), null);

    expect(changed.changedFile).toBe("Tides.docx");
    expect(changed.file.path).toBe(join(folder, "Tides 2.docx"));
    expect(await holds(saved.path)).toBe("the User's own words");
    expect(await holds(changed.file.path)).toBe("second");

    const copy = ledger.known(changed.file.path, "note-1", "docx");
    expect(copy.wrote).toBe(sha256("second"));
    const onTheCopy = await ledger.rewrite(copy, bytes("third"), null);
    expect(onTheCopy.changedFile).toBeUndefined();
    expect(await holds(changed.file.path)).toBe("third");
    expect(await holds(saved.path)).toBe("the User's own words");
  });

  // protects=a file the User made read-only is left as it is too; fails_when=it is written over, or the Change fails with nothing saved; no_claim=Windows, where the mode means something else.
  test.skipIf(windowsOrRoot)(
    "a read-only file is left as it is, with a copy beside it",
    async () => {
      const { ledger, folder, save, holds } = await ledgerIn();
      const saved = await save("first");
      await chmod(saved.path, 0o444);

      const changed = await ledger.rewrite(saved.known(), bytes("second"), null);

      expect(changed.changedFile).toBe("Tides.docx");
      expect(changed.file.path).toBe(join(folder, "Tides 2.docx"));
      expect(await holds(saved.path)).toBe("first");
    },
  );

  // protects=a copy that can't be saved leaves the record as it was: the export is still the file IncarnaMind wrote, and no copy is known; fails_when=the record takes the bytes for written, or a copy that isn't there is known; no_claim=Windows, where the mode means something else.
  test.skipIf(windowsOrRoot)("a copy that can't be saved changes no record", async () => {
    const { ledger, folder, save, holds } = await ledgerIn();
    const saved = await save("first");
    await writeFile(saved.path, "the User's own words");
    await chmod(folder, 0o555);

    const refused = ledger
      .rewrite(saved.known(), bytes("second"), null)
      .finally(() => chmod(folder, 0o755));
    await expect(refused).rejects.toMatchObject({
      wording: { key: "error.export.rewrite.locked", values: { name: "Tides.docx" } },
    });

    expect(await holds(saved.path)).toBe("the User's own words");
    expect(saved.known().wrote).toBe(sha256("first"));
    expect(() => ledger.known(join(folder, "Tides 2.docx"), "note-1", "docx")).toThrow(
      InvalidInputError,
    );
  });

  // protects=a Change refused because its copy can't be saved keeps no Undo step, so the Change before it is still the file's newest and can be taken back; fails_when=the refused Change leaves a step above the first one's, so Undo of the first is refused as changed; no_claim=Windows and root, where the mode means something else.
  test.skipIf(windowsOrRoot)(
    "a Change refused for want of a copy keeps no Undo step, so the one before it can still be taken back",
    async () => {
      const { ledger, folder, save, holds } = await ledgerIn();
      const saved = await save("first");
      const one = await ledger.rewrite(saved.known(), bytes("second"), null);
      await chmod(saved.path, 0o444);
      await chmod(folder, 0o555);

      const refused = ledger
        .rewrite(saved.known(), bytes("third"), null)
        .finally(() => chmod(folder, 0o755));
      await expect(refused).rejects.toMatchObject({
        wording: { key: "error.export.rewrite.locked", values: { name: "Tides.docx" } },
      });
      expect(await holds(saved.path)).toBe("second");

      await chmod(saved.path, 0o644);
      expect(await ledger.restore(saved.path, one.step)).toEqual({
        mindId: "note-1",
        comments: null,
      });
      expect(await holds(saved.path)).toBe("first");
    },
  );

  // protects=a Change is only for the export this Note saved at that path in that format; fails_when=another Note's export, another format's, or a path IncarnaMind never saved is taken; no_claim=what the window then shows.
  test("only this Note's export, in this format, is known at a path", async () => {
    const { ledger, folder, save } = await ledgerIn();
    const saved = await save("first");

    expect(ledger.known(saved.path, "note-1", "docx")).toEqual({
      mindId: "note-1",
      path: saved.path,
      format: "docx",
      wrote: sha256("first"),
    });
    const refused = { wording: { key: "error.export.rewrite.notThisNote" } };
    for (const [path, mindId, format] of [
      [saved.path, "note-2", "docx"],
      [saved.path, "note-1", "pdf"],
      [saved.path, "note-1", undefined],
      [join(folder, "Other.docx"), "note-1", "docx"],
      [undefined, "note-1", "docx"],
    ] as const) {
      expect(() => ledger.known(path, mindId, format)).toThrow(InvalidInputError);
      expect(() => ledger.known(path, mindId, format)).toThrow(expect.objectContaining(refused));
    }
  });

  // protects=what a Change writes is recorded as IncarnaMind's own before it is written, by its kind and its Note's Folder, so checks leave it out and it stays behind the Folder's wall; fails_when=a source pack is recorded as an export, or the Folder is lost; no_claim=how the record is kept.
  test("what a Change writes is recorded as IncarnaMind's own, by kind and the Note's Folder", async () => {
    const { ledger, save, ownFiles } = await ledgerIn();
    const pack = await save("first", "note-1", "source-pack");
    await ledger.rewrite(pack.known(), bytes("second"), null);
    expect(ownFiles.at(-1)).toEqual({ text: "second", kind: "source-pack", folderId: "folder-1" });

    await writeFile(pack.path, "the User's own words");
    const beside = await ledger.rewrite(pack.known(), bytes("third"), null);
    expect(beside.changedFile).toBe("Tides.docx");
    expect(ownFiles.at(-1)).toEqual({ text: "third", kind: "source-pack", folderId: "folder-1" });

    const other = await ledgerIn();
    const word = await other.save("first", "note-2", "docx");
    await other.ledger.rewrite(word.known(), bytes("second"), null);
    expect(other.ownFiles.at(-1)).toEqual({ text: "second", kind: "export", folderId: null });
  });
});

describe("A Change of an export taken back (#110, #2927)", () => {
  // protects=Undo puts back the bytes the Change replaced and gives the Note, and the file can be changed in place again; a step undone is gone; fails_when=the file keeps the Change, the next Change makes a copy, or the same step undoes twice; no_claim=the comment choice, tested below.
  test("Undo puts back what the Change replaced, once", async () => {
    const { ledger, save, holds } = await ledgerIn();
    const saved = await save("first");
    const changed = await ledger.rewrite(saved.known(), bytes("second"), null);

    expect(await ledger.restore(saved.path, changed.step)).toEqual({
      mindId: "note-1",
      comments: null,
    });
    expect(await holds(saved.path)).toBe("first");

    await expect(ledger.restore(saved.path, changed.step)).rejects.toMatchObject({
      wording: { key: "error.export.restore.nothing", values: { name: "Tides.docx" } },
    });
    const again = await ledger.rewrite(saved.known(), bytes("third"), null);
    expect(again.changedFile).toBeUndefined();
    expect(await holds(saved.path)).toBe("third");
  });

  // protects=Undo gives back the Note's comment choice as it was before the Change, and none where the Change set none; fails_when=the choice is lost or another is given; no_claim=that the core sets it.
  test.each([
    ["on", true],
    ["off", false],
    ["not set by the Change", null],
  ])("Undo gives back the comment choice: %s", async (_name, comments) => {
    const { ledger, save } = await ledgerIn();
    const saved = await save("first");
    const changed = await ledger.rewrite(saved.known(), bytes("second"), comments);

    expect((await ledger.restore(saved.path, changed.step)).comments).toBe(comments);
  });

  // protects=only a file's newest Change can be taken back, so an older step never takes a later Change with it; fails_when=an older step writes its bytes over a later Change, or is lost by being refused; no_claim=how many steps a file keeps.
  test("only the newest Change of a file can be taken back, then the one before", async () => {
    const { ledger, save, holds } = await ledgerIn();
    const saved = await save("first");
    const one = await ledger.rewrite(saved.known(), bytes("second"), null);
    const two = await ledger.rewrite(saved.known(), bytes("third"), null);

    await expect(ledger.restore(saved.path, one.step)).rejects.toMatchObject({
      wording: { key: "error.export.restore.changed", values: { name: "Tides.docx" } },
    });
    expect(await holds(saved.path)).toBe("third");

    await ledger.restore(saved.path, two.step);
    expect(await holds(saved.path)).toBe("second");
    await ledger.restore(saved.path, one.step);
    expect(await holds(saved.path)).toBe("first");
  });

  // protects=Undo of a Change that wrote a copy removes the copy and leaves the User's file, and the copy is no export any more; fails_when=the copy stays, the User's file is touched, or the removed copy can still be changed; no_claim=the original, which no step of the copy names.
  test("Undo of a copy removes it and leaves the User's file", async () => {
    const { ledger, save, holds } = await ledgerIn();
    const saved = await save("first");
    await writeFile(saved.path, "the User's own words");
    const copy = await ledger.rewrite(saved.known(), bytes("second"), true);

    expect(await ledger.restore(copy.file.path, copy.step)).toEqual({
      mindId: "note-1",
      comments: true,
    });

    expect(existsSync(copy.file.path)).toBe(false);
    expect(await holds(saved.path)).toBe("the User's own words");
    expect(() => ledger.known(copy.file.path, "note-1", "docx")).toThrow(InvalidInputError);
  });

  // protects=Undo never writes over a file the User changed since the Change, and the step waits: with the Change's bytes back in the file, it undoes; fails_when=the User's words are replaced, or the refused step is lost; no_claim=what the window says.
  test("Undo leaves a file the User changed since, and its step waits", async () => {
    const { ledger, save, holds } = await ledgerIn();
    const saved = await save("first");
    const changed = await ledger.rewrite(saved.known(), bytes("second"), null);
    await writeFile(saved.path, "the User's own words");

    await expect(ledger.restore(saved.path, changed.step)).rejects.toMatchObject({
      wording: { key: "error.export.restore.changed", values: { name: "Tides.docx" } },
    });
    expect(await holds(saved.path)).toBe("the User's own words");

    await writeFile(saved.path, "second");
    await ledger.restore(saved.path, changed.step);
    expect(await holds(saved.path)).toBe("first");
  });

  // protects=a copy the User removed can't be taken away: Undo says so, and its step goes with it; fails_when=Undo reports success, or the step stays to be tried for ever; no_claim=the wording.
  test("Undo of a copy that is gone says so, and its step goes with it", async () => {
    const { ledger, save } = await ledgerIn();
    const saved = await save("first");
    await writeFile(saved.path, "the User's own words");
    const copy = await ledger.rewrite(saved.known(), bytes("second"), null);
    await rm(copy.file.path);

    await expect(ledger.restore(copy.file.path, copy.step)).rejects.toMatchObject({
      wording: { key: "error.export.restore.copyGone" },
    });
    await expect(ledger.restore(copy.file.path, copy.step)).rejects.toMatchObject({
      wording: { key: "error.export.restore.nothing", values: { name: "Tides 2.docx" } },
    });
    expect(() => ledger.known(copy.file.path, "note-1", "docx")).toThrow(InvalidInputError);
  });

  // protects=Undo of a file made read-only since writes nothing and says it is locked, and the step waits until it can be written; fails_when=the step is lost or the file replaced; no_claim=Windows, where the mode means something else.
  test.skipIf(windowsOrRoot)(
    "Undo of a read-only file says it is locked, and its step waits",
    async () => {
      const { ledger, save, holds } = await ledgerIn();
      const saved = await save("first");
      const changed = await ledger.rewrite(saved.known(), bytes("second"), null);
      await chmod(saved.path, 0o444);

      await expect(ledger.restore(saved.path, changed.step)).rejects.toMatchObject({
        wording: { key: "error.export.rewrite.locked", values: { name: "Tides.docx" } },
      });
      expect(await holds(saved.path)).toBe("second");

      await chmod(saved.path, 0o644);
      await ledger.restore(saved.path, changed.step);
      expect(await holds(saved.path)).toBe("first");
    },
  );

  // protects=Undo is refused for a path or a step the ledger doesn't know, naming the file where there is one; fails_when=it writes or removes anything, or throws something the window can't word; no_claim=the wording.
  test("Undo of a path or a step it doesn't know is refused", async () => {
    const { ledger, folder, save, holds } = await ledgerIn();
    const saved = await save("first");
    await ledger.rewrite(saved.known(), bytes("second"), null);

    for (const [path, step, name] of [
      [saved.path, "", "Tides.docx"],
      [saved.path, "no-such-step", "Tides.docx"],
      [saved.path, undefined, "Tides.docx"],
      [join(folder, "Other.docx"), "no-such-step", "Other.docx"],
      [undefined, undefined, ""],
    ] as const) {
      const refused = ledger.restore(path, step);
      await expect(refused).rejects.toBeInstanceOf(InvalidInputError);
      await expect(refused).rejects.toMatchObject({
        wording: { key: "error.export.restore.nothing", values: { name } },
      });
    }
    expect(await holds(saved.path)).toBe("second");
  });
});

describe("One Change or Undo of an export at a time (#110, #2927)", () => {
  // protects=two Changes of one file run one after another, in the order asked, while another file's goes on meanwhile; fails_when=the second starts before the first ends, or one file's turn holds up another's; no_claim=how long a turn takes.
  test("a file's turns run one after another, and another file's doesn't wait", async () => {
    const { ledger } = await ledgerIn();
    const order: string[] = [];
    let endFirst = () => {};
    const first = ledger.inTurn("/out/Tides.docx", async () => {
      order.push("first starts");
      await new Promise<void>((resolve) => {
        endFirst = resolve;
      });
      order.push("first ends");
      return "first";
    });
    const second = ledger.inTurn("/out/Tides.docx", async () => {
      order.push("second");
      return "second";
    });

    expect(await ledger.inTurn("/out/Other.docx", async () => order.push("another file"))).toBe(2);
    expect(order).toEqual(["first starts", "another file"]);

    endFirst();
    expect(await Promise.all([first, second])).toEqual(["first", "second"]);
    expect(order).toEqual(["first starts", "another file", "first ends", "second"]);
  });

  // protects=a turn that fails tells its own caller and lets the next one run; fails_when=a failed Change blocks every later Change of that file, or its failure is lost; no_claim=what failed.
  test("a turn that fails tells its caller, and the next one still runs", async () => {
    const { ledger } = await ledgerIn();
    const failed = ledger.inTurn("/out/Tides.docx", async () => {
      throw new Error("The disk is full.");
    });
    const next = ledger.inTurn("/out/Tides.docx", async () => "ran");

    await expect(failed).rejects.toThrow("The disk is full.");
    expect(await next).toBe("ran");
  });
});
