/**
 * The one seam that writes a deck of the User's own (#149), driven as a sitting drives it: a write
 * that fails after the deck as it stood was kept must let no earlier kept state go.
 */
import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Document } from "../../src/core/api";
import { createKeptDecks, type KeptDecks, MAX_KEPT } from "../../src/core/decks/kept";
import { type DeckPlaceDeps, ownFile } from "../../src/core/decks/places";
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
