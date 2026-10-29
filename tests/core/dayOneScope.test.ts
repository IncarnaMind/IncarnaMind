/**
 * What "no Search scope" means once the example is there (#1942): the User's
 * own Documents, never the example's, on every surface that searches — a
 * Mind's check (against its Documents and for one sentence's support), the
 * evidence search behind a figure or a claim, Research, writing suggestions,
 * and the count a Search scope shows. An example's own Note still searches
 * the examples.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test, vi } from "vitest";
import type { Core, Document, ResearchPlan } from "../../src/core";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { claimCheckShown } from "../../src/shared/claimChecks";
import { NO_SCOPE } from "../../src/shared/searchScope";
import { checkGenerate, checkReply, isCheckRun } from "../helpers/checks";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";

const EXAMPLES = resolve(__dirname, "../../resources/examples");
const CLAIM = "Northwind Retail's leverage was 3.1 times at the end of Q3 2026.";
const HER_ONLY = "Northwind Retail results, in my own words.";

const text = (value: string): JSONContent => ({ type: "text", text: value });
const paragraph = (...content: JSONContent[]): JSONContent & { attrs: { id: string } } => ({
  type: "paragraph",
  attrs: { id: randomUUID() },
  content,
});

/** The example Documents, once the app has read them. */
async function examplesReady(core: Core) {
  const examples = await core.getExamples();
  if (examples.linkedFolderId === null) return [];
  return vi.waitFor(
    async () => {
      const read = await core.listDocuments({ linkedFolderId: examples.linkedFolderId ?? "" });
      expect(read.length).toBeGreaterThan(0);
      expect(read.every((each) => each.status === "ready")).toBe(true);
      return read;
    },
    { timeout: 30_000 },
  );
}

/** A core with the shipped examples and one Document of the User's own. */
async function setUp(model?: ReturnType<typeof scriptedModel>) {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    paths: { dataDir, examples: EXAMPLES },
    ...(model && { createChatModel: scriptedModels(model).createChatModel }),
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  await core.createExamples();
  const examples = await examplesReady(core);
  const sources = await createSourceFolder();
  const [own] = await addAndProcess(core, [
    await writeSourceFile(sources, "northwind-notes.txt", `${HER_ONLY}\n`),
  ]);
  if (!own) throw new Error("No Document added.");
  return { core, own, examples };
}

