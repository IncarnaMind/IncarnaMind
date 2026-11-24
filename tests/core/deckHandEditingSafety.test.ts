/**
 * What keeps a hand edit of a deck from losing or overwriting the User's work (#149): kept states
 * that Put back can't eat and a failed write can't drop, a change that waits whole while its file
 * can't be written, a file another app holds, a deck its author protected, and what a crash leaves.
 */
import { chmod, mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Core } from "../../src/core";
import type { DeckEdit } from "../../src/core/api";
import { MAX_KEPT } from "../../src/core/decks/kept";
import { hashBytes } from "../../src/core/documents/files";
import { openPackage } from "../../src/core/documents/formats/zip";
import { Deck } from "../../src/core/exports/pptxPatch/deck";
import { createTempDataFolder, startCore } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  linkWithoutFolderAndProcess,
} from "../helpers/documents";
import { pptxOf, sp, xfrm } from "../helpers/pptx";
import type { ZipInput } from "../helpers/zip";

const ROOT_RELS = {
  name: "_rels/.rels",
  data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
};

const deck = (extra: ZipInput[] = []) =>
  new Uint8Array(
    pptxOf({
      slides: [
        { shapes: sp({ id: 4, name: "Box", spPr: xfrm(5486400, 914400, 1828800, 914400) }) },
      ],
      parts: [ROOT_RELS, ...extra],
    }),
  );

const moveBox = (x: number) => [
  { kind: "box" as const, slide: 1, shape: "4", box: { x, y: 96, w: 192, h: 96 } },
];
const offsetOf = async (bytes: Uint8Array) =>
  /<a:off x="(\d+)"/.exec((await openPackage(bytes).readText("ppt/slides/slide1.xml")) ?? "")?.[1];

const saved = (edit: DeckEdit) => {
  if (edit.kind !== "saved") throw new Error(`Not saved: ${edit.why}`);
  return edit;
};

let core: Core | null = null;
afterEach(() => {
  core?.close();
  core = null;
});

async function opened(bytes = deck(), name = "Plan.pptx") {
  const dataDir = await createTempDataFolder();
  const files = await createSourceFolder();
  const path = join(files, name);
  await writeFile(path, bytes);
  core = startCore(dataDir);
  const [document] = await addAndProcess(core, [path]);
  if (!document) throw new Error("not added");
  return { core, dataDir, files, path, original: bytes, document };
}

const hashOn = async (path: string) => hashBytes(new Uint8Array(await readFile(path)));

/** One sitting: a move written, then the sitting closed, as a viewer closing ends one. */
async function sitting(core: Core, documentId: string, path: string, x: number) {
  const edit = saved(
    await core.editDeck({
      documentId,
      sittingId: null,
      shown: await hashOn(path),
      edits: moveBox(x),
    }),
  );
  await core.closeDeckSitting(edit.sittingId);
  return edit;
}

