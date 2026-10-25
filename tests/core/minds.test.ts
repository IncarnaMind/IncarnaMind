import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { InvalidInputError, type Mind, NotFoundError } from "../../src/core";
import { EDIT_TOUCH_INTERVAL_MS } from "../../src/core/minds";
import {
  createTempDataFolder,
  manualClock,
  queryDatabase,
  startCore,
  tickingClock,
} from "../helpers/core";
import { appendParagraph, connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";

const titles = (minds: Mind[]) => minds.map((mind) => mind.title);

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("Minds", () => {
  test("a new data folder has no Minds", async () => {
    const core = startCore(await createTempDataFolder());

    expect(await core.listMinds()).toEqual([]);
  });

  test("creating a Mind returns it with a random UUID and timestamps", async () => {
    const core = startCore(await createTempDataFolder(), {
      now: () => new Date("2026-10-06T12:00:00Z"),
    });

    const mind = await core.createMind({ title: "  Reading list  " });

    expect(mind).toEqual({
      id: expect.stringMatching(UUID_V4),
      title: "Reading list",
      autoTitle: "",
      kind: "mind",
      createdAt: "2026-10-06T12:00:00.000Z",
      updatedAt: "2026-10-06T12:00:00.000Z",
      // Not in a Folder.
      folderId: null,
    });
    expect(await core.listMinds()).toEqual([mind]);
  });

  test("a Mind created without a title has an empty title", async () => {
    const core = startCore(await createTempDataFolder());

    const mind = await core.createMind();

    expect(mind.title).toBe("");
    expect(await core.listMinds()).toEqual([mind]);
  });

  test("a Mind made with its name, headed, starts with it as a Heading 1 and an empty line under it (#908)", async () => {
    const core = startCore(await createTempDataFolder());

    const mind = await core.createMind({ title: "Fieldwork plan", headed: true });
    const plain = await core.createMind({ title: "Plain" });

    const headed = await connectToMind(core, mind.id);
    expect(readMind(headed).toJSON().content).toEqual([
      expect.objectContaining({
        type: "heading",
        attrs: expect.objectContaining({ level: 1 }),
        content: [{ type: "text", text: "Fieldwork plan" }],
      }),
      expect.objectContaining({ type: "paragraph" }),
    ]);
    expect(readMind(await connectToMind(core, plain.id)).textContent).toBe("");
  });

  test("a new Mind to write in, headed with no name, starts with an empty Heading 1, its title to be typed, and is named Untitled (#1088)", async () => {
    const core = startCore(await createTempDataFolder());

    const mind = await core.createMind({ headed: true });

    expect(readMind(await connectToMind(core, mind.id)).toJSON().content).toEqual([
      expect.objectContaining({ type: "heading", attrs: expect.objectContaining({ level: 1 }) }),
    ]);
    expect(mind.title).toBe("");
  });

  test("every Mind gets its own id", async () => {
    const core = startCore(await createTempDataFolder());

    const minds = await Promise.all([core.createMind(), core.createMind(), core.createMind()]);

    expect(new Set(minds.map((mind) => mind.id)).size).toBe(3);
  });

  test("Minds are listed most recently updated first", async () => {
    const core = startCore(await createTempDataFolder(), { now: tickingClock() });

    const first = await core.createMind({ title: "First" });
    const second = await core.createMind({ title: "Second" });
    const third = await core.createMind({ title: "Third" });

    expect(await core.listMinds()).toEqual([third, second, first]);
  });

  test("Minds created before a restart are still there after it", async () => {
    const dataDir = await createTempDataFolder();
    const before = startCore(dataDir, { now: tickingClock() });
    const papers = await before.createMind({ title: "Papers" });
    const contracts = await before.createMind({ title: "Contracts" });
    before.close();

    const after = startCore(dataDir);

    expect(await after.listMinds()).toEqual([contracts, papers]);
  });

  test("the data folder is created if it doesn't exist yet", async () => {
    const dataDir = join(await createTempDataFolder(), "nested", "IncarnaMind");
    const core = startCore(dataDir);

    const mind = await core.createMind({ title: "Fresh start" });

    expect(await core.listMinds()).toEqual([mind]);
  });

  test("a title that isn't text is rejected", async () => {
    const core = startCore(await createTempDataFolder());

    await expect(core.createMind({ title: 42 } as never)).rejects.toThrow(InvalidInputError);
    expect(await core.listMinds()).toEqual([]);
  });
});

describe("Renaming Minds", () => {
  test("renaming a Mind changes its title, trimmed, and moves it to the top", async () => {
    const core = startCore(await createTempDataFolder(), { now: tickingClock() });
    const first = await core.createMind({ title: "First" });
    const second = await core.createMind({ title: "Second" });

    const renamed = await core.renameMind(first.id, "  Literature review  ");

    expect(renamed).toEqual({ ...first, title: "Literature review", updatedAt: renamed.updatedAt });
    expect(renamed.updatedAt > second.updatedAt).toBe(true);
    expect(await core.listMinds()).toEqual([renamed, second]);
  });

  test("an empty title leaves the Mind untitled", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Draft" });

    expect((await core.renameMind(mind.id, "   ")).title).toBe("");
  });

  test("a new title survives a restart", async () => {
    const dataDir = await createTempDataFolder();
    const before = startCore(dataDir);
    const renamed = await before.renameMind((await before.createMind()).id, "Contracts");
    before.close();

    expect(await startCore(dataDir).listMinds()).toEqual([renamed]);
  });

  test("a title that isn't text, or a Mind that doesn't exist, is rejected", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Kept" });

    await expect(core.renameMind(mind.id, 42 as never)).rejects.toThrow(InvalidInputError);
    await expect(core.renameMind(randomUUID(), "Lost")).rejects.toThrow(NotFoundError);
    expect(await core.listMinds()).toEqual([mind]);
  });
});

