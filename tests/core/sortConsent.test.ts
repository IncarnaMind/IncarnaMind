/**
 * Dropped Documents wait for the User's Allow before a cloud service reads them (#2308, ADR-0022):
 * nothing goes before the press; the press is the consent for that service alone, turns sorting
 * new Documents on there and sorts the Documents that waited; later drops go by themselves; the
 * switch turned off, another service, a walled Folder and Local mode send nothing. What a sort
 * chooses waits in Suggestions for the User (#1569). Through the core, as the footer row uses it,
 * counting every request each provider's model gets.
 */
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import type { Core, LibraryClassifier } from "../../src/core";
import type { ChatModelSpec } from "../../src/core/providers/models";
import { translate } from "../../src/shared/i18n";
import {
  createMemoryKeychain,
  createTempDataFolder,
  startCore,
  turnOnAutomaticTagging,
} from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { proposedFor } from "../helpers/library";

/** A scripted model for each provider kind, counting its requests: it files every Document in the first Folder. */
function perProvider() {
  const sent: Record<string, number> = {};
  const failing = new Set<string>();
  const models = new Map<string, MockLanguageModelV4>();
  let gate: Promise<void> | null = null;
  let open = () => {};
  const createChatModel = (spec: ChatModelSpec) => {
    const known = models.get(spec.kind);
    if (known) return known;
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        sent[spec.kind] = (sent[spec.kind] ?? 0) + 1;
        if (gate) await gate;
        if (failing.has(spec.kind)) throw new Error("fetch failed");
        const format = options.responseFormat;
        const group = (
          format?.type === "json"
            ? (format.schema as { properties?: { groupId?: { enum: string[] } } })
            : undefined
        )?.properties?.groupId;
        const answer = group ? { groupId: group.enum[0], tags: [] } : { tags: [], newTags: [] };
        return {
          content: [{ type: "text", text: JSON.stringify(answer) }],
          finishReason: { unified: "stop", raw: undefined },
          warnings: [],
          usage: {
            inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
        };
      },
    });
    models.set(spec.kind, model);
    return model;
  };
  return {
    sent: (kind: string) => sent[kind] ?? 0,
    fail: (kind: string) => failing.add(kind),
    /** Holds every answer until `release`. */
    hold: () => {
      gate = new Promise((resolve) => {
        open = resolve;
      });
    },
    release: () => {
      gate = null;
      open();
    },
    createChatModel,
  };
}

const chat = (providerId: string, modelId: string): LibraryClassifier => ({
  kind: "chat",
  choice: { providerId, modelId },
});

const TEXTS = {
  en: (index: number) =>
    `Berth survey ${index}. The depth at the north quay was measured in March.`,
  "zh-CN": (index: number) => `泊位测量报告第 ${index} 份。北码头的水深于三月测得。`,
} as const;

async function setup(language: keyof typeof TEXTS = "en") {
  const models = perProvider();
  const dataDir = await createTempDataFolder();
  // One keychain, so the key saved before a restart is there after it.
  const keychain = createMemoryKeychain();
  const core = startCore(dataDir, { createChatModel: models.createChatModel, keychain });
  if (language === "zh-CN") await core.updateSettings({ user: { language: "zh-CN" } });
  const anthropic = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: "claude-haiku-5-5",
  });
  const harbour = await core.createLibraryGroup({
    name: language === "en" ? "Harbour" : "港口",
    description: language === "en" ? "Port work." : "码头工作。",
  });
  await core.saveLibrarySettings({
    ...(await core.getLibrary()).settings,
    classifier: chat(anthropic.id, "claude-haiku-5-5"),
  });
  const sources = await createSourceFolder();
  let added = 0;
  const drop = async (options?: { groupId: string }) => {
    added++;
    const path = await writeSourceFile(sources, `Survey ${added}.txt`, TEXTS[language](added));
    const { documents } = await core.addDocuments([path], options);
    const [document] = await waitForProcessing(
      core,
      documents.map((each) => each.id),
    );
    if (!document) throw new Error("Not added.");
    return document.id;
  };
  return { core, dataDir, keychain, models, harbour, anthropic, drop };
}

/** What the footer counts: Documents in no Folder held "off", and the service named. */
async function waiting(core: Core) {
  const library = await core.getLibrary();
  const filed = new Set(library.assignments.map((each) => each.documentId));
  const ids = (await core.listDocuments())
    .filter((each) => each.tagging === "off" && !filed.has(each.id))
    .map((each) => each.id)
    .sort();
  return { service: library.sortWaitsFor?.name ?? null, ids };
}

/** The row's Allow: the switch turned on where its line says what goes, then Organize on those that waited. */
async function allow(core: Core, ids: readonly string[]) {
  const { settings } = await core.getLibrary();
  await core.saveLibrarySettings({ ...settings, automatic: true, turnOn: true });
  await core.classifyDocuments([...ids]);
}

