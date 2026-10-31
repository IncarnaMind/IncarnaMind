import { chmod, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { type Core, MIND_CONTENT_FIELD, type UnsavedChanges } from "../../src/core";
import { unsavedReason } from "../../src/core/unsavedChanges";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { failMindDeleteCommits, refuseWrites } from "../helpers/failingStorage";
import { appendParagraph, connectToMind } from "../helpers/mindClient";
import { note } from "../helpers/minds";

/**
 * Changes storage refuses (#1119), through the core's public interface as a
 * window uses it: they stay in memory, reach every window at once, are said
 * with a reason, are stored with the next change, on a backoff and on closing,
 * and a crash leaves a count for the next start. Storage fails through a
 * SQLite trigger on synthetic data, not a real full disk.
 */

afterEach(() => {
  vi.useRealTimers();
});

const failWrites = (dataDir: string) => refuseWrites(dataDir);

/** The core's paths, with a temporary folder of its own, where it keeps its count of changes waiting. */
const tempPaths = async (dataDir: string) => ({
  dataDir,
  home: join(dataDir, "home"),
  documents: join(dataDir, "Documents"),
  tempDir: await mkdtemp(join(tmpdir(), "incarnamind-temp-")),
});

/** A copy of a new Mind holding "BASE", stored, that sends each change as the editor does. */
async function typingIn(core: Core) {
  const mind = await core.createMind({ title: "Notes" });
  const doc = new Y.Doc();
  Y.applyUpdate(doc, (await core.openMind(mind.id)).state, core);
  const sent: Promise<"stored" | "refused">[] = [];
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === core) return;
    sent.push(
      core.applyMindUpdate(mind.id, update).then(
        () => "stored" as const,
        () => "refused" as const,
      ),
    );
  });
  core.on("mind.update", (event) => {
    if (event.mindId === mind.id) Y.applyUpdate(doc, event.update, core);
  });
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText("BASE");
  paragraph.insert(0, [text]);
  doc.getXmlFragment(MIND_CONTENT_FIELD).push([paragraph]);
  await Promise.all(sent);
  return {
    mindId: mind.id,
    doc,
    /** Types at the end of the paragraph, and says whether the core took it. */
    type: (words: string) => {
      text.insert(text.length, words);
      const outcome = sent.at(-1);
      if (!outcome) throw new Error("Nothing was sent.");
      return outcome;
    },
  };
}

const textOf = (state: Uint8Array) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc.getXmlFragment(MIND_CONTENT_FIELD).toString();
};

/** What a Mind holds once the app has quit and started again. */
async function afterRestart(dataDir: string, mindId: string): Promise<string> {
  return textOf((await startCore(dataDir).openMind(mindId)).state);
}

const storedRows = (dataDir: string, mindId: string) =>
  queryDatabase<{ count: number }>(
    dataDir,
    "SELECT count(*) AS count FROM mind_updates WHERE mind_id = ? AND deleted_at IS NULL",
    [mindId],
  )[0]?.count ?? 0;

