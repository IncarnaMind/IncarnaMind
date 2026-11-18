/**
 * Sorting and tagging new Documents is on until the User turns it off, but for a cloud service it
 * asks before the first Document goes there (#2308, #3353, ADR-0022). Nothing goes before the
 * answer; Allow is the consent for every service the row names, turns sorting new Documents on
 * there and reads the Documents that waited, organized where there are Folders and tagged where
 * there are none; later ones go by themselves. The no, the switch turned off, a consent taken back,
 * another service, a walled Folder and Local mode send nothing, and only the first asks. What a
 * sort chooses waits in Suggestions for the User (#1569). Through the core's public interface, as
 * the footer row uses it, counting every request each provider's model gets: what reaches a model
 * has passed the send gate.
 */
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import type { Core, LibraryClassifier } from "../../src/core";
import type { ChatModelSpec } from "../../src/core/providers/models";
import { translate } from "../../src/shared/i18n";
import { sortingSwitchOn } from "../../src/shared/libraryModels";
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
import { waitForTagging } from "../helpers/tags";

const ANTHROPIC = "https://api.anthropic.com";

/**
 * A scripted model for each provider kind, counting its requests: it files every Document in the
 * first Folder, and gives each it tags the Report kind.
 */
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
        const user = options.prompt.find((message) => message.role === "user");
        const data = (() => {
          try {
            return JSON.parse(
              user && typeof user.content !== "string"
                ? user.content.map((part) => ("text" in part ? part.text : "")).join("")
                : "{}",
            ) as { documents?: { ref: string }[] };
          } catch {
            return {};
          }
        })();
        const answer = group
          ? { groupId: group.enum[0], tags: [] }
          : {
              tagged: (data.documents ?? []).map((document) => ({
                ref: document.ref,
                kind: "report",
                tags: [],
                topic: { name: "", description: "" },
              })),
            };
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

/**
 * A User with Anthropic as their AI model who never touched the switch. `folder`: Harbour there,
 * and the model chosen for Organize and Tags; otherwise no Folder and Automatic, as a new profile.
 */
