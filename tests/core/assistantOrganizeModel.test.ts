import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import type { ApprovalRequest, ConversationAnswer, Core, RegisteredDataFlow } from "../../src/core";
import { DATABASE_FILE } from "../../src/core";
import type { Language } from "../../src/core/language";
import { catalogProvider, kindOfCatalogId } from "../../src/core/providers/catalog/providers";
import { openDatabase } from "../../src/core/storage";
import { translate } from "../../src/shared/i18n";
import { askAssistant } from "../helpers/assistant";
import { answerEnded } from "../helpers/citations";
import {
  createMemoryKeychain,
  createTempDataFolder,
  queryDatabase,
  startCore,
} from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { planReply } from "../helpers/library";
import { type GenerateCall, scriptedModel, scriptedModels } from "../helpers/models";
import { waitForTagging } from "../helpers/tags";

/**
 * The assistant's Organize needs no model the Library's Sort doesn't (#2252): for a new User whose
 * only model came from the setup card, "Put my Documents into Folders" uses the model Settings
 * already names for Tags and Folders, asking first where a cloud service would read the
 * Documents, as the Library's "Use {company}" does, and does not send them to set one up.
 */

const FILES = [
  {
    name: "Lease Harbour Street.md",
    contents: "# Harbour Street\n\nThe rent is 900 euros a month.\n",
  },
  { name: "Lease Mill Lane.md", contents: "# Mill Lane\n\nThe tenant pays rent quarterly.\n" },
  { name: "Q3 commentary.md", contents: "# Q3\n\nRevenue grew 4%.\n" },
  {
    name: "Scan 0042.md",
    contents: "# Agreement\n\nThe landlord lets the flat; rent is due monthly.\n",
  },
];

/** Proposes one Folder, and puts every Document it is asked about in it. */
const classifying = ({ prompt }: GenerateCall) => {
  const planned = planReply(prompt, { name: "Leases", description: "Lease papers" });
  if (planned) return { text: planned.text };
  let data: { groups?: { id: string; name: string }[] };
  try {
    data = JSON.parse(prompt) as typeof data;
  } catch {
    return { text: JSON.stringify({ tags: [] }) };
  }
  if (!data.groups) return { text: JSON.stringify({ tags: [] }) };
  const leases = data.groups.find((each) => each.name === "Leases");
  return { text: JSON.stringify({ groupId: leases?.id ?? null, tags: [] }) };
};

const organizing = (reply: { pause?: { after: number; until: Promise<void> } } = {}) =>
  scriptedModel(
    (call) =>
      call.results.some((each) => each.tool === "run_command")
        ? { text: "Done.", ...reply }
        : { calls: [{ tool: "run_command", input: { command: "documents.organize" } }] },
    { generate: classifying },
  );

/** The requests a model got that carry this text: a Document's name or words. */
const requestsWith = (model: MockLanguageModelV4, text: string) =>
  model.doGenerateCalls.filter((call) => JSON.stringify(call.prompt).includes(text)).length;

/**
 * A new User: the one key the setup card saved, as it saves it, and Documents added. No Folder,
 * and nothing chosen in Settings.
 */
async function newUser({
  language = "en",
  model = organizing(),
  keychain,
}: {
  language?: Language;
  model?: MockLanguageModelV4;
  keychain?: ReturnType<typeof createMemoryKeychain>;
} = {}) {
  const folder = await createTempDataFolder();
  const sources = await createTempDataFolder();
  const models = scriptedModels(model);
  const core = startCore(folder, {
    createChatModel: models.createChatModel,
    ...(keychain && { keychain }),
  });
  if (language !== "en") await core.updateSettings({ user: { language } });
  const modelId = catalogProvider("anthropic")?.roles.answers;
  if (!modelId) throw new Error("Anthropic has no Answers model in the catalog.");
  const provider = await core.saveChatProvider({
    kind: kindOfCatalogId("anthropic"),
    catalogId: "anthropic",
    modelId,
    apiKey: "sk-ant-test",
  });
  const paths = await Promise.all(
    FILES.map((file) => writeSourceFile(sources, file.name, file.contents)),
  );
  await addAndProcess(core, paths);
  const mind = await core.createMind({ title: "Tides" });
  return { core, models, provider, mind, dataDir: folder };
}

