import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import {
  type AiUseEntry,
  BLOCK_ID_ATTRIBUTE,
  DATABASE_FILE,
  GENERATED_MARK,
  InvalidInputError,
  NotFoundError,
  type RecordAiUseInput,
  type UsageDataSender,
  type UsageEventMessage,
} from "../../src/core";
import { migrate, openDatabase } from "../../src/core/storage";
import { migrations } from "../../src/core/storage/migrations";
import { createTempDataFolder, nextEvent, queryDatabase, startCore } from "../helpers/core";
import { connectToMind, type MindClient } from "../helpers/mindClient";

/** Adds a paragraph with a Block id, the way the editor stores one, and returns the id. */
function addBlock(client: MindClient, text: string): string {
  const id = randomUUID();
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.setAttribute(BLOCK_ID_ATTRIBUTE, id);
  paragraph.insert(0, [new Y.XmlText(text)]);
  client.blocks.push([paragraph]);
  return id;
}

function blockOf(client: MindClient, id: string): Y.XmlElement {
  for (const child of client.blocks.toArray()) {
    if (child instanceof Y.XmlElement && child.getAttribute(BLOCK_ID_ATTRIBUTE) === id) {
      return child;
    }
  }
  throw new Error(`No Block ${id}.`);
}

async function setUp() {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir);
  const mind = await core.createMind({ title: "Essay" });
  const client = await connectToMind(core, mind.id);
  return { dataDir, core, mind, client };
}

const MODEL = { providerId: "anthropic", modelId: "claude-haiku" };

const outcomes = (entries: readonly AiUseEntry[]) => entries.map((entry) => entry.outcome);

