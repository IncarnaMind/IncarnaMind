/**
 * A deck edited by hand (#149), through the core's API as the viewer calls it: the User's own
 * file is written itself, only inside the edited shape, after its earlier state is kept; a sitting
 * never writes over bytes the viewer didn't show or another program saved; a file that can't be
 * written keeps the edit waiting for a copy beside it; and the kept state puts the deck back.
 */
import { chmod, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Core } from "../../src/core";
import type { DeckEdit } from "../../src/core/api";
import { MAX_KEPT } from "../../src/core/decks/kept";
import { hashBytes } from "../../src/core/documents/files";
import { openPackage } from "../../src/core/documents/formats/zip";
import { replaceFile } from "../../src/core/fileNames";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, waitForDocuments } from "../helpers/documents";
import { pptxOf, sp, txBody, xfrm } from "../helpers/pptx";

const RUNS =
  '<a:p><a:r><a:rPr lang="zh-CN"/><a:t>收入增长</a:t></a:r><a:r><a:rPr lang="zh-CN" b="1"/><a:t>百分之四</a:t></a:r><a:r><a:rPr lang="zh-CN"/><a:t>，已核对</a:t></a:r></a:p>';

/** The test deck: one slide, a text box of three runs, the middle one bold, and a rectangle. */
const deck = () =>
  new Uint8Array(
    pptxOf({
      slides: [
        {
          shapes:
            sp({
              id: 3,
              name: "Body",
              spPr: xfrm(914400, 914400, 4572000, 914400),
              body: txBody(RUNS),
            }) + sp({ id: 4, name: "Box", spPr: xfrm(5486400, 914400, 1828800, 914400) }),
        },
      ],
      parts: [
        {
          name: "_rels/.rels",
          data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
        },
      ],
    }),
  );

const typed = (text: string) => [
  {
    kind: "text" as const,
    slide: 1,
    shape: "3",
    paragraphs: [
      {
        source: 0,
        runs: [
          { source: { paragraph: 0, run: 0 }, text: "收入增长" },
          { source: { paragraph: 0, run: 1 }, text: "百分之四" },
          { source: { paragraph: 0, run: 2 }, text },
        ],
      },
    ],
  },
];

const moveBox = (x: number) => [
  { kind: "box" as const, slide: 1, shape: "4", box: { x, y: 96, w: 192, h: 96 } },
];

const slideXml = async (bytes: Uint8Array) =>
  (await openPackage(bytes).readText("ppt/slides/slide1.xml")) ?? "";

const saved = (edit: DeckEdit) => {
  if (edit.kind !== "saved") throw new Error(`Not saved: ${edit.why}`);
  return edit;
};

let core: Core | null = null;
afterEach(() => {
  core?.close();
  core = null;
});

async function opened() {
  const dataDir = await createTempDataFolder();
  const files = await createSourceFolder();
  const path = join(files, "Quarterly review.pptx");
  const original = deck();
  await writeFile(path, original);
  core = startCore(dataDir);
  const [document] = await addAndProcess(core, [path]);
  if (!document) throw new Error("not added");
  return { core, dataDir, path, original, document };
}