const approvals = (core: Core, asking: () => void = () => undefined) => {
  const asked: ApprovalRequest[] = [];
  core.on("approval.requested", (request) => {
    asked.push(request);
    asking();
    void core.respondToApproval(request.requestId, "allow-once");
  });
  return asked;
};

/** The User said no to sending Documents for sorting to this service, before. */
function decline(dataDir: string, service: { id: string; name: string }) {
  const at = new Date().toISOString();
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    db.run(
      `INSERT INTO data_flow_consents
         (id, flow, service_id, service_name, decision, data_kinds, created_at, updated_at)
       VALUES (?, 'classification', ?, ?, 'declined', '[]', ?, ?)`,
      [randomUUID(), service.id, service.name, at, at],
    );
  } finally {
    db.close();
  }
}

const commandCalls = (answer: ConversationAnswer) =>
  answer.toolCalls.filter((call) => call.source === "commands");

/** What the assistant's Organize proposes, waiting in Suggestions: nothing moves from the chat (#1569). */
const proposed = async (core: Core) => {
  const { assignments } = await core.getLibrary();
  if (assignments.some((each) => each.groupId !== null)) throw new Error("A Document was filed.");
  return (await core.getOrganizeReview()).items.filter(
    ({ placement }) => placement.kind === "folder" || placement.kind === "newFolder",
  );
};

