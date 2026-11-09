/**
 * A profile saved before #2308 holds the switch for tagging and sorting new Documents with no list
 * of the services the User turned it on for. Its consents say what the User allowed, not that they
 * turned the switch on: TypeSafe Jev's key save records the tagging flow with no turn-on (#2623,
 * ADR-0022). Through the core's public interface, counting what TypeSafe's Jev receives.
 */
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type Core, DATABASE_FILE, type LibraryClassifier } from "../../src/core";
import { openDatabase } from "../../src/core/storage";
import {
  createMemoryKeychain,
  createTempDataFolder,
  startCore,
  type TestAdapters,
} from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { JEV_KEY, startFakeJev } from "../helpers/jev";
import { scriptedModels } from "../helpers/models";
import { taggingModel, waitForTagging } from "../helpers/tags";

const AT = "2026-10-30T09:00:00.000Z";
const TYPESAFE = "https://api.typesafe.ai";
const ANTHROPIC = "https://api.anthropic.com";

const settledTagging = (core: Core, ids: readonly string[]) =>
  waitForTagging(
    core,
    ids,
    (each) => !["pending", "tagging", "waiting-for-provider"].includes(each.tagging),
  );

async function add(core: Core, name: string, text: string) {
  const [document] = await addAndProcess(core, [
    await writeSourceFile(await createSourceFolder(), name, text),
  ]);
  if (!document) throw new Error("Nothing was added.");
  return document;
}

/** Choosing Jev for sorting as Settings does: its key, then the choice, the switch as shown. */
async function chooseJev(core: Core) {
  await core.saveJevSettings({ apiKey: JEV_KEY });
  const { settings } = await core.getLibrary();
  await core.saveLibrarySettings({ ...settings, classifier: { kind: "jev" } });
}

/** Turn on…, with the line on screen. */
async function turnOn(core: Core, classifier?: LibraryClassifier) {
  const { settings } = await core.getLibrary();
  await core.saveLibrarySettings({
    ...settings,
    ...(classifier && { classifier }),
    automatic: true,
    turnOn: true,
  });
}

/**
 * Rewrites the stored switch as a version before #2308 saved it: `automatic`, and no list of
 * turn-ons. With `place`, the upgrade's place in the database's order for that service, as it
 * leaves a switch it found on (the next arrival then counts as new there).
 */
function storeAsBefore2308(
  dataDir: string,
  library: { classifier: unknown; automatic: boolean },
  place?: string,
) {
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    const stored = {
      ...library,
      ...(place && { automaticSinceSeq: { [place]: 1 } }),
      taggingStopped: [],
    };
    db.run("UPDATE device_settings SET value = ? WHERE key = 'library' AND deleted_at IS NULL", [
      JSON.stringify(stored),
    ]);
    expect(db.get("SELECT 1 AS found FROM device_settings WHERE key = 'library'")).toBeDefined();
    if (place) {
      db.run(
        `INSERT INTO tagging_sequence (id, value, created_at, updated_at) VALUES ('tagging', 1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET value = max(value, 1)`,
        [AT, AT],
      );
    }
  } finally {
    db.close();
  }
}

async function startWithJev(overrides: TestAdapters = {}) {
  const jev = await startFakeJev();
  const tagging = taggingModel(["Report"]);
  const keychain = createMemoryKeychain();
  const dataDir = await createTempDataFolder();
  const options: TestAdapters = {
    keychain,
    jevHostedUrl: jev.url,
    createChatModel: scriptedModels(tagging.model).createChatModel,
    ...overrides,
  };
  return { jev, tagging, dataDir, options, start: () => startCore(dataDir, options) };
}

