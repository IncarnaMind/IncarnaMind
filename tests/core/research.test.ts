/**
 * Research (#130): the composer's model plans a topic's steps, and the
 * Research Task does each as an Answer kept nowhere, searching the Library
 * within the composer's Search scope and the web, saving the pages it reads,
 * each step and each search and page read journalled. A local server stands
 * in for the web (../helpers/web).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  type ApprovalRequest,
  CITATION_NODE,
  type Core,
  DATABASE_FILE,
  type ResearchPlan,
  type SearchScope,
  type StartResearchInput,
  type Task,
} from "../../src/core";
import { CostCapError } from "../../src/core/providers/providerErrors";
import { openDatabase } from "../../src/core/storage";
import { cutTitle } from "../../src/shared/naming";
import { aiUseOfAccepted, pendingProposals, resolveProposals } from "../../src/shared/proposals";
import { shownPassages } from "../helpers/citations";
import {
  createMemoryKeychain,
  createTempDataFolder,
  queryDatabase,
  startCore,
} from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";
import { startWeb, webSearchingModel } from "../helpers/web";

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/web/${name}`, import.meta.url), "utf8");

const PORTUGUESE =
  "Tea was first introduced to Portuguese priests and merchants in China during the 16th century";
const MARGIN = "Harrow Foods' gross margin fell to 4.1% in the half year.";
const TEA = "http://encyclopedia.example/tea";
const MEMBERS = "http://news.example/members";
const FOUND = [
  { url: TEA, title: "Tea - The Open Encyclopedia" },
  { url: MEMBERS, title: "Tea's history, for members" },
];

const PLAN: ResearchPlan = {
  title: "How did tea reach Europe?",
  steps: ["Find who first brought tea to Europe", "Compare what the sources say"],
};

const waitFor = <T>(check: () => T | Promise<T>) => vi.waitFor(check, { timeout: 15_000 });

/** The step a request does: the last paragraph of its last user message. */
function stepOf(call: ModelCall): string {
  const last = call.options.prompt.filter((message) => message.role === "user").at(-1);
  const text =
    !last || typeof last.content === "string"
      ? ""
      : last.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  return text.split("\n\n").at(-1) ?? "";
}

const requestText = (call: ModelCall) =>
  call.options.prompt
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => ("text" in part ? part.text : "")).join(""),
    )
    .join("\n");

/**
 * A model that, for each step, searches the Library and the web as offered,
 * reads the pages found, cites the first Passage it was given, then writes
 * its notes. `hold` keeps a step's notes from finishing until it resolves.
 */
function researcher(
  seen: ModelCall[],
  hold?: { step: string; until: Promise<void> },
  /** While `capped`, the Tag request meets the monthly cap. */
  tagging: { capped: boolean } = { capped: false },
) {
  return scriptedModel(
    (call): ScriptedReply => {
      seen.push(call);
      const step = stepOf(call);
      const done = (tool: string) => call.results.some((result) => result.tool === tool);
      if (call.tools.includes("search_documents") && !done("search_documents")) {
        return { calls: [{ tool: "search_documents", input: { query: "gross margin" } }] };
      }
      if (call.tools.includes("search_web") && !done("search_web")) {
        return { calls: [{ tool: "search_web", input: { query: "tea reached Europe" } }] };
      }
      if (call.tools.includes("read_web_page") && !done("read_web_page")) {
        return {
          calls: [TEA, MEMBERS].map((url) => ({
            tool: "read_web_page",
            input: { url, query: "Portuguese merchants" },
          })),
        };
      }
      if (!done("cite")) {
        const passage = call.results.flatMap((result) => shownPassages(result.text))[0];
        const quote = passage?.text.includes(PORTUGUESE) ? PORTUGUESE : MARGIN;
        return {
          calls: [
            { tool: "cite", input: { citations: [{ marker: 1, passage: passage?.id, quote }] } },
          ],
        };
      }
      const notes = `Notes on “${step}”: the sources say so [^1].`;
      return hold?.step === step
        ? { text: notes, pause: { after: 4, until: hold.until } }
        : { text: notes };
    },
    {
      generate: (call) => {
        if (/Change it as the User asks/.test(call.prompt)) {
          return {
            text: "TITLE: How tea came to Europe\n1. Find the first traders\n2. **Check the dates**",
          };
        }
        if (call.prompt.includes("Topic: Thinks too long")) return { text: "", cutOff: true };
        if (call.prompt.includes("Topic:") && !call.prompt.includes("Plain words")) {
          return {
            text: "TITLE: How did tea reach Europe?\n1. Find who first brought tea\n2) Compare the sources\n\nThat's the plan.",
          };
        }
        if (/You tag the web pages/.test(call.system)) {
          if (tagging.capped) throw new CostCapError();
          return { text: "Tea: 1\nNothing here: 9" };
        }
        return { text: "Sure, I can help." };
      },
    },
  );
}