describe("Kept states of a User's own deck", () => {
  /** What the deck's menu offers to put back: before the latest sitting, and as it first was. */
  const offered = async (core: Core, documentId: string) => core.keptDeckStates(documentId);

  it("Put back and its Undo, again and again, never let the deck as it first was go", async () => {
    const { core, dataDir, path, original, document } = await opened();
    for (let at = 0; at < 3; at++) await sitting(core, document.id, path, 100 + at);
    const { sitting: state } = await offered(core, document.id);
    if (!state) throw new Error("nothing kept");
    for (let round = 0; round < MAX_KEPT + 2; round++) {
      const restored = await core.restoreKeptDeck({
        documentId: document.id,
        keptId: state.id,
        shown: await hashOn(path),
      });
      await core.restoreKeptDeck({
        documentId: document.id,
        keptId: restored.before ?? "",
        shown: restored.contentHash,
      });
    }
    expect((await readdir(join(dataDir, "Kept decks", document.id))).length).toBeLessThanOrEqual(5);
    const { first } = await offered(core, document.id);
    if (!first) throw new Error("the deck as it first was isn't offered");
    await core.restoreKeptDeck({
      documentId: document.id,
      keptId: first.id,
      shown: await hashOn(path),
    });
    expect(await hashOn(path)).toBe(hashBytes(original));
  });

  it("offers the deck as it first was however many sittings follow, and says which state it let go", async () => {
    const { core, dataDir, path, original, document } = await opened();
    let letGo: string[] = [];
    for (let at = 0; at <= MAX_KEPT + 1; at++) {
      const edit = await sitting(core, document.id, path, 100 + at);
      if (edit.saved.kind === "file" && edit.saved.letGo.length > 0) letGo = edit.saved.letGo;
    }
    expect(await readdir(join(dataDir, "Kept decks", document.id))).toHaveLength(MAX_KEPT);
    expect(letGo.length).toBeGreaterThan(0);
    const { first } = await offered(core, document.id);
    if (!first) throw new Error("the deck as it first was isn't offered");
    await core.restoreKeptDeck({
      documentId: document.id,
      keptId: first.id,
      shown: await hashOn(path),
    });
    expect(await hashOn(path)).toBe(hashBytes(original));
  });

  it("put back as it first was, then edited again: Put back as it was writes the state this sitting began from", async () => {
    const { core, path, original, document } = await opened();
    await sitting(core, document.id, path, 120);
    await sitting(core, document.id, path, 140);
    const { first } = await offered(core, document.id);
    if (!first) throw new Error("the deck as it first was isn't offered");
    await core.restoreKeptDeck({
      documentId: document.id,
      keptId: first.id,
      shown: await hashOn(path),
    });
    expect(await hashOn(path)).toBe(hashBytes(original));
    await sitting(core, document.id, path, 160);
    const now = await offered(core, document.id);
    expect(now.sitting?.contentHash).toBe(hashBytes(original));
    expect(now.first).toBeNull();
    await core.restoreKeptDeck({
      documentId: document.id,
      keptId: now.sitting?.id ?? "",
      shown: await hashOn(path),
    });
    expect(await hashOn(path)).toBe(hashBytes(original));
  });

  it("a kept copy that can't be written keeps the change waiting, the file untouched", async () => {
    const { core, dataDir, path, original, document } = await opened();
    await mkdir(join(dataDir, "Kept decks", document.id), { recursive: true });
    await chmod(join(dataDir, "Kept decks", document.id), 0o555);
    try {
      const waiting = await core.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: document.contentHash,
        edits: moveBox(200),
      });
      expect(waiting).toMatchObject({ kind: "unwritable", why: "unkept" });
      expect(await hashOn(path)).toBe(hashBytes(original));
    } finally {
      await chmod(join(dataDir, "Kept decks", document.id), 0o755);
    }
  });

  it("go with the deck when it is deleted for good, and a kept file with no record goes at the next start", async () => {
    const { core, dataDir, path, document } = await opened();
    await sitting(core, document.id, path, 120);
    const folder = join(dataDir, "Kept decks", document.id);
    expect(await readdir(folder)).toHaveLength(1);
    await core.deleteDocuments([document.id]);
    await core.deletePermanently([{ kind: "document", id: document.id }]);
    await expect(readdir(folder)).rejects.toThrow();
    await mkdir(join(dataDir, "Kept decks", "gone"), { recursive: true });
    await writeFile(join(dataDir, "Kept decks", "gone", "left.pptx"), "x");
    core.close();
    const again = startCore(dataDir);
    await again.listDocuments();
    await expect
      .poll(() => readdir(join(dataDir, "Kept decks")).then((names) => names.includes("gone")))
      .toBe(false);
    again.close();
  });
});

describe("A deck in the data folder that no agent handed over", () => {
  it("is written itself, kept first, and can be put back", async () => {
    const dataDir = await createTempDataFolder();
    core = startCore(dataDir);
    const own = join(dataDir, "Converted", "Plan.pptx");
    await mkdir(join(dataDir, "Converted"), { recursive: true });
    const original = deck();
    await writeFile(own, original);
    const [document] = await addAndProcess(core, [own]);
    if (!document) throw new Error("not added");
    const edit = saved(
      await core.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: document.contentHash,
        edits: moveBox(200),
      }),
    );
    expect(edit.saved.kind).toBe("file");
    const kept = (await core.keptDeckStates(document.id)).sitting;
    if (!kept) throw new Error("nothing kept");
    await core.restoreKeptDeck({
      documentId: document.id,
      keptId: kept.id,
      shown: await hashOn(own),
    });
    expect(await hashOn(own)).toBe(hashBytes(original));
  });
});