describe("The assistant's Organize for a new User (#2252)", { timeout: 60_000 }, () => {
  // protects=a new User whose only model came from the setup card is asked the first-cloud-read question on the Organize card, and then the Documents are filed with the model Settings names for Tags and Folders, which is kept as the Library's "Use {company}" keeps it; fails_when=the first request is refused for want of a classification model, runs without asking, or files nothing; no_claim=which Folder the classifier picks.
  test.each([
    ["en", "Put my Documents into Folders."],
    ["zh-CN", "把我的文档放进文件夹。"],
  ] as const)(
    "%s: the first request asks, then proposes Folders for them",
    async (language, text) => {
      const { core, models, provider, mind } = await newUser({ language });
      const premise = (await core.getTaggingModels()).automatic;
      expect(premise).toMatchObject({ name: "Claude Haiku 5.5", group: "keys" });
      const sentBeforeAllow: number[] = [];
      const requests = approvals(core, () =>
        sentBeforeAllow.push(requestsWith(models.model, "Harbour Street")),
      );

      const answer = await askAssistant(core, { text, mindId: mind.id });

      expect(commandCalls(answer).map((call) => call.commandProblem?.wording?.key)).toEqual([
        undefined,
      ]);
      expect(requests).toHaveLength(1);
      expect(requests[0] && "ask" in requests[0] ? requests[0].ask : null).toMatchObject({
        kind: "change",
        reason: "organize",
        service: "Anthropic",
      });
      expect(sentBeforeAllow).toEqual([0]);
      expect(requestsWith(models.model, "Harbour Street")).toBeGreaterThan(0);
      expect(await proposed(core)).toHaveLength(4);
      // The Folder it proposed waits to be made with them.
      expect((await core.getLibrary()).groups).toEqual([]);
      expect((await core.getLibrary()).settings.classifier).toEqual({
        kind: "chat",
        choice: { providerId: provider.id, modelId: "claude-haiku-5-5" },
      });
      const flow = (await core.listDataFlows()).find((each) => each.flow.id === "classification");
      expect(flow).toMatchObject({ consent: "accepted", flow: { service: { name: "Anthropic" } } });
    },
  );

  // protects=the model the User allowed is kept like the Library's "Use {company}", so after Undo, which takes the proposals back out, the same request asks nothing and proposes them again; fails_when=the second request asks again, or Undo leaves a proposal; no_claim=which Folder the classifier picks.
  test("asked again after Undo, it asks nothing", async () => {
    const { core, mind } = await newUser();
    const requests = approvals(core);
    const first = await askAssistant(core, {
      text: "Put my Documents into Folders.",
      mindId: mind.id,
    });
    const run = commandCalls(first).find((call) => call.command)?.command?.run;
    if (!run) throw new Error("No command ran.");
    expect(await proposed(core)).toHaveLength(4);

    await core.undoCommands(run);
    expect(await proposed(core)).toEqual([]);
    await askAssistant(core, { text: "Put my Documents into Folders.", mindId: mind.id });

    expect(requests).toHaveLength(1);
    expect(await proposed(core)).toHaveLength(4);
  });

  // protects=Don't allow on that card sends nothing and keeps no model for Organize; fails_when=a Document is filed, a Folder is made, or the model is kept without the User's yes; no_claim=the card's words.
  test("not allowed, nothing is sent and no model is kept", async () => {
    const { core, models, mind } = await newUser();
    core.on("approval.requested", (request) => {
      void core.respondToApproval(request.requestId, "deny");
    });

    await askAssistant(core, { text: "Put my Documents into Folders.", mindId: mind.id });

    expect(requestsWith(models.model, "Harbour Street")).toBe(0);
    const library = await core.getLibrary();
    expect(library.settings.classifier).toEqual({ kind: "automatic" });
    expect(library.groups).toEqual([]);
    expect(await proposed(core)).toEqual([]);
    const flow = (await core.listDataFlows()).find((each) => each.flow.id === "classification");
    expect(flow?.consent ?? "not-asked").not.toBe("accepted");
  });

  // protects=a standing no to sending Documents for sorting stays a no after the card's Allow, which lets this one request send and stores nothing, no model for Organize either; fails_when=Allow stores accepted, a model is kept, or the Documents are not filed; no_claim=which Folder the classifier picks.
  test("a standing no is still a no after the card's Allow", async () => {
    const { core, provider, mind, dataDir } = await newUser();
    if (!provider.service) throw new Error("No service.");
    decline(dataDir, provider.service);
    const requests = approvals(core);

    await askAssistant(core, { text: "Put my Documents into Folders.", mindId: mind.id });

    expect(requests).toHaveLength(1);
    expect(requests[0] && "ask" in requests[0] ? requests[0].ask : null).toMatchObject({
      reason: "organize",
      service: "Anthropic",
      declined: true,
    });
    expect(await proposed(core)).toHaveLength(4);
    const flow = (await core.listDataFlows()).find((each) => each.flow.id === "classification");
    expect(flow?.consent).toBe("declined");
    expect((await core.getLibrary()).settings.classifier).toEqual({ kind: "automatic" });
  });

  // protects=a model the User picks with the Library's "Use {company}" while the card waits is the one Organize uses and keeps, with or without a standing no; fails_when=Allow keeps Automatic's pick over theirs, or puts the Organize model back to none; no_claim=which Folder the classifier picks.
  test.each([
    ["no standing no", false],
    ["a standing no", true],
  ] as const)("%s: a model picked while the card waits is kept", async (_name, declined) => {
    const { core, models, provider, mind, dataDir } = await newUser();
    if (!provider.service) throw new Error("No service.");
    if (declined) decline(dataDir, provider.service);
    const waiting = Promise.withResolvers<ApprovalRequest>();
    core.on("approval.requested", (request) => waiting.resolve(request));
    const result = await core.askInConversation({
      text: "Put my Documents into Folders.",
      mindId: mind.id,
    });
    if (!result.asked) throw new Error("The Question wasn't asked.");
    const request = await waiting.promise;
    const theirs = {
      kind: "chat",
      choice: { providerId: provider.id, modelId: "claude-sonnet-5-5" },
    } as const;
    const { settings } = await core.getLibrary();
    await core.saveLibrarySettings({ ...settings, classifier: theirs });
    const asked = models.specs.length;

    const ended = answerEnded(core, result.answerId);
    await core.respondToApproval(request.requestId, "allow-once");

    expect((await ended).event).toBe("finished");
    expect((await core.getLibrary()).settings.classifier).toEqual(theirs);
    expect(await proposed(core)).toHaveLength(4);
    expect(models.specs.slice(asked).map((spec) => spec.modelId)).toContain("claude-sonnet-5-5");
  });

  // protects=a model chosen in Settings is the one Organize uses, with no question when its service is allowed, and Automatic's pick is not kept over it; fails_when=it asks again, uses Haiku, or sets the model Organize keeps; no_claim=which Folder the classifier picks.
  test("a model chosen in Settings is used as it was", async () => {
    const { core, models, provider, mind } = await newUser();
    await core.saveLibrarySettings({
      classifier: {
        kind: "chat",
        choice: { providerId: provider.id, modelId: "claude-sonnet-5-5" },
      },
      automatic: false,
    });
    const requests = approvals(core);
    const asked = models.specs.length;

    await askAssistant(core, { text: "Put my Documents into Folders.", mindId: mind.id });

    expect(requests).toHaveLength(0);
    expect(await proposed(core)).toHaveLength(4);
    expect((await core.getLibrary()).settings.classifier).toMatchObject({
      choice: { modelId: "claude-sonnet-5-5" },
    });
    expect(models.specs.slice(asked).map((spec) => spec.modelId)).toContain("claude-sonnet-5-5");
  });

  // protects=with no model Organize could use at all, the command still refuses and says so plainly in both languages, and nothing is made; fails_when=it asks to send the Documents to nowhere, files anything, or the refusal has no words in either language; no_claim=the assistant's own reply.
  test("with no model to use it still says so", async () => {
    const { core, provider, mind } = await newUser();
    await core.updateSettings({ user: { chatModel: null } });
    expect((await core.getTaggingModels()).automatic).toBeNull();
    const requests = approvals(core);

    const answer = await askAssistant(core, {
      text: "Put my Documents into Folders.",
      mindId: mind.id,
      model: { providerId: provider.id, modelId: "claude-haiku-5-5" },
    });

    expect(requests).toHaveLength(0);
    const [problem] = commandCalls(answer).map((call) => call.commandProblem);
    expect(problem?.wording?.key).toBe("error.library.noClassifier");
    expect(translate("en", "error.library.noClassifier")).toBe(
      "Choose a classification model first.",
    );
    expect(translate("zh-CN", "error.library.noClassifier")).toBe("先选择分类模型。");
    expect(await proposed(core)).toEqual([]);
    expect((await core.getLibrary()).groups).toEqual([]);
  });
});