async function setUp(
  answering: MockLanguageModelV4,
  {
    approve = "allow-once",
    onAsk,
  }: {
    approve?: "allow-once" | "deny";
    /** Done while the ask waits, before it is answered. */
    onAsk?(core: Core, request: ApprovalRequest): Promise<unknown>;
  } = {},
) {
  const { model, searches } = webSearchingModel(answering, FOUND);
  const web = await startWeb({
    "/tea": () => ({ status: 200, body: fixture("article.html") }),
    "/members": () => ({ status: 200, body: fixture("login.html") }),
  });
  const dataDir = await createTempDataFolder();
  const keychain = createMemoryKeychain();
  const core = startCore(dataDir, { createChatModel: () => model, keychain, ...web.adapters });
  const provider = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: "claude-haiku-5-5",
  });
  if (!provider.service) throw new Error("Anthropic has a service.");
  await core.allowDataFlow("chat", provider.service.id);
  core.on("consent.requested", (request) => {
    void core.respondToConsent(request.requestId, true);
  });
  const asked: ApprovalRequest[] = [];
  core.on("approval.requested", (request) => {
    asked.push(request);
    void (onAsk?.(core, request) ?? Promise.resolve()).then(() =>
      core.respondToApproval(request.requestId, approve),
    );
  });
  await core.updateSettings({ user: { webSearch: true } });
  const folder = await core.createLibraryGroup({ name: "Grocers", description: "" });
  const sources = await createSourceFolder();
  const [report] = await addAndProcess(core, [
    await writeSourceFile(
      sources,
      "Harrow Foods.txt",
      `Harrow Foods interim results.\n${MARGIN}\n`,
    ),
  ]);
  if (!report) throw new Error("The report was added.");
  await core.moveToFolder({ documentIds: [report.id], folderId: folder.id });
  const mind = await core.createMind({ title: "Credit memo", folderId: folder.id });
  return { core, dataDir, web, searches, provider, folder, mind, report, keychain, asked };
}

const startInput = (
  mindId: string | null,
  folderId: string,
  patch: Partial<StartResearchInput> = {},
) => ({
  mindId,
  topic: "Research how tea reached Europe",
  plan: PLAN,
  sources: { web: true, library: true },
  writeInto: mindId === null ? ({ newMind: true } as const) : { mindId },
  scope: { folderIds: [folderId], tagIds: [], documentIds: [] },
  ...patch,
});

async function started(core: Core, input: StartResearchInput): Promise<Task> {
  const result = await core.startResearch(input);
  if (!result.started) throw new Error(`Research didn't start: ${result.reason}`);
  return result.task;
}

/** The changes waiting in a Mind: their ids, their text, and their Citations' checks. */
async function changesIn(core: Core, mindId: string) {
  const client = await connectToMind(core, mindId);
  const ids = pendingProposals(client.blocks).map((each) => each.id);
  const texts: string[] = [];
  const checks: string[] = [];
  for (const block of client.blocks.toArray()) {
    if (!(block instanceof Y.XmlElement) || !block.getAttribute("proposal")) continue;
    const walk = (element: Y.XmlElement | Y.XmlText): string => {
      if (element instanceof Y.XmlText) return element.toString().replace(/<[^>]+>/g, "");
      if (element.nodeName === CITATION_NODE) {
        checks.push(String(element.getAttribute("check")));
        return "";
      }
      return element
        .toArray()
        .map((child) => walk(child as Y.XmlElement | Y.XmlText))
        .join("");
    };
    texts.push(
      walk(block)
        .replace(/\s+([.,;:!?])/g, "$1")
        .trim(),
    );
  }
  return { ids, texts, checks };
}