describe("no Search scope means the User's Documents, not the examples' (#1942)", () => {
  test("the count a Search scope shows is the User's own", async () => {
    const { core } = await setUp();
    expect(await core.countScopeDocuments(undefined)).toBe(1);
    expect(await core.countScopeDocuments(NO_SCOPE)).toBe(1);
    expect(await core.countScopeDocuments({ ...NO_SCOPE, documentIds: [] })).toBe(1);
    core.close();
  });

  test("the evidence search reaches the User's Document only", async () => {
    const { core, own } = await setUp();
    // The example's own words, which only it holds.
    expect(await core.searchEvidence("Net debt to EBITDA stood at 3.1 times")).toMatchObject({
      passages: [],
      excluded: [],
    });
    const hers = await core.searchEvidence("Northwind Retail");
    expect(hers.passages.length).toBeGreaterThan(0);
    expect(new Set(hers.passages.map((passage) => passage.documentId))).toEqual(new Set([own.id]));
    core.close();
  });

  test("find-support for one sentence searches the User's Documents only", async () => {
    const calls: ModelCall[] = [];
    const model = scriptedModel(
      (call) => {
        calls.push(call);
        return isCheckRun(call) ? checkReply(call, {}) : { text: "Done." };
      },
      { generate: checkGenerate({}) },
    );
    const { core } = await setUp(model);

    expect(await core.checkClaim({ claim: CLAIM })).toMatchObject({
      verdict: "unsupported",
      evidence: null,
    });
    for (const call of calls) {
      expect(JSON.stringify(call.options.prompt)).not.toContain("Net debt to EBITDA");
      expect(JSON.stringify(call.options.prompt)).not.toContain(
        "Northwind Retail · Senior facilities agreement",
      );
    }
    core.close();
  });

  test("a Mind's check against its Documents searches the User's Documents only", async () => {
    const calls: ModelCall[] = [];
    const model = scriptedModel(
      (call) => {
        calls.push(call);
        return isCheckRun(call) ? checkReply(call, {}) : { text: "Done." };
      },
      { generate: checkGenerate({}) },
    );
    const { core } = await setUp(model);
    const mind = await core.createMind({ title: "My note" });
    const client = await connectToMind(core, mind.id);
    const block = paragraph(text(CLAIM));
    writeMind(client, [block]);
    await client.settled();

    const checked = await core.checkSentences({
      requestId: randomUUID(),
      mindId: mind.id,
      action: "check-against-documents",
      from: { blockId: block.attrs.id, offset: 0 },
      to: { blockId: block.attrs.id, offset: CLAIM.length },
    });
    expect(checked.kind).toBe("checked");
    await client.settled();
    const versions = new Map(
      (await core.listDocuments()).map((document: Document) => [document.id, document.contentHash]),
    );
    const [span] = claimSpans(readMind(client));
    if (!span) throw new Error("The sentence has no check.");
    expect(
      claimCheckShown(span.check, { text: CLAIM, versions, folderId: null, scope: null }),
    ).toEqual({ state: "unsupported" });
    for (const call of calls) {
      expect(JSON.stringify(call.options.prompt)).not.toContain("Net debt to EBITDA");
    }
    core.close();
  });

  test("a writing suggestion looks in the User's Documents only", async () => {
    const calls: ModelCall[] = [];
    const model = scriptedModel((call) => {
      calls.push(call);
      return { text: JSON.stringify({ text: "a suggestion", quote: "none" }) };
    });
    const { core } = await setUp(model);
    await core.updateSettings({ user: { suggestWhileWriting: true } });
    const mind = await core.createMind({ title: "My note" });
    expect(
      await core.suggestNext({
        requestId: randomUUID(),
        mindId: mind.id,
        paragraph: "Net debt to EBITDA stood at",
        scope: NO_SCOPE,
      }),
    ).toEqual({ kind: "none" });
    for (const call of calls) {
      expect(JSON.stringify(call.options.prompt)).not.toContain("Net debt to EBITDA");
    }
    core.close();
  });

  test("Research from the User's Note reads the User's Documents only", async () => {
    const calls: ModelCall[] = [];
    const model = scriptedModel(
      (call) => {
        calls.push(call);
        if (call.tools.includes("search_documents")) {
          return { calls: [{ tool: "search_documents", input: { query: "Northwind Retail" } }] };
        }
        return { text: "Nothing in the User's Documents says so." };
      },
      {
        generate: (call) =>
          /Topic:/.test(call.prompt)
            ? { text: "TITLE: Northwind\n1. Search the Library" }
            : { text: "Sure." },
      },
    );
    const { core } = await setUp(model);
    const mind = await core.createMind({ title: "My note" });
    const plan: ResearchPlan = { title: "Northwind", steps: ["Search the Library"] };
    const started = await core.startResearch({
      mindId: mind.id,
      topic: "Northwind's leverage",
      plan,
      sources: { web: false, library: true },
      writeInto: { mindId: mind.id },
      scope: NO_SCOPE,
    });
    if (!started.started) throw new Error(`Research didn't start: ${started.reason}`);
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0), { timeout: 15_000 });
    await core.stopTask(started.task.id);
    for (const call of calls) {
      expect(JSON.stringify(call.options.prompt)).not.toContain("Net debt to EBITDA");
      expect(JSON.stringify(call.options.prompt)).not.toContain(
        "Northwind Retail · Q3 2026 results",
      );
    }
    core.close();
  });
});