async function setup(language: keyof typeof TEXTS = "en", { folder = true } = {}) {
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
  const harbour = folder
    ? await core.createLibraryGroup({
        name: language === "en" ? "Harbour" : "港口",
        description: language === "en" ? "Port work." : "码头工作。",
      })
    : null;
  if (folder) {
    await core.saveLibrarySettings({
      ...(await core.getLibrary()).settings,
      classifier: chat(anthropic.id, "claude-haiku-5-5"),
    });
  }
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

/** What the footer shows: the services it names, and the Documents in no Folder held "off". */
async function waiting(core: Core) {
  const library = await core.getLibrary();
  const filed = new Set(library.assignments.map((each) => each.documentId));
  const ids = (await core.listDocuments())
    .filter((each) => each.tagging === "off" && !filed.has(each.id))
    .map((each) => each.id)
    .sort();
  return { services: library.asksFor.map((each) => each.name), ids };
}

/**
 * The row's Allow, as the footer presses it: the switch turned on where its line says what goes,
 * then those that waited read as the User asked, organized where there is a Folder, else tagged.
 */
async function allow(core: Core, ids: readonly string[]) {
  const library = await core.getLibrary();
  await core.saveLibrarySettings({ ...library.settings, automatic: true, turnOn: true });
  if (library.groups.length > 0) {
    for (const service of library.asksFor) await core.allowOrganize(service.id);
    await core.classifyDocuments([...ids]);
  } else {
    await core.retagDocuments([...ids]);
  }
}

/** The row's no, or Settings' switch turned off: the User's own answer. */
async function no(core: Core) {
  const { settings } = await core.getLibrary();
  await core.saveLibrarySettings({ ...settings, automatic: false, turnOn: false });
}

/** Whether the User's decision on `flow` to Anthropic is "accepted", as Settings › Privacy lists it. */
const allowed = async (core: Core, flow: string) =>
  (await core.listDataFlows()).some(
    (each) =>
      each.flow.id === flow && each.flow.service.id === ANTHROPIC && each.consent === "accepted",
  );

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

describe("New Documents wait for the User's answer (#2308, #3353)", { timeout: 120_000 }, () => {
  // protects=the switch reads on and asks, naming the service, and before the press nothing reaches the cloud model; the press records the consent for Organize and Tags in Settings › Privacy, sorts those that waited, and a later drop goes by itself; fails_when=a drop is sent before the press, the press leaves those that waited unsorted or records no consent; no_claim=the row's look, which the window test shows.
  test.each(["en", "zh-CN"] as const)(
    "%s, with a Folder: nothing goes before Allow, which records the consent, organizes those that waited, and lets later ones go",
    async (language) => {
      const { core, models, harbour, drop } = await setup(language);
      if (!harbour) throw new Error("No Folder.");
      const first = [await drop(), await drop()];
      expect(models.sent("anthropic")).toBe(0);
      expect(await waiting(core)).toEqual({ services: ["Anthropic"], ids: [...first].sort() });
      const library = await core.getLibrary();
      expect([library.settings.automatic, sortingSwitchOn(library)]).toEqual([false, true]);

      await allow(core, first);
      await sorted(core, first, harbour.id);
      expect(models.sent("anthropic")).toBe(2);
      expect(await waiting(core)).toEqual({ services: [], ids: [] });
      expect([await allowed(core, "tagging"), await allowed(core, "classification")]).toEqual([
        true,
        true,
      ]);

      const later = await drop();
      await sorted(core, [later], harbour.id);
      expect(models.sent("anthropic")).toBe(3);
    },
  );

  // protects=a new profile with a cloud model and no Folder: the row still asks and nothing goes before it; Allow tags those that waited, records tagging's consent, and a later Document is tagged by itself; fails_when=the row needs a Folder to ask, or a Document goes before the press; no_claim=which Tags a real model picks.
  test.each(["en", "zh-CN"] as const)(
    "%s, with no Folder: the row asks too, and Allow tags those that waited",
    async (language) => {
      const { core, models, drop } = await setup(language, { folder: false });
      const first = [await drop(), await drop()];
      expect(models.sent("anthropic")).toBe(0);
      expect(await waiting(core)).toEqual({ services: ["Anthropic"], ids: [...first].sort() });

      await allow(core, first);
      await waitForTagging(core, first, undefined, WAIT.timeout);
      expect(models.sent("anthropic")).toBeGreaterThan(0);
      expect(await allowed(core, "tagging")).toBe(true);
      expect(await waiting(core)).toEqual({ services: [], ids: [] });

      const before = models.sent("anthropic");
      const later = await drop();
      await waitForTagging(core, [later], undefined, WAIT.timeout);
      expect(models.sent("anthropic")).toBe(before + 1);
    },
  );

  // protects=the row's no turns the switch off and is kept: a later drop waits with no row and nothing sent, and Settings' switch turns it on again with its consent; fails_when=the row comes back, or anything goes after the no; no_claim=the Settings page itself.
  test("the row's no keeps the switch off and asks no more; Settings turns it on again", async () => {
    const { core, models, harbour, drop } = await setup();
    if (!harbour) throw new Error("No Folder.");
    const first = await drop();
    await no(core);
    const second = await drop();

    expect(await waiting(core)).toEqual({ services: [], ids: [first, second].sort() });
    const off = await core.getLibrary();
    expect([off.settings.automatic, sortingSwitchOn(off)]).toEqual([false, false]);
    expect(models.sent("anthropic")).toBe(0);

    await turnOnAutomaticTagging(core);
    const later = await drop();
    await sorted(core, [later], harbour.id);
    expect(models.sent("anthropic")).toBe(1);
    expect((await waiting(core)).ids).toEqual([first, second].sort());
  });

  // protects=Settings' switch turned off while it asks is the User's no, and a save of another setting while it asks is not; fails_when=choosing a model answers for the User, or their off is dropped; no_claim=the window's switch.
  test("Settings' switch turned off while it asks is the no; choosing a model isn't", async () => {
    const { core, models, anthropic, drop } = await setup("en", { folder: false });
    await core.saveLibrarySettings({
      ...(await core.getLibrary()).settings,
      classifier: chat(anthropic.id, "claude-haiku-5-5"),
    });
    expect((await waiting(core)).services).toEqual(["Anthropic"]);

    await no(core);
    const held = await drop();
    expect(await waiting(core)).toEqual({ services: [], ids: [held] });
    expect(models.sent("anthropic")).toBe(0);
  });

  // protects=a consent taken back in Settings › Privacy, whether given by the press or elsewhere, sends nothing and asks nothing; fails_when=a Document goes after the take-back, or the row asks about a service the User took back; no_claim=the Privacy page's look.
  test.each([
    { given: "the row's Allow", flow: "tagging" },
    { given: "choosing the model for Organize", flow: "classification" },
    { given: "the Privacy page's Allow", flow: "tagging" },
  ] as const)(
    "a consent taken back after $given: nothing goes, nothing asks",
    async ({ given, flow }) => {
      const { core, models, drop } = await setup();
      if (given === "the row's Allow") {
        const first = await drop();
        await allow(core, [first]);
        await vi.waitFor(() => expect(models.sent("anthropic")).toBe(1), WAIT);
      } else if (given === "the Privacy page's Allow") {
        await core.allowDataFlow("tagging", ANTHROPIC);
      }
      const before = models.sent("anthropic");
      await core.revokeConsent(flow, ANTHROPIC);

      const held = await drop();
      expect(await waiting(core)).toEqual({ services: [], ids: [held] });
      expect((await core.getLibrary()).settings.automatic).toBe(false);
      expect(models.sent("anthropic")).toBe(before);
    },
  );

  // protects=the press allows only the service it named: once Organize sends to another service, a drop waits again with that service's name and nothing goes to it; fails_when=one service's Allow sends to another; no_claim=which services a User can choose.
  test("another service asks again on its own row", async () => {
    const { core, models, harbour, drop } = await setup();
    if (!harbour) throw new Error("No Folder.");
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
      async () => expect(await waiting(core)).toEqual({ services: ["OpenAI"], ids: [second] }),
      WAIT,
    );
    expect([models.sent("anthropic"), models.sent("openai")]).toEqual([1, 0]);
  });

  // protects=under Automatic with a Folder, the press covers Organize too, so Organize's own card doesn't ask again; fails_when=the User is asked twice for the same service; no_claim=the card's look.
  test("under Automatic with a Folder, Allow covers Organize: its card asks nothing more", async () => {
    const { core, models, drop } = await setup("en", { folder: false });
    const harbour = await core.createLibraryGroup({ name: "Harbour", description: "Port work." });
    const first = await drop();
    expect(await waiting(core)).toEqual({ services: ["Anthropic"], ids: [first] });

    await allow(core, [first]);
    expect(await core.startOrganize()).toMatchObject({ ready: true });
    await sorted(core, [first], harbour.id);
    expect(models.sent("anthropic")).toBe(1);
  });

  // protects=a model on this computer is on and asks nothing; fails_when=a local model asks or holds Documents back; no_claim=what the local model chooses.
  test("a model on this computer: on, nothing asked", async () => {
    const models = perProvider();
    const core = startCore(await createTempDataFolder(), {
      createChatModel: models.createChatModel,
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const [document] = await addAndProcess(core, [
      await writeSourceFile(await createSourceFolder(), "Survey.txt", TEXTS.en(1)),
    ]);
    if (!document) throw new Error("Not added.");
    await waitForTagging(core, [document.id], undefined, WAIT.timeout);
    const library = await core.getLibrary();
    expect([library.settings.automatic, library.asksFor]).toEqual([true, []]);
    expect(models.sent("ollama")).toBe(1);
  });

  // protects=in Local mode no row asks and nothing goes; what arrived then still waits once Local mode ends, while the row asks again for the cloud model; fails_when=Local mode asks or sends, or a Document from Local mode goes by itself after it; no_claim=what Local mode does for Answers.
  test("Local mode: no row and nothing goes; what arrived in it still waits after (#2982)", async () => {
    const { core, models, drop } = await setup();
    await core.setLocalOnly(true);
    const during = await drop();
    expect(await waiting(core)).toEqual({ services: [], ids: [during] });

    await core.setLocalOnly(false);
    expect(await waiting(core)).toEqual({ services: ["Anthropic"], ids: [during] });
    expect(models.sent("anthropic")).toBe(0);
  });

  // protects=a Document filed in a walled Folder goes nowhere by itself once the switch holds, while one dropped beside it is sorted; fails_when=a wall lets a Document reach the cloud model by itself; no_claim=what Organize proposes inside a wall.
  test("a walled Folder sends nothing by itself", async () => {
    const { core, models, harbour, drop } = await setup();
    if (!harbour) throw new Error("No Folder.");
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
    if (!harbour) throw new Error("No Folder.");
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
    if (!harbour) throw new Error("No Folder.");
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
    expect(await waiting(core)).toEqual({ services: ["Anthropic"], ids: [] });
    expect(models.sent("anthropic")).toBe(0);
  });
});

describe("The row's and Settings' words (#2308, #3353)", () => {
  // protects=the row, its popover and Settings' line say what was ruled, in English and Chinese, one and many, for organizing and for tagging; fails_when=a word drifts, or the tagging popover names what tagging doesn't send; no_claim=the look.
  test.each([
    [
      "en",
      {
        many: "4 to organize",
        one: "1 to organize",
        tagMany: "4 to tag",
        tagOne: "1 to tag",
        allow: "Allow Anthropic",
        no: "Don’t allow",
        sends:
          "4 Documents wait to be organized: Anthropic isn’t allowed to read them. Allowing it sends each Document’s name, kind and page count, the start of its text and its slide titles or sheet names, with your Folders’ names and descriptions, any matching Tags’ names and descriptions and your interface language, to Anthropic, for these and for Documents you add later.",
        sendsOne:
          "1 Document waits to be organized: Anthropic isn’t allowed to read it. Allowing it sends the Document’s name, kind and page count, the start of its text and its slide titles or sheet names, with your Folders’ names and descriptions, any matching Tags’ names and descriptions and your interface language, to Anthropic, for this one and for Documents you add later.",
        tagSends:
          "4 Documents wait to be tagged: Anthropic isn’t allowed to read them. Allowing it sends each Document’s name, kind and page count and the start of its text, with any matching Tags’ names and descriptions and your interface language, to Anthropic, for these and for Documents you add later.",
        tagSendsOne:
          "1 Document waits to be tagged: Anthropic isn’t allowed to read it. Allowing it sends the Document’s name, kind and page count and the start of its text, with any matching Tags’ names and descriptions and your interface language, to Anthropic, for this one and for Documents you add later.",
        asks: "Anthropic isn’t allowed yet: IncarnaMind asks you before the first Document goes.",
      },
    ],
    [
      "zh-CN",
      {
        many: "4 个待整理",
        one: "1 个待整理",
        tagMany: "4 个待打标签",
        tagOne: "1 个待打标签",
        allow: "允许 Anthropic",
        no: "不允许",
        sends:
          "4 个文档等待整理：尚未允许 Anthropic 读取。允许后，会把每个文档的名称、类型和页数、开头部分的文字及幻灯片标题或工作表名称，连同你的文件夹名称和描述、相符标签的名称和描述以及你的界面语言，发送给 Anthropic，包括这些文档和以后添加的文档。",
        sendsOne:
          "1 个文档等待整理：尚未允许 Anthropic 读取。允许后，会把这个文档的名称、类型和页数、开头部分的文字及幻灯片标题或工作表名称，连同你的文件夹名称和描述、相符标签的名称和描述以及你的界面语言，发送给 Anthropic，包括这个文档和以后添加的文档。",
        tagSends:
          "4 个文档等待打标签：尚未允许 Anthropic 读取。允许后，会把每个文档的名称、类型和页数及开头部分的文字，连同相符标签的名称和描述以及你的界面语言，发送给 Anthropic，包括这些文档和以后添加的文档。",
        tagSendsOne:
          "1 个文档等待打标签：尚未允许 Anthropic 读取。允许后，会把这个文档的名称、类型和页数及开头部分的文字，连同相符标签的名称和描述以及你的界面语言，发送给 Anthropic，包括这个文档和以后添加的文档。",
        asks: "尚未允许 Anthropic：第一个文档发送前，IncarnaMind 会先问你。",
      },
    ],
  ] as const)("%s", (language, words) => {
    const service = "Anthropic";
    expect(translate(language, "library.toSort.other", { count: 4 })).toBe(words.many);
    expect(translate(language, "library.toSort.one")).toBe(words.one);
    expect(translate(language, "library.toTag.other", { count: 4 })).toBe(words.tagMany);
    expect(translate(language, "library.toTag.one")).toBe(words.tagOne);
    expect(translate(language, "library.toSort.allow", { service })).toBe(words.allow);
    expect(translate(language, "library.toSort.dontAllow")).toBe(words.no);
    expect(translate(language, "library.toSort.sends.other", { count: 4, service })).toBe(
      words.sends,
    );
    expect(translate(language, "library.toSort.sends.one", { service })).toBe(words.sendsOne);
    expect(translate(language, "library.toTag.sends.other", { count: 4, service })).toBe(
      words.tagSends,
    );
    expect(translate(language, "library.toTag.sends.one", { service })).toBe(words.tagSendsOne);
    expect(translate(language, "ai.organize.automatic.asks", { service })).toBe(words.asks);
  });
});