async function waitForTask(core: Core, taskId: string, done: (task: Task) => boolean) {
  let found: Task | undefined;
  await waitFor(async () => {
    found = (await core.listTasks()).find((task) => task.id === taskId);
    expect(found && done(found)).toBe(true);
  });
  return found as Task;
}

describe("Research", { timeout: 30_000 }, () => {
  test("plans a topic's steps with the composer's model, and redoes them as the User says", async () => {
    const { core, mind } = await setUp(researcher([]));

    const planned = await core.planResearch({
      mindId: mind.id,
      topic: "Research how tea reached Europe",
      sources: { web: true, library: true },
    });
    expect(planned).toEqual({
      planned: true,
      plan: {
        title: "How did tea reach Europe?",
        steps: ["Find who first brought tea", "Compare the sources"],
      },
    });

    const changed = await core.planResearch({
      mindId: mind.id,
      topic: "Research how tea reached Europe",
      sources: { web: true, library: true },
      change: { steps: ["Find who first brought tea"], text: "Check the dates too" },
    });
    expect(changed).toEqual({
      planned: true,
      plan: {
        title: "How tea came to Europe",
        steps: ["Find the first traders", "Check the dates"],
      },
    });
  });

  test("with no Mind in focus it plans without one, and Start makes the new Mind its Task's own", async () => {
    const { core, folder } = await setUp(researcher([]));
    const planned = await core.planResearch({
      mindId: null,
      topic: "Research how tea reached Europe",
      sources: { web: false, library: true },
    });
    expect(planned).toMatchObject({ planned: true });

    const result = await core.startResearch(
      startInput(null, folder.id, {
        sources: { web: false, library: true },
        writeInto: { newMind: true },
      }),
    );
    if (!result.started) throw new Error(`Research didn't start: ${result.reason}`);
    const { task } = result;
    expect(task.mindId).not.toBeNull();
    const made = (await core.listMinds()).find((each) => each.id === task.mindId);
    expect(made?.title).toBe(cutTitle(PLAN.title));
    // Its plan says where its draft goes: the Mind it made, not "a new Mind".
    expect(await core.getResearchPlan(task.id)).toMatchObject({ writeInto: task.mindId });
    await waitForTask(core, task.id, (each) => each.finishedAt !== null);

    // A Mind chosen to write into is the Task's own too, with no Mind in focus.
    const second = await core.startResearch(
      startInput(null, folder.id, {
        sources: { web: false, library: true },
        writeInto: { mindId: made?.id ?? "" },
      }),
    );
    if (!second.started) throw new Error(`Research didn't start: ${second.reason}`);
    expect(second.task.mindId).toBe(made?.id);
    await core.stopTask(second.task.id);
  });

  test("with no Mind in focus it makes its own Mind, and once its pages are filed that Mind is in their Folder", async () => {
    const { core, folder } = await setUp(researcher([]));
    const task = await started(core, startInput(null, folder.id));
    const done = await waitForTask(core, task.id, (each) => each.finishedAt !== null);
    expect(done.status).toBe("done");
    // The Folder the pages it read were filed in, made by its save step.
    const filed = (await core.getLibrary()).groups.find(
      (each) => each.name === cutTitle(PLAN.title),
    );
    expect(filed).toBeDefined();
    const minds = await core.listMinds();
    const made = minds.find((each) => each.id === task.mindId);
    expect(made).toMatchObject({ title: cutTitle(PLAN.title), folderId: filed?.id });
    // Its draft went into that one Mind, which shows its progress; no second Mind was made.
    expect(done.review?.mindId).toBe(task.mindId);
    expect(minds.filter((each) => each.title === cutTitle(PLAN.title))).toHaveLength(1);
    expect((await changesIn(core, task.mindId ?? "")).ids).toHaveLength(1);
  });

  test("a Mind the Task made keeps the Folder the User gave it while it waited", async () => {
    let mine = "";
    const { core, folder } = await setUp(researcher([]), {
      // While the save step waits for approval, the User files the Task's own Mind elsewhere.
      onAsk: async (core) => {
        const running = (await core.listTasks()).find((each) => each.finishedAt === null);
        if (running?.mindId) await core.moveToFolder({ mindIds: [running.mindId], folderId: mine });
      },
    });
    mine = (await core.createLibraryGroup({ name: "Mine", description: "" })).id;
    const task = await started(core, startInput(null, folder.id));
    const done = await waitForTask(core, task.id, (each) => each.finishedAt !== null);
    expect(done.status).toBe("done");
    const made = (await core.listMinds()).find((each) => each.id === task.mindId);
    expect(made).toMatchObject({ folderId: mine });
    expect(done.review?.mindId).toBe(task.mindId);
  });

  test("a Search scope it can't read starts nothing, and leaves no Mind behind", async () => {
    const { core, folder } = await setUp(researcher([]));
    const minds = (await core.listMinds()).length;
    await expect(
      core.startResearch(
        startInput(null, folder.id, { scope: { folderIds: [42] } as unknown as SearchScope }),
      ),
    ).rejects.toThrow();
    expect(await core.listMinds()).toHaveLength(minds);
    expect(await core.listTasks()).toEqual([]);
  });

  test("the plan asks the model not to think where it can: Kimi K2.6's thinking took its whole reply (#1369)", async () => {
    // As Kimi K2.6 does, the model thinks through its whole reply unless thinking is off.
    let thinkingOff = false;
    const thinker = scriptedModel(() => ({ text: "" }), {
      generate: () =>
        thinkingOff
          ? { text: "TITLE: How did tea reach Europe?\n1. Find who first brought tea" }
          : { text: "", cutOff: true },
    });
    const { createChatModel: inner, specs } = scriptedModels(thinker);
    const createChatModel: typeof inner = (spec) => {
      thinkingOff = spec.thinking === "off";
      return inner(spec);
    };
    const core = startCore(await createTempDataFolder(), { createChatModel });
    const provider = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
    });
    if (provider.service) await core.allowDataFlow("chat", provider.service.id);
    const mind = await core.createMind({ title: "Tea" });
    const planned = await core.planResearch({
      mindId: mind.id,
      topic: "Thinks too long",
      sources: { web: false, library: true },
    });
    expect(planned).toMatchObject({ planned: true });
    expect(specs.at(-1)?.thinking).toBe("off");
  });

  test("a reply with no steps is a plan that failed, and with no model nothing is sent", async () => {
    const answering = researcher([]);
    const { core, mind } = await setUp(answering);
    const failed = await core.planResearch({
      mindId: mind.id,
      topic: "Plain words",
      sources: { web: false, library: true },
    });
    expect(failed).toMatchObject({
      planned: false,
      reason: "failed",
      error: { kind: "no-answer", wording: { key: "error.research.plan.noSteps" } },
    });
    const thought = await core.planResearch({
      mindId: mind.id,
      topic: "Thinks too long",
      sources: { web: false, library: true },
    });
    expect(thought).toMatchObject({
      planned: false,
      reason: "failed",
      error: { kind: "no-answer", wording: { key: "error.research.plan.thoughtOnly" } },
    });

    const bare = startCore(await createTempDataFolder());
    const own = await bare.createMind({ title: "Empty" });
    const notReady = await bare.planResearch({
      mindId: own.id,
      topic: "Anything",
      sources: { web: false, library: true },
    });
    expect(notReady).toMatchObject({ planned: false, reason: "not-ready" });
    expect(
      await bare.startResearch(
        startInput(own.id, "none", { scope: { folderIds: [], tagIds: [], documentIds: [] } }),
      ),
    ).toMatchObject({
      started: false,
      reason: "not-ready",
    });
    expect(await bare.listTasks()).toEqual([]);
  });

  test("each step searches the Library and the web as an Answer, then it files the pages it saved into a new Folder with Tags and writes a cited draft as changes", async () => {
    const seen: ModelCall[] = [];
    const { core, dataDir, folder, mind, web, report } = await setUp(researcher(seen));

    const task = await started(core, startInput(mind.id, folder.id));
    expect(task).toMatchObject({
      kind: "research",
      mindId: mind.id,
      question: "Research how tea reached Europe",
      status: "running",
      review: null,
    });
    const done = await waitForTask(core, task.id, (each) => each.finishedAt !== null);

    expect(done).toMatchObject({
      status: "done",
      progress: { done: 4, total: 4 },
      summary: "1 source saved · 1 change proposed",
      remaining: [],
    });
    // The two pages are read at once: whichever ends first comes first.
    const reads = expect.arrayContaining([
      ["Read “Tea - The Open Encyclopedia”", "done"],
      ["Read a page on news.example", "failed"],
    ]);
    const steps = (await core.listTaskSteps(task.id)).map((step) => [step.text, step.status]);
    expect(steps).toHaveLength(12);
    expect(steps.slice(0, 3)).toEqual([
      ["Find who first brought tea to Europe", "done"],
      ["Searched the Library for “gross margin”", "done"],
      ["Searched the web for “tea reached Europe”", "done"],
    ]);
    expect(steps.slice(3, 5)).toEqual(reads);
    expect(steps.slice(5, 8)).toEqual([
      ["Compare what the sources say", "done"],
      ["Searched the Library for “gross margin”", "done"],
      ["Searched the web for “tea reached Europe”", "done"],
    ]);
    expect(steps.slice(8, 10)).toEqual(reads);
    expect(steps.slice(10)).toEqual([
      ["1 source saved in “How did tea reach Europe”", "done"],
      ["Wrote a cited draft as 1 change in “Credit memo”", "done"],
    ]);
    expect(web.heard).toContain("encyclopedia.example/tea");
    // The second step reads what the first found, and the plan.
    const second = seen.find((call) => stepOf(call) === "Compare what the sources say");
    expect(second && requestText(second)).toContain("What the steps before found:");
    expect(second && requestText(second)).toContain(
      "Step 1: Notes on “Find who first brought tea to Europe”: the sources say so.",
    );

    // The page it saved is filed into a new Folder named for the research, with the Tag its model
    // chose; the User's own report stays in its Folder.
    const page = (await core.listDocuments()).find((each) => each.kind === "web");
    expect(page?.web?.address).toBe(TEA);
    const { groups, assignments } = await core.getLibrary();
    const filed = groups.find((each) => each.name === "How did tea reach Europe");
    expect(filed?.description).toBe(
      "Web pages Research saved for “Research how tea reached Europe”",
    );
    const folderOf = (id: string | undefined) =>
      assignments.find((each) => each.documentId === id)?.groupId;
    expect(folderOf(page?.id)).toBe(filed?.id);
    expect(folderOf(report.id)).toBe(folder.id);
    const tea = (await core.listTags()).find((tag) => tag.name === "Tea");
    const tagged = (await core.listDocuments()).find((each) => each.id === page?.id);
    expect(tagged?.tags).toEqual([
      expect.objectContaining({ tagId: tea?.id, source: "automatic" }),
    ]);

    // The draft is a change to accept in the Mind, its Citation found; Review opens it there.
    const changes = await changesIn(core, mind.id);
    expect(changes.texts).toEqual(["Notes on “How did tea reach Europe?”: the sources say so."]);
    expect(changes.checks).toEqual(["found"]);
    expect(done.review).toEqual({ mindId: mind.id, proposalId: changes.ids[0] });
    // Accepted, it is recorded as the assistant's change, with the model that wrote it.
    const client = await connectToMind(core, mind.id);
    let accepted: ReturnType<typeof resolveProposals> = [];
    client.doc.transact(() => {
      accepted = resolveProposals(client.blocks, () => true, "accept");
    });
    expect(aiUseOfAccepted(client.doc, mind.id, accepted, new Date().toISOString())).toEqual([
      expect.objectContaining({ kind: "assistant-change-accepted", modelId: "claude-haiku-5-5" }),
    ]);
    const [row] = queryDatabase<{ result: string }>(
      dataDir,
      "SELECT result FROM run_steps WHERE run_id = ? AND key = 'step:0'",
      [task.id],
    );
    expect(JSON.parse(row?.result ?? "{}").documents).toEqual(expect.arrayContaining([page?.id]));
  });

  test("going on after a quit in the middle of writing, it neither asks the model again nor proposes its draft twice, and a new Mind it made is made once", async () => {
    const seen: ModelCall[] = [];
    const answering = researcher(seen);
    const { core, dataDir, folder, mind, keychain, web } = await setUp(answering);
    const task = await started(
      core,
      startInput(mind.id, folder.id, { writeInto: { newMind: true } }),
    );
    const done = await waitForTask(core, task.id, (each) => each.finishedAt !== null);
    const written = done.review;
    if (!written) throw new Error("No draft written.");
    expect(written.mindId).not.toBe(mind.id);
    const made = (await core.listMinds()).find((each) => each.id === written.mindId);
    const filed = (await core.getLibrary()).groups.find(
      (each) => each.name === "How did tea reach Europe",
    );
    expect(made).toMatchObject({ title: "How did tea reach Europe", folderId: filed?.id });
    core.close();
    const asked = seen.length;

    // As if IncarnaMind had been quit after the changes went in, before the step was settled.
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    db.run(
      "UPDATE run_steps SET status = 'started', result = NULL WHERE run_id = ? AND key = 'draft'",
      [task.id],
    );
    db.run("UPDATE runs SET status = 'running', finished_at = NULL WHERE id = ?", [task.id]);
    db.close();
    const { model: reopenedModel } = webSearchingModel(answering, FOUND);
    const reopened = startCore(dataDir, {
      createChatModel: () => reopenedModel,
      keychain,
      ...web.adapters,
    });
    const again = await waitForTask(reopened, task.id, (each) => each.finishedAt !== null);

    expect(again.status).toBe("done");
    expect(
      (await reopened.listMinds()).filter((each) => each.title === "How did tea reach Europe"),
    ).toHaveLength(1);
    const changes = await changesIn(reopened, written.mindId);
    expect(changes.ids).toEqual([written.proposalId]);
    expect(again.review).toEqual(written);
    // The changes were found in the Mind, so the draft wasn't paid for again.
    expect(seen).toHaveLength(asked);
    reopened.close();
  });

  test("at the monthly cap while it chooses Tags, it pauses at the save step with the pages filed; going on, it tags them and writes its draft", async () => {
    const tagging = { capped: true };
    const { core, folder, mind, asked } = await setUp(researcher([], undefined, tagging));
    const task = await started(core, startInput(mind.id, folder.id));
    const paused = await waitForTask(core, task.id, (each) => each.status === "paused");

    expect(paused).toMatchObject({ pausedReason: "cost-cap", progress: { done: 2, total: 4 } });
    const page = (await core.listDocuments()).find((each) => each.kind === "web");
    expect(page?.tags).toEqual([]);
    const folderNamed = async () =>
      (await core.getLibrary()).groups.filter((each) => each.name === "How did tea reach Europe");
    const [filed] = await folderNamed();
    expect(
      (await core.getLibrary()).assignments.find((each) => each.documentId === page?.id)?.groupId,
    ).toBe(filed?.id);
    expect((await changesIn(core, mind.id)).ids).toEqual([]);

    tagging.capped = false;
    await core.resumeTask(task.id);
    const done = await waitForTask(core, task.id, (each) => each.finishedAt !== null);
    expect(done).toMatchObject({ status: "done", progress: { done: 4, total: 4 } });
    expect(await folderNamed()).toHaveLength(1);
    // The filing was allowed before the pause: going on doesn't ask again.
    expect(asked).toHaveLength(1);
    const tea = (await core.listTags()).find((tag) => tag.name === "Tea");
    const tagged = (await core.listDocuments()).find((each) => each.id === page?.id);
    expect(tagged?.tags.map((each) => each.tagId)).toEqual([tea?.id]);
    expect((await changesIn(core, mind.id)).ids).toHaveLength(1);
  });

  test("with the Library only, it files nothing and writes its draft; with nothing found, it says it couldn't finish and proposes nothing", async () => {
    const { core, folder, mind } = await setUp(researcher([]));
    const libraryOnly = await started(
      core,
      startInput(mind.id, folder.id, {
        sources: { web: false, library: true },
        plan: { ...PLAN, steps: ["Find margins"] },
      }),
    );
    const done = await waitForTask(core, libraryOnly.id, (each) => each.finishedAt !== null);
    expect(done).toMatchObject({ status: "done", progress: { done: 2, total: 2 } });
    expect((await core.getLibrary()).groups.map((each) => each.name)).toEqual(["Grocers"]);
    expect((await changesIn(core, mind.id)).texts).toHaveLength(1);

    const silent = scriptedModel(() => ({ text: "I found nothing." }));
    const empty = await setUp(silent);
    const nothing = await started(
      empty.core,
      startInput(empty.mind.id, empty.folder.id, { plan: { ...PLAN, steps: ["Find nothing"] } }),
    );
    const failed = await waitForTask(empty.core, nothing.id, (each) => each.finishedAt !== null);
    expect(failed).toMatchObject({ status: "failed", problem: "no-sources", review: null });
    expect((await changesIn(empty.core, empty.mind.id)).ids).toEqual([]);
  });

  test("having read web pages, it asks before filing them into the Library; denied, they stay where they were saved and the draft is still written", async () => {
    const seen: ModelCall[] = [];
    const { core, folder, mind, asked } = await setUp(researcher(seen), {
      approve: "deny",
      // Told while it waits: the draft, its next step, reads it.
      onAsk: (each, request) => each.tellTask(request.taskId ?? "", "Keep it to one paragraph"),
    });
    const task = await started(core, startInput(mind.id, folder.id));
    const done = await waitForTask(core, task.id, (each) => each.finishedAt !== null);
    const draft = seen.at(-1);
    expect(draft && requestText(draft)).toContain("- Keep it to one paragraph");
    expect(done.queued).toEqual([]);

    expect(asked).toEqual([
      expect.objectContaining({
        taskId: task.id,
        tool: "save_pages",
        title: "Save 1 web page to a new Folder",
        connector: { id: "library", name: "Library" },
        effects: [{ action: "write", scope: { kind: "documents" } }],
        thirdParty: [{ via: "read", source: "web-page" }],
      }),
    ]);
    const steps = (await core.listTaskSteps(task.id)).map((step) => step.text);
    expect(steps.slice(-2)).toEqual([
      "The web pages stay where they were saved",
      "Wrote a cited draft as 1 change in “Credit memo”",
    ]);
    expect(done).toMatchObject({ status: "done", summary: "1 change proposed" });
    const { groups, assignments } = await core.getLibrary();
    expect(groups.map((each) => each.name)).toEqual(["Grocers"]);
    const page = (await core.listDocuments()).find((each) => each.kind === "web");
    expect(assignments.find((each) => each.documentId === page?.id)?.groupId).toBe(folder.id);
  });

  test("Tell it…: two messages told during a step are read at the next one together, in the order they were told, once each", async () => {
    const seen: ModelCall[] = [];
    let release = () => {};
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = "Find who first brought tea to Europe";
    const { core, dataDir, folder, mind } = await setUp(researcher(seen, { step: first, until }));
    const task = await started(core, startInput(mind.id, folder.id));
    await waitFor(() =>
      expect(seen.some((call) => call.results.some((result) => result.tool === "cite"))).toBe(true),
    );
    await core.tellTask(task.id, "Leave out the discounters");
    await core.tellTask(task.id, "Say which source is oldest");
    release();
    await waitForTask(core, task.id, (each) => each.finishedAt !== null);

    const told = [
      "While it worked, the User told it this; follow it in this step and those after:",
      "- Leave out the discounters",
      "- Say which source is oldest",
    ].join("\n");
    const times = (text: string, part: string) => text.split(part).length - 1;
    const later = seen.filter((call) => stepOf(call) !== first);
    expect(later.length).toBeGreaterThan(0);
    for (const call of later) {
      expect(requestText(call)).toContain(told);
      expect(times(requestText(call), "Leave out the discounters")).toBe(1);
    }
    // The step that was running when they were told never sees them.
    for (const call of seen.filter((each) => stepOf(each) === first)) {
      expect(requestText(call)).not.toContain("discounters");
    }
    const read = queryDatabase<{ status: string }>(
      dataDir,
      "SELECT status FROM run_steps WHERE run_id = ? AND key LIKE '~message:%' ORDER BY started_at",
      [task.id],
    );
    expect(read.map((row) => row.status)).toEqual(["completed", "completed"]);
  });

  test("Tell it…: a message waits until the next step starts, which reads it; one taken back is never read", async () => {
    const seen: ModelCall[] = [];
    let release = () => {};
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { core, folder, mind } = await setUp(
      researcher(seen, { step: "Find who first brought tea to Europe", until }),
    );
    const task = await started(core, startInput(mind.id, folder.id));
    await waitFor(() =>
      expect(seen.some((call) => call.results.some((result) => result.tool === "cite"))).toBe(true),
    );

    const told = await core.tellTask(task.id, "Leave out the discounters");
    const kept = await core.tellTask(task.id, "Say nothing about coffee");
    expect(kept.queued.map((each) => each.text)).toEqual([
      "Leave out the discounters",
      "Say nothing about coffee",
    ]);
    const message = told.queued[0];
    if (!message) throw new Error("Nothing queued.");
    const after = await core.untellTask(task.id, kept.queued[1]?.id ?? "");
    expect(after.queued).toEqual([message]);
    await expect(core.tellTask(task.id, "   ")).rejects.toThrow("1 to 2000 characters");
    release();

    const done = await waitForTask(core, task.id, (each) => each.finishedAt !== null);
    expect(done.queued).toEqual([]);
    const second = seen.find((call) => stepOf(call) === "Compare what the sources say");
    expect(second && requestText(second)).toContain(
      "While it worked, the User told it this; follow it in this step and those after:\n- Leave out the discounters",
    );
    expect(seen.every((call) => !requestText(call).includes("coffee"))).toBe(true);
    // The steps it shows are its own: the messages are kept apart.
    expect(
      (await core.listTaskSteps(task.id)).some((step) => step.text.includes("discounters")),
    ).toBe(false);
    await expect(core.tellTask(task.id, "Too late")).rejects.toThrow("can’t be told");
  });

  test("at the monthly cap it pauses and lists the steps it has still to do", async () => {
    const { core, folder, mind } = await setUp(researcher([]));
    await core.updateSettings({ user: { monthlyCap: { amount: 0.000_001, currency: "USD" } } });
    const task = await started(core, startInput(mind.id, folder.id));
    const paused = await waitForTask(core, task.id, (each) => each.status === "paused");

    expect(paused).toMatchObject({ pausedReason: "cost-cap", summary: null });
    expect(paused.remaining).toEqual([
      "Find who first brought tea to Europe",
      "Compare what the sources say",
      "Save the sources in a new Folder",
      "Write a cited draft",
    ]);
    expect((await core.getResearchPlan(task.id)).steps.map((step) => step.status)).toEqual([
      "running",
      "waiting",
      "waiting",
      "waiting",
    ]);
  });

  test("with Web off it is offered no web Tool, and with the Library off no Document of the Library", async () => {
    const seen: ModelCall[] = [];
    const { core, folder, mind, report } = await setUp(researcher(seen));

    const libraryOnly = await started(
      core,
      startInput(mind.id, folder.id, {
        sources: { web: false, library: true },
        plan: { ...PLAN, steps: ["Find margins"] },
      }),
    );
    await waitForTask(core, libraryOnly.id, (each) => each.finishedAt !== null);
    expect(seen.every((call) => !call.tools.includes("search_web"))).toBe(true);
    expect(seen.some((call) => call.results.some((result) => result.text.includes(MARGIN)))).toBe(
      true,
    );

    seen.length = 0;
    const webOnly = await started(
      core,
      startInput(mind.id, folder.id, {
        sources: { web: true, library: false },
        plan: { ...PLAN, steps: ["Find tea"] },
      }),
    );
    await waitForTask(core, webOnly.id, (each) => each.finishedAt !== null);
    expect(seen.some((call) => call.tools.includes("search_web"))).toBe(true);
    const searched = seen.flatMap((call) =>
      call.results.filter((result) => result.tool === "search_documents"),
    );
    expect(searched.every((result) => !result.text.includes(report.name))).toBe(true);
  });

  test("Stop ends it in the middle of a step; the step is left to do again and nothing more runs", async () => {
    const seen: ModelCall[] = [];
    let release = () => {};
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { core, dataDir, folder, mind } = await setUp(
      researcher(seen, { step: "Find who first brought tea to Europe", until }),
    );
    const task = await started(core, startInput(mind.id, folder.id));
    await waitFor(() =>
      expect(seen.some((call) => call.results.some((result) => result.tool === "cite"))).toBe(true),
    );

    const stopped = await core.stopTask(task.id);
    release();
    expect(stopped.status).toBe("stopped");
    const rows = queryDatabase<{ key: string; status: string }>(
      dataDir,
      "SELECT key, status FROM run_steps WHERE run_id = ? AND key LIKE 'step:%' ORDER BY rowid",
      [task.id],
    );
    expect(rows).toEqual([{ key: "step:0", status: "started" }]);
    expect(seen.some((call) => stepOf(call) === "Compare what the sources say")).toBe(false);
  });
});
