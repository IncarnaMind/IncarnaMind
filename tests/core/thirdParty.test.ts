/**
 * Third-party text (#78; ADR-0013; CONTEXT.md): once a Run has read text
 * someone other than the User wrote (a saved web page, the document being
 * checked, or Blocks and Answers from someone else in its Question context),
 * a Tool-level "always" no longer covers a call that writes or sends data:
 * the call asks, and its request says why. A Run that read only the User's own
 * Documents behaves as before (approvalDecision.test.ts). Blocks record where
 * their text came from beside the Mind's Blocks, so it survives sync and
 * reload. Check Runs are offered only the Documents' search and `cite`.
 */
import { readFileSync } from "node:fs";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test, vi } from "vitest";
import type {
  AnswerToolCall,
  ApprovalPolicyValue,
  ApprovalRequest,
  ApprovalSubject,
  Core,
  Effect,
  ThirdPartyReason,
} from "../../src/core";
import { type AnswerTools, createAiSdkAnswerEngine } from "../../src/core/answers/engine";
import { createApprovals, type ToolCallToApprove } from "../../src/core/approvals";
import { connectorToolEffects } from "../../src/core/connectors";
import { createEventHub } from "../../src/core/events";
import { declaredAccess } from "../../src/core/execution";
import { createScriptRunner } from "../../src/core/skills/scripts";
import { scriptEffects, skillTools } from "../../src/core/skills/tools";
import { migrate, openDatabase } from "../../src/core/storage";
import type { Tool } from "../../src/core/tools";
import { setTextOrigin, textOriginOf } from "../../src/shared/textOrigins";
import { askAssistant } from "../helpers/assistant";
import { answerEnded } from "../helpers/citations";
import {
  logFileIn,
  serverLog,
  testProcesses,
  tideServer,
  waitForState,
} from "../helpers/connectors";
import { createTempDataFolder, nextEvent, startCore } from "../helpers/core";
import { addAndProcess, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { answerIn, editMind, note, question, readMind, writeMind } from "../helpers/minds";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

const CONNECTOR = { id: "connector-1", name: "Tides" };
const SKILL = { skillId: "skill-1", skillDir: "/data/skills/skill-1" };

/** A Block's stable id, as the editor gives it. */
const idOf = (block: JSONContent): string => String(block.attrs?.id);

const WEB_PAGE: ThirdPartyReason = { via: "read", source: "web-page" };
const CHECKED: ThirdPartyReason = { via: "read", source: "checked-document" };
const IMPORTED: ThirdPartyReason = { via: "context", source: "imported" };

/** Approvals over an empty database, with one Connector and one Skill. */
function approvalsWith(policy: ApprovalPolicyValue | null, subject: ApprovalSubject) {
  const db = openDatabase(":memory:");
  migrate(db);
  const approvals = createApprovals({
    db,
    events: createEventHub(),
    now: () => new Date().toISOString(),
    owners: {
      connectors: () => new Map([[CONNECTOR.id, CONNECTOR.name]]),
      skills: () => new Map([[SKILL.skillId, "toolbox"]]),
    },
  });
  if (policy) approvals.set({ subject, policy, riskAccepted: true });
  return approvals;
}

const tool = (name: string): ApprovalSubject => ({
  kind: "tool",
  connectorId: CONNECTOR.id,
  tool: name,
});
const script: ApprovalSubject = { kind: "skill-script", skillId: SKILL.skillId };

/** What a Connector Tool's call can do, as its Tool declares it. */
const connectorCall = (readOnly: boolean) =>
  connectorToolEffects({ id: `connector:${CONNECTOR.id}`, name: CONNECTOR.name }, readOnly);

/** What a Skill script's run can do at a sandbox level, as `run_skill_script` declares it. */
const scriptRun = (level: "none" | "os"): Effect[] => {
  const runner = createScriptRunner({
    executor: { level, run: () => Promise.reject(new Error("Nothing runs here.")) },
  });
  return scriptEffects(SKILL, runner.access(SKILL.skillDir));
};

describe('After third-party text, a Tool-level "always" doesn\'t cover writes or sends', () => {
  const book = tool("book_boat");

  const cases: {
    run: string;
    tainted: boolean;
    thirdParty: ThirdPartyReason[];
    outcome: "run" | "ask";
  }[] = [
    { run: "read only the User's own Documents", tainted: true, thirdParty: [], outcome: "run" },
    { run: "read a web page", tainted: true, thirdParty: [WEB_PAGE], outcome: "ask" },
    {
      run: "read the document under verification",
      tainted: true,
      thirdParty: [CHECKED],
      outcome: "ask",
    },
    {
      run: "has imported text in its Question context",
      tainted: false,
      thirdParty: [IMPORTED],
      outcome: "ask",
    },
  ];

  test.each(cases)(
    'an "always" Connector write, in a Run that $run: $outcome',
    ({ tainted, thirdParty, outcome }) => {
      const approvals = approvalsWith("always", book);

      expect(
        approvals.decide({ subject: book, effects: connectorCall(false), tainted, thirdParty }),
      ).toBe(outcome);
    },
  );

  test("a read-only Connector Tool still runs: the User's consent to its service covers what it sends", () => {
    const lookup = tool("lookup_tide");
    for (const policy of [null, "always"] as const) {
      const approvals = approvalsWith(policy, lookup);
      expect(
        approvals.decide({
          subject: lookup,
          effects: connectorCall(true),
          tainted: true,
          thirdParty: [WEB_PAGE],
        }),
      ).toBe("run");
    }
  });

  test('"ask" still asks', () => {
    const approvals = approvalsWith("ask", tool("lookup_tide"));

    expect(
      approvals.decide({
        subject: tool("lookup_tide"),
        effects: connectorCall(true),
        tainted: false,
        thirdParty: [WEB_PAGE],
      }),
    ).toBe("ask");
  });

  test("a Skill's \"always run\" asks for a script with no sandbox, and still covers one in the OS sandbox, which can't write out or go online", () => {
    const approvals = approvalsWith("always", script);
    const decide = (effects: Effect[]) =>
      approvals.decide({ subject: script, effects, tainted: true, thirdParty: [WEB_PAGE] });

    expect(decide(scriptRun("none"))).toBe("ask");
    expect(decide(scriptRun("os"))).toBe("run");
  });

  test("a side effect no Tool-level policy covers asks in every Run, as a new side-effecting Tool's does until a scope grant covers it", () => {
    const approvals = approvalsWith(null, book);
    const runs: { tainted: boolean; thirdParty: ThirdPartyReason[] }[] = [
      { tainted: false, thirdParty: [] },
      { tainted: true, thirdParty: [] },
      { tainted: true, thirdParty: [WEB_PAGE] },
    ];

    for (const run of runs) {
      expect(approvals.decide({ subject: book, effects: connectorCall(false), ...run })).toBe(
        "ask",
      );
    }
  });
});

describe('"Always allow" settles waiting calls of the same Tool only where it covers them', () => {
  test("a call waiting in a Run that read a web page keeps waiting", async () => {
    const approvals = approvalsWith(null, tool("book_boat"));
    const call = (toolCallId: string, thirdParty?: ThirdPartyReason[]): ToolCallToApprove => ({
      mindId: "mind-1",
      answerId: `answer-${toolCallId}`,
      toolCallId,
      subject: { kind: "tool", connectorId: CONNECTOR.id, tool: "book_boat" },
      connector: CONNECTOR,
      tool: "book_boat",
      title: null,
      input: { place: "Dover" },
      readOnly: false,
      effects: connectorCall(false),
      tainted: true,
      ...(thirdParty && { thirdParty }),
    });
    const signal = new AbortController().signal;
    const own = approvals.request(call("own"), signal);
    const web = approvals.request(call("web", [WEB_PAGE]), signal);
    const [first] = approvals.requests();
    if (!first) throw new Error("Nothing is waiting.");

    approvals.respond(first.requestId, "always-allow");

    expect(await own).toBe(true);
    expect(approvals.requests()).toMatchObject([{ toolCallId: "web", thirdParty: [WEB_PAGE] }]);
    approvals.close();
    expect(await web).toBe(false);
  });
});

const QUESTION = "Book me a boat from Dover.";
const BOOKING = { tool: "tides__book_boat", input: { place: "Dover" } };

/** Accepts every consent request: these tests are about approvals, not consent. */
function acceptConsent(core: Core) {
  core.on("consent.requested", (request) => {
    void core.respondToConsent(request.requestId, true);
  });
}

/**
 * A core with a local chat model, the tiny server as a ready Connector whose
 * `book_boat` the User always allows, and a Mind with a client.
 */
async function setUp(script: (call: ModelCall) => ScriptedReply) {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    createChatModel: scriptedModels(scriptedModel(script)).createChatModel,
    processes: testProcesses(),
  });
  acceptConsent(core);
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const logFile = logFileIn(dataDir);
  const connector = await core.addConnector(tideServer(logFile));
  await waitForState(core, connector.id, "ready");
  await core.setApprovalPolicy({
    subject: { kind: "tool", connectorId: connector.id, tool: "book_boat" },
    policy: "always",
  });
  const mind = await core.createMind({ title: "Boats" });
  const client = await connectToMind(core, mind.id);
  return { core, dataDir, logFile, connector, mind, client };
}