/** What the Library stored for the switch: when it was turned on, for each service. */
const storedSwitch = (dataDir: string) => {
  const [row] = queryDatabase<{ value: string }>(
    dataDir,
    "SELECT value FROM device_settings WHERE key = 'library' AND deleted_at IS NULL",
  );
  const stored = JSON.parse(row?.value ?? "{}") as {
    automatic?: boolean;
    automaticSince?: Record<string, string>;
  };
  return { automatic: stored.automatic, automaticSince: stored.automaticSince };
};

/**
 * A new User allows the first Organize; while its reply is still being written, a Document comes
 * in and the Library's Sort is asked for it, which waits for the reply to end; the app quits. How
 * many requests carrying that Document the next start sends by itself, and what it did with it.
 */
async function nextStart({ switchedOn }: { switchedOn: boolean }) {
  const keychain = createMemoryKeychain();
  const held = Promise.withResolvers<void>();
  const answering = organizing({ pause: { after: 2, until: held.promise } });
  const user = await newUser({ model: answering, keychain });
  if (switchedOn) {
    const { settings } = await user.core.getLibrary();
    await user.core.saveLibrarySettings({ ...settings, automatic: true, turnOn: true });
  }
  approvals(user.core);
  const asked = await user.core.askInConversation({
    text: "Put my Documents into Folders.",
    mindId: user.mind.id,
  });
  if (!asked.asked) throw new Error("The Question wasn't asked.");
  await vi.waitFor(async () => expect(await proposed(user.core)).toHaveLength(4));
  const [added] = await addAndProcess(user.core, [
    await writeSourceFile(
      await createSourceFolder(),
      "Lease Willow Court.md",
      "# Willow Court\n\nThe rent is 700 euros a month.\n",
    ),
  ]);
  if (!added) throw new Error("The Document wasn't added.");
  await user.core.classifyDocuments([added.id]);
  expect(requestsWith(answering, "Willow Court")).toBe(0);
  user.core.close();
  held.resolve();

  const restarted = scriptedModels(
    scriptedModel(() => ({ text: "Not asked." }), { generate: classifying }),
  );
  const core = startCore(user.dataDir, { keychain, createChatModel: restarted.createChatModel });
  const [settled] = await waitForTagging(
    core,
    [added.id],
    (each) => !["pending", "tagging", "waiting-for-provider"].includes(each.tagging),
  );
  core.close();
  return { sent: requestsWith(restarted.model, "Willow Court"), tagging: settled?.tagging };
}

