/**
 * What "every Document" means (#1942): the examples until the User has a
 * Document of their own, and theirs alone from then on, on every surface that
 * searches — a Question in their own Note, a Mind's check against its
 * Documents, find-support for one sentence, the evidence search behind a
 * figure, Research, writing suggestions, and a Search scope's count. An
 * example's own Note always searches every Document. Deleting the only Document
 * of the User's brings the examples back without a restart.
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
const QUOTE =
  "Net debt to EBITDA was 3.1 times at the end of the quarter, up from 2.7 times at the half year.";
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

/** A core with the shipped examples, and one Document of the User's unless `own` is false. */
async function setUp({
  model,
  own = true,
}: {
  model?: ReturnType<typeof scriptedModel>;
  own?: boolean;
} = {}) {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    paths: { dataDir, examples: EXAMPLES },
    ...(model && { createChatModel: scriptedModels(model).createChatModel }),
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  await core.createExamples();
  const examples = await examplesReady(core);
  if (!own) return { core, own: null, examples };
  const sources = await createSourceFolder();
  const [hers] = await addAndProcess(core, [
    await writeSourceFile(sources, "northwind-notes.txt", `${HER_ONLY}\n`),
  ]);
  if (!hers) throw new Error("No Document added.");
  return { core, own: hers, examples };
}

/** A check model that follows `plans` for the claim (none: unsupported), recording its calls. */
function checkingModel(
  calls: ModelCall[],
  plans: Record<string, { verdict?: "supported"; quote?: string }> = {},
) {
  return scriptedModel(
    (call) => {
      calls.push(call);
      return isCheckRun(call) ? checkReply(call, plans) : { text: "Done." };
    },
    { generate: checkGenerate(plans) },
  );
}