/** A model that searches when told to, then books a boat, then answers. */
const searchThenBook =
  (query: string | null) =>
  (call: ModelCall): ScriptedReply => {
    const searched = call.results.some((each) => each.tool === "search_documents");
    const booked = call.results.some((each) => each.tool === BOOKING.tool);
    if (query && !searched) return { calls: [{ tool: "search_documents", input: { query } }] };
    if (!booked) return { calls: [BOOKING] };
    return { text: "Done." };
  };

/** The Tool calls that reached the tiny server, by Tool name. */
async function callsReceived(logFile: string): Promise<string[]> {
  return (await serverLog(logFile)).flatMap((record) =>
    record.event === "call" ? [record.tool] : [],
  );
}

const toolCallsOf = (client: MindClient, answerId: string): AnswerToolCall[] =>
  JSON.parse(String(answerIn(client, answerId).attrs.toolCalls ?? "[]")) as AnswerToolCall[];

/** Asks the last Question of the Mind; resolves with the Answer's id once it has finished. */
async function askLast(core: Core, client: MindClient, mindId: string, questionId: string) {
  await client.settled();
  const result = await core.askQuestion({ mindId, questionId });
  if (!result.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(result)}`);
  return result.answerId;
}

/** Collects every approval request the core raises, denying each at once. */
function denyEveryRequest(core: Core): ApprovalRequest[] {
  const requested: ApprovalRequest[] = [];
  core.on("approval.requested", (request) => {
    requested.push(request);
    void core.respondToApproval(request.requestId, "deny");
  });
  return requested;
}

const ARTICLE = readFileSync(new URL("../fixtures/web/article.html", import.meta.url), "utf8");

describe('An Answer that reads a web page asks before an "always" write', {
  timeout: 30_000,
}, () => {
  test("own Documents only: the write runs without asking", async () => {
    const { core, dataDir, logFile, mind, client } = await setUp(
      searchThenBook("high water Dover"),
    );
    const source = await writeSourceFile(
      dataDir,
      "Sources/Tides.txt",
      "High water at Dover comes twice a day.",
    );
    await addAndProcess(core, [source]);
    const requested = denyEveryRequest(core);

    const asked = question(QUESTION);
    writeMind(client, [asked]);
    const answerId = await askLast(core, client, mind.id, asked.attrs.id);
    await answerEnded(core, answerId);

    expect(requested).toEqual([]);
    expect(toolCallsOf(client, answerId)).toMatchObject([
      { tool: "search_documents", resultCount: 1 },
      { tool: "book_boat", status: "done" },
    ]);
    expect(await callsReceived(logFile)).toEqual(["book_boat"]);
    expect(textOriginOf(client.doc, answerId)).toBeNull();
  });

  test("a search that found a saved web page's Passages: it asks, saying so, and the Answer keeps where its text came from", async () => {
    const { core, logFile, mind, client } = await setUp(
      searchThenBook("aromatic beverage Camellia sinensis"),
    );
    const saved = await core.saveWebPage({ address: "https://reader.example/tea", html: ARTICLE });
    if (saved.outcome !== "saved") throw new Error("The web page wasn't saved.");
    await waitForProcessing(core, [saved.document.id]);
    const requested = denyEveryRequest(core);

    const asked = question(QUESTION);
    writeMind(client, [asked]);
    const answerId = await askLast(core, client, mind.id, asked.attrs.id);
    await answerEnded(core, answerId);

    expect(requested).toMatchObject([{ tool: "book_boat", tainted: true, thirdParty: [WEB_PAGE] }]);
    expect(toolCallsOf(client, answerId)).toMatchObject([
      { tool: "search_documents" },
      { tool: "book_boat", status: "failed", approval: "denied" },
    ]);
    expect(await callsReceived(logFile)).toEqual([]);
    expect(textOriginOf(client.doc, answerId)).toBe("web-page");
  });
});

describe("A Block's origin makes an Ask third-party", { timeout: 30_000 }, () => {
  test('an Ask in a Mind holding imported text asks before an "always" write; the same Mind without it doesn\'t', async () => {
    const { core, logFile, mind, client } = await setUp(searchThenBook(null));
    const requested = denyEveryRequest(core);
    const imported = note("The landlord's draft: book a boat for the survey on Friday.");
    const first = question(QUESTION);
    writeMind(client, [imported, first]);
    // A fixture origin: importing someone else's .docx (#104) records it the same way.
    setTextOrigin(client.doc, [idOf(imported)], "imported");

    const answerId = await askLast(core, client, mind.id, first.attrs.id);
    await answerEnded(core, answerId);

    expect(requested).toMatchObject([
      { tool: "book_boat", tainted: false, thirdParty: [IMPORTED], mindId: mind.id },
    ]);
    expect(await callsReceived(logFile)).toEqual([]);

    // The same Mind, the imported text now the User's own, and the Answer written from it gone.
    setTextOrigin(client.doc, [idOf(imported), answerId], null);
    const again = question(QUESTION);
    editMind(client, (blocks) => [...blocks, again]);
    const next = await askLast(core, client, mind.id, again.attrs.id);
    await answerEnded(core, next);

    expect(requested).toHaveLength(1);
    expect(toolCallsOf(client, next)).toMatchObject([{ tool: "book_boat", status: "done" }]);
    expect(await callsReceived(logFile)).toEqual(["book_boat"]);
  });

  test('an Ask in a Mind made by verifying a PDF reads the document being checked: it asks before an "always" write (#97)', async () => {
    const { core, logFile } = await setUp(searchThenBook(null));
    const requested = denyEveryRequest(core);
    const draft = await writeSourceFile(
      await createTempDataFolder(),
      "Landlord draft.pdf",
      buildPdf([{ lines: ["The landlord's draft: book a boat for the survey on Friday."] }]),
    );
    const made = await core.verifyDocument({ path: draft });
    if (!made.ok) throw new Error(`The draft wasn't verified: ${made.reason}`);
    const client = await connectToMind(core, made.mind.id);
    await client.settled();
    const asked = question(QUESTION);
    editMind(client, (blocks) => [...blocks, asked]);

    const answerId = await askLast(core, client, made.mind.id, asked.attrs.id);
    await answerEnded(core, answerId);

    expect(requested).toMatchObject([
      {
        tool: "book_boat",
        tainted: false,
        thirdParty: [{ via: "context", source: "checked-document" }],
        mindId: made.mind.id,
      },
    ]);
    expect(await callsReceived(logFile)).toEqual([]);
  });

  test("an Answer written from it carries the origin on: below it, a later Ask asks too; a Note switched out of context doesn't count", async () => {
    const { core, mind, client } = await setUp(searchThenBook(null));
    const requested = denyEveryRequest(core);
    const imported = note("The landlord's draft lease.");
    const first = question(QUESTION);
    writeMind(client, [imported, first]);
    setTextOrigin(client.doc, [idOf(imported)], "imported");
    const answerId = await askLast(core, client, mind.id, first.attrs.id);
    await answerEnded(core, answerId);
    expect(textOriginOf(client.doc, answerId)).toBe("imported");

    // The imported Note leaves the Question context; the Answer written from it stays.
    editMind(client, (blocks) =>
      blocks.map((block) =>
        block.attrs?.id === imported.attrs?.id
          ? { ...block, attrs: { ...block.attrs, includeInContext: false } }
          : block,
      ),
    );
    const second = question(QUESTION);
    editMind(client, (blocks) => [...blocks, second]);
    const next = await askLast(core, client, mind.id, second.attrs.id);
    await answerEnded(core, next);

    expect(requested).toHaveLength(2);
    expect(requested[1]?.thirdParty).toEqual([{ via: "context", source: "imported" }]);

    // With the Answer gone from the context too, nothing third-party is left above a new Question.
    editMind(client, (blocks) => blocks.filter((block) => block.type !== "answer"));
    const third = question(QUESTION);
    editMind(client, (blocks) => [...blocks.filter((block) => block.type !== "question"), third]);
    const last = await askLast(core, client, mind.id, third.attrs.id);
    await answerEnded(core, last);
    expect(requested).toHaveLength(2);
    expect(textOriginOf(client.doc, last)).toBeNull();
  });

  test("regenerating an Answer whose Run no longer reads third-party text clears its origin", async () => {
    const { core, mind, client } = await setUp(() => ({ text: "Noted." }));
    const imported = note("The landlord's draft lease.");
    const asked = question("Summarise the draft.");
    writeMind(client, [imported, asked]);
    setTextOrigin(client.doc, [idOf(imported)], "imported");
    const answerId = await askLast(core, client, mind.id, asked.attrs.id);
    await answerEnded(core, answerId);
    expect(textOriginOf(client.doc, answerId)).toBe("imported");

    setTextOrigin(client.doc, [idOf(imported)], null);
    await client.settled();
    const ended = answerEnded(core, answerId);
    await core.regenerateAnswer({ mindId: mind.id, answerId });
    await ended;

    expect(textOriginOf(client.doc, answerId)).toBeNull();
  });

  test("imported text the Question context leaves out, over its budget, doesn't count: the model never reads it", async () => {
    const { core, logFile, mind, client } = await setUp(searchThenBook(null));
    const requested = denyEveryRequest(core);
    const imported = note("The landlord's draft lease.");
    // About 15,000 tokens of the User's own notes between: more than the Question context keeps.
    const own = note("Tide tables for Dover, read at the harbour. ".repeat(1_400));
    const asked = question(QUESTION);
    writeMind(client, [imported, own, asked]);
    setTextOrigin(client.doc, [idOf(imported)], "imported");

    const answerId = await askLast(core, client, mind.id, asked.attrs.id);
    await answerEnded(core, answerId);

    expect(requested).toEqual([]);
    expect(await callsReceived(logFile)).toEqual(["book_boat"]);
    expect(textOriginOf(client.doc, answerId)).toBeNull();
  });
});

