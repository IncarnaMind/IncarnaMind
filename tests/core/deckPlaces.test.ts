/**
 * The one seam that writes a deck of the User's own (#149), driven as a sitting drives it: a write
 * that fails after the deck as it stood was kept must let no earlier kept state go.
 */
import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StoredHandedFile, StoredHandedVersion } from "../../src/core/agentFiles";
import { HANDED_FOLDER } from "../../src/core/agentFiles/handOver";
import type { Document } from "../../src/core/api";
import { createKeptDecks, type KeptDecks, MAX_KEPT } from "../../src/core/decks/kept";
import { type DeckPlaceDeps, deckPlaceFor, ownFile } from "../../src/core/decks/places";
import { migrate, openDatabase } from "../../src/core/storage";
import { createTempDataFolder } from "../helpers/core";
import { createSourceFolder } from "../helpers/documents";

const bytesOf = (text: string) => new TextEncoder().encode(text);

/** A place's world with one deck at `path`, no Linked folder, no copies and no agents. */
function depsFor(dataDir: string, path: string, kept: KeptDecks): DeckPlaceDeps {
  return {
    dataDir,
    document: () => ({ id: "deck", path, linkedFolderId: null }) as Document,
    readAgain: async () => undefined,
    documentAt: () => null,
    addFile: async () => "copy",
    folderOf: () => null,
    inLinkedFolder: () => false,
    save: async () => {
      throw new Error("No copy is made here.");
    },
    handed: {
      holding: () => [],
      versions: () => [],
      addVersion: () => {
        throw new Error("No versions here.");
      },
      rewriteVersion: () => undefined,
    },
    kept,
    inHandOverTurn: (run) => run(),
    now: () => new Date().toISOString(),
    newId: () => randomUUID(),
  };
}

describe("A deck of the User's own, written itself", () => {
  // protects=a failed write lets no kept state go (#149); fails_when=older states go before the rename, which then fails; no_claim=how the line says it.
  it("a write that fails after the deck as it stood was kept lets no earlier kept state go", async () => {
    const dataDir = await createTempDataFolder();
    const folder = await createSourceFolder();
    const path = join(folder, "Plan.pptx");
    await writeFile(path, bytesOf("as it first was"));
    const db = openDatabase(join(dataDir, "test.db"));
    migrate(db);
    const kept = createKeptDecks({ db, dataDir, now: () => new Date().toISOString() });
    /** Run as the state is about to be kept: once set, the deck's folder takes no new file. */
    let lockOut = false;
    const deps = depsFor(dataDir, path, kept);
    deps.newId = () => {
      if (lockOut) chmodSync(folder, 0o555);
      return randomUUID();
    };
    let base = bytesOf("as it first was");
    for (let at = 0; at < MAX_KEPT; at++) {
      const next = bytesOf(`sitting ${at}`);
      expect((await ownFile(deps, "deck", base).write(next)).kind).toBe("written");
      base = next;
    }
    const before = kept.of("deck").map((each) => each.id);
    expect(before).toHaveLength(MAX_KEPT);
    lockOut = true;
    try {
      expect((await ownFile(deps, "deck", base).write(bytesOf("one more"))).kind).toBe(
        "unwritable",
      );
    } finally {
      await chmod(folder, 0o755);
    }
    const after = kept.of("deck").map((each) => each.id);
    db.close();
    for (const id of before) expect(after).toContain(id);
  });

  // protects=Put back as it was names the state the last sitting that wrote began from (#149 review); fails_when=a sitting whose first write fails is marked as begun, so Put back names what the file holds and hides; no_claim=how the item is worded.
  it("a sitting whose first write fails leaves Put back naming the last sitting that wrote", async () => {
    const dataDir = await createTempDataFolder();
    const folder = await createSourceFolder();
    const path = join(folder, "Plan.pptx");
    await writeFile(path, bytesOf("as it first was"));
    const db = openDatabase(join(dataDir, "test.db"));
    migrate(db);
    const kept = createKeptDecks({ db, dataDir, now: () => new Date().toISOString() });
    let lockOut = false;
    const deps = depsFor(dataDir, path, kept);
    deps.newId = () => {
      if (lockOut) chmodSync(folder, 0o555);
      return randomUUID();
    };
    const first = ownFile(deps, "deck", bytesOf("as it first was"));
    expect((await first.write(bytesOf("after the first sitting"))).kind).toBe("written");
    lockOut = true;
    let refused: string;
    try {
      refused = (
        await ownFile(deps, "deck", bytesOf("after the first sitting")).write(
          bytesOf("never written"),
        )
      ).kind;
    } finally {
      await chmod(folder, 0o755);
    }
    const named = kept.ofSitting("deck");
    const bytes = named ? await readFile(join(dataDir, named.file)) : null;
    db.close();
    expect(refused).toBe("unwritable");
    expect(bytes && new TextDecoder().decode(bytes)).toBe("as it first was");
  });

  // protects=a write that has happened stands (#149); fails_when=a step after the rename throws and the sitting is left behind the file; no_claim=the log's words.
  it("a write stands when reading the file again fails after it", async () => {
    const dataDir = await createTempDataFolder();
    const folder = await createSourceFolder();
    const path = join(folder, "Plan.pptx");
    await writeFile(path, bytesOf("as it first was"));
    const db = openDatabase(join(dataDir, "test.db"));
    migrate(db);
    const kept = createKeptDecks({ db, dataDir, now: () => new Date().toISOString() });
    const deps = depsFor(dataDir, path, kept);
    deps.readAgain = async () => {
      throw new Error("The Library is busy.");
    };
    const written = await ownFile(deps, "deck", bytesOf("as it first was")).write(
      bytesOf("edited"),
    );
    db.close();
    expect(written.kind).toBe("written");
    expect(new TextDecoder().decode(await readFile(path))).toBe("edited");
  });
});

