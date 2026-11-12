/**
 * A profile saved before #2308 holds the switch for tagging and sorting new Documents with no list
 * of the services the User turned it on for, and nothing stored tells a turn-on from a consent
 * given elsewhere: an old Turn on…, Organize's, the Privacy page's Allow, TypeSafe Jev's key, a
 * model chosen for Tags. So for a service outside this computer it reads off until the User
 * presses Turn on…; a model on this computer keeps it (#2623, ADR-0022). Through the core's
 * public interface, counting what each service's stand-in receives.
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

async function saveCloudModel(core: Core): Promise<LibraryClassifier> {
  const provider = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: "claude-haiku-5-5",
  });
  return { kind: "chat", choice: { providerId: provider.id, modelId: "claude-haiku-5-5" } };
}

/** A cloud model chosen for Tags in Settings, with no Turn on…: Organize's consent, not tagging's. */
async function chooseCloudModel(core: Core): Promise<LibraryClassifier> {
  const classifier = await saveCloudModel(core);
  await core.saveLibrarySettings({ ...(await core.getLibrary()).settings, classifier });
  return classifier;
}

/**
 * Rewrites the stored switch as a version before #2308 saved it: `automatic`, and no list of
 * turn-ons. With `place`, the upgrade's place in the database's order for that service, as it
 * leaves a switch it found on (the next arrival then counts as new there). With `chosenTagging`,
 * the tagging consent reads as a build before #2308 recorded it when a model was chosen for Tags.
 */
function storeAsBefore2308(
  dataDir: string,
  library: { classifier: unknown; automatic: boolean },
  { place, chosenTagging = false }: { place?: string; chosenTagging?: boolean } = {},
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
    if (chosenTagging) {
      db.run(
        `UPDATE data_flow_consents SET chosen = 1
         WHERE flow = 'tagging' AND service_id = ? AND decision = 'accepted' AND deleted_at IS NULL`,
        [ANTHROPIC],
      );
      expect(
        db.get("SELECT 1 AS found FROM data_flow_consents WHERE flow = 'tagging' AND chosen = 1"),
      ).toBeDefined();
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

/** Each kind of consent an older profile can hold for the service tagging sends to. */
const CONSENTS: {
  consent: string;
  sendsTo: "jev" | "cloud";
  /** Saves the profile as the older build left it; returns the model chosen for Tags. */
  setUp(core: Core): Promise<LibraryClassifier>;
  chosenTagging?: boolean;
}[] = [
  {
    consent: "tagging's, from an old Turn on…",
    sendsTo: "cloud",
    setUp: async (core) => {
      const classifier = await saveCloudModel(core);
      await turnOn(core, classifier);
      return classifier;
    },
  },
  {
    consent: "Organize's, from choosing the model",
    sendsTo: "cloud",
    setUp: chooseCloudModel,
  },
  {
    consent: "tagging's, from the Privacy page",
    sendsTo: "cloud",
    setUp: async (core) => {
      const classifier = await chooseCloudModel(core);
      await core.allowDataFlow("tagging", ANTHROPIC);
      return classifier;
    },
  },
  {
    consent: "tagging's, from choosing it for Tags",
    sendsTo: "cloud",
    setUp: async (core) => {
      const classifier = await chooseCloudModel(core);
      await core.allowDataFlow("tagging", ANTHROPIC);
      return classifier;
    },
    chosenTagging: true,
  },
  {
    consent: "Organize's, under Automatic",
    sendsTo: "cloud",
    setUp: async (core) => {
      // The chat model chosen first leaves Organize's consent, as Organize's own model did before
      // it stopped keeping one (#2835); then Automatic, which tags with the chat model.
      await chooseCloudModel(core);
      const classifier: LibraryClassifier = { kind: "automatic" };
      await core.saveLibrarySettings({ ...(await core.getLibrary()).settings, classifier });
      return classifier;
    },
  },
  {
    consent: "tagging's, from TypeSafe Jev's key",
    sendsTo: "jev",
    setUp: async (core) => {
      await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
      await chooseJev(core);
      return { kind: "jev" };
    },
  },
];

const ARMS = CONSENTS.flatMap((each) =>
  [
    { folder: false, placeKept: true },
    { folder: false, placeKept: false },
    { folder: true, placeKept: true },
    { folder: true, placeKept: false },
  ].map((arm) => ({ ...each, ...arm })),
);

describe.each([{ language: "en-US" }, { language: "zh-CN" }])(
  "A profile saved before #2308 reads tagging off for a service outside this computer until Turn on…, in $language (#2623)",
  {
    timeout: 30_000,
  },
  ({ language }) => {
    test.each(ARMS)(
      "with $consent on record (a Folder there: $folder; the upgrade kept a place: $placeKept): nothing goes out until Turn on…, then only what arrives after",
      async ({ sendsTo, setUp, chosenTagging, folder, placeKept }) => {
        const { jev, tagging, dataDir, options, start } = await startWithJev({
          systemLanguages: () => [language],
        });
        const before = start();
        const classifier = await setUp(before);
        before.close();
        storeAsBefore2308(
          dataDir,
          { classifier, automatic: true },
          {
            place: placeKept ? (sendsTo === "jev" ? TYPESAFE : ANTHROPIC) : undefined,
            chosenTagging,
          },
        );

        const core = startCore(dataDir, options);
        if (folder) await core.createLibraryGroup({ name: "Finance", description: "Reports." });
        expect((await core.getLibrary()).settings).toMatchObject({ classifier, automatic: false });
        const held = await add(core, "季度报告.txt", "季度报告：本季度收入增长百分之十。");
        const [settled] = await settledTagging(core, [held.id]);

        expect(settled?.tagging).toBe("off");
        expect(jev.requests).toEqual([]);
        expect(tagging.requests).toEqual([]);

        // The same steps do send once the User presses Turn on…, and only for what arrives after:
        // tagged, or with a Folder there, organized.
        await turnOn(core);
        const sent = await add(core, "Report.txt", "A quarterly report on revenue.");
        await (sendsTo === "jev" ? jev.requested(1) : tagging.requested(1));
        await settledTagging(core, [sent.id]);

        const received =
          sendsTo === "jev"
            ? jev.requests.map((request) => JSON.stringify(request.body))
            : tagging.requests.map((request) => request.text);
        expect((await core.getLibrary()).settings.automatic).toBe(true);
        expect(jev.requests.length + tagging.requests.length).toBe(1);
        expect(received).toHaveLength(1);
        expect(received[0]).toContain("A quarterly report on revenue.");
        expect(received[0]).not.toContain("季度报告");
        expect((await core.listDocuments()).find((each) => each.id === held.id)?.tagging).toBe(
          "off",
        );
      },
    );

    test("a model on this computer keeps its switch, and choosing Jev for sorting in Settings turns nothing on", async () => {
      const { jev, tagging, dataDir, options, start } = await startWithJev({
        systemLanguages: () => [language],
      });
      const before = start();
      await before.saveChatProvider({ kind: "ollama", modelId: "local-model" });
      await before.saveLibrarySettings({
        ...(await before.getLibrary()).settings,
        classifier: { kind: "automatic" },
      });
      before.close();
      storeAsBefore2308(dataDir, { classifier: { kind: "automatic" }, automatic: true });

      const core = startCore(dataDir, options);
      expect((await core.getLibrary()).settings.automatic).toBe(true);
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

    test("a profile that turned tagging on for Jev since the list was kept keeps it on, across a restart and a new key save", async () => {
      const { jev, dataDir, options, start } = await startWithJev({
        systemLanguages: () => [language],
      });
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
  },
);