describe("A Block's origin survives sync and reload", { timeout: 30_000 }, () => {
  test("set offline while another window edits the Block, it reaches every window and a restart, and the editor reads the Mind as before", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const mind = await core.createMind({ title: "Lease" });
    const first = await connectToMind(core, mind.id);
    const imported = note("The landlord's draft lease.");
    writeMind(first, [imported]);
    await first.settled();
    const second = await connectToMind(core, mind.id);
    const blockId = idOf(imported);

    first.goOffline();
    setTextOrigin(first.doc, [blockId], "imported");
    editMind(second, (blocks) => [...blocks, note("My own note.")]);
    await second.settled();
    await first.goOnline();

    await vi.waitFor(() => expect(textOriginOf(second.doc, blockId)).toBe("imported"));
    expect(readMind(first).toJSON()).toEqual(readMind(second).toJSON());
    expect(readMind(second).childCount).toBe(2);
    core.close();

    const reopened = startCore(dataDir);
    const third = await connectToMind(reopened, mind.id);
    expect(textOriginOf(third.doc, blockId)).toBe("imported");
    expect(readMind(third).toJSON()).toEqual(readMind(second).toJSON());
  });
});

describe("An Answer in a conversation that read a web page", { timeout: 30_000 }, () => {
  test('keeps where its text came from, and a later Question in the conversation asks before an "always" write', async () => {
    let turn = 0;
    const { core, dataDir, logFile } = await setUp((call) => {
      // The first Question searches; the second only books.
      if (call.index === 0) turn = 1;
      const searched = call.results.some((each) => each.tool === "search_documents");
      const booked = call.results.some((each) => each.tool === BOOKING.tool);
      if (turn === 1 && !searched)
        return { calls: [{ tool: "search_documents", input: { query: "aromatic beverage" } }] };
      if (turn === 1) {
        turn = 2;
        return { text: "Tea is an aromatic beverage." };
      }
      return booked ? { text: "Done." } : { calls: [BOOKING] };
    });
    const saved = await core.saveWebPage({ address: "https://reader.example/tea", html: ARTICLE });
    if (saved.outcome !== "saved") throw new Error("The web page wasn't saved.");
    // Too long for the Documents' text to go with a Question: the later one reads the page only
    // through the conversation.
    const tides = await writeSourceFile(
      dataDir,
      "Sources/Tides.txt",
      Array.from(
        { length: 800 },
        (_, at) => `Day ${at + 1}: high water at Dover comes twice.`,
      ).join("\n"),
    );
    await addAndProcess(core, [tides]);
    await waitForProcessing(core, [saved.document.id]);
    const requested = denyEveryRequest(core);

    const asked = await core.askInConversation({ text: "What is tea?" });
    if (!asked.asked) throw new Error("Not asked.");
    await answerEnded(core, asked.answerId);
    const content = await core.getConversation(asked.conversation.id);
    expect(content.messages.find((each) => each.id === asked.answerId)).toMatchObject({
      kind: "answer",
      textOrigin: "web-page",
    });

    const next = await core.askInConversation({
      conversationId: asked.conversation.id,
      text: QUESTION,
    });
    if (!next.asked) throw new Error("Not asked.");
    await answerEnded(core, next.answerId);

    expect(requested).toMatchObject([
      {
        tool: "book_boat",
        mindId: null,
        conversationId: asked.conversation.id,
        thirdParty: [{ via: "context", source: "web-page" }],
      },
    ]);
    expect(await callsReceived(logFile)).toEqual([]);
  });
});