describe("“every Document” is the examples until the User has one, then theirs (#1942)", () => {
  test("with only the examples, a count, the evidence search and find-support all reach them", async () => {
    const calls: ModelCall[] = [];
    const { core, examples } = await setUp({
      model: checkingModel(calls, { [CLAIM]: { verdict: "supported", quote: QUOTE } }),
      own: false,
    });
    const exampleIds = new Set(examples.map((document) => document.id));
    // The examples are the Library: counted, searched and checked against on day one.
    expect(await core.countScopeDocuments(undefined)).toBe(2);
    const found = await core.searchEvidence("Net debt to EBITDA stood at 3.1 times");
    expect(found.passages.length).toBeGreaterThan(0);
    expect(found.passages.every((passage) => exampleIds.has(passage.documentId))).toBe(true);
    const checked = await core.checkClaim({ claim: CLAIM });
    expect(checked.verdict).toBe("supported");
    if (checked.verdict !== "supported" || !checked.evidence) {
      throw new Error("The claim wasn't supported by an example Document.");
    }
    expect(exampleIds.has(checked.evidence.documentId)).toBe(true);
    core.close();
  });

  test("with only the examples, a Mind's check reaches them too", async () => {
    const calls: ModelCall[] = [];
    const { core } = await setUp({
      model: checkingModel(calls, { [CLAIM]: { verdict: "supported", quote: QUOTE } }),
      own: false,
    });
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
    ).toMatchObject({ state: "supported" });
    core.close();
  });

  test("with only the examples, a suggestion's scope and Research read them", async () => {
    const { core } = await setUp({ own: false });
    const mind = await core.createMind({ title: "My note" });
    // Suggestions are off: the answer says whether the scope has Documents to suggest from.
    expect(
      await core.suggestNext({
        requestId: randomUUID(),
        mindId: mind.id,
        paragraph: "Net debt to EBITDA was",
        scope: NO_SCOPE,
      }),
    ).toEqual({ kind: "off", scopeHasDocuments: true });
    core.close();

    const researchCalls: ModelCall[] = [];
    const generatedPrompts: string[] = [];
    const researching = scriptedModel(
      (call) => {
        researchCalls.push(call);
        return { text: "Nothing further." };
      },
      {
        generate: (call) => {
          if (/Topic:/.test(call.prompt))
            return { text: "TITLE: Northwind\n1. Search the Library" };
          generatedPrompts.push(call.prompt);
          if (!call.prompt.includes("Net debt to EBITDA was 3.1 times")) return { text: "OK" };
          return {
            text: JSON.stringify({
              text: "The ratio fell from the half year.",
              passage: "P1",
              quote: "up from 2.7 times at the half year",
            }),
          };
        },
      },
    );
    const second = await setUp({ model: researching, own: false });
    const note = await second.core.createMind({ title: "My note" });
    await second.core.updateSettings({ user: { suggestWhileWriting: true } });
    await second.core.suggestNext({
      requestId: randomUUID(),
      mindId: note.id,
      paragraph:
        "Net debt to EBITDA was 3.1 times at the end of the quarter, up from 2.7 times at the half year, and the",
      scope: NO_SCOPE,
    });
    // A hit, not just a count: the model was given the example's own words.
    const suggestionPrompts = generatedPrompts.filter((prompt) =>
      prompt.includes("Net debt to EBITDA was 3.1 times at the end of the quarter"),
    );
    expect(suggestionPrompts.length).toBeGreaterThan(0);
    expect(
      suggestionPrompts.some((prompt) => prompt.includes("up from 2.7 times at the half year")),
    ).toBe(true);
    const beforeResearch = researchCalls.length;
    const plan: ResearchPlan = { title: "Northwind", steps: ["Search the Library"] };
    const started = await second.core.startResearch({
      mindId: note.id,
      topic: "Northwind's leverage",
      plan,
      sources: { web: false, library: true },
      writeInto: { mindId: note.id },
      scope: NO_SCOPE,
    });
    if (!started.started) throw new Error(`Research didn't start: ${started.reason}`);
    await vi.waitFor(() => expect(researchCalls.length).toBeGreaterThan(beforeResearch), {
      timeout: 15_000,
    });
    await second.core.stopTask(started.task.id);
    expect(
      researchCalls
        .slice(beforeResearch)
        .some((call) =>
          JSON.stringify(call.options.prompt).includes("Northwind Retail · Q3 2026 results"),
        ),
    ).toBe(true);
    second.core.close();
  });

  test("her first Document takes the examples out of every surface", async () => {
    const calls: ModelCall[] = [];
    const { core, own } = await setUp({ model: checkingModel(calls) });
    if (!own) throw new Error("No Document added.");
    expect(await core.countScopeDocuments(undefined)).toBe(1);
    // The example's own words find nothing once her Document is there.
    expect(await core.searchEvidence("Net debt to EBITDA stood at 3.1 times")).toMatchObject({
      passages: [],
      excluded: [],
    });
    expect(await core.checkClaim({ claim: CLAIM })).toMatchObject({
      verdict: "unsupported",
      evidence: null,
    });
    const hers = await core.searchEvidence("Northwind Retail");
    expect(new Set(hers.passages.map((passage) => passage.documentId))).toEqual(new Set([own.id]));
    for (const call of calls) {
      expect(JSON.stringify(call.options.prompt)).not.toContain("Net debt to EBITDA");
    }
    core.close();
  });

  test("deleting her only Document brings the examples back, with no restart", async () => {
    const { core, own } = await setUp();
    if (!own) throw new Error("No Document added.");
    expect(await core.countScopeDocuments(undefined)).toBe(1);
    await core.deleteDocuments([own.id]);
    expect(await core.listDocuments()).toHaveLength(2);
    expect(await core.countScopeDocuments(undefined)).toBe(2);
    const found = await core.searchEvidence("Net debt to EBITDA stood at 3.1 times");
    expect(found.passages.length).toBeGreaterThan(0);
    core.close();
  });

  test("find-support for one sentence searches the User's Documents once she has one", async () => {
    const calls: ModelCall[] = [];
    const model = scriptedModel(
      (call) => {
        calls.push(call);
        return isCheckRun(call) ? checkReply(call, {}) : { text: "Done." };
      },
      { generate: checkGenerate({}) },
    );
    const { core } = await setUp({ model });
    const claimResult = await core.checkClaim({ claim: CLAIM });
    console.log("CLAIM RESULT", JSON.stringify(claimResult));
    expect(claimResult).toMatchObject({ verdict: "unsupported", evidence: null });
    for (const call of calls) {
      expect(JSON.stringify(call.options.prompt)).not.toContain("Net debt to EBITDA");
    }
    core.close();
  });

  test("a Mind's check against its Documents searches the User's Documents once she has one", async () => {
    const calls: ModelCall[] = [];
    const model = scriptedModel(
      (call) => {
        calls.push(call);
        return isCheckRun(call) ? checkReply(call, {}) : { text: "Done." };
      },
      { generate: checkGenerate({}) },
    );
    const { core } = await setUp({ model });
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
    ).toMatchObject({ state: "unsupported" });
    for (const call of calls) {
      expect(JSON.stringify(call.options.prompt)).not.toContain("Net debt to EBITDA");
    }
    core.close();
  });

  test("a writing suggestion looks in the User's Documents once she has one", async () => {
    const generated: string[] = [];
    const model = scriptedModel(() => ({ text: "Nothing further." }), {
      generate: (call) => {
        generated.push(call.prompt);
        return call.prompt.includes("In my own words, Northwind Retail results.")
          ? { text: JSON.stringify({ text: "a suggestion", quote: "none" }) }
          : { text: "OK" };
      },
    });
    const { core } = await setUp({ model });
    await core.updateSettings({ user: { suggestWhileWriting: true } });
    const mind = await core.createMind({ title: "My note" });
    expect(
      await core.suggestNext({
        requestId: randomUUID(),
        mindId: mind.id,
        paragraph: "In my own words, Northwind Retail results.",
        scope: NO_SCOPE,
      }),
    ).toEqual({ kind: "none" });
    // A hit on her own words, and none of the example's.
    const suggestionPrompts = generated.filter((prompt) =>
      prompt.includes("In my own words, Northwind Retail results."),
    );
    expect(suggestionPrompts.length).toBeGreaterThan(0);
    expect(
      suggestionPrompts.some((prompt) =>
        prompt.includes("Northwind Retail results, in my own words."),
      ),
    ).toBe(true);
    for (const prompt of suggestionPrompts) {
      expect(prompt).not.toContain("Net debt to EBITDA");
      expect(prompt).not.toContain("Northwind Retail · Q3 2026 results");
    }
    core.close();
  });

  test("Research from the User's Note reads the User's Documents once she has one", async () => {
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
    const { core } = await setUp({ model });
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
    // A hit on her own words, so the search is proven to have run.
    await vi.waitFor(
      () =>
        expect(
          calls.some((call) => JSON.stringify(call.options.prompt).includes("in my own words")),
        ).toBe(true),
      { timeout: 15_000 },
    );
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