describe("The first Organize leaves the switch as the User set it (#2252, #2308)", {
  timeout: 60_000,
}, () => {
  // protects=keeping the pick stores the same record of the switch as the Library's "Use {company}" (no turn-on time for a service the User never turned it on for); fails_when=the Allow's consent is recorded before the pick is saved, so the record names the service with the time of the Allow; no_claim=which Folder the classifier picks.
  test("the stored switch is what the Library's Use {company} stores", async () => {
    const assistant = await newUser();
    approvals(assistant.core);
    await askAssistant(assistant.core, {
      text: "Put my Documents into Folders.",
      mindId: assistant.mind.id,
    });
    const library = await newUser();
    const pick = (await library.core.getTaggingModels()).automatic;
    if (!pick) throw new Error("Automatic has no pick.");
    const { settings } = await library.core.getLibrary();
    await library.core.saveLibrarySettings({ ...settings, classifier: pick.classifier });

    expect(storedSwitch(library.dataDir)).toEqual({ automaticSince: {} });
    expect(storedSwitch(assistant.dataDir)).toEqual({ automaticSince: {} });
  });

  // protects=a Document that was waiting for the Library's Sort when the app quit is not sent by itself at the next start, because the User allowed one Organize and never turned the switch on; fails_when=the next start sends it to the service; no_claim=which Folder the classifier picks.
  test("a Document waiting when the app quits is not sent at the next start", async () => {
    const start = await nextStart({ switchedOn: false });

    expect(start).toEqual({ sent: 0, tagging: "off" });
  });

  // protects=the same steps do send at the next start for a User who turned the switch on for that service; fails_when=nothing is sent, so the test above would pass for any reason; no_claim=which Folder the classifier picks.
  test("a User who turned the switch on is sent the Document at the next start", async () => {
    const start = await nextStart({ switchedOn: true });

    expect(start.sent).toBe(1);
  });
});

/** What a window showing the Privacy page was last told about sending Documents for sorting to Anthropic. */
const watchingPrivacy = (core: Core) => {
  let last: RegisteredDataFlow[] | null = null;
  core.on("dataFlows.changed", (flows) => {
    last = flows;
  });
  return () => consentTo(last);
};

const consentTo = (flows: readonly RegisteredDataFlow[] | null) =>
  flows
    ?.find((each) => each.id === "classification")
    ?.services.find((each) => each.flow.service.name === "Anthropic")?.consent ?? "not-asked";

/**
 * A new User under a standing no whose first Organize was allowed, with a request to the model
 * still waiting: the run, and the model it lends, are going on.
 */
async function waitingUnderStandingNo(keychain = createMemoryKeychain()) {
  const held = Promise.withResolvers<void>();
  const waiting = scriptedModel(
    (call) =>
      call.results.some((each) => each.tool === "run_command")
        ? { text: "Done." }
        : { calls: [{ tool: "run_command", input: { command: "documents.organize" } }] },
    { generate: (call) => ({ ...classifying(call), until: held.promise }) },
  );
  const user = await newUser({ model: waiting, keychain });
  if (!user.provider.service) throw new Error("No service.");
  decline(user.dataDir, user.provider.service);
  approvals(user.core);
  const asked = await user.core.askInConversation({
    text: "Put my Documents into Folders.",
    mindId: user.mind.id,
  });
  if (!asked.asked) throw new Error("The Question wasn't asked.");
  await vi.waitFor(() => expect(requestsWith(waiting, "Harbour Street")).toBeGreaterThan(0));
  return user;
}

/** The model the Library stored for Organize and Tags; Automatic when it stored none. */
const storedChoice = (dataDir: string) => {
  const [row] = queryDatabase<{ value: string }>(
    dataDir,
    "SELECT value FROM device_settings WHERE key = 'library' AND deleted_at IS NULL",
  );
  const stored = JSON.parse(row?.value ?? "{}") as { classifier?: unknown; organizeWith?: unknown };
  expect(stored.organizeWith).toBeUndefined();
  return stored.classifier ?? { kind: "automatic" };
};

