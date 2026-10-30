/**
 * Web search in an Answer (#128): the model's provider searches, the pages
 * the Answer reads are saved as Web page Documents and cited like any other,
 * a page the search didn't return is refused, and nothing is searched
 * unless the User turned it on, allowed the provider, and asked for the web.
 * A local server stands in for the web (../helpers/web).
 */
import { readFileSync } from "node:fs";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type {
  AnswerToolCall,
  ChatProvider,
  CitationAttributes,
  Core,
  CoreAdapters,
  PageLook,
} from "../../src/core";
import { textOriginOf } from "../../src/shared/textOrigins";
import { askAndFinish, onlyCitation, shownPassages } from "../helpers/citations";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { answerIn, answerText } from "../helpers/minds";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";
import { connectorTo, startWeb, webSearchingModel } from "../helpers/web";

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/web/${name}`, import.meta.url), "utf8");

const PORTUGUESE =
  "Tea was first introduced to Portuguese priests and merchants in China during the 16th century";

const TEA = "http://encyclopedia.example/tea";
const MEMBERS = "http://news.example/members";
const FOUND = [
  { url: TEA, title: "Tea - The Open Encyclopedia" },
  { url: MEMBERS, title: "Tea's history, for members" },
];

/** Where the model tries to send the User's words in an address of its own. */
const MADE_UP = "http://collector.example/?notes=lease+terms";

/**
 * A model that searches the web, reads the two pages it found and one it
 * made up, cites the line on the Portuguese merchants, then answers.
 */
function researcher(): MockLanguageModelV4 {
  return scriptedModel((call: ModelCall): ScriptedReply => {
    if (!call.tools.includes("search_web")) return { text: "I didn't search the web." };
    if (!call.results.some((result) => result.tool === "search_web")) {
      return { calls: [{ tool: "search_web", input: { query: "how tea reached Europe" } }] };
    }
    const reads = call.results.filter((result) => result.tool === "read_web_page");
    if (reads.length === 0) {
      return {
        calls: [TEA, MEMBERS, MADE_UP].map((url) => ({
          tool: "read_web_page",
          input: { url, query: "Portuguese merchants" },
        })),
      };
    }
    if (!call.results.some((result) => result.tool === "cite")) {
      const passage = reads
        .flatMap((result) => shownPassages(result.text))
        .find((each) => each.text.includes(PORTUGUESE));
      return {
        calls: [
          {
            tool: "cite",
            input: { citations: [{ marker: 1, passage: passage?.id, quote: PORTUGUESE }] },
          },
        ],
      };
    }
    return { text: "Portuguese merchants met tea in China [^1]." };
  });
}

/** Called each time the test web serves the tea page. */
let servingTea = () => {};

/** Whether the core keeps a Citation inside a wall, seen from `mindId`: it then names that Folder. */
async function keptInside(core: Core, cited: CitationAttributes, mindId: string) {
  const { documentId, pageFrom, pageTo, quote, contentHash } = cited;
  if (documentId === null || quote === null) throw new Error("The Citation has no quote.");
  const result = await core.recheckCitation({
    documentId,
    pageFrom,
    pageTo,
    quote,
    contentHash,
    mindId,
  });
  return "keptInside" in result ? result.keptInside : null;
}

/** A core with `model` on Anthropic, Questions allowed to go there, web search on and allowed. */
async function setUp(
  model: MockLanguageModelV4,
  {
    webSearch = true,
    allowSearch = true,
    gate,
  }: {
    webSearch?: boolean;
    allowSearch?: boolean;
    /** Holds every connection web search makes until `open`, and says when the first is asked for. */
    gate?: { open: Promise<void>; reached(): void };
  } = {},
  overrides: Partial<CoreAdapters> = {},
) {
  const web = await startWeb({
    "/tea": () => {
      servingTea();
      return { status: 200, body: fixture("article.html") };
    },
    "/members": () => ({ status: 200, body: fixture("login.html") }),
  });
  const dataDir = await createTempDataFolder();
  const connect = connectorTo(web.port);
  const adapters = gate
    ? {
        web: {
          ...web.adapters.web,
          connector: (lookup: Parameters<typeof connect>[0]) => {
            const inner = connect(lookup);
            return (...args: Parameters<typeof inner>) => {
              gate.reached();
              void gate.open.then(() => inner(...args));
            };
          },
        },
      }
    : web.adapters;
  const core = startCore(dataDir, { createChatModel: () => model, ...adapters, ...overrides });
  const provider = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: "claude-haiku-5-5",
  });
  if (!provider.service) throw new Error("Anthropic has a service.");
  await core.allowDataFlow("chat", provider.service.id);
  const asked: string[] = [];
  core.on("consent.requested", (request) => {
    asked.push(`${request.flow.id} ${request.flow.service.name}`);
    void core.respondToConsent(request.requestId, allowSearch);
  });
  await core.updateSettings({ user: { webSearch } });
  const folder = await core.createLibraryGroup({ name: "Tea", description: "" });
  const mind = await core.createMind({ title: "Tea in Europe", folderId: folder.id });
  const client = await connectToMind(core, mind.id);
  return { core, dataDir, web, provider, asked, folder, mind, client };
}

const toolCalls = (client: Parameters<typeof answerIn>[0], answerId: string) =>
  JSON.parse(String(answerIn(client, answerId).attrs.toolCalls ?? "[]")) as AnswerToolCall[];

const offeredTools = (model: MockLanguageModelV4) =>
  (model.doStreamCalls[0]?.tools ?? []).map((each) => each.name);

describe("Web search in an Answer", { timeout: 30_000 }, () => {
  test("with pages kept as they look by default, a page an Answer saves is never loaded whole", async () => {
    const asked: string[] = [];
    const pageLook: PageLook = {
      async render(address) {
        asked.push(address);
        return { pdf: new TextEncoder().encode("%PDF-1.7") };
      },
    };
    const { model } = webSearchingModel(researcher(), FOUND);
    const { core, client, mind } = await setUp(model, {}, { pageLook });
    await core.updateSettings({ user: { keepWebPageLook: true } });

    await askAndFinish(core, client, mind.id, "Search the web: how did tea reach Europe?");

    const [page] = await core.listDocuments();
    expect(page?.web?.address).toBe(TEA);
    expect(page?.web?.look).toBeNull();
    expect(asked).toEqual([]);
  });

  test("searches through the model's provider, saves the page it reads as a Document in the Mind's Folder, and cites it by section and paragraph, found", async () => {
    const { model, searches } = webSearchingModel(researcher(), FOUND);
    const { core, dataDir, web, asked, folder, mind, client } = await setUp(model);

    const { answerId, finished } = await askAndFinish(
      core,
      client,
      mind.id,
      "Search the web: how did tea reach Europe?",
    );

    // The provider was asked to search once, with its own tool, forced; consent named it first.
    expect(asked).toEqual(["web-search Anthropic"]);
    expect(searches).toHaveLength(1);
    expect(searches[0]?.toolChoice).toEqual({ type: "tool", toolName: "web_search" });
    expect(searches[0]?.tools).toEqual([
      expect.objectContaining({ type: "provider", id: "anthropic.web_search_20250305" }),
    ]);
    const documents = await core.listDocuments();
    expect(documents).toHaveLength(1);
    const page = documents[0];
    expect(page).toMatchObject({ kind: "web", name: "Tea - The Open Encyclopedia" });
    expect(page?.web?.address).toBe(TEA);
    const { assignments } = await core.getLibrary();
    expect(assignments.find((each) => each.documentId === page?.id)?.groupId).toBe(folder.id);
    expect(answerText(client, answerId)).toMatch(/^Portuguese merchants met tea in China/);
    expect(onlyCitation(client, answerId)).toMatchObject({
      documentId: page?.id,
      location: { kind: "section", heading: "History", paragraphs: { from: 2, to: 2 } },
      quote: PORTUGUESE,
      check: "found",
    });
    expect(finished.citations.map((each) => each.check)).toEqual(["found"]);
    // The made-up address was never fetched; the page behind a sign-in was, and wasn't saved.
    // The saved page's picture was asked for, from its image server (#756).
    expect([...web.heard].sort()).toEqual([
      "encyclopedia.example/tea",
      "images.example/tea-plantation.jpg",
      "news.example/members",
    ]);
    expect(toolCalls(client, answerId)).toEqual([
      expect.objectContaining({
        tool: "search_web",
        source: "web",
        input: { query: "how tea reached Europe" },
        status: "done",
        resultCount: 2,
      }),
      expect.objectContaining({
        tool: "read_web_page",
        source: "web",
        input: { url: TEA },
        status: "done",
        webPage: { address: TEA, documentId: page?.id, name: "Tea - The Open Encyclopedia" },
      }),
      expect.objectContaining({
        tool: "read_web_page",
        status: "failed",
        webPage: { address: MEMBERS, failure: "needs-sign-in" },
      }),
      expect.objectContaining({
        tool: "read_web_page",
        status: "failed",
        webPage: { address: MADE_UP, failure: "not-from-search" },
      }),
    ]);
    // The search is billed: its fee on top of what its tokens cost, toward the monthly cap.
    const [search] = queryDatabase<{ flow: string; cost: number; reserved: number }>(
      dataDir,
      "SELECT flow, cost, reserved FROM model_requests WHERE flow = 'web-search'",
    );
    expect(search?.cost).toBeGreaterThan(0.01);
    expect(search?.reserved).toBeGreaterThanOrEqual(search?.cost ?? Number.POSITIVE_INFINITY);
  });

  test("the model reads why a page wasn't saved, and the Run counts as having read a web page", async () => {
    const answering = researcher();
    const { model } = webSearchingModel(answering, FOUND);
    const { core, client, mind } = await setUp(model);

    const { answerId } = await askAndFinish(
      core,
      client,
      mind.id,
      "Search online for tea's history",
    );

    const told = answering.doStreamCalls
      .flatMap((call) => call.prompt)
      .flatMap((message) => (message.role === "tool" ? message.content : []))
      .flatMap((part) =>
        part.type === "tool-result" && part.toolName === "read_web_page" ? [part.output] : [],
      );
    expect(told).toContainEqual({
      type: "error-text",
      value: `Error: Couldn't save ${MEMBERS}: the page needs a sign-in or a subscription.`,
    });
    expect(told).toContainEqual({
      type: "error-text",
      value: `Error: Couldn't save ${MADE_UP}: search_web didn't return it in this Answer.`,
    });
    // So later writes and sends ask, and Questions that read this Answer count as having read it too (#78).
    expect(textOriginOf(client.doc, answerId)).toBe("web-page");
  });

  test("a page read for words it doesn't have gives the Passages that match its title", async () => {
    const answering = scriptedModel((call: ModelCall): ScriptedReply => {
      if (!call.results.some((result) => result.tool === "search_web")) {
        return { calls: [{ tool: "search_web", input: { query: "茶的历史" } }] };
      }
      if (!call.results.some((result) => result.tool === "read_web_page")) {
        return {
          calls: [{ tool: "read_web_page", input: { url: TEA, query: "茶是怎么传到欧洲的" } }],
        };
      }
      return { text: "读到了。" };
    });
    const { model } = webSearchingModel(answering, FOUND);
    const { core, client, mind } = await setUp(model);

    await askAndFinish(core, client, mind.id, "联网搜索：茶是怎么传到欧洲的？");

    const read = answering.doStreamCalls
      .flatMap((call) => call.prompt)
      .flatMap((message) => (message.role === "tool" ? message.content : []))
      .find((part) => part.type === "tool-result" && part.toolName === "read_web_page");
    const text =
      read?.type === "tool-result" && read.output.type === "text" ? read.output.value : "";
    expect(text).toMatch(
      /^Saved "Tea - The Open Encyclopedia" .*\n\nNothing on the page matched "茶是怎么传到欧洲的"/,
    );
    expect(shownPassages(text).length).toBeGreaterThan(0);
  });

  test("a page saved already from this computer's network isn't reused when a search returns its address", async () => {
    let local = "";
    const answering = scriptedModel((call: ModelCall): ScriptedReply => {
      if (!call.results.some((result) => result.tool === "search_web")) {
        return { calls: [{ tool: "search_web", input: { query: "tea" } }] };
      }
      if (!call.results.some((result) => result.tool === "read_web_page")) {
        return { calls: [{ tool: "read_web_page", input: { url: local } }] };
      }
      return { text: "Nothing to read." };
    });
    const found: { url: string; title: string }[] = [];
    const { model } = webSearchingModel(answering, found);
    const { core, client, mind, web } = await setUp(model);
    // Added by the User through #261's path, which reaches this computer.
    local = `http://127.0.0.1:${web.port}/tea`;
    found.push({ url: local, title: "Tea on the intranet" });
    const added = await core.saveWebPage({ address: local });
    expect(added.outcome).toBe("saved");
    const heardBefore = web.heard.length;

    const { answerId } = await askAndFinish(core, client, mind.id, "Search the web for tea");

    expect(toolCalls(client, answerId)[1]).toMatchObject({
      tool: "read_web_page",
      status: "failed",
      webPage: { address: local, failure: "not-public" },
    });
    expect(web.heard).toHaveLength(heardBefore);
  });

  test("a page saved behind another Folder's wall is read again, never reused, on either side", async () => {
    const { model } = webSearchingModel(researcher(), FOUND);
    const { core, web, folder, mind, client } = await setUp(model);
    const walled = await core.createLibraryGroup({ name: "Client A", description: "" });
    await core.updateLibraryGroup(walled.id, {
      name: "Client A",
      description: "",
      keepInside: true,
    });
    const inside = await core.createMind({ title: "Client A tea", folderId: walled.id });
    const insideClient = await connectToMind(core, inside.id);
    const fetched = () => web.heard.filter((each) => each === "encyclopedia.example/tea").length;
    const ask = async (on: typeof client, mindId: string) => {
      const { answerId } = await askAndFinish(core, on, mindId, "Search the web: tea in Europe?");
      return onlyCitation(on, answerId);
    };

    const insideCited = await ask(insideClient, inside.id);
    const outsideCited = await ask(client, mind.id);
    const again = await ask(insideClient, inside.id);

    expect(fetched()).toBe(2);
    expect(outsideCited.documentId).not.toBe(insideCited.documentId);
    expect(again.documentId).toBe(insideCited.documentId);
    const library = await core.getLibrary();
    const folderOf = (id: unknown) =>
      library.assignments.find((each) => each.documentId === id)?.groupId;
    expect(folderOf(insideCited.documentId)).toBe(walled.id);
    expect(folderOf(outsideCited.documentId)).toBe(folder.id);
    // No Citation names a Folder it isn't in.
    expect(await keptInside(core, outsideCited, mind.id)).toBeNull();
    expect(await keptInside(core, insideCited, inside.id)).toBeNull();
  });

  test("an outside turn never shares the User's save under way of the same page into a walled Folder", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fetching = () => {};
    const userFetching = new Promise<void>((resolve) => {
      fetching = resolve;
    });
    // The User's own fetch waits until the turn has fetched the page for itself, then fails.
    const userFetch = async (): Promise<never> => {
      fetching();
      await held;
      throw new TypeError("fetch failed");
    };
    const { model } = webSearchingModel(researcher(), FOUND);
    const { core, folder, mind, client } = await setUp(
      model,
      {},
      { webPages: { fetch: userFetch } },
    );
    const walled = await core.createLibraryGroup({ name: "Client A", description: "" });
    await core.updateLibraryGroup(walled.id, {
      name: "Client A",
      description: "",
      keepInside: true,
    });
    servingTea = release;

    const users = core.saveWebPage({ address: TEA, folderId: walled.id });
    await userFetching;
    const { answerId } = await askAndFinish(
      core,
      client,
      mind.id,
      "Search the web: tea in Europe?",
    );

    expect((await users).outcome).toBe("failed");
    const cited = onlyCitation(client, answerId);
    const { assignments } = await core.getLibrary();
    expect(assignments.find((each) => each.documentId === cited.documentId)?.groupId).toBe(
      folder.id,
    );
    expect(await keptInside(core, cited, mind.id)).toBeNull();
  });

  /**
   * The User saves the tea page into `into` while a turn's search, from `asking`, is saving it:
   * where each page ends up, and whether the turn's Citation is kept inside a Folder.
   */
  async function userSavesWhileSearching(asking: "outside" | "inside", into: "walled" | "outside") {
    let open = () => {};
    let reached = () => {};
    const gate = {
      open: new Promise<void>((resolve) => {
        open = resolve;
      }),
      reached: () => reached(),
    };
    const searching = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const { model } = webSearchingModel(researcher(), FOUND);
    const { core, folder, mind, client } = await setUp(model, { gate });
    const walled = await core.createLibraryGroup({ name: "Client A", description: "" });
    await core.updateLibraryGroup(walled.id, {
      name: "Client A",
      description: "",
      keepInside: true,
    });
    const inside = await core.createMind({ title: "Client A tea", folderId: walled.id });
    const on = asking === "inside" ? await connectToMind(core, inside.id) : client;
    const from = asking === "inside" ? inside.id : mind.id;

    const asked = askAndFinish(core, on, from, "Search the web: tea in Europe?");
    await searching;
    const saving = core.saveWebPage({
      address: TEA,
      html: fixture("article.html"),
      folderId: into === "walled" ? walled.id : folder.id,
    });
    // The User's save has reached the page's save, joining the search's or starting its own.
    await new Promise((resolve) => setImmediate(resolve));
    open();
    const [users, { answerId }] = await Promise.all([saving, asked]);

    if (users.outcome !== "saved") throw new Error("The User's page wasn't saved.");
    const cited = onlyCitation(on, answerId);
    const { assignments } = await core.getLibrary();
    const folderOf = (id: unknown) => assignments.find((each) => each.documentId === id)?.groupId;
    const name = (id: unknown) => (id === walled.id ? "Client A" : id === folder.id ? "Tea" : id);
    return {
      users: name(folderOf(users.document.id)),
      cited: name(folderOf(cited.documentId)),
      keptInside: await keptInside(core, cited, from),
      pages: (await core.listDocuments()).length,
    };
  }

  test("the User saving a page into a walled Folder while an outside search saves it: each keeps its own", async () => {
    expect(await userSavesWhileSearching("outside", "walled")).toEqual({
      users: "Client A",
      cited: "Tea",
      keptInside: null,
      pages: 2,
    });
  });

  test("the User saving a page outside while a walled Note's search saves it: each keeps its own", async () => {
    expect(await userSavesWhileSearching("inside", "outside")).toEqual({
      users: "Tea",
      cited: "Client A",
      keptInside: null,
      pages: 2,
    });
  });

  test("the User saving a page on the search's own side shares the one page, in the User's Folder", async () => {
    expect(await userSavesWhileSearching("outside", "outside")).toEqual({
      users: "Tea",
      cited: "Tea",
      keptInside: null,
      pages: 1,
    });
  });

  test("an outside turn reads a page again that the User saved into a walled Folder before", async () => {
    const { model } = webSearchingModel(researcher(), FOUND);
    const { core, folder, mind, client } = await setUp(model);
    const walled = await core.createLibraryGroup({ name: "Client A", description: "" });
    await core.updateLibraryGroup(walled.id, {
      name: "Client A",
      description: "",
      keepInside: true,
    });
    const users = await core.saveWebPage({
      address: TEA,
      html: fixture("article.html"),
      folderId: walled.id,
    });
    if (users.outcome !== "saved") throw new Error("The User's page wasn't saved.");

    const { answerId } = await askAndFinish(
      core,
      client,
      mind.id,
      "Search the web: tea in Europe?",
    );

    const cited = onlyCitation(client, answerId);
    expect(cited.documentId).not.toBe(users.document.id);
    const { assignments } = await core.getLibrary();
    const folderOf = (id: unknown) => assignments.find((each) => each.documentId === id)?.groupId;
    expect(folderOf(users.document.id)).toBe(walled.id);
    expect(folderOf(cited.documentId)).toBe(folder.id);
  });

  test("isn't offered while the switch is off, in Local mode, for a Question that doesn't ask for the web, or with a provider that has no web search", async () => {
    const off = webSearchingModel(researcher(), FOUND);
    const first = await setUp(off.model, { webSearch: false });
    await askAndFinish(first.core, first.client, first.mind.id, "Search the web for tea");
    expect(offeredTools(off.model)).not.toContain("search_web");

    const notAsked = webSearchingModel(researcher(), FOUND);
    const second = await setUp(notAsked.model);
    await askAndFinish(second.core, second.client, second.mind.id, "How did tea reach Europe?");
    expect(offeredTools(notAsked.model)).not.toContain("search_web");

    const local = webSearchingModel(researcher(), FOUND);
    const third = await setUp(local.model);
    await third.core.setLocalOnly(true);
    await third.core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    await askAndFinish(third.core, third.client, third.mind.id, "Search the web for tea");
    expect(offeredTools(local.model)).not.toContain("search_web");

    const deepSeek = webSearchingModel(researcher(), FOUND);
    const fourth = await setUp(deepSeek.model);
    const saved: ChatProvider = await fourth.core.saveChatProvider({
      kind: "deepseek",
      apiKey: "sk-test",
      modelId: "deepseek-flash",
    });
    if (saved.service) await fourth.core.allowDataFlow("chat", saved.service.id);
    await askAndFinish(fourth.core, fourth.client, fourth.mind.id, "Search the web for tea");
    expect(offeredTools(deepSeek.model)).not.toContain("search_web");
    for (const each of [off, notAsked, local, deepSeek]) expect(each.searches).toEqual([]);
    expect(await fourth.core.listDocuments()).toEqual([]);
  });

  test("declined, the provider is sent nothing and nothing is saved", async () => {
    const { model, searches } = webSearchingModel(researcher(), FOUND);
    const { core, client, mind, web, asked } = await setUp(model, { allowSearch: false });

    const { answerId } = await askAndFinish(core, client, mind.id, "Search the web for tea");

    expect(asked).toEqual(["web-search Anthropic"]);
    expect(searches).toEqual([]);
    expect(web.heard).toEqual([]);
    expect(await core.listDocuments()).toEqual([]);
    expect(toolCalls(client, answerId)[0]).toMatchObject({ tool: "search_web", status: "failed" });
  });
});
