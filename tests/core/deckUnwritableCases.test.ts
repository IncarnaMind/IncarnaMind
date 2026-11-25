/**
 * Every case where a User's own deck file can't be written (#149 part 3):
 * read-only, locked (lock file & Windows sharing violation), no folder access,
 * cloud placeholder (macOS dataless, macOS .icloud stub, Windows Files On-Demand),
 * disk full, deleted/moved while open, and copy-beside failing too.
 *
 * Every failure is injected through the `DeckFiles` adapter — no `chmod` anywhere.
 */
import { readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Core, DeckFiles } from "../../src/core";
import type { DeckEdit, DeckUnwritable } from "../../src/core/api";
import {
  createNodeDeckFiles,
  isWindowsCloudAttributes,
  WIN32_CLOUD_ATTRIBUTES,
} from "../../src/core/decks/places";
import { hashBytes } from "../../src/core/documents/files";
import { openPackage } from "../../src/core/documents/formats/zip";
import { markReplaceStage } from "../../src/core/fileNames";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, waitForProcessing } from "../helpers/documents";
import { pptxOf, sp, xfrm } from "../helpers/pptx";

const ROOT_RELS = {
  name: "_rels/.rels",
  data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
};

const makeDeck = (xPx = 576) =>
  new Uint8Array(
    pptxOf({
      slides: [
        { shapes: sp({ id: 4, name: "Box", spPr: xfrm(xPx * 9525, 914400, 1828800, 914400) }) },
      ],
      parts: [ROOT_RELS],
    }),
  );

const moveBox = (x: number, y = 96) => [
  { kind: "box" as const, slide: 1, shape: "4", box: { x, y, w: 192, h: 96 } },
];

const offsetOf = async (bytes: Uint8Array) =>
  /<a:off x="(\d+)" y="(\d+)"/
    .exec((await openPackage(bytes).readText("ppt/slides/slide1.xml")) ?? "")
    ?.slice(1);

