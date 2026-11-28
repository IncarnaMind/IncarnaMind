/**
 * An outside agent has the Note it wrote checked (#3317): through the shim the app ships, with the
 * MCP SDK's own client, it calls `check_mind`. Every claim is checked against the Folder's
 * Documents on the User's model, the Note carries the marks, and the agent gets back each claim
 * that needs a look with what the Document says.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
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
import { versionsWithLibrary } from "../../src/shared/libraryFacts";
import { buildAgentShim, connectLegacyAgent, startAgentsCore } from "../helpers/agents";
import { checkingModel, isCheckRun, type Plan, sentenceOf } from "../helpers/checks";
import { sortReply } from "../helpers/claimSentences";
import { createTempDataFolder } from "../helpers/core";
import { recordRows } from "../helpers/csv";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { editMind, readMind } from "../helpers/minds";
import { type ModelCall, scriptedModel } from "../helpers/models";

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

  // protects=an outside agent's check_mind counts only the Library lists its own grant covers (#2525): Documents outside the grant, in ungranted Folders, in walled Folders (top-level or nested) and soft-deleted items leave the count unchanged, while Not cited workings in granted Folders stay counted like the User's lists; a grant change invalidates and re-counts; a User-made whole-Library mark is never overwritten and reads as not-checked / beyond-reach; and no name outside the grant ever appears in any request the model receives; fails_when=check_mind counts anything outside the grant, misfiles under an empty parent Folder, drops a Not cited working, keeps a stale count after a grant change, overwrites or leaks the User's Library verdict, or sends any ungranted name to the model.
  it("counts only the Library lists its own grant covers, and updates when the grant changes", async () => {
    const CLAIM = "Your Library holds 4 Documents across 4 Folders and 2 other Notes.";
    const CODE =
      'result("documents", len(inputs["files"]))\nresult("folders", len(inputs["folders"]))\nresult("notes", len(inputs["notes"]))';
    const calls: ModelCall[] = [];
    const runtime = createFakeAnalysisRuntime({
      answer: (job) => {
        const count = (name: string) => {
          const table = job.inputs.find((each) => each.kind === "table" && each.name === name);
          return table && table.kind === "table" ? table.rows.length : 0;
        };
        return {
          output: {
            results: [
              {
                kind: "figure",
                name: "documents",
                label: "documents",
                unit: null,
                value: count("files"),
              },
              {
                kind: "figure",
                name: "folders",
                label: "folders",
                unit: null,
                value: count("folders"),
              },
              { kind: "figure", name: "notes", label: "notes", unit: null, value: count("notes") },
            ],
            // Deliberately print names to prove the model never sees printed output either.
            printed: JSON.stringify(job.inputs),
          },
        };
      },
    });
    const model = scriptedModel(
      (call) => {
        calls.push(call);
        if (!isCheckRun(call)) return { text: JSON.stringify({ claims: [CLAIM] }) };
        const ran = call.results.find((result) => result.tool === ANALYSIS_TOOLS.run);
        if (!ran && call.tools.includes(ANALYSIS_TOOLS.run)) {
          return {
            calls: [
              {
                tool: ANALYSIS_TOOLS.run,
                input: {
                  title: "Count Library lists",
                  inputs: [
                    { name: "files", library: "documents" },
                    { name: "folders", library: "folders" },
                    { name: "notes", library: "notes" },
                  ],
                  code: CODE,
                },
              },
            ],
          };
        }
        const docs = Number(/- documents:\s*(\d+)/.exec(ran?.text ?? "")?.[1] ?? 0);
        const folders = Number(/- folders:\s*(\d+)/.exec(ran?.text ?? "")?.[1] ?? 0);
        const notes = Number(/- notes:\s*(\d+)/.exec(ran?.text ?? "")?.[1] ?? 0);
        if (docs === 4 && folders === 4 && notes === 2) {
          return {
            text: "Verdict: supported\nExplanation: The lists show 4 Documents across 4 Folders and 2 other Notes.\nEvidence: []\nWorking: Counted the Documents, Folders and Notes lists.",
          };
        }
        return {
          text: `Verdict: contradicted\nExplanation: The lists show ${docs} Documents across ${folders} Folders and ${notes} other Notes, not 4, 4 and 2.\nEvidence: []\nWorking: Counted the Documents, Folders and Notes lists.`,
        };
      },
      { generate: (call) => ({ text: sortReply(call.prompt) }) },
    );
    const { core } = await startAgentsCore(model, { analysisRuntime: runtime });
    const saved = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (saved.service) await core.allowDataFlow("checks", saved.service.id);

    const sources = await createSourceFolder();
    const added = await addAndProcess(core, [
      await writeSourceFile(sources, "Tides.md", "# Tides\n\nSpring tides come twice a month.\n"),
      await writeSourceFile(sources, "Chart.md", "# Chart\n\nSoundings in metres.\n"),
      await writeSourceFile(sources, "Quays.md", "# Quays\n\nTwo stone quays.\n"),
      await writeSourceFile(sources, "LooseLeaflet.md", "# Loose\n\nUnfiled outside grant.\n"),
      await writeSourceFile(sources, "Rivers.md", "# Rivers\n\nInland rivers.\n"),
      await writeSourceFile(sources, "VaultLedger.md", "# Vault\n\nPrivate vault ledger.\n"),
      await writeSourceFile(sources, "InnerSecret.md", "# Inner\n\nNested private wall.\n"),
      await writeSourceFile(sources, "RemovedDoc.md", "# Removed\n\nSoft-deleted doc.\n"),
      await writeSourceFile(sources, "OwnWorking.md", "# Working\n\nUser's own workings.\n"),
    ]);
    const byName = (name: string) => {
      const doc = added.find((each) => each.name === name);
      if (!doc) throw new Error(`Missing ${name}`);
      return doc;
    };

    // Granted folders: Coast (with subfolder Coves) and Harbour (empty parent holding subfolder
    // Wharf, which sorts after Harbour so ancestry—not a size tie—must assign Quays to Wharf).
    const coast = await core.createLibraryGroup({ name: "Coast", description: "" });
    const coves = await core.createLibraryGroup({
      name: "Coves",
      description: "",
      parentId: coast.id,
    });
    const harbour = await core.createLibraryGroup({ name: "Harbour", description: "" });
    const wharf = await core.createLibraryGroup({
      name: "Wharf",
      description: "",
      parentId: harbour.id,
    });
    // Ungranted folder, top-level walled folder, inner walled folder inside Coast, soft-deleted folder inside Coast.
    const inland = await core.createLibraryGroup({ name: "Inland", description: "" });
    const vault = await core.createLibraryGroup({ name: "PrivateVault", description: "" });
    await core.updateLibraryGroup(vault.id, {
      name: "PrivateVault",
      description: "",
      keepInside: true,
    });
    const innerWall = await core.createLibraryGroup({
      name: "InnerWall",
      description: "",
      parentId: coast.id,
    });
    await core.updateLibraryGroup(innerWall.id, {
      name: "InnerWall",
      description: "",
      keepInside: true,
    });
    const removedFolder = await core.createLibraryGroup({
      name: "RemovedFolder",
      description: "",
      parentId: coast.id,
    });

    await core.assignDocumentGroup(byName("Tides").id, coast.id);
    await core.assignDocumentGroup(byName("Chart").id, coves.id);
    // Quays sits only in child Wharf (Harbour has 0 direct Documents): ancestry must assign it to Wharf.
    await core.assignDocumentGroup(byName("Quays").id, wharf.id);
    await core.assignDocumentGroup(byName("Rivers").id, inland.id);
    await core.assignDocumentGroup(byName("VaultLedger").id, vault.id);
    await core.assignDocumentGroup(byName("InnerSecret").id, innerWall.id);
    await core.assignDocumentGroup(byName("RemovedDoc").id, coast.id);
    await core.assignDocumentGroup(byName("OwnWorking").id, coast.id);

    // Notes inside and outside the grant, plus a soft-deleted one inside the grant.
    await core.createMind({ title: "Coast log", folderId: coast.id });
    await core.createMind({ title: "Harbour log", folderId: harbour.id });
    await core.createMind({ title: "Inland brief", folderId: inland.id });
    await core.createMind({ title: "VaultMemo", folderId: vault.id });
    await core.createMind({ title: "InnerMemo", folderId: innerWall.id });
    const removedNote = await core.createMind({ title: "RemovedNote", folderId: coast.id });

    // Soft-delete doc, folder and note, and mark OwnWorking as Not cited (still counted in Coast).
    await core.deleteDocument(byName("RemovedDoc").id);
    await core.deleteLibraryGroup(removedFolder.id);
    await core.deleteMind(removedNote.id);
    await core.setNotCited(byName("OwnWorking").id, true);

    const OUT_OF_GRANT = [
      "LooseLeaflet",
      "Inland",
      "Rivers",
      "Inland brief",
      "PrivateVault",
      "VaultLedger",
      "VaultMemo",
      "InnerWall",
      "InnerSecret",
      "InnerMemo",
      "RemovedDoc",
      "RemovedFolder",
      "RemovedNote",
    ];
    const assertNoLeak = (
      seenCalls: readonly ModelCall[],
      reply: unknown,
      extra: string[] = [],
    ) => {
      const forbidden = [...OUT_OF_GRANT, ...extra];
      const blobs = [...seenCalls.map((each) => JSON.stringify(each)), JSON.stringify(reply)];
      for (const blob of blobs) {
        for (const secret of forbidden) {
          expect(blob).not.toContain(secret);
        }
      }
    };

    await core.setAgentsEnabled(true);
    const { launch, pairing } = await core.connectAgent({
      name: "Claude Code",
      folderIds: [coast.id, harbour.id],
      propose: true,
    });
    const agent = await connectLegacyAgent(launch);
    const { mindId } = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: { title: "Library rundown", folderId: coast.id, markdown: CLAIM },
      }),
    );

    // 1. Grant [Coast, Harbour]: counts granted Documents (4, including Not cited OwnWorking), Folders (4) and Notes (2).
    calls.length = 0;
    const first = structured<Checked>(await check(agent, mindId));
    expect(first).toMatchObject({ status: "checked", supported: 1, needLook: 0, notChecked: 0 });
    expect(runtime.jobs).toHaveLength(1);
    const job1 = runtime.jobs[0];
    expect(job1?.inputs).toMatchObject([
      {
        name: "files",
        rows: expect.arrayContaining([
          ["Tides", "markdown", "Coast", "Coast", ""],
          ["Chart", "markdown", "Coves", "Coast / Coves", ""],
          ["Quays", "markdown", "Wharf", "Harbour / Wharf", ""],
          ["OwnWorking", "markdown", "Coast", "Coast", ""],
        ]),
      },
      {
        name: "folders",
        rows: expect.arrayContaining([
          ["Coast", "", "Coast", 3],
          ["Coves", "Coast", "Coast / Coves", 1],
          ["Harbour", "", "Harbour", 1],
          ["Wharf", "Harbour", "Harbour / Wharf", 1],
        ]),
      },
      {
        name: "notes",
        rows: expect.arrayContaining([
          ["Coast log", "Coast", "Coast"],
          ["Harbour log", "Harbour", "Harbour"],
        ]),
      },
    ]);
    expect(job1?.inputs.map((input) => (input.kind === "table" ? input.rows.length : -1))).toEqual([
      4, 4, 2,
    ]);
    assertNoLeak(calls, first);

    // Unchanged grant: asking again sends nothing and keeps the verdict.
    calls.length = 0;
    const repeated = structured<Checked>(await check(agent, mindId));
    expect(calls).toEqual([]);
    expect(runtime.jobs).toHaveLength(1);
    expect(repeated).toMatchObject({ status: "checked", supported: 1, needLook: 0 });

    // 2. Grant narrowed to [Coast]: invalidates the prior Library count and re-checks under [Coast].
    await core.updateAgent(pairing.id, { folderIds: [coast.id] });
    calls.length = 0;
    const narrowed = structured<Checked>(await check(agent, mindId));
    expect(runtime.jobs).toHaveLength(2);
    const job2 = runtime.jobs[1];
    expect(job2?.inputs.map((input) => (input.kind === "table" ? input.rows.length : -1))).toEqual([
      3, 2, 1,
    ]);
    expect(narrowed).toMatchObject({ status: "checked", supported: 0, needLook: 1, notChecked: 0 });
    expect(narrowed.claims[0]).toMatchObject({
      sentence: CLAIM,
      group: "needLook",
      result: "contradicted",
      document: "“Coast”",
      location: "“Coast”: 3 Documents",
      quote: null,
      cite: null,
    });
    expect(narrowed.claims[0]?.says).toContain("3 Documents across 2 Folders and 1 other Notes");
    assertNoLeak(calls, narrowed, ["Harbour", "Wharf", "Quays", "Harbour log"]);

    // 3. Grant expanded back to [Coast, Harbour]: updates the count back to Supported.
    await core.updateAgent(pairing.id, { folderIds: [coast.id, harbour.id] });
    calls.length = 0;
    const expanded = structured<Checked>(await check(agent, mindId));
    expect(runtime.jobs).toHaveLength(3);
    expect(expanded).toMatchObject({ status: "checked", supported: 1, needLook: 0 });
    assertNoLeak(calls, expanded);

    // 4. The User runs their own Check (seeing full non-walled Library + left-out wall count),
    // then the narrowed agent checks again: it never overwrites the User's mark and reports beyond-reach.
    await core.updateAgent(pairing.id, { folderIds: [coast.id] });
    const own = await core.checkMind({ requestId: "own-full-check", mindId, mode: "all" });
    expect(own.kind).toBe("checked");
    expect(runtime.jobs).toHaveLength(4);
    calls.length = 0;
    const afterOwn = structured<Checked>(await check(agent, mindId));
    expect(calls).toEqual([]);
    expect(runtime.jobs).toHaveLength(4);
    expect(afterOwn).toMatchObject({
      status: "checked",
      supported: 0,
      needLook: 0,
      notChecked: 1,
      claims: [
        {
          sentence: CLAIM,
          group: "notChecked",
          result: "not-checked",
          reason: "beyond-reach",
          says: null,
          document: null,
          location: null,
          quote: null,
          cite: null,
        },
      ],
    });
    assertNoLeak(calls, afterOwn, ["Harbour", "Wharf", "Quays", "Harbour log"]);

    // The User's own verdict still stands untouched in the Note.
    const client = await connectToMind(core, mindId);
    await client.settled();
    const userVersions = versionsWithLibrary(
      await core.listDocuments(),
      await core.libraryListsVersion(mindId),
    );
    expect(
      claimSpans(readMind(client)).map((span) =>
        claimCheckShown(span.check, {
          footing: "not-yet-known",
          text: span.sentence.text,
          versions: userVersions,
          folderId: coast.id,
          scope: null,
        }),
      ),
    ).toEqual([{ state: "contradicted" }]);

    // Once the Library changes outside the agent's grant so the User's Library check goes stale,
    // the agent still may not overwrite it: check_mind is refused beyond-reach and sends nothing.
    const [extraInland] = await addAndProcess(core, [
      await writeSourceFile(sources, "Estuary.md", "# Estuary\n\nAnother inland document.\n"),
    ]);
    if (!extraInland) throw new Error("Missing Estuary");
    await core.assignDocumentGroup(extraInland.id, inland.id);
    calls.length = 0;
    expect(refusal(await check(agent, mindId))).toContain("outside the Folders");
    expect(calls).toEqual([]);
    expect(runtime.jobs).toHaveLength(4);

    // Editing that sentence in place while the User's Library mark still overlaps it is ALSO
    // refused beyond-reach instead of queueing as `fresh` and overwriting the User's mark.
    const edited = await connectToMind(core, mindId);
    await edited.settled();
    edited.doc.transact(() => {
      const paragraph = edited.blocks.get(1);
      if (paragraph instanceof Y.XmlElement) {
        const textNode = paragraph.get(0);
        if (textNode instanceof Y.XmlText) {
          const plain = (textNode.toDelta() as { insert?: unknown }[])
            .map((op) => (typeof op.insert === "string" ? op.insert : ""))
            .join("");
          const at = plain.indexOf("4");
          if (at >= 0) {
            textNode.delete(at, 1);
            textNode.insert(at, "5");
          }
        }
      }
    });
    await edited.settled();
    expect(readMind(edited).textContent).toContain("5 Documents");
    calls.length = 0;
    expect(refusal(await check(agent, mindId))).toContain("outside the Folders");
    expect(calls).toEqual([]);
    expect(runtime.jobs).toHaveLength(4);

    // 5. Revoking all Folders leaves no grant: check_mind is refused and sends nothing.
    await core.updateAgent(pairing.id, { folderIds: [] });
    calls.length = 0;
    expect(refusal(await check(agent, mindId))).toContain("No such passage");
    expect(calls).toEqual([]);
    expect(runtime.jobs).toHaveLength(4);
  });

  // protects=a User Check inside a walled Folder (whose Library source carries kind "scope") is still User-owned so an outside agent can neither read nor overwrite it when stale, while the agent's own stale scoped pairing mark can still be re-checked (#2525); fails_when=isUserLibraryCheck mistakes a User check inside a walled Folder for a pairing check, or blocks an agent from re-checking its own stale pairing mark.
  it("preserves a User-made Library mark inside a walled Folder while letting an agent re-check its own stale pairing mark", async () => {
    const CLAIM = "The Library holds 2 Documents.";
    const CODE = 'result("documents", len(inputs["files"]))';
    const runtime = createFakeAnalysisRuntime({
      answer: (job) => {
        const table = job.inputs.find((each) => each.kind === "table" && each.name === "files");
        const count = table && table.kind === "table" ? table.rows.length : 0;
        return {
          output: {
            results: [
              { kind: "figure", name: "documents", label: "documents", unit: null, value: count },
            ],
            printed: "",
          },
        };
      },
    });
    const calls: string[] = [];
    const model = scriptedModel(
      (call) => {
        calls.push(JSON.stringify(call));
        if (!isCheckRun(call)) return { text: JSON.stringify({ claims: [CLAIM] }) };
        const ran = call.results.find((result) => result.tool === ANALYSIS_TOOLS.run);
        if (!ran && call.tools.includes(ANALYSIS_TOOLS.run)) {
          return {
            calls: [
              {
                tool: ANALYSIS_TOOLS.run,
                input: {
                  title: "Count Documents",
                  inputs: [{ name: "files", library: "documents" }],
                  code: CODE,
                },
              },
            ],
          };
        }
        const docs = Number(/- documents:\s*(\d+)/.exec(ran?.text ?? "")?.[1] ?? 0);
        return {
          text:
            docs === 2
              ? "Verdict: supported\nExplanation: The list has 2 Documents.\nEvidence: []\nWorking: Counted the Documents list."
              : `Verdict: contradicted\nExplanation: The list has ${docs} Documents.\nEvidence: []\nWorking: Counted the Documents list.`,
        };
      },
      { generate: (call) => ({ text: sortReply(call.prompt) }) },
    );
    const { core } = await startAgentsCore(model, { analysisRuntime: runtime });
    const saved = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (saved.service) await core.allowDataFlow("checks", saved.service.id);

    const sources = await createSourceFolder();
    const [secretDoc, publicDoc] = await addAndProcess(core, [
      await writeSourceFile(sources, "Secret.md", "# Secret\n\nWalled document.\n"),
      await writeSourceFile(sources, "Public.md", "# Public\n\nShared sub-folder document.\n"),
    ]);
    if (!secretDoc || !publicDoc) throw new Error("Missing fixture Documents.");
    const vault = await core.createLibraryGroup({ name: "Vault", description: "" });
    const pub = await core.createLibraryGroup({
      name: "Public",
      description: "",
      parentId: vault.id,
    });
    await core.updateLibraryGroup(vault.id, {
      name: "Vault",
      description: "",
      keepInside: true,
    });
    await core.assignDocumentGroup(secretDoc.id, vault.id);
    await core.assignDocumentGroup(publicDoc.id, pub.id);

    await core.setAgentsEnabled(true);
    const { launch } = await core.connectAgent({
      name: "Claude Code",
      folderIds: [pub.id],
      propose: true,
    });
    const agent = await connectLegacyAgent(launch);

    // User checks a Note inside the walled Folder (stored with source.kind: "scope", outside absent).
    const { mindId: userNote } = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: { title: "Vault count", folderId: pub.id, markdown: CLAIM },
      }),
    );
    expect(
      (await core.checkMind({ requestId: "user-wall", mindId: userNote, mode: "all" })).kind,
    ).toBe("checked");

    // While current, the User's walled-Folder Library mark is masked as beyond-reach (never revealed).
    calls.length = 0;
    expect(structured<Checked>(await check(agent, userNote))).toMatchObject({
      status: "checked",
      supported: 0,
      needLook: 0,
      notChecked: 1,
      claims: [
        {
          sentence: CLAIM,
          group: "notChecked",
          result: "not-checked",
          reason: "beyond-reach",
          says: null,
          document: null,
          location: null,
          quote: null,
          cite: null,
        },
      ],
    });
    expect(calls).toEqual([]);

    // Once stale, the agent still may not overwrite the User's walled-Folder Library mark.
    const [extraVault] = await addAndProcess(core, [
      await writeSourceFile(sources, "Secret2.md", "# Secret 2\n\nAnother walled document.\n"),
    ]);
    if (!extraVault) throw new Error("Missing Secret2.");
    await core.assignDocumentGroup(extraVault.id, vault.id);
    calls.length = 0;
    expect(refusal(await check(agent, userNote))).toContain("outside the Folders");
    expect(calls).toEqual([]);

    // Meanwhile, an agent's own pairing mark (outside: true) IS re-checked once its grant changes.
    const { mindId: agentNote } = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: { title: "Agent count", folderId: pub.id, markdown: CLAIM },
      }),
    );
    expect(structured<Checked>(await check(agent, agentNote))).toMatchObject({
      status: "checked",
      supported: 0,
      needLook: 1,
    });
    const [extraPub] = await addAndProcess(core, [
      await writeSourceFile(sources, "Public2.md", "# Public 2\n\nSecond shared document.\n"),
    ]);
    if (!extraPub) throw new Error("Missing Public2.");
    await core.assignDocumentGroup(extraPub.id, pub.id);
    expect(structured<Checked>(await check(agent, agentNote))).toMatchObject({
      status: "checked",
      supported: 1,
      needLook: 0,
    });

    // An agent's own Library mark written via check_mind_yourself + run_analysis + report_check
    // also carries `outside: true`, so the same agent can re-check it with check_mind after a change.
    const { mindId: ownCheckedNote } = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: { title: "Reported count", folderId: pub.id, markdown: CLAIM },
      }),
    );
    const task = structured<{ task: string; sentences: { n: number }[] }>(
      await agent.callTool({
        name: "check_mind_yourself",
        arguments: { mindId: ownCheckedNote },
      }),
    );
    const analysis = structured<{ id: string }>(
      await agent.callTool({
        name: "run_analysis",
        arguments: {
          title: "Count Documents",
          inputs: [{ name: "files", library: "documents" }],
          code: CODE,
        },
      }),
    );
    expect(
      structured<{ marked: number; unconfirmed: number[] }>(
        await agent.callTool({
          name: "report_check",
          arguments: {
            mindId: ownCheckedNote,
            task: task.task,
            results: [
              {
                n: 1,
                verdict: "supported",
                run: analysis.id,
                explanation: "The list has 2 Documents.",
              },
            ],
          },
        }),
      ),
    ).toMatchObject({ marked: 1, unconfirmed: [] });
    const [thirdPub] = await addAndProcess(core, [
      await writeSourceFile(sources, "Public3.md", "# Public 3\n\nThird shared document.\n"),
    ]);
    if (!thirdPub) throw new Error("Missing Public3.");
    await core.assignDocumentGroup(thirdPub.id, pub.id);
    expect(structured<Checked>(await check(agent, ownCheckedNote))).toMatchObject({
      status: "checked",
      supported: 0,
      needLook: 1,
    });

    // An old Library mark stored before `outside: true` existed (source.kind: "scope", no `outside`
    // flag) fails closed as User-owned: masked while current, and refused with guidance for the User
    // to check it in IncarnaMind once stale.
    const legacyClient = await connectToMind(core, agentNote);
    await legacyClient.settled();
    legacyClient.doc.transact(() => {
      const paragraph = legacyClient.blocks.get(1);
      if (paragraph instanceof Y.XmlElement) {
        const textNode = paragraph.get(0);
        if (textNode instanceof Y.XmlText) {
          for (const op of textNode.toDelta() as {
            insert?: string;
            attributes?: Record<string, unknown>;
          }[]) {
            for (const [key, raw] of Object.entries(op.attributes ?? {})) {
              if (!key.startsWith("claimCheck") || !raw || typeof raw !== "object") continue;
              const { outside: _drop, ...withoutOutside } = raw as Record<string, unknown>;
              textNode.format(0, textNode.length, { [key]: withoutOutside });
            }
          }
        }
      }
    });
    await legacyClient.settled();
    expect(claimSpans(readMind(legacyClient))[0]?.check.outside).toBeUndefined();
    calls.length = 0;
    const legacyRefusal = refusal(await check(agent, agentNote));
    expect(legacyRefusal).toContain("outside the Folders");
    expect(legacyRefusal).toContain("The User can check it in IncarnaMind.");
    expect(calls).toEqual([]);
  });

  // protects=every User-side reader (editor, Word export, check record, AI use statement) reads an agent's grant-only Library check as needs-recheck when the User's Library differs, Not cited workings are counted alike by User and agent, and check_mind names the granted source with sourceWords and libraryRow rather than "library-facts" or "Your Library" (#2525); fails_when=export/check-record/AI-use-statement show an agent's grant-only Library check as Supported, agent and User disagree on Not cited workings, or check_mind leaks "library-facts" or "Your Library".
  it("flags an agent's grant-only Library check as needs-recheck across User views, counts Not cited workings alike, and names the granted source", async () => {
    const TWO = "Your Library holds 2 Documents.";
    const NINE = "Your Library holds 9 Documents.";
    const CODE = 'result("documents", len(inputs["files"]))';
    const runtime = createFakeAnalysisRuntime({
      answer: (job) => {
        const table = job.inputs.find((each) => each.kind === "table" && each.name === "files");
        const count = table && table.kind === "table" ? table.rows.length : 0;
        return {
          output: {
            results: [
              { kind: "figure", name: "documents", label: "documents", unit: null, value: count },
            ],
            printed: "",
          },
        };
      },
    });
    const model = scriptedModel(
      (call) => {
        if (!isCheckRun(call)) {
          const text = JSON.stringify(call);
          return { text: JSON.stringify({ claims: [text.includes(NINE) ? NINE : TWO] }) };
        }
        const ran = call.results.find((result) => result.tool === ANALYSIS_TOOLS.run);
        if (!ran && call.tools.includes(ANALYSIS_TOOLS.run)) {
          return {
            calls: [
              {
                tool: ANALYSIS_TOOLS.run,
                input: {
                  title: "Count Documents",
                  inputs: [{ name: "files", library: "documents" }],
                  code: CODE,
                },
              },
            ],
          };
        }
        const docs = Number(/- documents:\s*(\d+)/.exec(ran?.text ?? "")?.[1] ?? 0);
        const claimed = JSON.stringify(call).includes(NINE) ? 9 : 2;
        return {
          text:
            docs === claimed
              ? `Verdict: supported\nExplanation: The list has ${docs} Documents.\nEvidence: []\nWorking: Counted the Documents list.`
              : `Verdict: contradicted\nExplanation: The list has ${docs} Documents, not ${claimed}.\nEvidence: []\nWorking: Counted the Documents list.`,
        };
      },
      { generate: (call) => ({ text: sortReply(call.prompt) }) },
    );
    const { core } = await startAgentsCore(model, { analysisRuntime: runtime });
    const saved = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (saved.service) await core.allowDataFlow("checks", saved.service.id);

    const sources = await createSourceFolder();
    const [tides, quays, rivers] = await addAndProcess(core, [
      await writeSourceFile(sources, "Tides.md", "# Tides\n\nSpring tides.\n"),
      await writeSourceFile(sources, "Quays.md", "# Quays\n\nStone quays.\n"),
      await writeSourceFile(sources, "Rivers.md", "# Rivers\n\nInland rivers.\n"),
    ]);
    if (!tides || !quays || !rivers) throw new Error("Missing fixture Documents.");
    const coast = await core.createLibraryGroup({ name: "Coast", description: "" });
    const harbour = await core.createLibraryGroup({ name: "Harbour", description: "" });
    await core.assignDocumentGroup(tides.id, coast.id);
    await core.assignDocumentGroup(quays.id, coast.id);
    await core.assignDocumentGroup(rivers.id, harbour.id);
    await core.setNotCited(quays.id, true);

    await core.setAgentsEnabled(true);
    const { launch } = await core.connectAgent({
      name: "Claude Code",
      folderIds: [coast.id],
      propose: true,
    });
    const agent = await connectLegacyAgent(launch);

    // 1. Agent checks "2 Documents" on [Coast] (Tides + Not cited Quays = 2): Supported for agent,
    //    but Needs re-check across EVERY User-side view because ungranted Harbour holds Rivers.
    const { mindId: supportedNote } = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: { title: "Coast count", folderId: coast.id, markdown: TWO },
      }),
    );
    expect(structured<Checked>(await check(agent, supportedNote))).toMatchObject({
      status: "checked",
      supported: 1,
      needLook: 0,
    });

    // Editor view:
    const editorClient = await connectToMind(core, supportedNote);
    await editorClient.settled();
    const userVersions = versionsWithLibrary(
      await core.listDocuments(),
      await core.libraryListsVersion(supportedNote),
    );
    expect(
      claimSpans(readMind(editorClient)).map((span) =>
        claimCheckShown(span.check, {
          footing: "not-yet-known",
          text: span.sentence.text,
          versions: userVersions,
          folderId: coast.id,
          scope: null,
        }),
      ),
    ).toEqual([{ state: "needs-recheck", why: "library" }]);

    // Word export view:
    const exported = await core.exportMind(supportedNote, {
      format: "docx",
      commentFailedChecks: true,
    });
    expect(exported.sentenceChecks.needsRecheck).toBe(1);

    // Check record CSV view:
    const outDir = await createTempDataFolder();
    await core.setOutputLocation(outDir);
    const savedRecord = await core.saveCheckRecord(supportedNote);
    if (savedRecord.status !== "saved") throw new Error(`Not saved: ${savedRecord.status}`);
    const csvPath = join(outDir, savedRecord.file.name.replace(/\.(pdf|csv)$/, ".csv"));
    expect(
      recordRows(readFileSync(csvPath, "utf8"))
        .filter((row) => row.Kind === "Sentence")
        .map((row) => row.Result),
    ).toEqual(["Needs re-check"]);

    // AI use statement view:
    const statement = await core.createAiUseStatement(supportedNote);
    const statementClient = await connectToMind(core, statement.id);
    await statementClient.settled();
    const statementText = readMind(statementClient).textContent;
    expect(statementText).toContain("Needs re-check");
    expect(statementText).not.toContain("Supported: 1");

    // 2. Agent check_mind reply names the granted source with sourceWords and libraryRow (EN + zh-CN).
    const { mindId: contradictedNote } = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: { title: "Wrong count", folderId: coast.id, markdown: NINE },
      }),
    );
    const contradictedEn = structured<Checked>(await check(agent, contradictedNote));
    expect(contradictedEn.claims[0]).toMatchObject({
      result: "contradicted",
      document: "“Coast”",
      location: "“Coast”: 2 Documents",
      quote: null,
      cite: null,
    });
    expect(contradictedEn.claims[0]?.document).not.toContain("library-facts");
    expect(contradictedEn.claims[0]?.document).not.toContain("Your Library");
    expect(contradictedEn.claims[0]?.location).not.toContain("Your Library");

    await core.updateSettings({ user: { language: "zh-CN" } });
    const contradictedZh = structured<Checked>(await check(agent, contradictedNote));
    expect(contradictedZh.claims[0]).toMatchObject({
      result: "contradicted",
      document: "“Coast”",
      location: "“Coast”：2 个文档",
      quote: null,
      cite: null,
    });
    await core.updateSettings({ user: { language: "en" } });

    // 3. When Coast is the whole Library (Harbour & Rivers removed), User and agent agree on Not cited Quays (2 Documents).
    await core.deleteDocument(rivers.id);
    await core.deleteLibraryGroup(harbour.id);
    const { mindId: agreedNote } = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: { title: "Agreed count", folderId: coast.id, markdown: TWO },
      }),
    );
    const userRun = await core.checkMind({
      requestId: "user-agrees-not-cited",
      mindId: agreedNote,
      mode: "all",
    });
    expect(userRun.kind).toBe("checked");
    const savedAgreed = await core.saveCheckRecord(agreedNote);
    if (savedAgreed.status !== "saved") throw new Error(`Not saved: ${savedAgreed.status}`);
    const agreedCsvPath = join(outDir, savedAgreed.file.name.replace(/\.(pdf|csv)$/, ".csv"));
    expect(
      recordRows(readFileSync(agreedCsvPath, "utf8"))
        .filter((row) => row.Kind === "Sentence")
        .map((row) => row.Result),
    ).toEqual(["Supported"]);
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
      toCheck: 2,
      cantCheck: 2,
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
      notChecked: (tableRows.toCheck ?? 0) + (tableRows.cantCheck ?? 0),
      canBeCited: tableRows.notYetCited,
      ownViews: tableRows.ownViews,
    });

    // A cantCheck sentence before a toCheck sentence stays first in notChecked (Note order).
    const uncheckable = "See Smith v. Harbor Board for the mooring rule.";
    editMind(client, (blocks) => [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: uncheckable,
            marks: [
              {
                type: "claimCheck",
                attrs: {
                  id: "cant-check-first",
                  request: "request-1",
                  action: "find-support",
                  state: "not-checked",
                  reason: "cited-case-missing",
                  detail: null,
                  providerId: null,
                  modelId: null,
                  text: uncheckable,
                  evidence: null,
                  says: null,
                  unsupported: null,
                  calculation: null,
                  citedCaseUnchecked: true,
                  citedCaseFound: false,
                  scope: { folderId: coast.id, widened: false },
                  versions: [{ documentId: tides.id, contentHash: tides.contentHash }],
                  excluded: [],
                  checkedAt: "2026-11-18T09:00:00.000Z",
                },
              },
            ],
          },
        ],
      },
      ...blocks,
    ]);
    await client.settled();
    const ordered = structured<Checked>(await check(agent, mindId));
    const notCheckedSentences = ordered.claims
      .filter((claim) => claim.group === "notChecked")
      .map((claim) => claim.sentence);
    expect(notCheckedSentences).toEqual([uncheckable, UNREAD]);
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

  // protects=a User-made library-unsettled mark is masked as beyond-reach and never overwritten by an outside agent, while an outside agent's own library-unsettled mark (outside: true) is held on unchanged grant and re-checked once its granted Folder changes (#2525); fails_when=an outside agent reads or overwrites a User's library-unsettled mark, or cannot re-check its own.
  it("masks and protects a User's library-unsettled mark while allowing an agent to re-check its own", async () => {
    const CLAIM = "Two of your Documents were added in October.";
    const calls: ModelCall[] = [];
    const runtime = createFakeAnalysisRuntime({
      answer: () => ({
        output: {
          results: [
            { kind: "figure", name: "documents", label: "documents", unit: null, value: 1 },
          ],
          printed: "",
        },
      }),
    });
    const model = scriptedModel(
      (call) => {
        if (!isCheckRun(call)) return { text: JSON.stringify({ claims: [CLAIM] }) };
        calls.push(call);
        if (!call.results.some((result) => result.tool === "search_documents")) {
          return { calls: [{ tool: "search_documents", input: { query: "October" } }] };
        }
        return {
          text: "Verdict: not found\nUnits: none\nLibrary: unsettled\nExplanation: Lists do not hold dates added.\nEvidence: []",
        };
      },
      { generate: (call) => ({ text: sortReply(call.prompt) }) },
    );
    const { core } = await startAgentsCore(model, { analysisRuntime: runtime });
    const saved = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (saved.service) await core.allowDataFlow("checks", saved.service.id);

    const sources = await createSourceFolder();
    const [secretDoc, publicDoc] = await addAndProcess(core, [
      await writeSourceFile(sources, "Secret.md", "# Secret\n\nPrivate file.\n"),
      await writeSourceFile(sources, "Public.md", "# Public\n\nShared file.\n"),
    ]);
    if (!secretDoc || !publicDoc) throw new Error("Missing fixture Documents.");
    const vault = await core.createLibraryGroup({ name: "Vault", description: "" });
    const pub = await core.createLibraryGroup({ name: "Public", description: "" });
    await core.assignDocumentGroup(secretDoc.id, vault.id);
    await core.assignDocumentGroup(publicDoc.id, pub.id);

    await core.setAgentsEnabled(true);
    const { launch } = await core.connectAgent({
      name: "Claude Code",
      folderIds: [pub.id],
      propose: true,
    });
    const agent = await connectLegacyAgent(launch);

    const { mindId: userNote } = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: { title: "User unsettled", folderId: pub.id, markdown: CLAIM },
      }),
    );
    expect(
      (await core.checkMind({ requestId: "user-u1", mindId: userNote, mode: "all" })).kind,
    ).toBe("checked");

    // Current User library-unsettled mark: masked as beyond-reach, zero model calls.
    calls.length = 0;
    expect(structured<Checked>(await check(agent, userNote))).toMatchObject({
      status: "checked",
      notChecked: 1,
      claims: [{ sentence: CLAIM, result: "not-checked", reason: "beyond-reach" }],
    });
    expect(calls).toEqual([]);

    // Once User's Library changes, the agent is refused rather than overwriting the User's mark.
    const [extraVault] = await addAndProcess(core, [
      await writeSourceFile(sources, "Secret2.md", "# Secret 2\n\nAnother private file.\n"),
    ]);
    if (!extraVault) throw new Error("Missing Secret2.");
    await core.assignDocumentGroup(extraVault.id, vault.id);
    calls.length = 0;
    expect(refusal(await check(agent, userNote))).toContain("outside the Folders");
    expect(calls).toEqual([]);

    // Agent's own library-unsettled mark (outside: true): held when unchanged, re-checked when grant changes.
    const { mindId: agentNote } = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: { title: "Agent unsettled", folderId: pub.id, markdown: CLAIM },
      }),
    );
    calls.length = 0;
    expect(structured<Checked>(await check(agent, agentNote))).toMatchObject({
      status: "checked",
      notChecked: 1,
      claims: [{ sentence: CLAIM, result: "not-checked", reason: "library-unsettled" }],
    });
    expect(calls).toHaveLength(1);

    calls.length = 0;
    expect(structured<Checked>(await check(agent, agentNote))).toMatchObject({
      status: "checked",
      notChecked: 1,
      claims: [{ sentence: CLAIM, result: "not-checked", reason: "library-unsettled" }],
    });
    expect(calls).toEqual([]);

    const [extraPub] = await addAndProcess(core, [
      await writeSourceFile(sources, "Public2.md", "# Public 2\n\nSecond shared file.\n"),
    ]);
    if (!extraPub) throw new Error("Missing Public2.");
    await core.assignDocumentGroup(extraPub.id, pub.id);
    calls.length = 0;
    expect(structured<Checked>(await check(agent, agentNote))).toMatchObject({
      status: "checked",
      notChecked: 1,
      claims: [{ sentence: CLAIM, result: "not-checked", reason: "library-unsettled" }],
    });
    expect(calls).toHaveLength(1);
  });
});