describe("Deleting Minds", () => {
  test("a deleted Mind leaves the list but stays stored, marked deleted with its content", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, { now: tickingClock() });
    const kept = await core.createMind({ title: "Kept" });
    const deleted = await core.createMind({ title: "Deleted" });
    const writer = await connectToMind(core, deleted.id);
    appendParagraph(writer, "Soon gone from the list");
    await writer.settled();

    await core.deleteMind(deleted.id);

    expect(await core.listMinds()).toEqual([kept]);
    const [row] = queryDatabase<{ title: string; deleted_at: string | null }>(
      dataDir,
      "SELECT title, deleted_at FROM minds WHERE id = ?",
      [deleted.id],
    );
    expect(row).toEqual({ title: "Deleted", deleted_at: expect.any(String) });
    const content = queryDatabase<{ deleted_at: string | null }>(
      dataDir,
      "SELECT deleted_at FROM mind_updates WHERE mind_id = ?",
      [deleted.id],
    );
    expect(content).not.toHaveLength(0);
    expect(content).toEqual(content.map(() => ({ deleted_at: row?.deleted_at })));
  });

  test("a deleted Mind can't be opened, edited, renamed or deleted again", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind();
    await core.deleteMind(mind.id);

    await expect(core.openMind(mind.id)).rejects.toThrow(NotFoundError);
    await expect(core.applyMindUpdate(mind.id, new Uint8Array([0, 0]))).rejects.toThrow(
      NotFoundError,
    );
    await expect(core.renameMind(mind.id, "Back")).rejects.toThrow(NotFoundError);
    await expect(core.deleteMind(mind.id)).rejects.toThrow(NotFoundError);
  });

  test("a deleted Mind stays out of the list after a restart", async () => {
    const dataDir = await createTempDataFolder();
    const before = startCore(dataDir, { now: tickingClock() });
    const kept = await before.createMind({ title: "Kept" });
    await before.deleteMind((await before.createMind({ title: "Deleted" })).id);
    before.close();

    expect(await startCore(dataDir).listMinds()).toEqual([kept]);
  });
});

describe("Ordering Minds by last edited", () => {
  test("editing a Mind's content moves it to the top, also after a restart", async () => {
    const dataDir = await createTempDataFolder();
    const clock = manualClock();
    const core = startCore(dataDir, { now: clock.now });
    const minds: Record<string, Mind> = {};
    for (const title of ["Oldest", "Middle", "Newest"]) {
      minds[title] = await core.createMind({ title });
      clock.advance(1000);
    }
    const edit = async (title: string, text: string) => {
      const client = await connectToMind(core, `${minds[title]?.id}`);
      appendParagraph(client, text);
      await client.settled();
      clock.advance(1000);
    };

    await edit("Oldest", "Back to the oldest");
    expect(titles(await core.listMinds())).toEqual(["Oldest", "Newest", "Middle"]);

    await edit("Middle", "Now the middle one");
    expect(titles(await core.listMinds())).toEqual(["Middle", "Oldest", "Newest"]);

    core.close();
    expect(titles(await startCore(dataDir).listMinds())).toEqual(["Middle", "Oldest", "Newest"]);
  });

  test("typing moves a Mind's updatedAt at most once per interval, unless another Mind was edited in between", async () => {
    const clock = manualClock("2026-10-06T09:00:00.000Z");
    const core = startCore(await createTempDataFolder(), { now: clock.now });
    const notes = await core.createMind({ title: "Notes" });
    const other = await core.createMind({ title: "Other" });
    const writer = await connectToMind(core, notes.id);
    const otherWriter = await connectToMind(core, other.id);
    const typeAt = async (ms: number) => {
      clock.advance(ms);
      appendParagraph(writer, "typing");
      await writer.settled();
      return (await core.listMinds()).find((mind) => mind.id === notes.id)?.updatedAt;
    };

    expect(await typeAt(1000)).toBe("2026-10-06T09:00:01.000Z");
    expect(await typeAt(1000)).toBe("2026-10-06T09:00:01.000Z");
    expect(await typeAt(EDIT_TOUCH_INTERVAL_MS - 1000)).toBe("2026-10-06T09:00:11.000Z");

    appendParagraph(otherWriter, "an edit elsewhere");
    await otherWriter.settled();
    expect(await typeAt(1000)).toBe("2026-10-06T09:00:12.000Z");
  });

  test("the core pushes the list of Minds whenever it changes", async () => {
    const clock = manualClock();
    const core = startCore(await createTempDataFolder(), { now: clock.now });
    const listener = vi.fn();
    core.on("minds.changed", listener);

    const mind = await core.createMind({ title: "Pushed" });
    expect(listener).toHaveBeenLastCalledWith([mind]);

    const renamed = await core.renameMind(mind.id, "Renamed");
    expect(listener).toHaveBeenLastCalledWith([renamed]);

    clock.advance(EDIT_TOUCH_INTERVAL_MS);
    const writer = await connectToMind(core, mind.id);
    appendParagraph(writer, "An edit");
    await writer.settled();
    expect(listener).toHaveBeenLastCalledWith(await core.listMinds());
    expect(listener.mock.lastCall?.[0][0].updatedAt).toBe(clock.now().toISOString());

    await core.deleteMind(mind.id);
    expect(listener).toHaveBeenLastCalledWith([]);
    expect(listener).toHaveBeenCalledTimes(4);
  });
});