describe("A profile saved before #2308 never counts Jev's key as turning tagging on (#2623)", {
  timeout: 30_000,
}, () => {
  test.each([
    { folder: false, placeKept: true },
    { folder: false, placeKept: false },
    { folder: true, placeKept: true },
    { folder: true, placeKept: false },
  ])(
    "Jev chosen (a Folder there: $folder; the upgrade kept a place for its consent: $placeKept): nothing goes to TypeSafe until Turn on…",
    async ({ folder, placeKept }) => {
      const { jev, dataDir, options, start } = await startWithJev();
      const before = start();
      await before.saveChatProvider({ kind: "ollama", modelId: "local-model" });
      await chooseJev(before);
      before.close();
      storeAsBefore2308(
        dataDir,
        { classifier: { kind: "jev" }, automatic: true },
        placeKept ? TYPESAFE : undefined,
      );

      const core = startCore(dataDir, options);
      if (folder) await core.createLibraryGroup({ name: "Finance", description: "Reports." });
      expect((await core.getLibrary()).settings).toMatchObject({
        classifier: { kind: "jev" },
        automatic: false,
      });
      const held = await add(core, "季度报告.txt", "季度报告：本季度收入增长百分之十。");
      const [settled] = await settledTagging(core, [held.id]);

      expect(settled?.tagging).toBe("off");
      expect(jev.requests).toEqual([]);

      // The same steps do send once the User presses Turn on…, and only for what arrives after.
      await turnOn(core);
      const sent = await add(core, "Report.txt", "A quarterly report on revenue.");
      await jev.requested(1);
      await settledTagging(core, [sent.id]);

      expect((await core.getLibrary()).settings.automatic).toBe(true);
      expect(jev.requests).toHaveLength(1);
      expect(JSON.stringify(jev.requests[0]?.body)).toContain("A quarterly report on revenue.");
      expect((await core.listDocuments()).find((each) => each.id === held.id)?.tagging).toBe("off");
    },
  );

  test("choosing Jev for sorting in Settings turns nothing on that was on for a model on this computer", async () => {
    const { jev, tagging, dataDir, options, start } = await startWithJev();
    const before = start();
    await before.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    await before.saveLibrarySettings({
      ...(await before.getLibrary()).settings,
      classifier: { kind: "automatic" },
    });
    before.close();
    storeAsBefore2308(dataDir, { classifier: { kind: "automatic" }, automatic: true });

    const core = startCore(dataDir, options);
    const here = await add(core, "On this computer.txt", "A quarterly report.");
    await waitForTagging(core, [here.id]);
    expect(tagging.requests).toHaveLength(1);

    await chooseJev(core);
    const held = await add(core, "Held.txt", "Another quarterly report.");
    const [settled] = await settledTagging(core, [held.id]);

    expect((await core.getLibrary()).settings).toMatchObject({
      classifier: { kind: "jev" },
      automatic: false,
    });
    expect(settled?.tagging).toBe("off");
    expect(jev.requests).toEqual([]);

    await turnOn(core);
    const sent = await add(core, "Sent.txt", "A third quarterly report.");
    await waitForTagging(core, [sent.id]);
    expect(jev.requests).toHaveLength(1);
  });

  test("a profile that turned tagging on for Jev keeps it on, across a restart and a new key save", async () => {
    const { jev, dataDir, options, start } = await startWithJev();
    const before = start();
    await before.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    await before.saveJevSettings({ apiKey: JEV_KEY });
    await turnOn(before, { kind: "jev" });
    before.close();

    const core = startCore(dataDir, options);
    expect((await core.getLibrary()).settings.automatic).toBe(true);
    await core.saveJevSettings({ apiKey: JEV_KEY });
    const sent = await add(core, "Report.txt", "A quarterly report on revenue.");
    await waitForTagging(core, [sent.id]);

    expect((await core.getLibrary()).settings.automatic).toBe(true);
    expect(jev.requests).toHaveLength(1);
  });

  test("a profile saved before #2308 that turned tagging on for a cloud model keeps it on", async () => {
    const { jev, tagging, dataDir, options, start } = await startWithJev();
    const before = start();
    const provider = await before.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
    });
    const classifier: LibraryClassifier = {
      kind: "chat",
      choice: { providerId: provider.id, modelId: "claude-haiku-5-5" },
    };
    await turnOn(before, classifier);
    before.close();
    storeAsBefore2308(dataDir, { classifier, automatic: true }, ANTHROPIC);

    const core = startCore(dataDir, options);
    expect((await core.getLibrary()).settings.automatic).toBe(true);
    const sent = await add(core, "Report.txt", "A quarterly report on revenue.");
    await waitForTagging(core, [sent.id]);

    expect(tagging.requests).toHaveLength(1);
    expect(jev.requests).toEqual([]);
  });
});