// Waits for states, with room for a busy runner.
const WAIT = { timeout: 30_000, interval: 50 };

const filedIn = async (core: Core, id: string) =>
  (await core.getLibrary()).assignments.find((each) => each.documentId === id);

/** Sorted: Organize read them, and each waits in Suggestions to go into `folderId`, filed in none. */
async function sorted(core: Core, ids: readonly string[], folderId: string) {
  await vi.waitFor(async () => {
    for (const id of ids) {
      const found = await filedIn(core, id);
      expect([found?.groupId, found?.status, found?.error?.message]).toEqual([
        null,
        "classified",
        undefined,
      ]);
      expect(await proposedFor(core, id)).toBe(folderId);
    }
  }, WAIT);
}

describe("Dropped Documents wait for the User's Allow (#2308)", { timeout: 120_000 }, () => {
  // protects=before the press nothing reaches the cloud model and the row names it with the Documents that wait; the press sorts them and a later drop goes by itself; the switch turned off sends nothing and the row comes back; fails_when=a drop is sent without the press, the press leaves those that waited unsorted, or the switch off still sends; no_claim=the row's look, which the window test shows.
  test.each(["en", "zh-CN"] as const)(
    "%s: nothing goes before the press, the press sorts them, and off stops it",
    async (language) => {
      const { core, models, harbour, drop } = await setup(language);
      const first = [await drop(), await drop()];
      expect(models.sent("anthropic")).toBe(0);
      expect(await waiting(core)).toEqual({ service: "Anthropic", ids: [...first].sort() });

      await allow(core, first);
      await sorted(core, first, harbour.id);
      expect(models.sent("anthropic")).toBe(2);
      expect(await waiting(core)).toEqual({ service: null, ids: [] });

      const later = await drop();
      await sorted(core, [later], harbour.id);
      expect(models.sent("anthropic")).toBe(3);

      const { settings } = await core.getLibrary();
      await core.saveLibrarySettings({ ...settings, automatic: false });
      const held = await drop();
      await vi.waitFor(
        async () => expect(await waiting(core)).toEqual({ service: "Anthropic", ids: [held] }),
        WAIT,
      );
      expect(models.sent("anthropic")).toBe(3);
    },
  );

  // protects=the press allows only the service it named: once Organize sends to another service, a drop waits again with that service's name and nothing goes to it; fails_when=one service's Allow sends to another; no_claim=which services a User can choose.
  test("another service asks again on its own row", async () => {
    const { core, models, harbour, drop } = await setup();
    const first = await drop();
    await allow(core, [first]);
    await sorted(core, [first], harbour.id);
    const openai = await core.saveChatProvider({
      kind: "openai",
      apiKey: "sk-test",
      modelId: "gpt-6-luna",
    });
    await core.saveLibrarySettings({
      ...(await core.getLibrary()).settings,
      classifier: chat(openai.id, "gpt-6-luna"),
    });
    const second = await drop();
    await vi.waitFor(
      async () => expect(await waiting(core)).toEqual({ service: "OpenAI", ids: [second] }),
      WAIT,
    );
    expect([models.sent("anthropic"), models.sent("openai")]).toEqual([1, 0]);
  });

  // protects=in Local mode no row asks and nothing goes, even after the press for that service; a Document filed in a walled Folder goes nowhere by itself while one dropped beside it is sorted; fails_when=Local mode or a wall lets a Document reach the cloud model by itself; no_claim=what Local mode does for Answers.
  test("Local mode and walled Folders send nothing", async () => {
    const { core, models, harbour, drop } = await setup();
    const first = await drop();
    await allow(core, [first]);
    await sorted(core, [first], harbour.id);
    const walled = await core.createLibraryGroup({
      // After Harbour by name, so the scripted model's first Folder stays Harbour.
      name: "Matter kept apart",
      description: "Kept apart.",
      keepInside: true,
    });
    const inside = await drop({ groupId: walled.id });
    const beside = await drop();
    await sorted(core, [beside], harbour.id);
    expect(models.sent("anthropic")).toBe(2);
    expect((await filedIn(core, inside))?.groupId).toBe(walled.id);
    expect(await proposedFor(core, inside)).toBeNull();

    // Off again, a drop would wait for the Allow; in Local mode nothing asks.
    const { settings } = await core.getLibrary();
    await core.saveLibrarySettings({ ...settings, automatic: false });
    expect((await core.getLibrary()).sortWaitsFor?.name).toBe("Anthropic");
    await core.setLocalOnly(true);
    expect((await core.getLibrary()).sortWaitsFor).toBeUndefined();
    await drop();
    expect(models.sent("anthropic")).toBe(2);
  });

  // protects=Organize may propose a walled Folder, its matter's; the User's Confirm files it there, and the one Undo takes it out again, with nothing more sent; fails_when=a walled Folder can't be chosen, or Undo leaves the Document inside the wall; no_claim=which Folder a real model picks.
  test("a Document confirmed into a wall comes back out with the Undo", async () => {
    const { core, models, drop } = await setup();
    // Before Harbour by name, so the scripted model's first Folder is the walled one.
    const walled = await core.createLibraryGroup({
      name: "Archive matter",
      description: "Kept apart.",
      keepInside: true,
    });
    const document = await drop();
    await allow(core, [document]);
    await sorted(core, [document], walled.id);
    expect(models.sent("anthropic")).toBe(1);

    const { items } = await core.getOrganizeReview();
    const confirmed = await core.confirmOrganizeReview(items.map((item) => item.id));
    if (!confirmed) throw new Error("Not confirmed.");
    expect(await filedIn(core, document)).toMatchObject({ groupId: walled.id, source: "user" });
    await core.undoOrganizeReviewConfirmation(confirmed.id);
    expect((await filedIn(core, document))?.groupId).toBeNull();
    expect(models.sent("anthropic")).toBe(1);
  });

  // protects=after a restart the Allow still holds for new drops and nothing that was sorted is sent again; a sort set aside with Discard stays set aside; a failing service leaves its Document with its problem, not waiting again; fails_when=a restart forgets the Allow, sends again, re-sorts after an Undo, or counts a failed Document to sort; no_claim=how the failure is worded.
  test("a restart, an Undo and a failing service", async () => {
    const { core, dataDir, keychain, models, harbour, drop } = await setup();
    const first = await drop();
    await allow(core, [first]);
    await sorted(core, [first], harbour.id);
    core.close();

    const reopened = startCore(dataDir, { createChatModel: models.createChatModel, keychain });
    const sources = await createSourceFolder();
    const path = await writeSourceFile(sources, "Survey 9.txt", TEXTS.en(9));
    const [later] = await addAndProcess(reopened, [path]);
    if (!later) throw new Error("Not added.");
    await sorted(reopened, [later.id], harbour.id);
    expect(models.sent("anthropic")).toBe(2);

    const { items } = await reopened.getOrganizeReview();
    await reopened.discardOrganizeReview(items.map((item) => item.id));
    expect(await proposedFor(reopened, later.id)).toBeNull();
    expect(models.sent("anthropic")).toBe(2);

    models.fail("anthropic");
    const failPath = await writeSourceFile(sources, "Survey 10.txt", TEXTS.en(10));
    const [failed] = await addAndProcess(reopened, [failPath]);
    if (!failed) throw new Error("Not added.");
    await vi.waitFor(
      async () => expect((await filedIn(reopened, failed.id))?.status).toBe("failed"),
      WAIT,
    );
    expect((await waiting(reopened)).ids).not.toContain(failed.id);
    expect(models.sent("anthropic")).toBeGreaterThan(2);
  });

  // protects=the row asks only when the Allow would turn sorting on for the one service it names: with tagging sending to another service, no row shows and nothing goes to either; fails_when=the Allow turns sending on, or records consent, for a service the row doesn't name; no_claim=how such a User turns it on, which Settings does.
  test("no row when the Allow would turn on a service it doesn't name", async () => {
    const { core, models, anthropic, drop } = await setup();
    const openai = await core.saveChatProvider({
      kind: "openai",
      apiKey: "sk-test",
      modelId: "gpt-6-luna",
    });
    // Tags on Automatic, which picks the chat model's service; Organize on another one.
    await core.updateSettings({
      user: { chatModel: { providerId: openai.id, modelId: "gpt-6-luna" } },
    });
    const { settings } = await core.getLibrary();
    await core.saveLibrarySettings({
      ...settings,
      classifier: { kind: "automatic" },
      organizeWith: {
        kind: "chat",
        choice: { providerId: anthropic.id, modelId: "claude-haiku-5-5" },
      },
    });
    const held = await drop();
    expect(await waiting(core)).toEqual({ service: null, ids: [held] });
    expect([models.sent("anthropic"), models.sent("openai")]).toEqual([0, 0]);

    await core.saveLibrarySettings({
      ...(await core.getLibrary()).settings,
      classifier: chat(anthropic.id, "claude-haiku-5-5"),
      organizeWith: null,
    });
    expect((await waiting(core)).service).toBe("Anthropic");
  });

  // protects=automatic tagging, with Organize having no model, sends nothing of a Document filed in a walled Folder while one dropped beside it is tagged; fails_when=tagging sends a walled Document's name or text to a cloud model by itself; no_claim=Organize's own wall check, tested above.
  test("automatic tagging sends nothing of a walled Document", async () => {
    const models = perProvider();
    const core = startCore(await createTempDataFolder(), {
      createChatModel: models.createChatModel,
    });
    await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
    });
    await turnOnAutomaticTagging(core);
    await core.createTag({ name: "Survey", description: "Measurements taken on site." });
    const walled = await core.createLibraryGroup({
      name: "Matter kept apart",
      description: "Kept apart.",
      keepInside: true,
    });
    expect((await core.getLibrary()).settings.automatic).toBe(true);
    const sources = await createSourceFolder();
    const insidePath = await writeSourceFile(sources, "Inside.txt", TEXTS.en(1));
    const { documents } = await core.addDocuments([insidePath], { groupId: walled.id });
    const [inside] = await waitForProcessing(
      core,
      documents.map((each) => each.id),
    );
    const [beside] = await addAndProcess(core, [
      await writeSourceFile(sources, "Beside.txt", TEXTS.en(2)),
    ]);
    if (!inside || !beside) throw new Error("Not added.");
    await vi.waitFor(async () => {
      const listed = await core.listDocuments();
      expect(listed.find((each) => each.id === beside.id)?.tagging).toBe("tagged");
      expect(listed.find((each) => each.id === inside.id)?.tagging).toBe("off");
    }, WAIT);
    expect(models.sent("anthropic")).toBe(1);
  });

  // protects=quitting after the Allow, while its run is still out, the next start organizes the Documents that waited, as the User asked; fails_when=they are left in no Folder with nothing saying why; no_claim=what a request cut off mid-way costs.
  test("a quit between the Allow and its run still organizes them", async () => {
    const { core, dataDir, keychain, models, harbour, drop } = await setup();
    const first = [await drop(), await drop()];
    models.hold();
    await allow(core, first);
    await vi.waitFor(() => expect(models.sent("anthropic")).toBeGreaterThan(0), WAIT);
    core.close();
    models.release();

    const reopened = startCore(dataDir, { createChatModel: models.createChatModel, keychain });
    await sorted(reopened, first, harbour.id);
  });

  // protects=an empty Library has nothing to sort and sends nothing, while the service it would ask for is named; fails_when=the row counts Documents that aren't there; no_claim=the row, which shows only with a Document to sort.
  test("an empty Library has nothing to sort", async () => {
    const { core, models } = await setup();
    expect(await waiting(core)).toEqual({ service: "Anthropic", ids: [] });
    expect(models.sent("anthropic")).toBe(0);
  });
});