describe("A Question in a conversation beside a Mind holding imported text", {
  timeout: 30_000,
}, () => {
  // protects=a Mind's third-party Blocks stay marked when the assistant reads them (#544): the write asks, naming the Mind, and the Answer keeps the origin; fails_when=the always-allowed write runs, the reason isn't the Mind, or the origin is lost; no_claim=the card's words, which the approvals e2e covers.
  test('asks before an "always" write, the Mind as the reason, and keeps the origin; with no Mind in focus it doesn\'t ask', async () => {
    const { core, logFile, mind, client } = await setUp(searchThenBook(null));
    const requested = denyEveryRequest(core);
    const imported = note("The landlord's draft: book a boat for the survey on Friday.");
    writeMind(client, [imported]);
    setTextOrigin(client.doc, [idOf(imported)], "imported");
    await client.settled();

    const asked = await core.askInConversation({ text: QUESTION, mindId: mind.id });
    if (!asked.asked) throw new Error("Not asked.");
    await answerEnded(core, asked.answerId);

    expect(requested).toMatchObject([
      {
        tool: "book_boat",
        mindId: null,
        conversationId: asked.conversation.id,
        thirdParty: [{ via: "mind", source: "imported" }],
      },
    ]);
    expect(await callsReceived(logFile)).toEqual([]);
    const content = await core.getConversation(asked.conversation.id);
    expect(content.messages.find((each) => each.id === asked.answerId)).toMatchObject({
      textOrigin: "imported",
      read: { mindId: mind.id },
    });

    const elsewhere = await core.askInConversation({ text: QUESTION });
    if (!elsewhere.asked) throw new Error("Not asked.");
    await answerEnded(core, elsewhere.answerId);
    expect(requested).toHaveLength(1);
    expect(await callsReceived(logFile)).toEqual(["book_boat"]);
  });
});