describe("Changes storage refuses (#1119)", () => {
  // protects=after one write fails, the User's later typing is stored, and the refused change with it, there after a restart, and nothing tells the window a change failed; fails_when=later typing vanishes on reopen, or the window is told to send again; no_claim=a real full disk.
  test("typing after a refused write is stored with it, and all of it is there after a restart", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const copy = await typingIn(core);
    const restore = failWrites(dataDir);

    expect(await copy.type(" LOST")).toBe("stored");
    restore();
    expect(await copy.type(" AFTER")).toBe("stored");
    core.close();

    expect(await afterRestart(dataDir, copy.mindId)).toBe("<paragraph>BASE LOST AFTER</paragraph>");
  });

  // protects=the core's own edit while storage fails (Add to note) applies, reaches the windows at once, doesn't throw, so its caller never tries again, and is stored once storage is back: one paragraph, not two; fails_when=Add to note fails and, tried again, leaves two paragraphs, or the windows don't see it; no_claim=none beyond protects.
  test("Add to note while storage fails applies once, reaches the windows, and is stored later", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const mind = await core.createMind({ title: "Notes" });
    const client = await connectToMind(core, mind.id);
    const restore = failWrites(dataDir);

    await core.addToNote({ mindId: mind.id, blocks: [note("ADDED")], origin: null, model: null });

    expect(client.blocks.toString()).toContain("ADDED");
    restore();
    await core.saveChangesAgain();
    core.close();
    const after = await afterRestart(dataDir, mind.id);
    expect(after.match(/ADDED/g)).toHaveLength(1);
  });

  // protects=while changes wait, the core says how many, in which Mind, why in plain words (a full disk) and the database's own words for Details, as an event and when asked; and that nothing waits once they are stored; fails_when=the User isn't told, or the reason is SQLite's text; no_claim=the notice's look, which the e2e checks.
  test("what waits is said with its reason, and nothing once it is stored", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const copy = await typingIn(core);
    const heard: (UnsavedChanges | null)[] = [];
    core.on("minds.unsaved", (state) => heard.push(state));
    const restore = failWrites(dataDir);

    await copy.type(" ONE");
    await copy.type(" TWO");

    expect(await core.unsavedChanges()).toEqual({
      count: 2,
      mindIds: [copy.mindId],
      reason: "full",
      detail: expect.stringContaining("database or disk is full"),
    });
    restore();
    expect(await core.saveChangesAgain()).toBeNull();
    expect(heard.at(-1)).toBeNull();
    expect(heard[0]).toMatchObject({ count: 1, reason: "full" });
  });

  // protects=storage's refusals read as plain reasons by SQLite's own codes (full, I/O, read-only, busy) and by their words; fails_when=a full disk reads as an unknown failure; no_claim=none beyond protects.
  test.each([
    [{ errcode: 13, message: "database or disk is full" }, "full"],
    [{ errcode: 266, message: "disk I/O error" }, "io"],
    [{ errcode: 8, message: "attempt to write a readonly database" }, "readOnly"],
    [{ errcode: 5, message: "database is locked" }, "busy"],
    [{ errcode: 19, message: "database or disk is full" }, "full"],
    [{ errcode: 19, message: "constraint failed" }, "other"],
  ] as const)("%o reads as %s", (failure, reason) => {
    expect(unsavedReason(Object.assign(new Error(failure.message), failure))).toBe(reason);
  });

  // protects=changes that wait are stored as one merged row, not once per try, and on their own once storage is back, on a backoff, with nothing typed; fails_when=each try stores the queue again, or nothing is stored until the next change; no_claim=the exact delays.
  test("what waits is stored once storage is back, as one row, with nothing typed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const copy = await typingIn(core);
    const before = storedRows(dataDir, copy.mindId);
    const restore = failWrites(dataDir);
    for (const word of [" A", " B", " C"]) await copy.type(word);
    restore();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(await core.unsavedChanges()).toBeNull();
    expect(storedRows(dataDir, copy.mindId)).toBe(before + 1);
    core.close();
    expect(await afterRestart(dataDir, copy.mindId)).toBe("<paragraph>BASE A B C</paragraph>");
  });

  // protects=closing a Mind stores what waits first, though its rows were compacted to one; fails_when=closing drops it from memory and it is lost; no_claim=none beyond protects.
  test("closing a Mind stores what waits first", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const copy = await typingIn(core);
    await core.closeMind(copy.mindId);
    const restore = failWrites(dataDir);
    await copy.type(" LOST");
    restore();

    await core.closeMind(copy.mindId);

    expect(await core.unsavedChanges()).toBeNull();
    const reader = new Y.Doc();
    Y.applyUpdate(reader, (await startCore(dataDir).openMind(copy.mindId)).state);
    expect(reader.getXmlFragment(MIND_CONTENT_FIELD).toString()).toBe(
      "<paragraph>BASE LOST</paragraph>",
    );
  });

  // protects=a change that builds on one the core never got is refused, the whole copy then stores it, and a later change of another window's isn't refused for it; fails_when=the dependent change is acknowledged and lost, or every later change says it wasn't saved; no_claim=none beyond protects.
  test("a change after one the core never got is refused, alone", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const copy = await typingIn(core);
    copy.doc.transact(() => {
      const paragraph = copy.doc.getXmlFragment(MIND_CONTENT_FIELD).get(0);
      const words = paragraph instanceof Y.XmlElement ? paragraph.get(0) : null;
      if (words instanceof Y.XmlText) words.insert(words.length, " MISSED");
    }, core);

    expect(await copy.type(" NEXT")).toBe("refused");
    expect(await copy.type(" MORE")).toBe("refused");
    const other = await connectToMind(core, copy.mindId);
    appendParagraph(other, "ELSEWHERE");
    await expect(other.settled()).resolves.toBeUndefined();
    await core.applyMindUpdate(copy.mindId, Y.encodeStateAsUpdate(copy.doc));
    core.close();

    expect(await afterRestart(dataDir, copy.mindId)).toBe(
      "<paragraph>BASE MISSED NEXT MORE</paragraph><paragraph>ELSEWHERE</paragraph>",
    );
  });

  // protects=a copy of a Mind can be exported while storage refuses every write, and holds what waits: the rescue never needs a write; fails_when=noting the file as IncarnaMind's fails the export; no_claim=the host's saving of the file, which the e2e checks.
  test("a copy exports while storage refuses every write, with what waits in it", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const copy = await typingIn(core);
    const restore = refuseWrites(dataDir, { every: true });
    await copy.type(" LOST");

    const exported = await core.exportMind(copy.mindId, { format: "markdown" });

    expect(new TextDecoder().decode(exported.data)).toContain("BASE LOST");
    restore();
  });

  // protects=quitting tries once more: storage back, what waits is stored though nothing was typed since; fails_when=it is lost at quit; no_claim=none beyond protects.
  test("quitting once storage works again stores what waits", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const copy = await typingIn(core);
    const restore = failWrites(dataDir);
    await copy.type(" LOST");
    restore();

    core.close();

    expect(await afterRestart(dataDir, copy.mindId)).toBe("<paragraph>BASE LOST</paragraph>");
  });

  // protects=a run that ends without quitting while changes wait (a crash) leaves their count for the next start, said once; a run that quits leaves none, as the quit sheet told the User; fails_when=the next start says nothing of a crash's loss, says it twice, or speaks after a quit; no_claim=what the count file survives.
  test("a crash leaves the count of changes lost for the next start, once; quitting leaves 0", async () => {
    const dataDir = await createTempDataFolder();
    const tempDir = await mkdtemp(join(tmpdir(), "incarnamind-temp-"));
    const paths = {
      dataDir,
      home: join(dataDir, "home"),
      documents: join(dataDir, "Documents"),
      tempDir,
    };
    const crashed = startCore(dataDir, { paths });
    const copy = await typingIn(crashed);
    const restore = failWrites(dataDir);
    await copy.type(" ONE");
    await copy.type(" TWO");

    const next = startCore(dataDir, { paths });

    expect(await next.takeLostChanges()).toBe(2);
    expect(await next.takeLostChanges()).toBeNull();
    crashed.close();
    restore();
    expect(await startCore(dataDir, { paths }).takeLostChanges()).toBe(0);
  });

  // protects=the next start says nothing was lost only when the last run wrote that down (#2309); fails_when=a stored run leaves no count, so the next start can't tell; no_claim=what a crash says.
  test("a run that stored everything leaves 0", async () => {
    const dataDir = await createTempDataFolder();
    const paths = await tempPaths(dataDir);
    const copy = await typingIn(startCore(dataDir, { paths }));
    expect(await copy.type(" KEPT")).toBe("stored");
    expect(await startCore(dataDir, { paths }).takeLostChanges()).toBe(0);
  });

  // protects=a count that couldn't be written is never read back as the old 0 (#2309); fails_when=a refused write leaves the last {"count":0} readable, so a crash's loss reads as nothing; no_claim=a temporary folder that refuses removing too.
  test.skipIf(process.platform === "win32")(
    "one whose count couldn't be written leaves no answer",
    async () => {
      const dataDir = await createTempDataFolder();
      const paths = await tempPaths(dataDir);
      const copy = await typingIn(startCore(dataDir, { paths }));
      const [countFile] = await readdir(paths.tempDir);
      if (!countFile) throw new Error("The count was never written.");
      expect(await readFile(join(paths.tempDir, countFile), "utf8")).toBe('{"count":0}');

      // Read-only, as a disk that refuses writes leaves it: the old 0 could still be read.
      await chmod(join(paths.tempDir, countFile), 0o400);
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const restore = failWrites(dataDir);
      await copy.type(" LOST");
      restore();
      expect(logged).toHaveBeenCalledWith(
        "unsaved: the count of changes waiting couldn't be written",
        expect.anything(),
      );
      expect(await startCore(dataDir, { paths }).takeLostChanges()).toBeNull();
    },
  );

  // protects=as Windows ends the session, what waits is stored at once when storage takes it, and what it still refuses is counted for the host to record (#2309); fails_when=the session's end leaves stored changes unsaid as lost or loses count of refused ones; no_claim=Windows's own timing.
  test("the session's end stores what waits at once, or says how many it still couldn't", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const copy = await typingIn(core);
    const restore = failWrites(dataDir);
    await copy.type(" ONE");
    await copy.type(" TWO");
    expect(core.sessionEnding()).toEqual({
      count: 2,
      minds: [{ mindId: copy.mindId, count: 2 }],
    });
    restore();
    expect(core.sessionEnding()).toEqual({ count: 0, minds: [] });
    expect(await core.unsavedChanges()).toBeNull();
    expect(await afterRestart(dataDir, copy.mindId)).toBe("<paragraph>BASE ONE TWO</paragraph>");
  });

  // protects=quitting while storage still fails quits cleanly, keeps what was stored before, and says in the log which Mind lost how many changes; fails_when=quitting throws, the stored text is damaged, or the loss goes unlogged; no_claim=that the refused change survives, which nothing can store.
  test("quitting while storage still fails keeps what was stored, and logs what was lost", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const copy = await typingIn(core);
    const restore = failWrites(dataDir);
    await copy.type(" LOST");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => core.close()).not.toThrow();
    restore();

    expect(logged.mock.calls.flat().join(" ")).toContain(copy.mindId);
    logged.mockRestore();
    expect(await afterRestart(dataDir, copy.mindId)).toBe("<paragraph>BASE</paragraph>");
  });
});

