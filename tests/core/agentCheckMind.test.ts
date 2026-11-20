/**
 * An outside agent has the Note it wrote checked (#3317): through the shim the app ships, with the
 * MCP SDK's own client, it calls `check_mind`. Every claim is checked against the Folder's
 * Documents on the User's model, the Note carries the marks, and the agent gets back each claim
 * that needs a look with what the Document says.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createFakeAnalysisRuntime } from "../../src/core/analysis/fake";
import {
  ANALYSIS_TABLE_ATTRIBUTE,
  ANALYSIS_TABLE_NODE,
  type AnswerAnalysis,
} from "../../src/core/api";
import { ANALYSIS_TOOLS } from "../../src/core/tools";
import { claimSpans, claimsOf } from "../../src/renderer/src/editor/claimChecks";
import { checkRows, noteHealth } from "../../src/renderer/src/editor/healthCounts";
import { noAnalysisOutput } from "../../src/shared/analysis";
import { liveVersions, tableShownIn } from "../../src/shared/analysisTables";
import { citationState } from "../../src/shared/citations";
import { claimCheckShown } from "../../src/shared/claimChecks";
import { pendingPart } from "../../src/shared/claimParts";
import { installFigureRuns, keptBinding, retainFigureAnalysis } from "../../src/shared/figureRuns";
import { buildAgentShim, connectLegacyAgent, startAgentsCore } from "../helpers/agents";
import { checkingModel, isCheckRun, type Plan, sentenceOf } from "../helpers/checks";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { editMind, readMind } from "../helpers/minds";
import type { ModelCall } from "../helpers/models";

const TIDES = [
  "# Tides",
  "",
  "Spring tides happen twice a month, at new moon and full moon.",
  "",
  "The range of a spring tide is the largest of the month.",
].join("\n");

const SPRING = "Spring tides come twice in every month.";
const NEAP = "Neap tides have the largest range of the month.";
const PENGUINS = "Penguins nest on the cliffs above the harbour.";
const NOTE = [SPRING, NEAP, PENGUINS].join("\n\n");

// One sentence for each count of the Note's page, besides the contradicted and the unsupported.
const CITED = "Spring tides come twice every month.";
const ELSEWHERE = "A spring tide has the largest range of its month.";
const OWN = "We should survey at the spring tides.";
const UNREAD = "The tide tables for the quay are kept elsewhere.";
const UNMARKED = "The outer pier floods during autumn storms.";
const TWICE = "Spring tides happen twice a month";
const LARGEST = "The range of a spring tide is the largest of the month.";
// A sentence whose Citation holds a Passage of Tides, backed by a Document the agent can't read.
const GULLS = "Gulls nest on the harbour cliffs.";
const GULLS_QUOTE = "Gulls nest on the cliffs.";

const PLANS: Record<string, Plan> = {
  [SPRING]: {
    verdict: "supported",
    quote: "Spring tides happen twice a month",
    says: "Tides says spring tides happen twice a month.",
  },
  [NEAP]: {
    verdict: "contradicted",
    quote: "The range of a spring tide is the largest of the month.",
    says: "Tides says the spring tide's range is the largest.",
  },
  [PENGUINS]: { verdict: "unsupported" },
  [CITED]: { verdict: "supported", quote: TWICE, says: "Tides says it twice a month." },
  [ELSEWHERE]: { verdict: "supported", quote: LARGEST, says: "Tides says the range is largest." },
  [OWN]: { verdict: "own view", says: "A plan, not a fact." },
  [UNREAD]: { reply: { text: "It reads well to me." } },
  [UNMARKED]: { sort: "undecided" },
  [GULLS]: { verdict: "supported", quote: GULLS_QUOTE, says: "Rivers says it of the cliffs." },
  // The sentence of two facts, as the agent writes it again with both Passages cited.
  [`${TWICE}, and the range of a spring tide is the largest of the month.`]: {
    verdict: "supported",
    quote: LARGEST,
    says: "Tides says the spring tide's range is the largest.",
  },
};

type Agent = Awaited<ReturnType<typeof connectLegacyAgent>>;

interface Checked {
  mindId: string;
  title: string;
  status: string;
  stopped: string | null;
  models: string[];
  supported: number;
  needLook: number;
  notChecked: number;
  canBeCited: number;
  ownViews: number;
  claims: {
    sentence: string;
    group: string;
    result: string;
    reason: string | null;
    says: string | null;
    document: string | null;
    location: string | null;
    quote: string | null;
    cite: string | null;
  }[];
}

function structured<T>(result: unknown): T {
  const { isError, structuredContent, content } = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: { text?: string }[];
  };
  expect(isError ?? false, content?.[0]?.text).toBe(false);
  return structuredContent as T;
}

function refusal(result: unknown): string {
  const { isError, content } = result as { isError?: boolean; content?: { text?: string }[] };
  expect(isError).toBe(true);
  return content?.[0]?.text ?? "";
}

const check = (agent: Agent, mindId: string) =>
  agent.callTool({ name: "check_mind", arguments: { mindId } });

/** A core with agents on, Tides in "Coast" and an agent that may write there. */
async function paired({ propose = true, calls = [] as ModelCall[], python = false } = {}) {
  const started = await startAgentsCore(
    checkingModel(PLANS, calls),
    python ? { analysisRuntime: createFakeAnalysisRuntime() } : {},
  );
  const { core } = started;
  const sources = await createSourceFolder();
  const [tides] = await addAndProcess(core, [await writeSourceFile(sources, "Tides.md", TIDES)]);
  if (!tides) throw new Error("Tides wasn't added.");
  const coast = await core.createLibraryGroup({ name: "Coast", description: "The sea." });
  await core.assignDocumentGroup(tides.id, coast.id);
  await core.setAgentsEnabled(true);
  const { launch, pairing } = await core.connectAgent({
    name: "Claude Code",
    folderIds: [coast.id],
    propose,
  });
  const agent = await connectLegacyAgent(launch);
  return { ...started, core, coast, agent, pairing, tides };
}