describe("A saved web page given whole with a Question in the assistant (#1036)", {
  timeout: 30_000,
}, () => {
  // protects=a short web page's text given up front, with no search, makes the Run third-party as a search that found it does: the always-allowed write asks, the web page as the reason, and the Answer keeps the origin; fails_when=the write runs, the reason isn't the web page, or the origin is lost; no_claim=the card's words, which the approvals e2e covers.
  test('asks before an "always" write, the web page as the reason, and keeps the origin', async () => {
    const prompts: string[] = [];
    const { core, logFile } = await setUp((call) => {
      prompts.push(call.prompt);
      return searchThenBook(null)(call);
    });
    const saved = await core.saveWebPage({ address: "https://reader.example/tea", html: ARTICLE });
    if (saved.outcome !== "saved") throw new Error("The web page wasn't saved.");
    await waitForProcessing(core, [saved.document.id]);
    const requested = denyEveryRequest(core);

    const answer = await askAssistant(core, { text: QUESTION });

    expect(prompts[0]).toContain("<document-text>");
    expect(requested).toMatchObject([{ tool: "book_boat", thirdParty: [WEB_PAGE] }]);
    expect(await callsReceived(logFile)).toEqual([]);
    expect(answer.textOrigin).toBe("web-page");
  });
});

/** Documents that hold one Document, whose every search finds one Passage. */
const oneDocument = (thirdParty?: "web-page"): AnswerTools => ({
  documentCount: 1,
  searchDocuments: async () => ({
    text: '<passage id="P1" document="Tides">\nHigh water at Dover is at six.\n</passage>',
    passageCount: 1,
    ...(thirdParty && { thirdParty: [thirdParty] }),
  }),
  readDocument: async () => ({ text: "", passageCount: 0 }),
  cite: () => "Recorded.",
});