describe("A change that waits", () => {
  it("is never lost when another app writes its file meanwhile: it waits on, and a copy beside it keeps it", async () => {
    const { core, files, path, document } = await opened();
    const lock = join(files, "~$Plan.pptx");
    await writeFile(lock, "PowerPoint");
    const waiting = await core.editDeck({
      documentId: document.id,
      sittingId: null,
      shown: document.contentHash,
      edits: moveBox(200),
    });
    expect(waiting).toMatchObject({ kind: "unwritable", why: "locked", lock: "~$Plan.pptx" });
    // The other app saves as it closes: its own version, then its lock file goes.
    await writeFile(
      path,
      deck([{ name: "docProps/app.xml", data: "<Properties>theirs</Properties>" }]),
    );
    await rm(lock);
    const tried = await core.retryDeckEdit(waiting.sittingId);
    expect(tried).toMatchObject({ kind: "unwritable", why: "changed" });
    expect(
      await openPackage(new Uint8Array(await readFile(path))).readText("docProps/app.xml"),
    ).toContain("theirs");
    const copy = saved(await core.saveDeckCopy(tried.sittingId));
    expect(await offsetOf(copy.bytes)).toBe(String(200 * 9525));
  });

  it("outlives its viewer: closed, it is found again for the deck, and the quit counts it", async () => {
    const { core, path, document } = await opened();
    await chmod(path, 0o444);
    const waiting = await core.editDeck({
      documentId: document.id,
      sittingId: null,
      shown: document.contentHash,
      edits: moveBox(200),
    });
    expect(waiting.kind).toBe("unwritable");
    await core.closeDeckSitting(waiting.sittingId);
    expect(core.deckChangesWaiting()).toHaveLength(1);
    const found = await core.deckChangeWaiting(document.id);
    expect(found).toMatchObject({ sittingId: waiting.sittingId, why: "read-only" });
    expect(await offsetOf(found?.bytes ?? new Uint8Array())).toBe(String(200 * 9525));
    saved(await core.saveDeckCopy(waiting.sittingId));
    expect(core.deckChangesWaiting()).toHaveLength(0);
  });

  it("takes every gesture made while it waits, and the copy beside it holds them all", async () => {
    const { core, path, document } = await opened();
    await chmod(path, 0o444);
    const first = await core.editDeck({
      documentId: document.id,
      sittingId: null,
      shown: document.contentHash,
      edits: moveBox(200),
    });
    expect(first.kind).toBe("unwritable");
    const second = await core.editDeck({
      documentId: document.id,
      sittingId: first.sittingId,
      shown: document.contentHash,
      edits: [{ kind: "box", slide: 1, shape: "4", box: { x: 200, y: 150, w: 192, h: 96 } }],
    });
    expect(second.kind).toBe("unwritable");
    const copy = saved(await core.saveDeckCopy(second.sittingId));
    expect(await offsetOf(copy.bytes)).toBe(String(200 * 9525));
    expect(
      /<a:off x="\d+" y="(\d+)"/.exec(
        (await openPackage(copy.bytes).readText("ppt/slides/slide1.xml")) ?? "",
      )?.[1],
    ).toBe(String(150 * 9525));
  });

  it("is saved as a copy in the Output location where its Linked folder takes no new files", async () => {
    const dataDir = await createTempDataFolder();
    const files = await createSourceFolder();
    const path = join(files, "Plan.pptx");
    await writeFile(path, deck());
    core = startCore(dataDir);
    const [document] = await linkWithoutFolderAndProcess(core, files);
    if (!document?.linkedFolderId) throw new Error("not linked");
    await core.setLinkedFolderWriting(document.linkedFolderId, false);
    await chmod(path, 0o444);
    const waiting = await core.editDeck({
      documentId: document.id,
      sittingId: null,
      shown: document.contentHash,
      edits: moveBox(200),
    });
    const copy = saved(await core.saveDeckCopy(waiting.sittingId));
    if (copy.saved.kind !== "copy") throw new Error("no copy");
    expect(copy.saved.path.startsWith(files)).toBe(false);
  });

  it("waits while another app has the file open, and is written when tried again once it closes", async () => {
    const { core, files, path, original, document } = await opened();
    const lock = join(files, "~$Plan.pptx");
    await writeFile(lock, "PowerPoint");
    const waiting = await core.editDeck({
      documentId: document.id,
      sittingId: null,
      shown: document.contentHash,
      edits: moveBox(200),
    });
    expect(waiting).toMatchObject({ kind: "unwritable", why: "locked" });
    expect(await hashOn(path)).toBe(hashBytes(original));
    await import("node:fs/promises").then((fs) => fs.rm(lock));
    const done = saved(await core.retryDeckEdit(waiting.sittingId));
    expect(await hashOn(path)).toBe(hashBytes(done.bytes));
  });
});

