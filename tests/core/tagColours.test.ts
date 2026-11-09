import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { InvalidInputError } from "../../src/core";
import { migrate, migrations, openDatabase } from "../../src/core/storage";
import { nextTagColour, TAG_COLOURS } from "../../src/shared/tagColours";
import { createTempDataFolder, startCore } from "../helpers/core";
import { tagNamed } from "../helpers/tags";

describe("Tag colours", () => {
  test("the preset Tags come with their kinds' colours: eight colours for nine kinds, so Letter shares Book's", async () => {
    const core = startCore(await createTempDataFolder());
    const colours = Object.fromEntries(
      (await core.listTags()).map((tag) => [tag.name, tag.colour]),
    );
    expect(colours).toEqual({
      Book: "orange",
      Contract: "red",
      Invoice: "green",
      Letter: "orange",
      "Meeting notes": "gray",
      Paper: "purple",
      Report: "blue",
      Slides: "yellow",
      Statement: "teal",
    });
  });

  test("a new Tag takes the colour fewest Tags have, unless the User chooses one", async () => {
    const core = startCore(await createTempDataFolder());
    // Every colour is on a preset, orange on two: the earliest in the palette of the fewest.
    expect((await core.createTag({ name: "Urgent" })).colour).toBe("red");
    expect((await core.createTag({ name: "Later" })).colour).toBe("yellow");
    expect((await core.createTag({ name: "Travel", colour: "green" })).colour).toBe("green");
    expect((await core.createTag({ name: "Ideas" })).colour).toBe("teal");
    await expect(core.createTag({ name: "Odd", colour: "magenta" as never })).rejects.toThrow(
      InvalidInputError,
    );
  });

  test("the User changes a Tag's colour; it stays through a merge and a restart", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const report = await tagNamed(core, "Report");
    const notes = await core.createTag({ name: "Notes" });
    expect(await core.updateTag(report.id, { colour: "teal" })).toMatchObject({
      colour: "teal",
      name: "Report",
    });
    await expect(core.updateTag(report.id, { colour: "petrol" as never })).rejects.toThrow(
      InvalidInputError,
    );
    // The Tag merged into keeps its own colour.
    expect((await core.mergeTags(notes.id, report.id)).tag.colour).toBe("teal");
    core.close();
    const reopened = startCore(dataDir);
    expect((await tagNamed(reopened, "Report")).colour).toBe("teal");
  });

  test("Tags made before colours get them: presets their own, the User's in turn", async () => {
    const db = openDatabase(join(await createTempDataFolder(), "test.db"));
    migrate(
      db,
      migrations.filter((migration) => migration.version < 27),
    );
    const at = "2026-10-01T00:00:00.000Z";
    const insert = (id: string, name: string, preset: string | null, created: string) =>
      db.run(
        "INSERT INTO tags (id, name, description, preset, created_at, updated_at) VALUES (?, ?, '', ?, ?, ?)",
        [id, name, preset, created, at],
      );
    insert("a", "Paper", "paper", at);
    insert("b", "Second", null, "2026-10-03T00:00:00.000Z");
    insert("c", "First", null, "2026-10-02T00:00:00.000Z");
    insert("d", "Invoice", "invoice", at);

    migrate(db);

    // Coloured in turn by migration 27, then moved to the bright palette by migration 28.
    expect(db.all("SELECT id, colour FROM tags ORDER BY id")).toEqual([
      { id: "a", colour: "purple" },
      { id: "b", colour: "yellow" },
      { id: "c", colour: "gray" },
      { id: "d", colour: "green" },
    ]);
    db.close();
  });

  test("Tags coloured from the first palette move to the bright one: presets on their first colour to their new one, the rest by hue, each to a different one", async () => {
    const db = openDatabase(join(await createTempDataFolder(), "test.db"));
    migrate(
      db,
      migrations.filter((migration) => migration.version < 28),
    );
    const at = "2026-10-09T00:00:00.000Z";
    const insert = (id: string, preset: string | null, colour: string) =>
      db.run(
        "INSERT INTO tags (id, name, description, preset, colour, created_at, updated_at) VALUES (?, ?, '', ?, ?, ?, ?)",
        [id, `Tag ${id}`, preset, colour, at, at],
      );
    // Every preset on its first colour.
    for (const [preset, colour] of [
      ["paper", "violet"],
      ["report", "petrol"],
      ["book", "brick"],
      ["contract", "indigo"],
      ["invoice", "rose"],
      ["slides", "orchid"],
      ["notes", "taupe"],
    ] as const) {
      insert(`preset-${preset}`, preset, colour);
    }
    // A preset the User recoloured, and the User's Tags in every first-palette colour.
    insert("recoloured-paper", "paper", "petrol");
    const first = ["stone", "taupe", "brick", "rose", "orchid", "violet", "indigo", "petrol"];
    for (const colour of first) insert(`user-${colour}`, null, colour);

    migrate(db);

    const colours = Object.fromEntries(
      db
        .all<{ id: string; colour: string }>("SELECT id, colour FROM tags")
        .map((row) => [row.id, row.colour]),
    );
    expect(colours).toMatchObject({
      "preset-paper": "purple",
      "preset-report": "blue",
      "preset-book": "orange",
      "preset-contract": "red",
      "preset-invoice": "green",
      "preset-slides": "yellow",
      "preset-notes": "gray",
      "recoloured-paper": "green",
      "user-stone": "gray",
      "user-taupe": "yellow",
      "user-brick": "orange",
      "user-rose": "red",
      "user-orchid": "purple",
      "user-violet": "teal",
      "user-indigo": "blue",
      "user-petrol": "green",
    });
    // Each first colour has its own bright one, and every stored colour is in the palette.
    expect(new Set(first.map((colour) => colours[`user-${colour}`])).size).toBe(8);
    for (const colour of Object.values(colours)) expect(TAG_COLOURS).toContain(colour);
    db.close();
  });
});

describe("the next Tag colour", () => {
  test("is the least used, the earliest in the palette on a tie", () => {
    expect(nextTagColour([])).toBe(TAG_COLOURS[0]);
    expect(nextTagColour(["red"])).toBe("orange");
    expect(nextTagColour([...TAG_COLOURS])).toBe("red");
    expect(nextTagColour([...TAG_COLOURS, "red", "orange"])).toBe("yellow");
  });
});