/** A Connector's Tool that may change something, as the Connectors hand it out. */
const bookTool: Tool = {
  name: BOOKING.tool,
  description: 'From the User\'s Connector "Tides". Book a boat trip.',
  inputSchema: {
    type: "object",
    properties: { place: { type: "string", description: "Where from." } },
    required: ["place"],
  },
  provider: { kind: "connector", id: CONNECTOR.id, name: CONNECTOR.name },
  providerTool: "book_boat",
  effects: () => connectorCall(false),
  untrustedResult: true,
  call: async () => "Booked a boat trip from Dover.",
};

/** Every other kind of Tool an Answer can be offered: the Skills', a Skill script, and a Connector's. */
const everyOtherTool = (): Tool[] => [
  ...skillTools({
    loadable: true,
    skill: (name) =>
      name === "tide-tables" ? { skillId: "skill-1", skillDir: "/skills/1" } : null,
    useSkill: async (name) => `The Skill ${name}.`,
    readSkillFile: async (skill, path) => `${skill}/${path}`,
    scripts: {
      access: () => declaredAccess("none", { read: [], write: [], network: "none" }),
      run: async () => "Exit code 0.",
    },
  }),
  bookTool,
];

/** Runs the engine with a model that searches, then books, then writes; returns what each model call was offered and what the gate saw. */
async function runEngine(request: {
  toolSet?: "answer" | "check";
  documents: AnswerTools;
  thirdParty?: ThirdPartyReason[];
}) {
  const offered: string[][] = [];
  const model = scriptedModel((call: ModelCall) => {
    offered.push(call.tools);
    if (call.index === 0)
      return { calls: [{ tool: "search_documents", input: { query: "high water" } }] };
    if (call.index === 1 && call.tools.includes(BOOKING.tool)) return { calls: [BOOKING] };
    return { text: "Done." };
  });
  const gated: { tool: string; thirdParty: readonly ThirdPartyReason[] }[] = [];
  const events: string[] = [];
  for await (const event of createAiSdkAnswerEngine().generate({
    instructions: () => "Answer from the Documents.",
    messages: [{ role: "user", content: QUESTION }],
    question: QUESTION,
    model,
    documents: request.documents,
    tools: everyOtherTool(),
    toolSet: request.toolSet,
    thirdParty: request.thirdParty,
    gate: async (tool, call) => {
      gated.push({ tool: tool.name, thirdParty: call.thirdParty });
      return { run: true };
    },
    support: "tools",
    signal: new AbortController().signal,
  })) {
    events.push(event.type);
  }
  expect(events.at(-1)).toBe("finished");
  return { offered, gated, events };
}