describe("Changes waiting when their Mind is deleted (#1202)", () => {
  // protects=a Mind deleted while its changes wait keeps them: they are stored, deleted with it, once storage is back, and Restore brings back everything typed; fails_when=deleting drops them, and the restored Mind lacks the typing; no_claim=none beyond protects.
  test.each(["after", "before"] as const)(
    "restored %s storage is back, the Mind holds what was typed",
    async (when) => {
      const dataDir = await createTempDataFolder();
      const core = startCore(dataDir);
      const copy = await typingIn(core);
      const restore = failWrites(dataDir);
      await copy.type(" LOST");

      await core.deleteMind(copy.mindId);
      if (when === "before") await core.restore([{ kind: "mind", id: copy.mindId }]);
      restore();
      expect(await core.saveChangesAgain()).toBeNull();
      if (when === "after") await core.restore([{ kind: "mind", id: copy.mindId }]);
      core.close();

      expect(await afterRestart(dataDir, copy.mindId)).toBe("<paragraph>BASE LOST</paragraph>");
    },
  );

  // protects=a Restore that throws partway leaves a deleted Mind as it was: its waiting changes still count with no copy offered, and are stored deleted once storage is back, never as live text; fails_when=the failed Restore brings the Mind back in memory, so a copy is offered or the next save stores the changes live; no_claim=none beyond protects.
  test("a Restore that fails partway leaves the deleted Mind's waiting changes as they were", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const copy = await typingIn(core);
    const restore = failWrites(dataDir);
    await copy.type(" LOST");
    await core.deleteMind(copy.mindId);

    await expect(
      core.restore([
        { kind: "mind", id: copy.mindId },
        { kind: "mind", id: "no-such-mind" },
      ]),
    ).rejects.toThrow();

    expect(await core.unsavedChanges()).toMatchObject({ count: 1, mindIds: [] });
    restore();
    expect(await core.saveChangesAgain()).toBeNull();
    expect(storedRows(dataDir, copy.mindId)).toBe(0);
    core.close();
  });

  // protects=what waits in a deleted Mind still counts, for the notice and the quit sheet, but no copy of it is offered; fails_when=the count leaves it out, so quitting says nothing of it; no_claim=the sheet's look, which the e2e checks.
  test("a deleted Mind's waiting changes count, with no copy offered", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const copy = await typingIn(core);
    const restore = failWrites(dataDir);
    await copy.type(" ONE");
    await copy.type(" TWO");

    await core.deleteMind(copy.mindId);

    expect(await core.unsavedChanges()).toMatchObject({ count: 2, mindIds: [] });
    restore();
  });

  // protects=a deletion that fails, at its own write or at its commit, leaves the Mind there, and what is typed after it is stored as the Mind's; fails_when=memory takes the Mind for deleted, so that typing is stored as deleted and is gone after a restart; no_claim=none beyond protects.
  test.each(["write", "commit"] as const)(
    "a deletion that fails at its %s keeps the Mind, with what is typed after it",
    async (step) => {
      const dataDir = await createTempDataFolder();
      const core = startCore(dataDir);
      const copy = await typingIn(core);
      const restoreWrites = refuseWrites(dataDir, { updates: step === "write" });
      const restoreCommits = step === "commit" ? failMindDeleteCommits(dataDir) : null;
      await copy.type(" WAITS");

      await expect(core.deleteMind(copy.mindId)).rejects.toThrow();
      restoreCommits?.();
      restoreWrites();
      expect(await copy.type(" AFTER")).toBe("stored");
      core.close();

      const again = startCore(dataDir);
      expect((await again.listMinds()).map((mind) => mind.id)).toContain(copy.mindId);
      again.close();
      expect(await afterRestart(dataDir, copy.mindId)).toBe(
        "<paragraph>BASE WAITS AFTER</paragraph>",
      );
    },
  );

  // protects=deleting for good that fails keeps what waits in a Mind it would have purged; fails_when=that Mind's waiting changes go though nothing was purged; no_claim=none beyond protects.
  test("deleting for good that fails keeps what waits", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const copy = await typingIn(core);
    const restore = failWrites(dataDir);
    await copy.type(" WAITS");
    await core.deleteMind(copy.mindId);

    await expect(
      core.deletePermanently([
        { kind: "mind", id: copy.mindId },
        { kind: "mind", id: "no-such-mind" },
      ]),
    ).rejects.toThrow();

    expect(await core.unsavedChanges()).toMatchObject({ count: 1 });
    restore();
  });

  // protects=deleting a Mind for good drops what of it waits, and says so in the log; fails_when=it keeps being tried, or the notice never goes; no_claim=none beyond protects.
  test("deleted for good, what waits goes, and the log says so", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const copy = await typingIn(core);
    const restore = failWrites(dataDir);
    await copy.type(" LOST");
    await core.deleteMind(copy.mindId);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await core.deletePermanently([{ kind: "mind", id: copy.mindId }]);

    expect(await core.unsavedChanges()).toBeNull();
    expect(logged.mock.calls.flat().join(" ")).toContain(copy.mindId);
    logged.mockRestore();
    restore();
  });
});