describe("The first Organize tells the window and leaves nothing behind (#2252)", {
  timeout: 60_000,
}, () => {
  // protects=an open Settings > Privacy page is told when the card's Allow is stored, so it never shows "not asked" for a service the Documents went to; fails_when=the last thing the window was told says not-asked after the run, or it differs from what the core lists; no_claim=which Folder the classifier picks.
  test("the Privacy page is told the Allow, and says what the core lists", async () => {
    const { core, mind } = await newUser();
    const shown = watchingPrivacy(core);
    approvals(core);

    await askAssistant(core, { text: "Put my Documents into Folders.", mindId: mind.id });

    expect(shown()).toBe("accepted");
    expect(consentTo(await core.listRegisteredDataFlows())).toBe("accepted");
  });

  // protects=the window is told "accepted" only when the User allowed; fails_when=Don't allow leaves the Privacy page, or the core, saying accepted; no_claim=the card's words.
  test("not allowed, the Privacy page still says not asked", async () => {
    const { core, mind } = await newUser();
    const shown = watchingPrivacy(core);
    core.on("approval.requested", (request) => {
      void core.respondToApproval(request.requestId, "deny");
    });

    await askAssistant(core, { text: "Put my Documents into Folders.", mindId: mind.id });

    expect(shown()).toBe("not-asked");
    expect(consentTo(await core.listRegisteredDataFlows())).toBe("not-asked");
  });

  // protects=under a standing no the Allow lets this one request send and stores nothing at all: the Library keeps no record of a model or a switch, and the Library's own Sort has no model to use afterwards; fails_when=the Library's record exists after the run, or the model is still lent to the Library's Sort; no_claim=which Folder the classifier picks.
  test("a standing no leaves no record in the Library", async () => {
    const { core, provider, mind, dataDir } = await newUser();
    if (!provider.service) throw new Error("No service.");
    decline(dataDir, provider.service);
    approvals(core);

    await askAssistant(core, { text: "Put my Documents into Folders.", mindId: mind.id });

    expect(await proposed(core)).toHaveLength(4);
    expect(
      queryDatabase(
        dataDir,
        "SELECT value FROM device_settings WHERE key = 'library' AND deleted_at IS NULL",
      ),
    ).toEqual([]);
    await expect(core.classifyDocuments()).rejects.toMatchObject({
      wording: { key: "error.library.noClassifier" },
    });
  });

  // protects=quitting while a request waits under a standing no leaves no model kept, so the Library's own "Use {company}" question is still offered at the next start; fails_when=the next start has a model for Organize or the decision is no longer no; no_claim=which Folder the classifier picks.
  test("quitting during a run under a standing no keeps no model", async () => {
    const keychain = createMemoryKeychain();
    const user = await waitingUnderStandingNo(keychain);
    user.core.close();

    const restarted = scriptedModels(
      scriptedModel(() => ({ text: "Not asked." }), { generate: classifying }),
    );
    const core = startCore(user.dataDir, { keychain, createChatModel: restarted.createChatModel });

    expect((await core.getLibrary()).settings.classifier).toEqual({ kind: "automatic" });
    const flow = (await core.listDataFlows()).find((each) => each.flow.id === "classification");
    expect(flow?.consent).toBe("declined");
    expect(requestsWith(restarted.model, "Harbour Street")).toBe(0);
    core.close();
  });

  // protects=a save that leaves the Organize model out leaves it as the User had it, also while a run lends one under a standing no; fails_when=the lent model is stored as the User's choice; no_claim=which Folder the classifier picks.
  test("a save that leaves the model out stores none while a run lends one", async () => {
    const { core, dataDir } = await waitingUnderStandingNo();

    await core.saveLibrarySettings({ classifier: { kind: "automatic" }, automatic: false });

    expect(storedChoice(dataDir)).toEqual({ kind: "automatic" });
  });

  // protects=the Library's Use {company} records the answer the same during a run under a standing no as outside one, so Organize never has a model with the no still standing; fails_when=during the run the model is saved but the consent isn't recorded; no_claim=which Folder the classifier picks.
  test.each([
    ["outside a run", false],
    ["during a run", true],
  ] as const)(
    "the Library's Use records the consent %s under a standing no",
    async (_name, running) => {
      const { core, dataDir, provider } = running
        ? await waitingUnderStandingNo()
        : await newUser();
      if (!running) {
        if (!provider.service) throw new Error("No service.");
        decline(dataDir, provider.service);
      }
      const pick = (await core.getTaggingModels()).automatic;
      if (!pick) throw new Error("Automatic has no pick.");
      const { settings } = await core.getLibrary();
      expect(settings.classifier).toEqual({ kind: "automatic" });

      await core.saveLibrarySettings({ ...settings, classifier: pick.classifier });

      const flow = (await core.listDataFlows()).find((each) => each.flow.id === "classification");
      expect(flow?.consent).toBe("accepted");
      expect(storedChoice(dataDir)).toEqual(pick.classifier);
    },
  );
});