describe("Tool sets per Run", () => {
  test("a check Run's Tool set is exactly search and cite, whatever the request brings", async () => {
    const { offered, gated } = await runEngine({ toolSet: "check", documents: oneDocument() });

    expect(offered.length).toBeGreaterThan(0);
    for (const tools of offered) expect([...tools].sort()).toEqual(["cite", "search_documents"]);
    expect(gated.map((each) => each.tool)).toEqual(["search_documents"]);
  });

  test("an ordinary Answer keeps every Tool", async () => {
    const { offered } = await runEngine({ documents: oneDocument() });

    expect([...(offered[0] ?? [])].sort()).toEqual(
      [
        "cite",
        "read_document",
        "read_skill_file",
        "run_skill_script",
        "search_documents",
        BOOKING.tool,
        "use_skill",
      ].sort(),
    );
  });
});

describe("The Run tells each gated call why it counts as third-party", () => {
  test("a check Run that reads the document under verification starts third-party; what its search reads adds to it", async () => {
    const { gated, events } = await runEngine({
      documents: oneDocument("web-page"),
      thirdParty: [CHECKED],
    });

    expect(gated).toEqual([
      { tool: "search_documents", thirdParty: [CHECKED] },
      { tool: BOOKING.tool, thirdParty: [CHECKED, WEB_PAGE] },
    ]);
    // The Answer hears of what was read, once, before the search's card finishes.
    expect(events.filter((each) => each === "read-third-party")).toHaveLength(1);
    expect(events.indexOf("read-third-party")).toBeLessThan(events.indexOf("tool-call-finished"));
  });

  test("a Run that read only the User's own Documents tells it nothing", async () => {
    const { gated } = await runEngine({ documents: oneDocument() });

    expect(gated.map((each) => each.thirdParty)).toEqual([[], []]);
  });
});

