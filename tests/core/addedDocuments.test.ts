/**
 * Documents added since a Mind's checks (#993): only the checks found
 * unsupported or not checked are offered again, and only for Documents added
 * to the scope they used; Check again checks only those, each in its scope.
 */
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { type CheckMindInput, DATABASE_FILE } from "../../src/core";
import { openDatabase } from "../../src/core/storage";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { checkGenerate, checkReply, isCheckRun, type Plan } from "../helpers/checks";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";

const MOON = "Spring tides come at new and full moon.";
const YEARLY = "Harbours publish the times of high water every year.";
const PENGUINS = "Penguins nest on the cliffs above the harbour.";
const PUFFINS = "Puffins dig their burrows in the turf.";
const WEEKLY = "The harbour office publishes the times of high water every week.";

const text = (value: string): JSONContent => ({ type: "text", text: value });

async function setUp() {
  const plans: Record<string, Plan> = {
    [MOON]: { verdict: "supported", quote: MOON },
    [YEARLY]: {
      verdict: "contradicted",
      quote: WEEKLY,
      says: "The harbour office says every week, not every year.",
    },
    [PENGUINS]: { verdict: "unsupported" },
    [PUFFINS]: { verdict: "unsupported" },
  };
  const calls: ModelCall[] = [];
  const model = scriptedModel(
    (call) => {
      calls.push(call);
      return checkReply(call, plans);
    },
    { generate: checkGenerate(plans) },
  );
  const clock = manualClock("2026-10-02T14:20:00.000Z");
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    createChatModel: scriptedModels(model).createChatModel,
    now: clock.now,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const sources = await createTempDataFolder();
  const add = async (name: string, contents: string) => {
    const [document] = await addAndProcess(core, [await writeSourceFile(sources, name, contents)]);
    if (!document) throw new Error(`${name} wasn't added.`);
    return document;
  };
  const tides = await add("Tides.md", `# Tides\n\n${MOON}\n\n${WEEKLY}\n`);
  const folder = await core.createLibraryGroup({ name: "Harbours", description: "" });
  await core.moveToFolder({ documentIds: [tides.id], folderId: folder.id });
  const mind = await core.createMind({ title: "Harbour notes", folderId: folder.id });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [
    { type: "paragraph", attrs: { id: "one" }, content: [text(`${MOON} ${YEARLY} ${PENGUINS}`)] },
    { type: "paragraph", attrs: { id: "two" }, content: [text(PUFFINS)] },
  ]);
  await client.settled();
  const checkRuns = () => calls.filter((call) => isCheckRun(call) && call.results.length === 0);
  return {
    core,
    client,
    clock,
    plans,
    add,
    dataDir,
    mindId: mind.id,
    folderId: folder.id,
    checkRuns,
  };
}

const request = (mindId: string, mode: CheckMindInput["mode"]): CheckMindInput => ({
  requestId: `run-${mode}`,
  mindId,
  mode,
});

const checksIn = async (client: Awaited<ReturnType<typeof setUp>>["client"]) => {
  await client.settled();
  return claimSpans(readMind(client)).map((span) => ({
    sentence: span.sentence.text.trim(),
    id: span.check.id,
    state: span.check.state,
    widened: span.check.scope.widened,
  }));
};