/** A token that cites `quote`, which Tides holds word for word. */
async function citeToken(agent: Agent, quote: string): Promise<string> {
  const { passages } = structured<{ passages: { passageId: string }[] }>(
    await agent.callTool({ name: "search", arguments: { query: quote } }),
  );
  const { citations } = structured<{ citations: { cite: string | null }[] }>(
    await agent.callTool({
      name: "cite",
      arguments: { citations: passages.map(({ passageId }) => ({ passageId, quote })) },
    }),
  );
  const found = citations.find((each) => each.cite !== null)?.cite;
  if (!found) throw new Error(`No Passage holds “${quote}”.`);
  return found;
}

async function written(agent: Agent): Promise<string> {
  const { mindId } = structured<{ mindId: string }>(
    await agent.callTool({
      name: "create_mind",
      arguments: { title: "Tide notes", markdown: NOTE },
    }),
  );
  return mindId;
}

describe("an outside agent has its Note checked (#3317)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=a check an outside agent started counts none of the Library's own lists, which follow the Note's Folder walls and not what the agent may read: its verdicts would tell the agent the names and counts of Documents outside its Folders (#2525); the User's own Check of the same Note may count them; fails_when=an agent can ask "is there a Document called X" of the whole Library through check_mind.
  it("is offered no count of the Library's own lists, which the User's own Check is", async () => {
    const calls: ModelCall[] = [];
    const { core, agent } = await paired({ calls, python: true });
    // A model that can run code, on a service the User allowed checks to send to.
    const saved = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (saved.service) await core.allowDataFlow("checks", saved.service.id);
    const mindId = await written(agent);
    const countsLists = () =>
      calls.some((call) => isCheckRun(call) && call.tools.includes(ANALYSIS_TOOLS.run));

    await check(agent, mindId);
    expect(calls.some(isCheckRun)).toBe(true);
    expect(countsLists()).toBe(false);

    await core.checkMind({ requestId: "own", mindId, mode: "all" });
    expect(countsLists()).toBe(true);
  });

  // protects=an agent learns which of the claims it wrote the User's Documents don't support, and the User sees the same marks in the Note; fails_when=the Tool checks only Citations, returns nothing of what the Document says, or leaves the Note unmarked
  it("checks every claim against the Folder's Documents, marks the Note and lists what needs a look", async () => {
    const { core, agent, pairing, coast } = await paired();
    const mindId = await written(agent);

    const checked = structured<Checked>(await check(agent, mindId));
    expect(checked).toMatchObject({
      mindId,
      title: "Tide notes",
      status: "checked",
      stopped: null,
      supported: 0,
      needLook: 2,
      notChecked: 0,
      canBeCited: 1,
      ownViews: 0,
    });
    expect(checked.models).toHaveLength(1);
    expect(checked.claims).toEqual([
      {
        sentence: NEAP,
        group: "needLook",
        result: "contradicted",
        reason: null,
        says: "Tides says the spring tide's range is the largest.",
        document: "Tides",
        location: expect.any(String),
        quote: "The range of a spring tide is the largest of the month.",
        cite: expect.stringMatching(/^\[cite:[^\]]+\]$/),
      },
      {
        sentence: PENGUINS,
        group: "needLook",
        // Nothing in the Folder speaks of it: the record's "Not found".
        result: "not-found",
        reason: null,
        says: null,
        document: null,
        location: null,
        quote: null,
        cite: null,
      },
      {
        // Supported, with a Passage the sentence doesn't cite: the page counts it as one that can be cited.
        sentence: SPRING,
        group: "canBeCited",
        result: "supported",
        reason: null,
        says: "Tides says spring tides happen twice a month.",
        document: "Tides",
        location: expect.any(String),
        quote: "Spring tides happen twice a month",
        cite: expect.stringMatching(/^\[cite:[^\]]+\]$/),
      },
    ]);
    // The token cites the Passage the claim was judged on: the agent can use it as any other.
    const [{ check: found }] = structured<{ citations: { check: string }[] }>(
      await agent.callTool({
        name: "check_citations",
        arguments: { text: `Spring tides have the largest range ${checked.claims[0]?.cite}.` },
      }),
    ).citations as [{ check: string }];
    expect(found).toBe("found");

    // The User sees the same marks in the Note.
    const client = await connectToMind(core, mindId);
    await client.settled();
    const versions = new Map(
      (await core.listDocuments()).map((each) => [each.id, each.contentHash]),
    );
    expect(
      claimSpans(readMind(client)).map((span) => [
        span.sentence.text,
        claimCheckShown(span.check, {
          footing: "not-yet-known",
          text: span.sentence.text,
          versions,
          folderId: coast.id,
          scope: null,
        }).state,
      ]),
    ).toEqual([
      [SPRING, "supported"],
      [NEAP, "contradicted"],
      [PENGUINS, "unsupported"],
    ]);

    // Asked again with nothing changed, it sends nothing and gives the same result.
    expect(structured<Checked>(await check(agent, mindId))).toMatchObject({
      status: "checked",
      supported: 0,
      needLook: 2,
      canBeCited: 1,
    });
    expect((await core.listAgentActivity(pairing.id)).map((each) => each.tool)).toContain(
      "check_mind",
    );
  });

  // protects=an agent tells the User what the Note's page shows: the reply counts the sentences in the page's own groups, so a sentence that isn't checked or can be cited is never one that needs a look, and each of those is listed with its group and a token to cite it by (#3453); fails_when=a count of the reply differs from the page's check card for the same Note, or a sentence that can be cited isn't listed with its cite
  it("counts the groups the Note's page counts", async () => {
    const { core, agent, coast } = await paired();
    const supportedBy = await citeToken(agent, TWICE);
    // One Citation that holds the Passage the check finds, one that holds another, and one sentence with none.
    const markdown = [
      `${CITED.slice(0, -1)}${supportedBy}.`,
      `${ELSEWHERE.slice(0, -1)}${supportedBy}.`,
      SPRING,
      NEAP,
      PENGUINS,
      OWN,
      UNREAD,
    ].join("\n\n");
    const { mindId } = structured<{ mindId: string }>(
      await agent.callTool({ name: "create_mind", arguments: { title: "Tide notes", markdown } }),
    );

    const checked = structured<Checked>(await check(agent, mindId));

    const client = await connectToMind(core, mindId);
    await client.settled();
    const documents = await core.listDocuments();
    const note = readMind(client);
    const { claims, kept } = claimsOf(note, {
      footing: "not-yet-known",
      versions: new Map(documents.map((each) => [each.id, each.contentHash])),
      folderId: coast.id,
      scope: null,
    });
    const rows = Object.fromEntries(
      checkRows(
        noteHealth(note, {
          claims,
          kept,
          citationCheck: (attributes) => citationState(attributes, documents, []).check,
        }),
      ).map(({ row, places }) => [row, places.length]),
    );
    expect(rows).toEqual({ look: 2, supported: 1, notYetCited: 2, ownViews: 1, toCheck: 1 });
    expect({
      supported: checked.supported,
      needLook: checked.needLook,
      notChecked: checked.notChecked,
      canBeCited: checked.canBeCited,
      ownViews: checked.ownViews,
    }).toEqual({
      supported: rows.supported,
      needLook: rows.look,
      notChecked: rows.toCheck,
      canBeCited: rows.notYetCited,
      ownViews: rows.ownViews,
    });
    expect(
      checked.claims.map(({ sentence, group, result, reason, cite }) => [
        sentence,
        group,
        result,
        reason,
        cite !== null,
      ]),
    ).toEqual([
      [NEAP, "needLook", "contradicted", null, true],
      [PENGUINS, "needLook", "not-found", null, false],
      [UNREAD, "notChecked", "not-checked", "malformed", false],
      [ELSEWHERE, "canBeCited", "supported", null, true],
      [SPRING, "canBeCited", "supported", null, true],
    ]);
  });

  // protects=check_mind's notChecked equals the Note's page count when a sentence carries no check mark or an Analysis table has columns that are not recalculated, by the page's own rule, while the counts for marked sentences don't change (#3460); fails_when=notChecked leaves out unmarked claims or non-recalculated Analysis table columns, or changes supported, needLook, canBeCited or ownViews
  it("counts unmarked claims and Analysis table columns not recalculated in notChecked, as the Note's page does", async () => {
    const { core, agent, coast, tides } = await paired();
    const supportedBy = await citeToken(agent, TWICE);
    const markdown = [
      `${CITED.slice(0, -1)}${supportedBy}.`,
      `${ELSEWHERE.slice(0, -1)}${supportedBy}.`,
      SPRING,
      NEAP,
      PENGUINS,
      OWN,
      UNREAD,
      UNMARKED,
    ].join("\n\n");
    const { mindId } = structured<{ mindId: string }>(
      await agent.callTool({ name: "create_mind", arguments: { title: "Tide notes", markdown } }),
    );
    const documents = await core.listDocuments();
    const client = await connectToMind(core, mindId);
    await client.settled();
    const countOnPage = () => {
      const note = readMind(client);
      const { claims, kept } = claimsOf(note, {
        footing: "not-yet-known",
        versions: new Map(documents.map((each) => [each.id, each.contentHash])),
        folderId: coast.id,
        scope: null,
      });
      return Object.fromEntries(
        checkRows(
          noteHealth(note, {
            claims,
            kept,
            citationCheck: (attributes) => citationState(attributes, documents, []).check,
            tableShown: (table) =>
              tableShownIn(client.doc, table.toJSON(), "en", liveVersions(documents), null),
            tableKept: (table) =>
              keptBinding(client.doc, table.attrs[ANALYSIS_TABLE_ATTRIBUTE]) !== null,
          }),
        ).map(({ row, places }) => [row, places.length]),
      );
    };

    // Case 1: a sentence left without a check mark.
    const withUnmarked = structured<Checked>(await check(agent, mindId));
    await client.settled();
    expect(claimSpans(readMind(client)).map((span) => span.sentence.text)).not.toContain(UNMARKED);
    const unmarkedRows = countOnPage();
    expect(unmarkedRows).toEqual({
      look: 2,
      supported: 1,
      notYetCited: 2,
      ownViews: 1,
      toCheck: 2,
    });
    expect({
      supported: withUnmarked.supported,
      needLook: withUnmarked.needLook,
      notChecked: withUnmarked.notChecked,
      canBeCited: withUnmarked.canBeCited,
      ownViews: withUnmarked.ownViews,
    }).toEqual({
      supported: unmarkedRows.supported,
      needLook: unmarkedRows.look,
      notChecked: unmarkedRows.toCheck,
      canBeCited: unmarkedRows.notYetCited,
      ownViews: unmarkedRows.ownViews,
    });

    // Case 2: an Analysis table with two columns that are not recalculated.
    const binding = { id: "run-1", table: { result: "tide_summary" } };
    const run: AnswerAnalysis = {
      number: 1,
      title: "Tide summary",
      language: "python",
      code: "result('tide_summary', …)",
      inputs: [
        {
          kind: "range",
          name: "tides",
          citation: {
            passageId: "p-1",
            documentId: tides.id,
            documentName: "Tides",
            contentHash: tides.contentHash,
            pageFrom: 1,
            pageTo: 1,
            location: { kind: "rows", sheet: "Tides", from: 1, to: 10 },
            quote: "month\tspring\tneap",
            check: "found",
            checkReason: null,
          },
          range: "A1:C10",
          rows: 9,
          columns: 3,
          rowCount: 9,
          cut: false,
          sha256: "a".repeat(64),
        },
      ],
      versions: null,
      codeSha256: "b".repeat(64),
      outputSha256: "c".repeat(64),
      end: { kind: "done" },
      output: {
        ...noAnalysisOutput(),
        results: [
          {
            kind: "table",
            name: "tide_summary",
            label: "Tide summary by month",
            unit: null,
            table: {
              columns: ["month", "spring", "neap"],
              rows: [
                ["May", 2, 2],
                ["June", 2, 2],
              ],
              rowCount: 2,
              columnCount: 3,
            },
          },
        ],
      },
      ms: 1,
      ranAt: "2026-11-20T09:00:00.000Z",
      markers: { figures: [], tables: [{ result: "tide_summary", marker: 1 }], charts: [] },
    };
    const retained = retainFigureAnalysis(run, binding.id, [], [binding]);
    if (!retained) throw new Error("No Analysis run retained.");
    installFigureRuns(client.doc, [retained]);
    const cell = (type: "tableHeader" | "tableCell", value: string) => ({
      type,
      attrs: { colspan: 1, rowspan: 1 },
      content: [{ type: "paragraph", content: [{ type: "text", text: value }] }],
    });
    const row = (type: "tableHeader" | "tableCell", ...values: string[]) => ({
      type: "tableRow",
      content: values.map((value) => cell(type, value)),
    });
    editMind(client, (blocks) => [
      ...blocks,
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Tide summary by month" },
          { type: ANALYSIS_TABLE_NODE, attrs: { [ANALYSIS_TABLE_ATTRIBUTE]: binding } },
        ],
      },
      {
        type: "table",
        attrs: { [ANALYSIS_TABLE_ATTRIBUTE]: binding },
        content: [
          row("tableHeader", "month", "spring", "neap"),
          row("tableCell", "May", "2", "2"),
          row("tableCell", "June", "2", "2"),
        ],
      },
    ]);
    await client.settled();

    const withTable = structured<Checked>(await check(agent, mindId));
    const tableRows = countOnPage();
    expect(tableRows).toEqual({
      look: 2,
      supported: 1,
      notYetCited: 2,
      ownViews: 1,
      toCheck: 4,
    });
    expect({
      supported: withTable.supported,
      needLook: withTable.needLook,
      notChecked: withTable.notChecked,
      canBeCited: withTable.canBeCited,
      ownViews: withTable.ownViews,
    }).toEqual({
      supported: tableRows.supported,
      needLook: tableRows.look,
      notChecked: tableRows.toCheck,
      canBeCited: tableRows.notYetCited,
      ownViews: tableRows.ownViews,
    });
  });

  // protects=nothing of a Note goes to a service the User took checks back from, and an agent's call never puts a question on their screen (ADR-0022); fails_when=check_mind raises the consent dialog or sends while checks aren't allowed there
  it("sends nothing and asks the User nothing while checks aren't allowed on that service", async () => {
    const calls: ModelCall[] = [];
    const { core, agent } = await paired({ calls });
    const mindId = await written(agent);
    const asked: string[] = [];
    core.on("consent.requested", (request) => {
      asked.push(request.flow.id);
      void core.respondToConsent(request.requestId, false);
    });
    const saved = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
    });
    if (!saved.service) throw new Error("The provider has no service.");
    // Choosing the service allowed its checks; the User takes that back in Settings › Privacy.
    await core.revokeConsent("checks", saved.service.id);
    calls.length = 0;

    expect(refusal(await check(agent, mindId))).toBe(
      "IncarnaMind’s AI model isn’t allowed to check yet. Check the note with check_mind_yourself instead; for IncarnaMind’s own check, the User checks a note in IncarnaMind to allow it.",
    );
    expect(asked).toEqual([]);
    expect(calls).toEqual([]);

    await core.allowDataFlow("checks", saved.service.id);
    expect(structured<Checked>(await check(agent, mindId))).toMatchObject({
      status: "checked",
      supported: 0,
      needLook: 2,
      canBeCited: 1,
    });
    expect(asked).toEqual([]);
  });

  // protects=an agent learns nothing of Documents outside its Folders by having a Note checked: an empty Folder doesn't search the whole Library for it, and the User's own wider check isn't passed on; fails_when=check_mind searches Documents the agent can't read, or reports a verdict from a check that did
  it("checks within the agent's Folders only, and keeps the User's wider check to the User", async () => {
    const calls: ModelCall[] = [];
    const { core, agent } = await paired({ calls });
    const sources = await createSourceFolder();
    const [rivers] = await addAndProcess(core, [
      await writeSourceFile(sources, "Rivers.md", "# Rivers\n\nPenguins nest on the cliffs.\n"),
    ]);
    if (!rivers) throw new Error("Rivers wasn't added.");
    const inland = await core.createLibraryGroup({ name: "Inland", description: "Rivers." });
    await core.assignDocumentGroup(rivers.id, inland.id);

    // A Folder with no Document would search every Document: not for an agent.
    const empty = await core.createLibraryGroup({ name: "Empty", description: "Nothing yet." });
    const { launch } = await core.connectAgent({
      name: "Codex",
      folderIds: [empty.id],
      propose: true,
    });
    const other = await connectLegacyAgent(launch);
    const alone = await written(other);
    calls.length = 0;
    expect(refusal(await check(other, alone))).toBe(
      "The note’s Folder has no Documents to check it against.",
    );
    expect(calls).toEqual([]);

    // The User checks the agent's Note against every Document; the agent then asks for its check.
    const mindId = await written(agent);
    const own = await core.checkMind({
      requestId: "the-users-own",
      mindId,
      mode: "changed",
      allDocuments: true,
    });
    expect(own.kind).toBe("checked");
    calls.length = 0;
    const checked = structured<Checked>(await check(agent, mindId));
    expect(checked).toMatchObject({
      status: "checked",
      supported: 0,
      needLook: 0,
      notChecked: 3,
      canBeCited: 0,
      ownViews: 0,
    });
    expect(
      checked.claims.map(({ group, result, reason, says, document, quote, cite }) => [
        group,
        result,
        reason,
        says,
        document,
        quote,
        cite,
      ]),
    ).toEqual(Array(3).fill(["notChecked", "not-checked", "beyond-reach", null, null, null, null]));
    expect(calls).toEqual([]);
  });

  // protects=a result stands for the agent only while it reaches the Document it rests on: once the User files that Document outside the agent's Folders, the agent's check checks the sentence again within its reach and tells nothing the Document says (#3412 review); fails_when=check_mind keeps telling a result that rests on a Document the agent can no longer read
  it("checks a result again once the agent no longer reaches the Document it rests on", async () => {
    const calls: ModelCall[] = [];
    const { core, agent, coast, tides } = await paired({ calls });
    const sources = await createSourceFolder();
    const [harbour] = await addAndProcess(core, [
      await writeSourceFile(sources, "Harbour.md", "# Harbour\n\nThe harbour has two quays.\n"),
    ]);
    if (!harbour) throw new Error("Harbour wasn't added.");
    await core.assignDocumentGroup(harbour.id, coast.id);
    const mindId = await written(agent);
    expect(structured<Checked>(await check(agent, mindId))).toMatchObject({
      needLook: 2,
      canBeCited: 1,
    });
    const vault = await core.createLibraryGroup({ name: "Vault", description: "Kept apart." });
    await core.assignDocumentGroup(tides.id, vault.id);
    calls.length = 0;

    const checked = structured<Checked>(await check(agent, mindId));
    expect(new Set(calls.filter(isCheckRun).map(sentenceOf))).toEqual(new Set([SPRING, NEAP]));
    expect(checked).toMatchObject({ supported: 0, canBeCited: 0 });
    expect(JSON.stringify(checked)).not.toContain("Tides says");
  });

  // protects=what the User's wider check found in Documents beyond the agent's Folders is told as not checked for every sentence it left a mark on, also the one whose check the record keeps no scope for: a sentence the wider check found supported by a Passage its Citation doesn't hold (stored as Not checked, found elsewhere) is never told as Supported, can be cited, with a Passage to cite (#3453); fails_when=a sentence the wider check backed is told as supported or as one that can be cited, or names its Document, quote or cite
  it("tells a sentence the User's wider check backed beyond the agent's Folders as not checked", async () => {
    const calls: ModelCall[] = [];
    const { core, agent } = await paired({ calls });
    const sources = await createSourceFolder();
    const [rivers] = await addAndProcess(core, [
      await writeSourceFile(sources, "Rivers.md", `# Rivers\n\n${GULLS_QUOTE}\n`),
    ]);
    if (!rivers) throw new Error("Rivers wasn't added.");
    const inland = await core.createLibraryGroup({ name: "Inland", description: "Rivers." });
    await core.assignDocumentGroup(rivers.id, inland.id);
    const holds = await citeToken(agent, TWICE);
    const { mindId } = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "Gull notes",
          markdown: `${GULLS.slice(0, -1)}${holds}.`,
        },
      }),
    );
    const own = await core.checkMind({
      requestId: "the-users-own",
      mindId,
      mode: "changed",
      allDocuments: true,
    });
    expect(own.kind).toBe("checked");
    calls.length = 0;

    const checked = structured<Checked>(await check(agent, mindId));

    expect(checked).toMatchObject({
      status: "checked",
      supported: 0,
      needLook: 0,
      notChecked: 1,
      canBeCited: 0,
      ownViews: 0,
    });
    expect(
      checked.claims.map(({ group, result, reason, says, document, quote, cite }) => [
        group,
        result,
        reason,
        says,
        document,
        quote,
        cite,
      ]),
    ).toEqual([["notChecked", "not-checked", "beyond-reach", null, null, null, null]]);
    expect(calls).toEqual([]);
  });

  // protects=the cite an agent is given for a sentence that can be cited is for the Passage an Add would cite, the one of the sentence's supported parts that none of its Citations is on, with that Passage's own words, Document and place, and not the Passage the sentence's other part rests on and it already cites; and when the agent adds that cite and has the Note checked again, the sentence is no longer one that can be cited (#3453); fails_when=the cite, quote or says is that of a Passage the sentence already cites, so the agent adds nothing and the sentence stays one that can be cited
  it("gives for a sentence that can be cited the Passage it doesn't cite yet", async () => {
    const calls: ModelCall[] = [];
    const { core, agent, coast } = await paired({ calls });
    // Two facts: the first Passage is cited after its words, the second is only what the check found.
    const first = "Spring tides happen twice a month";
    const second = "the range of a spring tide is the largest of the month";
    const sentence = `${first}, and ${second}.`;
    const cites = await citeToken(agent, TWICE);
    const { mindId } = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: { title: "Tide notes", markdown: `${first}${cites}, and ${second}.` },
      }),
    );
    const [tides] = await core.listDocuments();
    if (!tides) throw new Error("Tides is gone.");
    const { passages } = structured<{ passages: { passageId: string }[] }>(
      await agent.callTool({ name: "search", arguments: { query: "spring tide" } }),
    );
    const passageId = passages[0]?.passageId;
    if (!passageId) throw new Error("Tides has no Passage.");
    const held = (quote: string) => ({
      passageId,
      documentId: tides.id,
      documentName: "Tides",
      contentHash: tides.contentHash,
      pageFrom: 1,
      pageTo: 1,
      location: null,
      quote,
      check: "found" as const,
      checkReason: null,
    });
    const supportedOn = (start: number, end: number, quote: string, says: string) => ({
      ...pendingPart({ span: { start, end }, kind: "fact" }),
      verdict: "supported" as const,
      evidence: [held(quote)],
      decidingEvidence: 0,
      says,
    });
    const mark = {
      id: "the-mark",
      request: "request-1",
      action: "find-support",
      state: "supported",
      reason: null,
      detail: null,
      providerId: null,
      modelId: null,
      text: sentence,
      evidence: held(TWICE),
      says: "Tides says spring tides happen twice a month.",
      unsupported: null,
      calculation: null,
      citedCaseUnchecked: false,
      citedCaseFound: false,
      scope: { folderId: coast.id, widened: false },
      versions: [{ documentId: tides.id, contentHash: tides.contentHash }],
      excluded: [],
      checkedAt: "2026-11-18T09:00:00.000Z",
      parts: [
        supportedOn(0, first.length, TWICE, "Tides says spring tides happen twice a month."),
        supportedOn(
          first.length + 6,
          sentence.length - 1,
          LARGEST,
          "Tides says the spring tide's range is the largest.",
        ),
      ],
    };
    const client = await connectToMind(core, mindId);
    await client.settled();
    editMind(client, (blocks) =>
      blocks.map((block) =>
        block.type !== "paragraph"
          ? block
          : {
              ...block,
              content: block.content?.map((node) =>
                node.type === "text"
                  ? { ...node, marks: [{ type: "claimCheck", attrs: mark }] }
                  : node,
              ),
            },
      ),
    );
    await client.settled();
    calls.length = 0;

    const checked = structured<Checked>(await check(agent, mindId));

    expect(calls).toEqual([]);
    expect(checked).toMatchObject({ supported: 0, needLook: 0, notChecked: 0, canBeCited: 1 });
    const [claim] = checked.claims;
    expect(claim).toMatchObject({
      sentence,
      group: "canBeCited",
      result: "supported",
      says: "Tides says the spring tide's range is the largest.",
      document: "Tides",
      quote: LARGEST,
      cite: expect.stringMatching(/^\[cite:[^\]]+\]$/),
    });
    const [given] = structured<{ citations: { check: string; quote: string | null }[] }>(
      await agent.callTool({
        name: "check_citations",
        arguments: { text: `The range is largest ${claim?.cite}.` },
      }),
    ).citations;
    expect(given).toMatchObject({ check: "found", quote: LARGEST });

    // The agent puts that cite after the part it backs, and has the Note checked again.
    const { markdown, version } = structured<{ markdown: string; version: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
    );
    const already = /\[cite:[^\]]+\]/.exec(markdown)?.[0];
    expect(already).toBeDefined();
    const added = structured<{ status: string }>(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId,
          version,
          changes: [{ paragraph: "¶1", text: `${first}${already}, and ${second}${claim?.cite}.` }],
        },
      }),
    );
    expect(added.status).toBe("applied");
    const again = structured<Checked>(await check(agent, mindId));
    expect(again).toMatchObject({ status: "checked", needLook: 0, canBeCited: 0, supported: 1 });
  });

  // protects=an agent can't spend the User's model on, or mark, a Note that isn't its own, and one that may only read checks nothing; fails_when=check_mind runs on the User's own Note or for a read-only pairing
  it("is refused on a Note it didn't write, and for an agent that may only read", async () => {
    const { core, agent, coast } = await paired();
    const own = await core.createMind({ title: "My own", folderId: coast.id });
    expect(refusal(await check(agent, own.id))).toBe(
      "Only a note this agent wrote with create_mind can be checked. It didn’t write this one.",
    );
    expect(refusal(await check(agent, "no-such-note"))).toContain("No such passage");

    const reader = await paired({ propose: false });
    const theirs = await reader.core.createMind({ title: "Theirs", folderId: reader.coast.id });
    expect(refusal(await check(reader.agent, theirs.id))).toContain("This agent may only read.");
  });
});