describe("A deck its author protected", () => {
  const cases: [string, ZipInput[]][] = [
    [
      "signed",
      [
        { name: "_xmlsignatures/sig1.xml", data: "<Signature/>" },
        { name: "_xmlsignatures/origin.sigs", data: "" },
      ],
    ],
    [
      "final",
      [
        {
          name: "docProps/custom.xml",
          data: `<?xml version="1.0"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="_MarkAsFinal"><vt:bool>true</vt:bool></property></Properties>`,
        },
      ],
    ],
  ];
  for (const [why, extra] of cases) {
    it(`is never written: ${why}`, async () => {
      const { core, path, original, document } = await opened(deck(extra));
      await expect(
        core.editDeck({
          documentId: document.id,
          sittingId: null,
          shown: document.contentHash,
          edits: moveBox(200),
        }),
      ).rejects.toMatchObject({ wording: { key: `error.deck.protected.${why}` } });
      expect(await hashOn(path)).toBe(hashBytes(original));
    });
  }

  it("is never written: protected by a password to modify", async () => {
    const plain = Deck.open(deck());
    const presentation = (await plain.pkg.text("ppt/presentation.xml")) ?? "";
    plain.pkg.set(
      "ppt/presentation.xml",
      presentation.replace(
        "<p:defaultTextStyle>",
        `<p:modifyVerifier cryptProviderType="rsaAES" cryptAlgorithmClass="hash" cryptAlgorithmType="typeAny" cryptAlgorithmSid="14" spinCount="100000" saltData="AAAA" hashData="AAAA"/><p:defaultTextStyle>`,
      ),
    );
    const { core, path, original, document } = await opened(new Uint8Array(await plain.save()));
    await expect(
      core.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: document.contentHash,
        edits: moveBox(200),
      }),
    ).rejects.toMatchObject({ wording: { key: "error.deck.protected.protected" } });
    expect(await hashOn(path)).toBe(hashBytes(original));
  });
});

describe("A deck whose file can't be written back whole", () => {
  it("is never written: two parts share a name", async () => {
    const twice = deck([
      { name: "docProps/app.xml", data: "<Properties/>" },
      { name: "docProps/app.xml", data: "<Properties>2</Properties>" },
    ]);
    const { core, path, original, document } = await opened(twice);
    await expect(
      core.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: document.contentHash,
        edits: moveBox(200),
      }),
    ).rejects.toMatchObject({ wording: { key: "error.deck.unrewritable" } });
    expect(await hashOn(path)).toBe(hashBytes(original));
  });
});

describe("What a crash leaves", () => {
  it("a temporary file an earlier run left beside the deck goes at the next write there", async () => {
    const { core, files, path, document } = await opened();
    const left = join(files, ".0b8f8a2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b.partial");
    await writeFile(left, "half");
    const long = new Date(Date.now() - 3_600_000);
    await utimes(left, long, long);
    saved(
      await core.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: await hashOn(path),
        edits: moveBox(200),
      }),
    );
    expect(await readdir(files)).not.toContain(".0b8f8a2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b.partial");
  });
});

