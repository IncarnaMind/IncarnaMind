import { describe, expect, test } from "vitest";
import type { ApprovalRequest, ConversationAnswer, Core } from "../../src/core";
import type { Language } from "../../src/core/language";
import { catalogProvider, kindOfCatalogId } from "../../src/core/providers/catalog/providers";
import { translate } from "../../src/shared/i18n";
import { askAssistant } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { type GenerateCall, scriptedModel, scriptedModels } from "../helpers/models";

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
  let data: {
    groups?: { id: string; name: string }[];
    documents?: unknown;
    folders?: string[];
  };
  try {
    data = JSON.parse(prompt) as typeof data;
  } catch {
    return { text: JSON.stringify({ tags: [] }) };
  }
  if (data.documents && data.folders) {
    return { text: JSON.stringify({ folders: [{ name: "Leases", description: "Lease papers" }] }) };
  }
  if (!data.groups) return { text: JSON.stringify({ tags: [] }) };
  const leases = data.groups.find((each) => each.name === "Leases");
  return { text: JSON.stringify({ groupId: leases?.id ?? null, tags: [] }) };
};

const organizing = () =>
  scriptedModel(
    (call) =>
      call.results.some((each) => each.tool === "run_command")
        ? { text: "Done." }
        : { calls: [{ tool: "run_command", input: { command: "documents.organize" } }] },
    { generate: classifying },
  );

/**
 * A new User: the one key the setup card saved, as it saves it, and Documents added. No Folder,
 * and nothing chosen in Settings.
 */
async function newUser(language: Language = "en") {
  const folder = await createTempDataFolder();
  const sources = await createTempDataFolder();
  const models = scriptedModels(organizing());
  const core = startCore(folder, { createChatModel: models.createChatModel });
  if (language !== "en") await core.updateSettings({ user: { language } });
  const catalog = catalogProvider("anthropic");
  if (!catalog) throw new Error("No Anthropic in the catalog.");
  const provider = await core.saveChatProvider({
    kind: kindOfCatalogId("anthropic"),
    catalogId: "anthropic",
    modelId: catalog.roles.answers,
    apiKey: "sk-ant-test",
  });
  const paths = await Promise.all(
    FILES.map((file) => writeSourceFile(sources, file.name, file.contents)),
  );
  await addAndProcess(core, paths);
  const mind = await core.createMind({ title: "Tides" });
  return { core, models, provider, mind };
}

const approvals = (core: Core) => {
  const asked: ApprovalRequest[] = [];
  core.on("approval.requested", (request) => {
    asked.push(request);
    void core.respondToApproval(request.requestId, "allow-once");
  });
  return asked;
};

const commandCalls = (answer: ConversationAnswer) =>
  answer.toolCalls.filter((call) => call.source === "commands");

const filed = async (core: Core) =>
  (await core.getLibrary()).assignments.filter((each) => each.groupId !== null);

describe("The assistant's Organize for a new User (#2252)", { timeout: 60_000 }, () => {
  // protects=a new User whose only model came from the setup card is asked the first-cloud-read question on the Organize card, and then the Documents are filed with the model Settings names for Tags and Folders, which is kept as the Library's "Use {company}" keeps it; fails_when=the first request is refused for want of a classification model, runs without asking, or files nothing; no_claim=which Folder the classifier picks.
  test.each([
    ["en", "Put my Documents into Folders."],
    ["zh-CN", "把我的文档放进文件夹。"],
  ] as const)("%s: the first request asks, then files them", async (language, text) => {
    const { core, provider, mind } = await newUser(language);
    const premise = (await core.getTaggingModels()).automatic;
    expect(premise).toMatchObject({ name: "Claude Haiku 5.5", group: "keys" });
    const requests = approvals(core);

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
    expect(await filed(core)).toHaveLength(4);
    expect((await core.getLibrary()).settings.organizeWith).toEqual({
      kind: "chat",
      choice: { providerId: provider.id, modelId: "claude-haiku-5-5" },
    });
    const flow = (await core.listDataFlows()).find((each) => each.flow.id === "classification");
    expect(flow).toMatchObject({ consent: "accepted", flow: { service: { name: "Anthropic" } } });
  });

  // protects=Don't allow on that card sends nothing and keeps no model for Organize; fails_when=a Document is filed, a Folder is made, or the model is kept without the User's yes; no_claim=the card's words.
  test("not allowed, nothing is sent and no model is kept", async () => {
    const { core, mind } = await newUser();
    core.on("approval.requested", (request) => {
      void core.respondToApproval(request.requestId, "deny");
    });

    await askAssistant(core, { text: "Put my Documents into Folders.", mindId: mind.id });

    const library = await core.getLibrary();
    expect(library.settings.organizeWith).toBeNull();
    expect(library.groups).toEqual([]);
    expect(await filed(core)).toEqual([]);
    const flow = (await core.listDataFlows()).find((each) => each.flow.id === "classification");
    expect(flow?.consent ?? "not-asked").not.toBe("accepted");
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
    expect(await filed(core)).toHaveLength(4);
    expect((await core.getLibrary()).settings.organizeWith).toBeNull();
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
    expect(await filed(core)).toEqual([]);
    expect((await core.getLibrary()).groups).toEqual([]);
  });
});