const errno = (code: string, message = code): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: ${message}`), { code });

const hashOn = async (path: string) => hashBytes(new Uint8Array(await readFile(path)));

const asSaved = (edit: DeckEdit) => {
  if (edit.kind !== "saved") throw new Error(`Expected saved, got unwritable (${edit.why})`);
  return edit;
};

const asUnwritable = (edit: DeckEdit): DeckUnwritable => {
  if (edit.kind !== "unwritable") throw new Error("Expected unwritable, got saved");
  return edit;
};

let core: Core | null = null;
afterEach(() => {
  core?.close();
  core = null;
});

async function setup(
  overrides: {
    deckFiles?: Partial<DeckFiles>;
    detectDatalessFiles?: boolean;
    platform?: NodeJS.Platform;
  } = {},
) {
  const dataDir = await createTempDataFolder();
  const files = await createSourceFolder();
  const path = join(files, "Plan.pptx");
  const original = makeDeck();
  await writeFile(path, original);
  core = startCore(dataDir, {
    ...(overrides.deckFiles && { deckFiles: overrides.deckFiles }),
    ...(overrides.platform && { platform: overrides.platform }),
    ...(overrides.detectDatalessFiles !== undefined && {
      linkedFolders: { detectDatalessFiles: overrides.detectDatalessFiles },
    }),
  });
  const [document] = await addAndProcess(core, [path]);
  if (!document) throw new Error("Document was not added.");
  return { core, dataDir, files, path, original, document };
}

describe("Unwritable deck file cases via DeckFiles adapter (#149 part 3)", () => {
  it.each(["EACCES", "EPERM", "EROFS"] as const)(
    "read-only (%s): keeps edit waiting, original untouched, saves copy beside and edits on in copy",
    async (code) => {
      const node = createNodeDeckFiles({ detectDataless: false });
      const { core, files, path, original, document } = await setup({
        deckFiles: {
          access: async (target, mode) => {
            if (mode === "write" && target === path) throw errno(code, "read-only");
            return node.access(target, mode);
          },
        },
      });

      const waiting = asUnwritable(
        await core.editDeck({
          documentId: document.id,
          sittingId: null,
          shown: document.contentHash,
          edits: moveBox(200),
        }),
      );
      expect(waiting).toMatchObject({ why: "read-only", name: "Plan.pptx" });
      expect(await hashOn(path)).toBe(hashBytes(original));

      // Saving a copy beside creates Plan 2.pptx with the waiting edit.
      const copy = asSaved(await core.saveDeckCopy(waiting.sittingId));
      expect(copy.saved).toMatchObject({ kind: "copy", name: "Plan 2.pptx", beside: true });
      const copyPath = join(files, "Plan 2.pptx");
      expect(await offsetOf(new Uint8Array(await readFile(copyPath)))).toEqual([
        String(200 * 9525),
        String(96 * 9525),
      ]);

      // Continuing to edit in the copy writes to Plan 2.pptx and keeps original byte-identical.
      const next = asSaved(
        await core.editDeck({
          documentId: copy.documentId,
          sittingId: copy.sittingId,
          shown: copy.contentHash,
          edits: moveBox(240, 140),
        }),
      );
      expect(next.documentId).toBe(copy.documentId);
      expect(await offsetOf(new Uint8Array(await readFile(copyPath)))).toEqual([
        String(240 * 9525),
        String(140 * 9525),
      ]);
      expect(await hashOn(path)).toBe(hashBytes(original));
    },
  );

  it.each(["EBUSY", "EPERM", "EACCES"] as const)(
    "Windows sharing violation (%s on rename): reports locked, preserves edit, and writes on Try again once unlocked",
    async (code) => {
      const node = createNodeDeckFiles({ detectDataless: false });
      let locked = true;
      const { core, path, original, document } = await setup({
        deckFiles: {
          replaceFile: async (target, data, stillSo, mode) => {
            if (locked && target === path) {
              throw markReplaceStage(errno(code, "sharing violation"), "rename");
            }
            return node.replaceFile(target, data, stillSo, mode);
          },
        },
      });

      const waiting = asUnwritable(
        await core.editDeck({
          documentId: document.id,
          sittingId: null,
          shown: document.contentHash,
          edits: moveBox(210),
        }),
      );
      expect(waiting).toMatchObject({ why: "locked", name: "Plan.pptx" });
      expect(waiting.lock).toBeUndefined();
      expect(await hashOn(path)).toBe(hashBytes(original));

      locked = false;
      const retried = asSaved(await core.retryDeckEdit(waiting.sittingId));
      expect(await offsetOf(new Uint8Array(await readFile(path)))).toEqual([
        String(210 * 9525),
        String(96 * 9525),
      ]);
      expect(await hashOn(path)).toBe(hashBytes(retried.bytes));
    },
  );

  it("exclusive lock on read during holds() keeps edit waiting as locked instead of dropping it as changed", async () => {
    const node = createNodeDeckFiles({ detectDataless: false });
    let blockHash = true;
    const { core, path, document } = await setup({
      deckFiles: {
        hashFile: async (target) => {
          if (blockHash && target === path) throw errno("EBUSY", "locked for reading");
          return node.hashFile(target);
        },
      },
    });

    const waiting = asUnwritable(
      await core.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: document.contentHash,
        edits: moveBox(215),
      }),
    );
    expect(waiting).toMatchObject({ why: "locked", name: "Plan.pptx" });
    blockHash = false;
    const done = asSaved(await core.retryDeckEdit(waiting.sittingId));
    expect(await offsetOf(done.bytes)).toEqual([String(215 * 9525), String(96 * 9525)]);
  });

  it("read permission denied (EACCES on hashFile): unreadable on POSIX, locked on Windows", async () => {
    for (const [platform, expectedWhy] of [
      ["darwin", "unreadable"],
      ["win32", "locked"],
    ] as const) {
      const spy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      try {
        const node = createNodeDeckFiles({ detectDataless: false });
        const {
          core: c,
          path,
          document,
        } = await setup({
          deckFiles: {
            hashFile: async (target) => {
              if (target === path) throw errno("EACCES", "permission denied reading");
              return node.hashFile(target);
            },
          },
        });
        const waiting = asUnwritable(
          await c.editDeck({
            documentId: document.id,
            sittingId: null,
            shown: document.contentHash,
            edits: moveBox(218),
          }),
        );
        expect(waiting).toMatchObject({ why: expectedWhy, name: "Plan.pptx" });
        c.close();
        core = null;
      } finally {
        spy.mockRestore();
      }
    }
  });

  it("LibreOffice lock file (.~lock.Plan.pptx#) reports locked and names the lock file", async () => {
    const node = createNodeDeckFiles({ detectDataless: false });
    const { core, files, document } = await setup({
      deckFiles: {
        access: async (target, mode) => {
          if (mode === "exists" && target === join(files, ".~lock.Plan.pptx#")) return;
          return node.access(target, mode);
        },
      },
    });

    const waiting = asUnwritable(
      await core.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: document.contentHash,
        edits: moveBox(220),
      }),
    );
    expect(waiting).toMatchObject({ why: "locked", name: "Plan.pptx", lock: ".~lock.Plan.pptx#" });
  });

  it("no access to its folder (access or temp-file stage): names folder and saves copy in Output location", async () => {
    const node = createNodeDeckFiles({ detectDataless: false });
    const { core, files, path, original, document } = await setup({
      deckFiles: {
        access: async (target, mode) => {
          if (mode === "write" && target === dirname(path)) throw errno("EACCES", "folder denied");
          return node.access(target, mode);
        },
        saveCopy: async (file, save) => {
          if (file.folder === dirname(path)) throw errno("EACCES", "folder denied");
          return save();
        },
      },
    });

    const waiting = asUnwritable(
      await core.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: document.contentHash,
        edits: moveBox(230),
      }),
    );
    expect(waiting).toMatchObject({ why: "folder", name: "Plan.pptx", folder: basename(files) });

    const copy = asSaved(await core.saveDeckCopy(waiting.sittingId));
    if (copy.saved.kind !== "copy") throw new Error("Expected copy");
    expect(copy.saved.beside).toBe(false);
    expect(copy.saved.path.startsWith(files)).toBe(false);
    expect(await offsetOf(new Uint8Array(await readFile(copy.saved.path)))).toEqual([
      String(230 * 9525),
      String(96 * 9525),
    ]);
    expect(await hashOn(path)).toBe(hashBytes(original));
  });

  it("temp-file creation refusal inside replaceFile reports folder rather than locked", async () => {
    const { core, files, document } = await setup({
      deckFiles: {
        replaceFile: async () => {
          throw markReplaceStage(errno("EACCES", "cannot create temp"), "temp");
        },
      },
    });

    const waiting = asUnwritable(
      await core.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: document.contentHash,
        edits: moveBox(235),
      }),
    );
    expect(waiting).toMatchObject({ why: "folder", folder: basename(files) });
  });

  it("macOS dataless cloud placeholder: reports cloud, never reads or hydrates file, keeps edit for copy", async () => {
    const node = createNodeDeckFiles({ detectDataless: true });
    const readSpy = vi.fn(node.readFile);
    const hashSpy = vi.fn(node.hashFile);
    const { core, files, path, original, document } = await setup({
      detectDatalessFiles: true,
      deckFiles: {
        stat: async (target) =>
          target === path
            ? { mode: 0o644, size: original.byteLength, blocks: 0 }
            : node.stat(target),
        readFile: readSpy,
        hashFile: hashSpy,
      },
    });
    readSpy.mockClear();
    hashSpy.mockClear();

    const waiting = asUnwritable(
      await core.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: document.contentHash,
        shownBytes: original,
        edits: moveBox(250),
      }),
    );
    expect(waiting).toMatchObject({ why: "cloud", name: "Plan.pptx" });
    expect(readSpy).not.toHaveBeenCalled();
    expect(hashSpy).not.toHaveBeenCalled();

    const copy = asSaved(await core.saveDeckCopy(waiting.sittingId));
    expect(copy.saved).toMatchObject({ kind: "copy", name: "Plan 2.pptx", beside: true });
    expect(await offsetOf(new Uint8Array(await readFile(join(files, "Plan 2.pptx"))))).toEqual([
      String(250 * 9525),
      String(96 * 9525),
    ]);
  });

  it("macOS .icloud stub: reports cloud (not gone) when file is absent and .Plan.pptx.icloud exists", async () => {
    const node = createNodeDeckFiles({ detectDataless: true });
    const { core, files, path, original, document } = await setup({
      detectDatalessFiles: true,
      deckFiles: {
        stat: async (target) => {
          if (target === path) throw errno("ENOENT", "evicted to icloud stub");
          return node.stat(target);
        },
        isCloudPlaceholder: async (target, info) => {
          if (target === path && info === null) return true;
          return node.isCloudPlaceholder(target, info);
        },
      },
    });

    const waiting = asUnwritable(
      await core.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: document.contentHash,
        shownBytes: original,
        edits: moveBox(260),
      }),
    );
    expect(waiting).toMatchObject({ why: "cloud", name: "Plan.pptx" });

    const copy = asSaved(await core.saveDeckCopy(waiting.sittingId));
    if (copy.saved.kind !== "copy") throw new Error("Expected copy");
    expect(copy.saved).toMatchObject({ kind: "copy", beside: true });
    expect(await offsetOf(new Uint8Array(await readFile(join(files, copy.saved.name))))).toEqual([
      String(260 * 9525),
      String(96 * 9525),
    ]);
  });

  it("Windows cloud placeholder (Files On-Demand): drives attribute bitmasks through editDeck + Try again, and skips repeated checks after a local write", async () => {
    expect(isWindowsCloudAttributes(WIN32_CLOUD_ATTRIBUTES | 0x20)).toBe(true);
    expect(isWindowsCloudAttributes(0x20)).toBe(false);
    expect(isWindowsCloudAttributes(0)).toBe(false);
    expect(isWindowsCloudAttributes(-1)).toBe(false);
    expect(isWindowsCloudAttributes(Number.NaN)).toBe(false);

    // Each Windows cloud attribute bit causes editDeck to report why: "cloud" without reading bytes.
    for (const bits of [0x00400000, 0x00040000, 0x00001000]) {
      const node = createNodeDeckFiles({
        detectDataless: false,
        windowsCloudPlaceholder: async () => isWindowsCloudAttributes(bits),
      });
      const readSpy = vi.fn(node.readFile);
      const {
        core: c,
        original,
        document,
      } = await setup({
        detectDatalessFiles: false,
        deckFiles: { ...node, readFile: readSpy },
      });
      readSpy.mockClear();
      const waiting = asUnwritable(
        await c.editDeck({
          documentId: document.id,
          sittingId: null,
          shown: document.contentHash,
          shownBytes: original,
          edits: moveBox(262),
        }),
      );
      expect(waiting).toMatchObject({ why: "cloud", name: "Plan.pptx" });
      expect(readSpy).not.toHaveBeenCalled();
      c.close();
      core = null;
    }

    // After downloading (attributes become NORMAL = 0x80), Try again writes, and 10 gestures check
    // isCloudPlaceholder only before the sitting's first write (never on gestures 2..10 or Undo/Redo).
    let attributes = 0x00400000;
    const cloudChecks = vi.fn(async () => isWindowsCloudAttributes(attributes));
    const node = createNodeDeckFiles({
      detectDataless: false,
      windowsCloudPlaceholder: cloudChecks,
    });
    const {
      core: c,
      path,
      original,
      document,
    } = await setup({
      detectDatalessFiles: false,
      deckFiles: node,
    });
    cloudChecks.mockClear();

    const waiting = asUnwritable(
      await c.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: document.contentHash,
        shownBytes: original,
        edits: moveBox(265),
      }),
    );
    expect(waiting).toMatchObject({ why: "cloud", name: "Plan.pptx" });

    attributes = 0x80; // FILE_ATTRIBUTE_NORMAL (downloaded)
    const written = asSaved(await c.retryDeckEdit(waiting.sittingId));
    expect(await offsetOf(new Uint8Array(await readFile(path)))).toEqual([
      String(265 * 9525),
      String(96 * 9525),
    ]);
    expect(await hashOn(path)).toBe(hashBytes(written.bytes));

    // Gestures 2..10 + Undo + Redo in the same sitting do 0 additional cloud attribute checks.
    const callsAfterFirstWrite = cloudChecks.mock.calls.length;
    let shown = hashBytes(written.bytes);
    let lastStepId = written.stepId;
    for (let i = 2; i <= 10; i++) {
      const next = asSaved(
        await c.editDeck({
          documentId: document.id,
          sittingId: written.sittingId,
          shown,
          edits: moveBox(265 + i),
        }),
      );
      shown = hashBytes(next.bytes);
      lastStepId = next.stepId;
    }
    await c.undoDeckEdit(written.sittingId, lastStepId);
    await c.redoDeckEdit(written.sittingId, lastStepId);
    expect(cloudChecks.mock.calls.length).toBe(callsAfterFirstWrite);
  });

  it("disk full (ENOSPC on kept backup and EDQUOT on replaceFile): reports full, original untouched, writes once space frees", async () => {
    const node = createNodeDeckFiles({ detectDataless: false });
    let keepFull = true;
    let replaceFull = true;
    const { core, path, original, document } = await setup({
      deckFiles: {
        writeWholeFile: async (target, bytes, at, opts) => {
          if (keepFull) throw errno("ENOSPC", "no space left on device");
          return node.writeWholeFile(target, bytes, at, opts);
        },
        replaceFile: async (target, data, stillSo, mode) => {
          if (replaceFull) throw markReplaceStage(errno("EDQUOT", "disk quota exceeded"), "temp");
          return node.replaceFile(target, data, stillSo, mode);
        },
      },
    });

    const first = asUnwritable(
      await core.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: document.contentHash,
        edits: moveBox(270),
      }),
    );
    expect(first).toMatchObject({ why: "full", name: "Plan.pptx" });
    expect(await hashOn(path)).toBe(hashBytes(original));

    keepFull = false;
    const second = asUnwritable(await core.retryDeckEdit(first.sittingId));
    expect(second).toMatchObject({ why: "full", name: "Plan.pptx", again: true });
    expect(await hashOn(path)).toBe(hashBytes(original));

    replaceFull = false;
    const written = asSaved(await core.retryDeckEdit(second.sittingId));
    expect(await offsetOf(new Uint8Array(await readFile(path)))).toEqual([
      String(270 * 9525),
      String(96 * 9525),
    ]);
    expect(await hashOn(path)).toBe(hashBytes(written.bytes));
  });

  it("deleted on disk before first edit: renderer's two-step call (fileMissing -> retry with shownBytes) keeps edit waiting and saves a copy", async () => {
    const { core, files, path, original, document } = await setup({
      deckFiles: {
        saveCopy: async (file, save) => {
          if (file.folder === dirname(path)) throw errno("ENOENT", "folder moved too");
          return save();
        },
      },
    });

    // Actually remove the file on disk (no fake stat, no chmod).
    await unlink(path);

    // Renderer's first call carries no shownBytes: core marks the file missing and throws fileMissing.
    await expect(
      core.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: document.contentHash,
        edits: moveBox(280),
      }),
    ).rejects.toMatchObject({ wording: { key: "error.document.fileMissing" } });

    // Renderer's immediate retry supplies shownBytes: core verifies against shown and keeps edit waiting.
    const waiting = asUnwritable(
      await core.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: document.contentHash,
        shownBytes: original,
        edits: moveBox(280),
      }),
    );
    expect(waiting).toMatchObject({ why: "gone", name: "Plan.pptx" });

    const copy = asSaved(await core.saveDeckCopy(waiting.sittingId));
    if (copy.saved.kind !== "copy") throw new Error("Expected copy");
    expect(copy.saved.beside).toBe(false);
    expect(copy.saved.path.startsWith(files)).toBe(false);
    expect(await offsetOf(new Uint8Array(await readFile(copy.saved.path)))).toEqual([
      String(280 * 9525),
      String(96 * 9525),
    ]);
  });

  it("external save without a watcher: readDeck runs library.check so the Document updates to the newest version", async () => {
    const { core, path, document } = await setup();
    const externalBytes = new Uint8Array(
      pptxOf({
        slides: [
          {
            shapes:
              sp({
                id: 4,
                name: "Externally Updated Box",
                spPr: xfrm(420 * 9525, 914400, 1828800, 914400),
              }) +
              sp({
                id: 5,
                name: "Added By Another App",
                spPr: xfrm(100000, 100000, 500000, 500000),
              }),
          },
        ],
        parts: [ROOT_RELS],
      }),
    );
    await writeFile(path, externalBytes);

    await expect(
      core.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: document.contentHash,
        edits: moveBox(285),
      }),
    ).rejects.toMatchObject({ wording: { key: "error.deck.changed" } });

    // Even with no watcher running, library.check queued reprocessing of the external save.
    const [refreshed] = await waitForProcessing(core, [document.id]);
    expect(refreshed?.contentHash).toBe(hashBytes(externalBytes));
  });

  it("copy-beside failing too (ENOSPC / EACCES): reports copyFailed with folder name in place, unasked quit rethrows raw error, recovers cleanly", async () => {
    const node = createNodeDeckFiles({ detectDataless: false });
    let copyError: NodeJS.ErrnoException | null = errno("ENOSPC", "disk full everywhere");
    const { core, files, path, document } = await setup({
      deckFiles: {
        access: async (target, mode) => {
          if (mode === "write" && target === path) throw errno("EACCES", "read-only");
          return node.access(target, mode);
        },
        saveCopy: async (_file, save) => {
          if (copyError) throw copyError;
          return save();
        },
      },
    });

    const waiting = asUnwritable(
      await core.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: document.contentHash,
        edits: moveBox(290),
      }),
    );
    expect(waiting).toMatchObject({ why: "read-only" });

    // Both beside and Output location hit ENOSPC: edit stays waiting with copyFailed: "full".
    const fullFail = asUnwritable(await core.saveDeckCopy(waiting.sittingId));
    expect(fullFail).toMatchObject({ why: "read-only", copyFailed: "full" });
    expect(core.deckChangesWaiting()).toHaveLength(1);
    expect(await core.deckChangeWaiting(document.id)).toMatchObject({
      sittingId: waiting.sittingId,
      copyFailed: "full",
    });

    // Unasked quit copy rethrows the original system error (so quit sheet words it once, not twice).
    await expect(core.saveDeckCopyUnasked(waiting.sittingId)).rejects.toMatchObject({
      code: "ENOSPC",
    });
    expect(core.deckChangesWaiting()).toHaveLength(1);

    // Folder refusal on both beside and Output location reports copyFailed: "folder" and names the deck's folder.
    copyError = errno("EACCES", "both folders read-only");
    const folderFail = asUnwritable(await core.saveDeckCopy(waiting.sittingId));
    expect(folderFail).toMatchObject({
      why: "read-only",
      copyFailed: "folder",
      folder: basename(files),
    });
    expect(core.deckChangesWaiting()).toHaveLength(1);

    // Once space/permissions recover, Save a copy succeeds with the preserved edit intact.
    copyError = null;
    const copied = asSaved(await core.saveDeckCopy(waiting.sittingId));
    expect(copied.saved).toMatchObject({ kind: "copy", name: "Plan 2.pptx", beside: true });
    expect(core.deckChangesWaiting()).toHaveLength(0);
    expect(await offsetOf(new Uint8Array(await readFile(join(files, "Plan 2.pptx"))))).toEqual([
      String(290 * 9525),
      String(96 * 9525),
    ]);
  });
});