describe("Changes that wait and gestures from a window that is going", () => {
  // protects=a gesture handed over before its window learnt its sitting (the window closing while the first write is under way) joins that sitting, behind the write (#149 review); fails_when=it starts a sitting of its own that is refused as changed, and its words are lost; no_claim=the window's own queue.
  it("a gesture with no sitting, made on the same version while a write is under way, joins it and both land", async () => {
    const { core, path, document } = await opened();
    const first = core.editDeck({
      documentId: document.id,
      sittingId: null,
      shown: document.contentHash,
      edits: moveBox(200),
    });
    const second = core.editDeck({
      documentId: document.id,
      sittingId: null,
      shown: document.contentHash,
      edits: [{ kind: "box", slide: 1, shape: "4", box: { x: 200, y: 150, w: 192, h: 96 } }],
    });
    const [one, two] = [saved(await first), saved(await second)];
    expect(two.sittingId).toBe(one.sittingId);
    const xml =
      (await openPackage(new Uint8Array(await readFile(path))).readText("ppt/slides/slide1.xml")) ??
      "";
    expect(/<a:off x="(\d+)" y="(\d+)"/.exec(xml)?.slice(1)).toEqual([
      String(200 * 9525),
      String(150 * 9525),
    ]);
  });

  // protects=a change that waits is never left behind by a new sitting on its deck (#149 review); fails_when=a gesture with no sitting begins one while another's change waits; no_claim=the window's line, which takes the change up.
  it("a change that waits on a closed sitting refuses a new sitting with the waiting words", async () => {
    const { core, path, document } = await opened();
    await chmod(path, 0o444);
    const waiting = await core.editDeck({
      documentId: document.id,
      sittingId: null,
      shown: document.contentHash,
      edits: moveBox(200),
    });
    expect(waiting.kind).toBe("unwritable");
    await core.closeDeckSitting(waiting.sittingId);
    await expect(
      core.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: document.contentHash,
        edits: moveBox(300),
      }),
    ).rejects.toMatchObject({ wording: { key: "error.deck.waiting" } });
  });

  // protects=a deck moved to Recently deleted keeps its file, so its waiting change is still saved as a copy (#149 review); fails_when=the copy fails as not found until the deck is restored; no_claim=the deleted deck's tab.
  it("a deck in Recently deleted still saves its waiting change as a copy beside its file", async () => {
    const { core, files, path, document } = await opened();
    await chmod(path, 0o444);
    const waiting = await core.editDeck({
      documentId: document.id,
      sittingId: null,
      shown: document.contentHash,
      edits: moveBox(200),
    });
    await core.deleteDocument(document.id);
    const copy = saved(await core.saveDeckCopy(waiting.sittingId));
    expect(copy.saved).toMatchObject({ kind: "copy", name: "Plan 2.pptx", beside: true });
    expect(await offsetOf(new Uint8Array(await readFile(join(files, "Plan 2.pptx"))))).toBe(
      String(200 * 9525),
    );
    expect(core.deckChangesWaiting()).toHaveLength(0);
  });

  // protects=a folder that refuses writes is said as the folder, and its copy is said where it went (#149 review); fails_when=the line says the file is read-only, or the copy is said to be beside it; no_claim=the Output location's own name.
  it("a folder that refuses writes is named, and the copy goes to the Output location", async () => {
    const { core, files, path, document } = await opened();
    await chmod(files, 0o555);
    try {
      const waiting = await core.editDeck({
        documentId: document.id,
        sittingId: null,
        shown: document.contentHash,
        edits: moveBox(200),
      });
      expect(waiting).toMatchObject({
        kind: "unwritable",
        why: "folder",
        folder: basenameOf(files),
      });
      const copy = saved(await core.saveDeckCopy(waiting.sittingId));
      if (copy.saved.kind !== "copy") throw new Error("no copy");
      expect(copy.saved.beside).toBe(false);
      expect(copy.saved.path.startsWith(files)).toBe(false);
      expect(await hashOn(path)).toBe(document.contentHash);
    } finally {
      await chmod(files, 0o755);
    }
  });
});

const basenameOf = (path: string) => path.split(/[\\/]/).at(-1) ?? "";