describe("A deck an agent handed over, written as a version", () => {
  // protects=a disk that refuses part way keeps the change waiting, and the retry finishes the version it began (#149 review); fails_when=the failure throws past the waiting change, or the retry makes a second version; no_claim=how the line says it.
  it("waits when the disk refuses part way, and finishes the same version when tried again", async () => {
    const dataDir = await createTempDataFolder();
    const db = openDatabase(join(dataDir, "test.db"));
    migrate(db);
    const kept = createKeptDecks({ db, dataDir, now: () => new Date().toISOString() });
    const shown = join(dataDir, HANDED_FOLDER, "item", "v1");
    await mkdir(shown, { recursive: true });
    const path = join(shown, "Plan.pptx");
    await writeFile(path, bytesOf("as handed over"));
    const at = new Date().toISOString();
    const item: StoredHandedFile = {
      id: "item",
      title: "Plan",
      kind: "pptx",
      folderId: null,
      agent: "Claude",
      documentId: "deck",
      version: 1,
      createdAt: at,
      updatedAt: at,
      pairingId: "pairing",
      path: "/elsewhere/Plan.pptx",
    };
    const versions: StoredHandedVersion[] = [
      {
        id: "v1",
        number: 1,
        contentHash: "handed",
        size: 14,
        mindId: "mind",
        agent: "Claude",
        createdAt: at,
        file: join(HANDED_FOLDER, "item", "v1", "Plan.pptx"),
        unread: null,
        checkedAt: at,
      },
    ];
    const deps = depsFor(dataDir, path, kept);
    deps.handed = {
      holding: () => [item],
      versions: () => versions,
      addVersion: (_id, input) => {
        const made: StoredHandedVersion = {
          id: `v${versions.length + 1}`,
          number: versions.length + 1,
          contentHash: input.contentHash,
          size: input.size,
          mindId: null,
          agent: input.agent,
          createdAt: at,
          file: input.file,
          unread: null,
          checkedAt: null,
        };
        versions.push(made);
        return made;
      },
      rewriteVersion: () => undefined,
    };
    const place = deckPlaceFor(deps, "deck", bytesOf("as handed over"));
    // The new version's copy is kept; then the deck's own file can't be put in place.
    await chmod(shown, 0o555);
    let first: Awaited<ReturnType<typeof place.write>>;
    try {
      first = await place.write(bytesOf("edited"));
    } finally {
      await chmod(shown, 0o755);
    }
    const second = await place.write(bytesOf("edited"));
    db.close();
    expect(first.kind).toBe("unwritable");
    expect(second.kind).toBe("written");
    expect(versions.map((each) => each.number)).toEqual([1, 2]);
    expect(new TextDecoder().decode(await readFile(path))).toBe("edited");
  });
});

describe("The kept decks' sweep", () => {
  // protects=a kept copy a write is putting in place is never swept (#149); fails_when=an unnamed file newer than the sweep's start is removed, or a link is followed; no_claim=when the sweep runs.
  it("takes out only unnamed files from before the start, and never follows a link", async () => {
    const dataDir = await createTempDataFolder();
    const db = openDatabase(join(dataDir, "test.db"));
    migrate(db);
    const kept = createKeptDecks({ db, dataDir, now: () => new Date().toISOString() });
    const live = join(dataDir, "Kept decks", "live");
    await mkdir(live, { recursive: true });
    await writeFile(join(live, "left.pptx"), "a crash left it");
    const long = new Date(Date.now() - 3_600_000);
    await utimes(join(live, "left.pptx"), long, long);
    const start = Date.now();
    await writeFile(join(live, "being-kept.pptx"), "renamed into place now");
    const elsewhere = await createSourceFolder();
    await writeFile(join(elsewhere, "keep-me.pptx"), "outside the data folder");
    await symlink(elsewhere, join(dataDir, "Kept decks", "linked"));
    await kept.dropGone((documentId) => documentId === "live", start - 1);
    db.close();
    expect(await readdir(live)).toEqual(["being-kept.pptx"]);
    expect(await readdir(elsewhere)).toEqual(["keep-me.pptx"]);
  });
});