describe("Documents added since a Mind's checks", () => {
  test("only an unsupported check is offered, for a Document filed into its Folder since, and Check again checks it alone", async () => {
    const { core, client, clock, plans, add, mindId, folderId, checkRuns } = await setUp();
    const colony = await add("Colony.md", `# Colony\n\n${PENGUINS}\n`);
    clock.advance(60_000);
    await core.checkMind(request(mindId, "all"));
    const checked = await checksIn(client);
    expect(checked.map((each) => [each.sentence, each.state])).toEqual([
      [MOON, "supported"],
      [YEARLY, "contradicted"],
      [PENGUINS, "unsupported"],
      [PUFFINS, "unsupported"],
    ]);
    expect(await core.documentsAddedSinceChecks(mindId)).toEqual([]);

    clock.advance(60_000);
    await add("Seabirds.md", `# Seabirds\n\n${PENGUINS}\n`);
    expect(await core.documentsAddedSinceChecks(mindId)).toEqual([]);
    expect(await core.planMindCheck(mindId, "added")).toEqual({ kind: "nothing" });

    clock.advance(60_000);
    await core.moveToFolder({ documentIds: [colony.id], folderId });
    const unsupported = checked.filter((each) => each.state === "unsupported");
    expect(await core.documentsAddedSinceChecks(mindId)).toEqual(
      unsupported.map((each) => ({ checkId: each.id, documentIds: [colony.id] })),
    );
    expect(await core.planMindCheck(mindId, "added")).toEqual({
      kind: "ready",
      sentences: 2,
      findsClaims: false,
      inFolder: true,
      model: (await core.getSettings()).user.chatModel,
    });

    plans[PENGUINS] = { verdict: "supported", quote: PENGUINS };
    const before = checkRuns().length;
    clock.advance(60_000);
    expect(await core.checkMind(request(mindId, "added"))).toMatchObject({
      kind: "checked",
      sentences: 2,
      checked: 2,
    });
    expect(checkRuns().length - before).toBe(2);
    const after = await checksIn(client);
    expect(after.map((each) => [each.sentence, each.state])).toEqual([
      [MOON, "supported"],
      [YEARLY, "contradicted"],
      [PENGUINS, "supported"],
      [PUFFINS, "unsupported"],
    ]);
    expect(after.slice(0, 2).map((each) => each.id)).toEqual(checked.slice(0, 2).map((e) => e.id));
    expect(await core.documentsAddedSinceChecks(mindId)).toEqual([]);
  });

  test("a check made in every Document counts a Document added anywhere, and is checked again in every Document", async () => {
    const { core, client, clock, add, mindId } = await setUp();
    await core.checkMind({ ...request(mindId, "all"), allDocuments: true });
    const checked = await checksIn(client);
    expect(checked.every((each) => each.widened)).toBe(true);

    clock.advance(60_000);
    const elsewhere = await add("Seabirds.md", `# Seabirds\n\n${PENGUINS}\n`);
    const unsupported = checked.filter((each) => each.state === "unsupported");
    expect(await core.documentsAddedSinceChecks(mindId)).toEqual(
      unsupported.map((each) => ({ checkId: each.id, documentIds: [elsewhere.id] })),
    );
    expect(await core.planMindCheck(mindId, "added")).toMatchObject({
      kind: "ready",
      inFolder: false,
    });
    clock.advance(60_000);
    await core.checkMind(request(mindId, "added"));
    const after = await checksIn(client);
    expect(after.filter((each) => each.sentence === PENGUINS || each.sentence === PUFFINS)).toEqual(
      [
        expect.objectContaining({ state: "unsupported", widened: true }),
        expect.objectContaining({ state: "unsupported", widened: true }),
      ],
    );
    expect(await core.documentsAddedSinceChecks(mindId)).toEqual([]);
  });

  test("mixed scopes name all Documents while each sentence keeps the scope it searched", async () => {
    const { core, client, clock, add, mindId, folderId } = await setUp();
    await core.checkMind(request(mindId, "all"));
    await core.checkSentences({
      requestId: "widen-puffins",
      mindId,
      action: "check-against-documents",
      from: { blockId: "two", offset: 0 },
      to: { blockId: "two", offset: PUFFINS.length },
      allDocuments: true,
    });
    clock.advance(60_000);
    const added = await add("Seabirds.md", `# Seabirds\n\n${PENGUINS}\n`);
    await core.moveToFolder({ documentIds: [added.id], folderId });
    expect(await core.planMindCheck(mindId, "added")).toMatchObject({
      kind: "ready",
      sentences: 2,
      inFolder: false,
    });
    clock.advance(60_000);
    await core.checkMind(request(mindId, "added"));
    const checks = await checksIn(client);
    expect(checks.find((each) => each.sentence === PENGUINS)?.widened).toBe(false);
    expect(checks.find((each) => each.sentence === PUFFINS)?.widened).toBe(true);
    expect(await core.documentsAddedSinceChecks(mindId)).toEqual([]);
  });

  test("Undo restores when a Document joined its Folder, even after moving it twice", async () => {
    const { core, clock, mindId, folderId } = await setUp();
    const before = (await core.getLibrary()).assignments.find((each) => each.groupId === folderId);
    if (!before) throw new Error("No filed Document.");
    clock.advance(60_000);
    await core.checkMind(request(mindId, "all"));
    for (const time of [1, 2]) {
      clock.advance(60_000);
      const move = await core.moveToFolder({ documentIds: [before.documentId], folderId: null });
      const moved = move.documents[0];
      if (!moved) throw new Error(`Move ${time} returned no Document.`);
      clock.advance(60_000);
      await core.restoreAssignment(moved.id, moved.previous);
      expect(
        (await core.getLibrary()).assignments.find((each) => each.documentId === moved.id),
      ).toEqual(before);
      expect(await core.documentsAddedSinceChecks(mindId)).toEqual([]);
      expect(await core.planMindCheck(mindId, "added")).toEqual({ kind: "nothing" });
    }
    clock.advance(60_000);
    await core.deleteLibraryGroup(folderId);
    clock.advance(60_000);
    await core.restore([{ kind: "folder", id: folderId }]);
    expect(await core.documentsAddedSinceChecks(mindId)).toEqual([]);
    expect(await core.planMindCheck(mindId, "added")).toEqual({ kind: "nothing" });
    await expect(
      core.restoreAssignment(before.documentId, { ...before, filedAt: "yesterday" }),
    ).rejects.toThrow();
  });

  test("filings from before migration 98 use their creation time, including when Undo restores them", async () => {
    const { core, clock, add, dataDir, mindId, folderId } = await setUp();
    clock.advance(60_000);
    await core.checkMind(request(mindId, "all"));
    clock.advance(60_000);
    const added = await add("Seabirds.md", `# Seabirds\n\n${PENGUINS}\n`);
    await core.moveToFolder({ documentIds: [added.id], folderId });
    const expected = await core.documentsAddedSinceChecks(mindId);
    expect(expected).toHaveLength(2);
    core.close();

    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.exec("ALTER TABLE document_groups DROP COLUMN filed_at");
      db.run("DELETE FROM schema_migrations WHERE version = ?", [98]);
    } finally {
      db.close();
    }
    const reopened = startCore(dataDir, { now: clock.now });
    expect(await reopened.documentsAddedSinceChecks(mindId)).toEqual(expected);
    const before = (await reopened.getLibrary()).assignments.find(
      (each) => each.documentId === added.id,
    );
    clock.advance(60_000);
    const move = await reopened.moveToFolder({ documentIds: [added.id], folderId: null });
    const moved = move.documents[0];
    if (!moved) throw new Error("Move returned no Document.");
    clock.advance(60_000);
    await reopened.restoreAssignment(moved.id, moved.previous);
    expect(
      (await reopened.getLibrary()).assignments.find((each) => each.documentId === added.id),
    ).toEqual(before);
    expect(await reopened.documentsAddedSinceChecks(mindId)).toEqual(expected);
  });
});