describe("New side-effecting Tools keep the day-one rule", { timeout: 30_000 }, () => {
  test("a Tool whose side effect nothing can approve yet never runs it: the model is told, and the Answer carries on", async () => {
    const saveFile: Tool = {
      name: "save_file",
      description: "Saves a file.",
      inputSchema: { type: "object", properties: {} },
      provider: { kind: "sources", id: "sources", name: "Find sources" },
      providerTool: "save_file",
      effects: () => [
        { action: "write", scope: { kind: "folder", path: "/Users/someone/Reports" } },
      ],
      untrustedResult: false,
      call: async () => {
        throw new Error("It ran.");
      },
    };
    const decisions: unknown[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, {
      createChatModel: scriptedModels(scriptedModel(() => ({ text: "Saved." }))).createChatModel,
      // Stands in for the engine: the Answer's gate is asked about a call of the new Tool.
      answerEngine: {
        async *generate(request) {
          decisions.push(
            await request.gate?.(saveFile, {
              id: "call-1",
              tool: "save_file",
              input: {},
              tainted: false,
              thirdParty: [],
            }),
          );
          yield { type: "finished" };
        },
      },
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const mind = await core.createMind({ title: "Reports" });
    const client = await connectToMind(core, mind.id);
    const asked = question("Save the report.");
    writeMind(client, [asked]);
    const answerId = await askLast(core, client, mind.id, asked.attrs.id);
    await answerEnded(core, answerId);

    expect(decisions).toEqual([{ run: false, result: expect.stringContaining("wasn't made") }]);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe("Approval requests from a Run that read nothing third-party are as before", {
  timeout: 30_000,
}, () => {
  test("they carry no reasons", async () => {
    const { core, connector, mind, client } = await setUp(searchThenBook(null));
    await core.setApprovalPolicy({
      subject: { kind: "tool", connectorId: connector.id, tool: "book_boat" },
      policy: null,
    });
    const requested = nextEvent(core, "approval.requested");
    const asked = question(QUESTION);
    writeMind(client, [asked]);
    const answerId = await askLast(core, client, mind.id, asked.attrs.id);
    const request = await requested;
    const ended = answerEnded(core, answerId);
    await core.respondToApproval(request.requestId, "deny");
    await ended;

    expect(request).not.toHaveProperty("thirdParty");
  });
});