describe("The record of AI use", () => {
  test("each kind of insertion records one entry, with the model, size and time", async () => {
    const { core, mind, client } = await setUp();
    const answer = addBlock(client, "Spring tides happen at new moon.");
    const edit = addBlock(client, "Rewritten by Edit with AI.");
    await client.settled();

    const entries = await core.recordAiUse([
      { mindId: mind.id, kind: "answer-added", characters: 32, blockIds: [answer], ...MODEL },
      { mindId: mind.id, kind: "suggestion-accepted", characters: 21, ...MODEL },
      { mindId: mind.id, kind: "edit-with-ai-accepted", characters: 26, blockIds: [edit] },
      { mindId: mind.id, kind: "assistant-change-rejected", characters: 40, ...MODEL },
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual([
      "answer-added",
      "suggestion-accepted",
      "edit-with-ai-accepted",
      "assistant-change-rejected",
    ]);
    const listed = await core.listAiUse();
    expect(listed).toEqual(entries);
    expect(listed[0]).toMatchObject({
      mindId: mind.id,
      outcome: "kept",
      providerId: "anthropic",
      modelId: "claude-haiku",
      characters: 32,
      blockIds: [answer],
    });
    expect(listed[0]?.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(listed[2]).toMatchObject({ providerId: null, modelId: null });
    expect(outcomes(listed)).toEqual(["kept", "kept", "kept", "rejected"]);
    expect(await core.getAiUseStatus()).toEqual({ entries: 4 });
  });

  test("a change of three Blocks, two accepted and one rejected, records three entries", async () => {
    const { core, mind, client } = await setUp();
    const first = addBlock(client, "First accepted Block.");
    const second = addBlock(client, "Second accepted Block.");
    await client.settled();

    await core.recordAiUse([
      { mindId: mind.id, kind: "assistant-change-accepted", characters: 21, blockIds: [first] },
      { mindId: mind.id, kind: "assistant-change-accepted", characters: 22, blockIds: [second] },
      // Rejected Blocks made nothing in the Mind, so a Block id sent with one is not followed.
      {
        mindId: mind.id,
        kind: "assistant-change-rejected",
        characters: 30,
        blockIds: [randomUUID()],
      },
    ]);

    const entries = await core.listAiUse(mind.id);
    expect(outcomes(entries)).toEqual(["kept", "kept", "rejected"]);
    expect(entries[2]?.blockIds).toEqual([]);
  });

  test("a later edit marks the entry edited, and deleting its Block marks it deleted", async () => {
    const { core, mind, client } = await setUp();
    const edited = addBlock(client, "The tide rises twice a day.");
    const removed = addBlock(client, "A claim the AI made.");
    const untouched = addBlock(client, "Left alone.");
    await client.settled();
    await core.recordAiUse(
      [edited, removed, untouched].map(
        (blockId): RecordAiUseInput => ({
          mindId: mind.id,
          kind: "answer-added",
          characters: 20,
          blockIds: [blockId],
        }),
      ),
    );

    const text = blockOf(client, edited).get(0);
    if (!(text instanceof Y.XmlText)) throw new Error("Expected text.");
    text.insert(0, "Roughly: ");
    const index = client.blocks.toArray().indexOf(blockOf(client, removed));
    client.blocks.delete(index, 1);
    await client.settled();

    expect(outcomes(await core.listAiUse())).toEqual(["edited", "deleted", "kept"]);

    // Putting the words back by hand is not an edit any more.
    text.delete(0, "Roughly: ".length);
    await client.settled();
    expect((await core.listAiUse())[0]?.outcome).toBe("kept");
  });

  test("Mark as mine changes no word: the entry stays kept (#95)", async () => {
    const { core, mind, client } = await setUp();
    const id = addBlock(client, "Spring tides happen at new moon.");
    const text = blockOf(client, id).get(0);
    if (!(text instanceof Y.XmlText)) throw new Error("Expected text.");
    text.format(0, text.length, { [GENERATED_MARK]: {} });
    await client.settled();
    await core.recordAiUse([
      { mindId: mind.id, kind: "answer-added", characters: text.length, blockIds: [id] },
    ]);

    text.format(0, "Spring tides".length, { [GENERATED_MARK]: null });
    await client.settled();
    expect(outcomes(await core.listAiUse())).toEqual(["kept"]);
  });

  test("an insertion of several Blocks is edited when only some are gone", async () => {
    const { core, mind, client } = await setUp();
    const first = addBlock(client, "One.");
    const second = addBlock(client, "Two.");
    await client.settled();
    await core.recordAiUse([
      { mindId: mind.id, kind: "answer-added", characters: 8, blockIds: [first, second] },
    ]);

    client.blocks.delete(client.blocks.toArray().indexOf(blockOf(client, first)), 1);
    await client.settled();
    expect(outcomes(await core.listAiUse())).toEqual(["edited"]);

    client.blocks.delete(0, 1);
    await client.settled();
    expect(outcomes(await core.listAiUse())).toEqual(["deleted"]);
  });

  test("a Block whose update comes after the record is followed from the moment it arrives", async () => {
    const { core, mind, client } = await setUp();
    const id = randomUUID();
    await core.recordAiUse([
      { mindId: mind.id, kind: "answer-added", characters: 5, blockIds: [id] },
    ]);
    // Not in the Mind yet: not deleted, just not seen.
    expect(outcomes(await core.listAiUse())).toEqual(["kept"]);

    const paragraph = new Y.XmlElement("paragraph");
    paragraph.setAttribute(BLOCK_ID_ATTRIBUTE, id);
    paragraph.insert(0, [new Y.XmlText("Late.")]);
    client.blocks.push([paragraph]);
    await client.settled();
    expect(outcomes(await core.listAiUse())).toEqual(["kept"]);

    client.blocks.delete(0, 1);
    await client.settled();
    expect(outcomes(await core.listAiUse())).toEqual(["deleted"]);
  });

  test("outcomes are kept when the app quits, without anyone reading the record", async () => {
    const { dataDir, core, mind, client } = await setUp();
    const id = addBlock(client, "Written by the AI.");
    await client.settled();
    await core.recordAiUse([
      { mindId: mind.id, kind: "answer-added", characters: 18, blockIds: [id] },
    ]);
    client.blocks.delete(0, 1);
    await client.settled();

    core.close();

    expect(
      queryDatabase<{ outcome: string }>(dataDir, "SELECT outcome FROM ai_use").map(
        (row) => row.outcome,
      ),
    ).toEqual(["deleted"]);
  });

  test("Clear empties the record and Undo brings it back", async () => {
    const { core, mind } = await setUp();
    await core.recordAiUse([
      { mindId: mind.id, kind: "suggestion-accepted", characters: 10, ...MODEL },
      { mindId: mind.id, kind: "suggestion-accepted", characters: 12, ...MODEL },
    ]);
    const changed = nextEvent(core, "aiUse.changed");

    const cleared = await core.clearAiUse();

    expect(cleared.count).toBe(2);
    expect(await changed).toEqual({ entries: 0 });
    expect(await core.listAiUse()).toEqual([]);
    expect(await core.getAiUseStatus()).toEqual({ entries: 0 });

    expect(await core.restoreAiUse(cleared.clearedAt)).toEqual({ entries: 2 });
    expect(await core.listAiUse()).toHaveLength(2);
  });

  test("a cleared record holds nothing but ids, sizes, kinds, models or agents, and times", async () => {
    const { dataDir, core, mind, client } = await setUp();
    const id = addBlock(client, "A sentence nobody should find in the table.");
    await client.settled();
    await core.recordAiUse([
      { mindId: mind.id, kind: "answer-added", characters: 44, blockIds: [id], ...MODEL },
    ]);
    core.close();

    const [row] = queryDatabase<Record<string, unknown>>(dataDir, "SELECT * FROM ai_use");
    expect(JSON.stringify(row)).not.toContain("nobody should find");
    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        "agent",
        "blocks",
        "characters",
        "created_at",
        "deleted_at",
        "id",
        "kind",
        "mind_id",
        "model_id",
        "occurred_at",
        "outcome",
        "provider_id",
        "updated_at",
      ].sort(),
    );
  });

  test("the record survives a restart", async () => {
    const { dataDir, core, mind } = await setUp();
    await core.recordAiUse([{ mindId: mind.id, kind: "suggestion-accepted", characters: 9 }]);
    core.close();

    const again = startCore(dataDir);
    expect(await again.listAiUse()).toHaveLength(1);
  });

  test("bad input is refused and records nothing", async () => {
    const { core, mind } = await setUp();
    const good: RecordAiUseInput = { mindId: mind.id, kind: "answer-added", characters: 1 };

    await expect(core.recordAiUse([{ ...good, mindId: randomUUID() }])).rejects.toThrow(
      NotFoundError,
    );
    await expect(
      core.recordAiUse([good, { ...good, kind: "mystery" as RecordAiUseInput["kind"] }]),
    ).rejects.toThrow(InvalidInputError);
    await expect(core.recordAiUse([{ ...good, characters: -1 }])).rejects.toThrow(
      InvalidInputError,
    );
    await expect(core.recordAiUse([{ ...good, characters: 1.5 }])).rejects.toThrow(
      InvalidInputError,
    );
    await expect(core.recordAiUse([{ ...good, occurredAt: "yesterday-ish" }])).rejects.toThrow(
      InvalidInputError,
    );
    await expect(core.recordAiUse([{ ...good, blockIds: [""] }])).rejects.toThrow(
      InvalidInputError,
    );
    expect(await core.getAiUseStatus()).toEqual({ entries: 0 });
  });

  test("a database from before the record gains it, and keeps its Minds", async () => {
    const dataDir = await createTempDataFolder();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    migrate(
      db,
      migrations.filter((migration) => migration.version < 46),
    );
    const at = "2026-10-01T09:00:00.000Z";
    const mindId = randomUUID();
    db.run("INSERT INTO minds (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", [
      mindId,
      "Old Mind",
      at,
      at,
    ]);
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'ai_use'")).toBeUndefined();
    db.close();

    const core = startCore(dataDir);

    expect(await core.listAiUse()).toEqual([]);
    await core.recordAiUse([{ mindId, kind: "suggestion-accepted", characters: 3 }]);
    expect(await core.getAiUseStatus()).toEqual({ entries: 1 });
    expect((await core.listMinds()).map((mind) => mind.title)).toEqual(["Old Mind"]);
  });
});

describe("The record of AI use stays on this computer", () => {
  test("nothing is sent, whatever the usage-data setting", async () => {
    const sent: UsageEventMessage[] = [];
    const sender: UsageDataSender = {
      service: { id: "https://analytics.example.com", name: "PostHog (analytics.example.com)" },
      // A test build sends until the User says no: the most it can ever send.
      testerBuild: true,
      appVersion: "1.2.3",
      setEnabled: () => undefined,
      capture: (message) => {
        sent.push(message);
      },
    };
    const core = startCore(await createTempDataFolder(), { usageData: sender });
    const mind = await core.createMind();
    const flowsBefore = await core.listRegisteredDataFlows();
    const trafficBefore = await core.listNetworkTraffic();
    expect((await core.getPrivacySettings()).usageData.enabled).toBe(true);
    const before = sent.length;

    const client = await connectToMind(core, mind.id);
    const id = addBlock(client, "Written by the AI.");
    await client.settled();
    await core.recordAiUse([
      { mindId: mind.id, kind: "answer-added", characters: 18, blockIds: [id], ...MODEL },
      { mindId: mind.id, kind: "assistant-change-rejected", characters: 18, ...MODEL },
    ]);
    client.blocks.delete(0, 1);
    await client.settled();
    await core.listAiUse();
    const cleared = await core.clearAiUse();
    await core.restoreAiUse(cleared.clearedAt);

    // Whatever else the app sent about creating a Mind, nothing came of the record.
    expect(sent.slice(before)).toEqual([]);
    expect(JSON.stringify(sent)).not.toMatch(/ai.?use|claude-haiku|anthropic/i);
    // It is no data flow and no network traffic either: there is nothing to allow or turn off.
    expect(await core.listRegisteredDataFlows()).toEqual(flowsBefore);
    expect(await core.listNetworkTraffic()).toEqual(trafficBefore);
  });

  test("the module reaches neither the network nor the usage-data catalog", () => {
    const source = readFileSync(join(__dirname, "../../src/core/aiUse.ts"), "utf8");
    const imports = [...source.matchAll(/^import .*? from "(.+?)";$/gms)].map((match) => match[1]);
    expect(imports.filter((from) => !from?.startsWith("."))).toEqual(["node:crypto", "yjs"]);
    expect(imports).not.toContain("./usageData");
    expect(imports).not.toContain("./usageEvents");
    expect(imports).not.toContain("./consent");
    expect(source).not.toMatch(/\bfetch\(|node:http|node:net|XMLHttpRequest/);
  });
});