describe("The row's words (#2308)", () => {
  // protects=the row and its popover say what the design ruled, in English and Chinese, one and many; fails_when=a word drifts from the ruling; no_claim=the look.
  test.each([
    [
      "en",
      "4 to organize",
      "1 to organize",
      "Allow Anthropic",
      "4 Documents wait to be organized: Anthropic isn’t allowed to read them. Allowing it sends each Document’s name, kind and page count, the start of its text and its slide titles or sheet names, with your Folders’ names and descriptions and any matching Tags’, to Anthropic, for these and for Documents you add later.",
      "1 Document waits to be organized: Anthropic isn’t allowed to read it. Allowing it sends the Document’s name, kind and page count, the start of its text and its slide titles or sheet names, with your Folders’ names and descriptions and any matching Tags’, to Anthropic, for this one and for Documents you add later.",
    ],
    [
      "zh-CN",
      "4 个待整理",
      "1 个待整理",
      "允许 Anthropic",
      "4 个文档等待整理：尚未允许 Anthropic 读取。允许后，会把每个文档的名称、类型和页数、开头部分的文字及幻灯片标题或工作表名称，连同你的文件夹名称和描述以及相符标签的名称和描述，发送给 Anthropic，包括这些文档和以后添加的文档。",
      "1 个文档等待整理：尚未允许 Anthropic 读取。允许后，会把这个文档的名称、类型和页数、开头部分的文字及幻灯片标题或工作表名称，连同你的文件夹名称和描述以及相符标签的名称和描述，发送给 Anthropic，包括这个文档和以后添加的文档。",
    ],
  ] as const)("%s", (language, many, one, allowLabel, sends, sendsOne) => {
    expect(translate(language, "library.toSort.other", { count: 4 })).toBe(many);
    expect(translate(language, "library.toSort.one")).toBe(one);
    expect(translate(language, "library.toSort.allow", { service: "Anthropic" })).toBe(allowLabel);
    expect(
      translate(language, "library.toSort.sends.other", { count: 4, service: "Anthropic" }),
    ).toBe(sends);
    expect(translate(language, "library.toSort.sends.one", { service: "Anthropic" })).toBe(
      sendsOne,
    );
  });
});