describe("A deck of the User's own, edited by hand", () => {
  it("is written itself, changed only inside the edited shape, its earlier state kept", async () => {
    const { core, path, original, document, dataDir } = await opened();
    const mode = (await stat(path)).mode;
    const edit = saved(
      await core.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: document.contentHash,
        edits: typed("，已核对无误"),
      }),
    );
    expect(edit.saved).toMatchObject({ kind: "file", name: "Quarterly review.pptx", letGo: [] });
    expect(edit.slides).toEqual({ changed: 1, kept: 0 });
    const now = new Uint8Array(await readFile(path));
    expect(hashBytes(now)).toBe(hashBytes(edit.bytes));
    expect((await stat(path)).mode).toBe(mode);
    // Only the run's text changed; every other part kept its stored bytes.
    expect((await slideXml(now)).replace("，已核对无误", "，已核对")).toBe(
      await slideXml(original),
    );
    const before = openPackage(original);
    const after = openPackage(now);
    for (const name of before.names().filter((each) => each !== "ppt/slides/slide1.xml")) {
      expect(
        Buffer.from(after.raw(name)?.data ?? []).equals(Buffer.from(before.raw(name)?.data ?? [])),
      ).toBe(true);
    }
    // The file as it stood is kept, whole, once for the sitting: what Put back as it was writes.
    const kept = await core.keptDeckStates(document.id);
    expect(kept.sitting?.contentHash).toBe(hashBytes(original));
    expect(kept.first).toBeNull();
    const keptFiles = await readdir(join(dataDir, "Kept decks", document.id));
    expect(keptFiles).toHaveLength(1);
    expect(
      hashBytes(
        new Uint8Array(
          await readFile(join(dataDir, "Kept decks", document.id, keptFiles[0] ?? "")),
        ),
      ),
    ).toBe(hashBytes(original));
    // A second gesture of the sitting writes again, keeping nothing more.
    saved(
      await core.editDeck({
        documentId: document.id,
        sittingId: edit.sittingId,
        shown: "",
        edits: moveBox(200),
      }),
    );
    expect(await readdir(join(dataDir, "Kept decks", document.id))).toHaveLength(1);
  });

  it("undoes and redoes one gesture at a time, writing the file each time", async () => {
    const { core, path, original, document } = await opened();
    const first = saved(
      await core.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: document.contentHash,
        edits: moveBox(200),
      }),
    );
    const second = saved(
      await core.editDeck({
        documentId: document.id,
        sittingId: first.sittingId,
        shown: "",
        edits: typed("，改"),
      }),
    );
    saved(await core.undoDeckEdit(second.sittingId, second.stepId));
    expect(await slideXml(new Uint8Array(await readFile(path)))).toBe(await slideXml(first.bytes));
    saved(await core.undoDeckEdit(first.sittingId, first.stepId));
    expect(hashBytes(new Uint8Array(await readFile(path)))).toBe(hashBytes(original));
    saved(await core.redoDeckEdit(first.sittingId, first.stepId));
    expect(await slideXml(new Uint8Array(await readFile(path)))).toBe(await slideXml(first.bytes));
    await expect(core.undoDeckEdit(second.sittingId, second.stepId)).rejects.toThrow();
  });

  it("applies nothing when the file isn't the version shown, or another program saved it during the sitting", async () => {
    const { core, path, document } = await opened();
    await expect(
      core.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: "not the shown version",
        edits: moveBox(200),
      }),
    ).rejects.toThrow(/changed since/);
    const first = saved(
      await core.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: document.contentHash,
        edits: moveBox(200),
      }),
    );
    const theirs = new Uint8Array([...deck(), 0]);
    await writeFile(path, theirs);
    await expect(
      core.editDeck({
        documentId: document.id,
        sittingId: first.sittingId,
        shown: "",
        edits: moveBox(300),
      }),
    ).rejects.toThrow(/changed since/);
    expect(hashBytes(new Uint8Array(await readFile(path)))).toBe(hashBytes(theirs));
    await expect(core.undoDeckEdit(first.sittingId, first.stepId)).rejects.toThrow();
    expect(hashBytes(new Uint8Array(await readFile(path)))).toBe(hashBytes(theirs));
  });

  it("keeps the edit waiting when the file is read-only, and saves it as a copy beside it", async () => {
    const { core, path, original, document } = await opened();
    await chmod(path, 0o444);
    const waiting = await core.editDeck({
      documentId: document.id,
      sittingId: null,
      shown: document.contentHash,
      edits: moveBox(200),
    });
    expect(waiting).toMatchObject({
      kind: "unwritable",
      why: "read-only",
      name: "Quarterly review.pptx",
    });
    expect(hashBytes(new Uint8Array(await readFile(path)))).toBe(hashBytes(original));
    const copy = saved(await core.saveDeckCopy(waiting.sittingId));
    expect(copy.saved).toMatchObject({ kind: "copy", name: "Quarterly review 2.pptx" });
    expect(copy.documentId).not.toBe(document.id);
    expect(hashBytes(new Uint8Array(await readFile(path)))).toBe(hashBytes(original));
    if (copy.saved.kind !== "copy") throw new Error("no copy");
    expect(hashBytes(new Uint8Array(await readFile(copy.saved.path)))).toBe(hashBytes(copy.bytes));
    // The sitting goes on in the copy.
    const next = saved(
      await core.editDeck({
        documentId: copy.documentId,
        sittingId: copy.sittingId,
        shown: "",
        edits: moveBox(300),
      }),
    );
    expect(next.saved).toMatchObject({ kind: "file", name: "Quarterly review 2.pptx" });
  });

  it("keeps the edit waiting when the file's folder takes nothing, or the file is gone", async () => {
    const { core, path, original, document } = await opened();
    const folder = dirname(path);
    await chmod(folder, 0o555);
    try {
      const shut = await core.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: document.contentHash,
        edits: moveBox(200),
      });
      expect(shut).toMatchObject({ kind: "unwritable", why: "read-only" });
      expect(hashBytes(new Uint8Array(await readFile(path)))).toBe(hashBytes(original));
      expect(await readdir(folder)).toEqual(["Quarterly review.pptx"]);
    } finally {
      await chmod(folder, 0o755);
    }
  });

  it("keeps the edit waiting when the file is gone during a sitting, and saves it as a copy where it was", async () => {
    const { core, path, document } = await opened();
    const first = saved(
      await core.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: document.contentHash,
        edits: moveBox(200),
      }),
    );
    await rm(path);
    const waiting = await core.editDeck({
      documentId: document.id,
      sittingId: first.sittingId,
      shown: "",
      edits: moveBox(300),
    });
    expect(waiting).toMatchObject({
      kind: "unwritable",
      why: "gone",
      name: "Quarterly review.pptx",
    });
    const copy = saved(await core.saveDeckCopy(waiting.sittingId));
    expect(copy.saved).toMatchObject({ kind: "copy", name: "Quarterly review.pptx" });
    if (copy.saved.kind !== "copy") throw new Error("no copy");
    expect(hashBytes(new Uint8Array(await readFile(copy.saved.path)))).toBe(hashBytes(copy.bytes));
  });

  it("puts the deck back as it stood before the sitting, and that can be undone", async () => {
    const { core, path, original, document } = await opened();
    const edit = saved(
      await core.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: document.contentHash,
        edits: typed("，改"),
      }),
    );
    const kept = (await core.keptDeckStates(document.id)).sitting;
    if (!kept) throw new Error("nothing kept");
    const now = await waitForDocuments(core, (documents) =>
      expect(documents.find((each) => each.id === document.id)?.contentHash).toBe(
        hashBytes(edit.bytes),
      ),
    );
    const shown = now.find((each) => each.id === document.id)?.contentHash ?? "";
    const restored = await core.restoreKeptDeck({
      documentId: document.id,
      keptId: kept.id,
      shown,
    });
    expect(hashBytes(new Uint8Array(await readFile(path)))).toBe(hashBytes(original));
    expect(restored.before).not.toBeNull();
    await core.restoreKeptDeck({
      documentId: document.id,
      keptId: restored.before ?? "",
      shown: hashBytes(original),
    });
    expect(hashBytes(new Uint8Array(await readFile(path)))).toBe(hashBytes(edit.bytes));
  });

  it(`keeps ${MAX_KEPT} states and says which one it let go`, async () => {
    const { core, dataDir, path, document } = await opened();
    let letGo: string[] = [];
    for (let sitting = 0; sitting <= MAX_KEPT; sitting++) {
      const shown = hashBytes(new Uint8Array(await readFile(path)));
      const edit = saved(
        await core.editDeck({
          documentId: document.id,
          sittingId: null,
          shown,
          edits: moveBox(100 + sitting),
        }),
      );
      if (edit.saved.kind === "file") letGo = edit.saved.letGo;
      await core.closeDeckSitting(edit.sittingId);
    }
    expect(await readdir(join(dataDir, "Kept decks", document.id))).toHaveLength(MAX_KEPT);
    expect(letGo).toHaveLength(1);
  });

  it("leaves the file whole when the write stops before the rename", async () => {
    const files = await createSourceFolder();
    const path = join(files, "deck.pptx");
    const original = deck();
    await writeFile(path, original);
    await expect(
      replaceFile(path, new Uint8Array([1, 2, 3]), () => Promise.reject(new Error("quit"))),
    ).rejects.toThrow("quit");
    expect(hashBytes(new Uint8Array(await readFile(path)))).toBe(hashBytes(original));
    expect(await readdir(files)).toEqual(["deck.pptx"]);
  });
});
