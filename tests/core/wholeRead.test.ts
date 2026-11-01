import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test, vi } from "vitest";
import type {
  ClaimCheckAttributes,
  ClaimPartPlan,
  Core,
  CoreAdapters,
  Document,
  PlanDocumentCheckInput,
  SearchScope,
} from "../../src/core";
import {
  SEARCH_OUTPUT_TOKENS,
  VERDICT_OUTPUT_TOKENS,
} from "../../src/core/answers/checks/wholeRead";
import { estimateTokens } from "../../src/core/answers/context";
import { DATABASE_FILE } from "../../src/core/core";
import { createMeter, type MeteredModel } from "../../src/core/cost/meter";
import { openDatabase } from "../../src/core/storage";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { readClaimCheck } from "../../src/shared/claimChecks";
import {
  checkGenerate,
  checkingModel,
  checkReply,
  isCheckRun,
  listedSentences,
  type Plan,
  sentenceOf,
} from "../helpers/checks";
import { type SourceFile, setUpWithDocuments, shownPassages } from "../helpers/citations";
import { createTempDataFolder, nextEvent } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import type { MindClient } from "../helpers/mindClient";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { type ModelCall, scriptedModel } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

const paragraph = (...content: JSONContent[]): JSONContent & { attrs: { id: string } } => ({
  type: "paragraph",
  attrs: { id: crypto.randomUUID() },
  content,
});
const text = (value: string, check?: ClaimCheckAttributes): JSONContent => ({
  type: "text",
  text: value,
  ...(check && { marks: [{ type: "claimCheck", attrs: check }] }),
});
const whole = (block: { attrs: { id: string } }, length: number) => ({
  from: { blockId: block.attrs.id, offset: 0 },
  to: { blockId: block.attrs.id, offset: length },
});
const within = (documentIds: readonly string[]): SearchScope => ({
  folderIds: [],
  tagIds: [],
  documentIds: [...documentIds],
});

async function setup(
  files: readonly SourceFile[],
  plans: Record<string, Plan>,
  claim: string,
  calls: ModelCall[] = [],
  initial?: ClaimCheckAttributes,
  givenModel?: ReturnType<typeof checkingModel>,
  overrides: Partial<CoreAdapters> = {},
) {
  const model = givenModel ?? checkingModel(plans, calls);
  const result = await setUpWithDocuments(model, files, overrides);
  const block = paragraph(text(claim, initial));
  writeMind(result.client, [block]);
  await result.client.settled();
  return { ...result, model, block };
}

function checkInput(
  mindId: string,
  block: { attrs: { id: string } },
  claim: string,
  picked: SearchScope,
  requestId: string = crypto.randomUUID(),
) {
  return {
    requestId,
    mindId,
    action: "check-against-document" as const,
    ...whole(block, claim.length),
    within: picked,
  };
}

/** A whole read's input, sized first as the card sizes it: its plan, for this sentence and pick. */
async function readInput(
  core: Core,
  mindId: string,
  block: { attrs: { id: string } },
  claim: string,
  picked: SearchScope,
  requestId: string = crypto.randomUUID(),
  extra: Pick<PlanDocumentCheckInput, "model" | "part"> = {},
) {
  const plan = await core.planDocumentCheck({
    mindId,
    ...whole(block, claim.length),
    within: picked,
    ...extra,
  });
  if (plan.kind !== "ready") throw new Error(`The pick can't be read: ${plan.kind}.`);
  return { ...checkInput(mindId, block, claim, picked, requestId), plan: plan.id, ...extra };
}

async function marks(client: MindClient) {
  await client.settled();
  return claimSpans(readMind(client)).map((span) => span.check);
}

async function onlyMark(client: MindClient): Promise<ClaimCheckAttributes> {
  const [check] = await marks(client);
  if (!check) throw new Error("The sentence has no check.");
  return check;
}

const EN = {
  language: "en" as const,
  claim: "The lease allows pets up to 15 kg.",
  quote: "The lease allows pets up to 15 kg",
  // A named Document can be read directly, before the ranked cut-off this fixture measures.
  document: "Document-0.md",
};
const ZH = {
  language: "zh-CN" as const,
  claim: "租约允许养15公斤以下的宠物。",
  quote: "租约允许养15公斤以下的宠物",
  document: "Lease-zh.md",
};

describe("Check against a Document, read whole", () => {
  test.each([EN, ZH])(
    "finds support below the ranked-search cut-off ($language)",
    async (example) => {
      const decoys = Array.from({ length: 30 }, (_, index) => ({
        name: `Similar-${index}.md`,
        contents: `${Array.from({ length: 8 }, () => example.quote).join(" ")} Unrelated variation ${index}.`,
      }));
      const leaseQuote = `${example.quote}; the signed lease controls.`;
      const files = [{ name: example.document, contents: leaseQuote }, ...decoys];
      const calls: ModelCall[] = [];
      const model = scriptedModel(
        (call) => {
          calls.push(call);
          const handedLease = JSON.stringify(call.options.prompt).includes(leaseQuote);
          // The sentence's figure is a part of its own, found in the lease too.
          return checkReply(call, {
            [sentenceOf(call)]: handedLease
              ? { verdict: "supported", quote: leaseQuote }
              : { verdict: "unsupported" },
          });
        },
        { generate: checkGenerate({}) },
      );
      const { core, client, mind, block, documents } = await setup(
        files,
        {},
        example.claim,
        calls,
        undefined,
        model,
      );
      await core.updateSettings({ user: { language: example.language } });
      const lease = documents[0] as Document;

      await core.checkSentences({
        requestId: crypto.randomUUID(),
        mindId: mind.id,
        action: "check-against-documents",
        ...whole(block, example.claim.length),
        allDocuments: true,
      });
      const before = await onlyMark(client);
      expect(before.state).toBe("unsupported");
      const handed = calls
        .filter(isCheckRun)
        .flatMap((call) => call.results)
        .filter((result) => result.tool === "search_documents");
      expect(handed.length).toBeGreaterThan(0);
      expect(handed.some((result) => result.text.includes(leaseQuote))).toBe(false);

      const planBefore = await core.planDocumentCheck({
        mindId: mind.id,
        ...whole(block, example.claim.length),
        within: within([lease.id]),
      });
      expect(planBefore).toMatchObject({ kind: "ready", documents: [{ documentId: lease.id }] });

      const result = await core.checkSentences(
        await readInput(core, mind.id, block, example.claim, within([lease.id])),
      );

      expect(result).toMatchObject({ kind: "checked", sentences: 1, checked: 1 });
      const check = await onlyMark(client);
      expect(check).toMatchObject({
        // The card that asked stays on its mark, which now holds the result.
        id: before.id,
        action: "check-against-document",
        state: "supported",
        evidence: { documentId: lease.id, quote: leaseQuote, check: "found" },
        scope: { chosen: { documentIds: [lease.id] } },
      });
      expect(check.read?.pages).toBe(check.read?.of);
    },
  );

  test.each([
    {
      language: "en" as const,
      claim: "The tenant may keep a cat.",
      quote: "The tenant may keep a cat",
    },
    { language: "zh-CN" as const, claim: "乙方可以养猫。", quote: "乙方可以养猫" },
  ])("sends its window once however often a check searches it ($language)", async (example) => {
    const filler = Array.from(
      { length: 40 },
      (_, index) => `Clause ${index + 1} covers the ordinary upkeep of the flat.`,
    );
    const lease = [...filler, `${example.quote}.`].join("\n\n");
    const runs: ModelCall[] = [];
    const plan = { [example.claim]: { verdict: "supported" as const, quote: example.quote } };
    const model = scriptedModel(
      (call) => {
        runs.push(call);
        const searched = call.results.filter((result) => result.tool === "search_documents");
        // Two searches at once, as Claude Haiku 5.5 searched, then one more.
        if (searched.length === 0) {
          return {
            calls: [
              { tool: "search_documents", input: { query: example.claim } },
              { tool: "search_documents", input: { query: "pets" } },
            ],
          };
        }
        if (searched.length === 2) {
          return { calls: [{ tool: "search_documents", input: { query: "animals" } }] };
        }
        if (!call.results.some((result) => result.tool === "cite")) {
          const holding = searched
            .flatMap((result) => shownPassages(result.text))
            .find((passage) => passage.text.includes(example.quote));
          return {
            calls: [
              {
                tool: "cite",
                input: { citations: [{ marker: 1, passage: holding?.id, quote: example.quote }] },
              },
            ],
          };
        }
        return checkReply(call, plan);
      },
      { generate: checkGenerate(plan) },
    );
    const { core, client, mind, block, documents } = await setup(
      [{ name: "Lease.md", contents: lease }],
      plan,
      example.claim,
      [],
      undefined,
      model,
    );
    await core.updateSettings({ user: { language: example.language } });

    await core.checkSentences(
      await readInput(core, mind.id, block, example.claim, within([documents[0]?.id ?? ""])),
    );

    expect(await onlyMark(client)).toMatchObject({
      state: "supported",
      evidence: { quote: example.quote },
    });
    const read = runs.filter(isCheckRun);
    expect(read.length).toBeGreaterThanOrEqual(4);
    const copies = (call: ModelCall) =>
      JSON.stringify(call.options.prompt).split("Clause 7 covers").length - 1;
    expect(copies(read[0] as ModelCall)).toBe(0);
    for (const call of read.slice(1)) expect(copies(call)).toBe(1);
    const results = read.at(-1)?.results.filter((result) => result.tool === "search_documents");
    expect(results?.map((result) => shownPassages(result.text).length > 0)).toEqual([
      true,
      false,
      false,
    ]);
    expect(results?.[2]?.text).toContain("an earlier search returned them all");
  });

  test("stops after the first settling window", async () => {
    const lines = [
      EN.quote,
      ...Array.from(
        { length: 6000 },
        (_, index) => `Unrelated lease paragraph ${index} with ordinary words.`,
      ),
    ];
    const document = buildPdf([{ placed: lines.map((text) => ({ text, x: 72, y: 760 })) }]);
    const calls: ModelCall[] = [];
    const plan = { [EN.claim]: { verdict: "supported" as const, quote: EN.quote } };
    const { core, client, mind, block, documents } = await setup(
      [{ name: "Lease.pdf", contents: document }],
      plan,
      EN.claim,
      calls,
    );
    const progress: number[] = [];
    core.on("documentCheck.progress", (event) => progress.push(event.pages));

    await core.checkSentences(
      await readInput(core, mind.id, block, EN.claim, within([documents[0]?.id ?? ""])),
    );

    expect(progress).toHaveLength(2);
    const check = await onlyMark(client);
    expect(check.state).toBe("supported");
    expect(check.read).toEqual({ pages: 0, of: 1 });
    expect(progress.at(-1)).toBe(check.read?.pages);
  });

  test("reads every window before saying a sentence is absent", async () => {
    const filler = Array.from(
      { length: 6000 },
      (_, index) => `Unrelated lease paragraph ${index} with ordinary words.`,
    ).join("\n");
    const calls: ModelCall[] = [];
    const plan = { [EN.claim]: { verdict: "unsupported" as const } };
    const { core, client, mind, block, documents } = await setup(
      [{ name: EN.document, contents: filler }],
      plan,
      EN.claim,
      calls,
    );
    const progress: number[] = [];
    core.on("documentCheck.progress", (event) => progress.push(event.pages));

    await core.checkSentences(
      await readInput(core, mind.id, block, EN.claim, within([documents[0]?.id ?? ""])),
    );

    expect(calls.filter(isCheckRun).length).toBeGreaterThan(1);
    const check = await onlyMark(client);
    expect(check.state).toBe("unsupported");
    expect(check.read?.pages).toBe(check.read?.of);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(check.read?.of);
  });

  const LONG_CLAIM = "The lease allows pets.";
  const longLines = (page: number) =>
    Array.from(
      { length: 30 },
      (_, line) => `Page ${page} line ${line + 1} has ordinary lease words for this check.`,
    );
  const LONG_PLAN = { [LONG_CLAIM]: { verdict: "supported" as const, quote: longLines(1)[4] } };

  /** A 12-page lease read by a model whose window holds fewer Passages than each read's window. */
  async function readLong(model?: ReturnType<typeof checkingModel>, calls: ModelCall[] = []) {
    const document = buildPdf(
      Array.from({ length: 12 }, (_, page) => ({ lines: longLines(page + 1) })),
    );
    const ollamaModels: CoreAdapters["ollamaModels"] = {
      describe: async () => ({
        digest: null,
        capabilities: ["completion", "tools"],
        contextLength: 12288,
        parameters: null,
        support: "tools",
        chat: true,
        remote: false,
        settings: { numCtx: 12288, outputTokens: 1024, keepAlive: "5m", think: false },
      }),
      loaded: async () => true,
      running: async () => true,
    };
    const result = await setup(
      [{ name: "Lease-long.pdf", contents: document }],
      LONG_PLAN,
      LONG_CLAIM,
      calls,
      undefined,
      model,
      { ollamaModels },
    );
    const { core, mind, block, documents } = result;
    await core.checkSentences(
      await readInput(core, mind.id, block, LONG_CLAIM, within([documents[0]?.id ?? ""])),
    );
    const { pages } = await core.readDocumentText(documents[0]?.id ?? "");
    /** The pages every line the Document holds of which reached the model in these requests. */
    const completeIn = (sent: readonly ModelCall[]) => {
      const handed = sent
        .filter(isCheckRun)
        .flatMap((call) => call.results.map((each) => each.text))
        .join("\n");
      return pages.filter(({ text: words }) =>
        words
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .every((line) => handed.includes(line)),
      ).length;
    };
    return { ...result, check: await onlyMark(result.client), completeIn };
  }

  test("counts a page only when every supplied Passage on it reached the model", async () => {
    const calls: ModelCall[] = [];
    const { check, completeIn } = await readLong(undefined, calls);

    const complete = completeIn(calls);
    expect(complete).toBeGreaterThan(0);
    expect(complete).toBeLessThan(12);
    expect(check.state).toBe("supported");
    expect(check.read).toEqual({ pages: complete, of: 12 });
  });

  test("plans with the same model-specific windows as the read", async () => {
    const filler = Array.from(
      { length: 6000 },
      (_, index) => `Unrelated lease paragraph ${index} with ordinary words.`,
    ).join("\n");
    const { core, client, mind, block, documents } = await setup(
      [{ name: EN.document, contents: filler }],
      { [EN.claim]: { verdict: "unsupported" } },
      EN.claim,
    );
    const provider = await core.saveChatProvider({
      kind: "openai",
      apiKey: "sk-test",
      modelId: "gpt-4-turbo",
    });
    if (!provider.service) throw new Error("The test provider has no service.");
    await core.allowDataFlow("document-check", provider.service.id);
    const model = { providerId: provider.id, modelId: "gpt-4-turbo" };
    const plan = await core.planDocumentCheck({
      mindId: mind.id,
      ...whole(block, EN.claim.length),
      within: within([documents[0]?.id ?? ""]),
      model,
    });
    if (plan.kind !== "ready" || plan.estimate?.billing !== "per-token") {
      throw new Error("The whole read has no per-token estimate.");
    }
    const requestId = crypto.randomUUID();
    let reports = 0;
    core.on("documentCheck.progress", (event) => {
      if (event.requestId === requestId) reports++;
    });

    await core.checkSentences(
      await readInput(core, mind.id, block, EN.claim, within([documents[0]?.id ?? ""]), requestId, {
        model,
      }),
    );
    await client.settled();

    expect(reports - 1).toBeGreaterThan(1);
    // A search and a verdict for each window's check, and the absence judgement it may need, and a
    // quarter more, as Claude Haiku 5.5's reads sent. At the most, 23 for each window: twenty, and
    // three more comparisons for the sentence's figure (15 kg).
    expect(plan.estimate.calls).toBe(Math.round((reports - 1) * 3 * 1.25));
    expect(plan.estimate.upTo?.calls).toBe((reports - 1) * 23);
  });

  test("keeps an earlier on-topic result when a later window finds nothing", async () => {
    const filler = [
      "Covered clause: pets up to 10 kg are allowed.",
      ...Array.from(
        { length: 6000 },
        (_, index) => `Unrelated lease paragraph ${index} with ordinary words.`,
      ),
    ].join("\n");
    const calls: ModelCall[] = [];
    const model = scriptedModel(
      (call) => {
        calls.push(call);
        const found = JSON.stringify(call.options.prompt).includes("Covered clause");
        return checkReply(call, {
          [EN.claim]: found
            ? {
                reply: {
                  text: "Verdict: unsupported\nTopic: found\nCovered: pets up to 10 kg\nNot covered: pets up to 15 kg",
                },
              }
            : { verdict: "unsupported" },
        });
      },
      { generate: checkGenerate({}) },
    );
    const result = await setUpWithDocuments(model, [{ name: EN.document, contents: filler }]);
    const block = paragraph(text(EN.claim));
    writeMind(result.client, [block]);
    await result.client.settled();

    await result.core.checkSentences(
      await readInput(
        result.core,
        result.mind.id,
        block,
        EN.claim,
        within([result.documents[0]?.id ?? ""]),
      ),
    );

    expect(calls.filter(isCheckRun).length).toBeGreaterThan(1);
    const check = await onlyMark(result.client);
    expect(check.state).toBe("unsupported");
    expect(check.unsupported).toMatchObject({ found: true, covered: "pets up to 10 kg" });
    expect(check.read?.pages).toBe(check.read?.of);
  });

  test("a later unjudged window prevents an earlier partial answer becoming an absence", async () => {
    const filler = [
      "Covered clause: pets up to 10 kg are allowed.",
      ...Array.from(
        { length: 6000 },
        (_, index) => `Unrelated lease paragraph ${index} with ordinary words.`,
      ),
    ].join("\n");
    const model = scriptedModel(
      (call) => {
        if (
          isCheckRun(call) &&
          call.results.some((result) => result.tool === "search_documents") &&
          !JSON.stringify(call.options.prompt).includes("Covered clause")
        ) {
          return { text: "This window has no readable verdict." };
        }
        return checkReply(call, {
          [EN.claim]: {
            reply: {
              text: "Verdict: unsupported\nTopic: found\nCovered: pets up to 10 kg\nNot covered: pets up to 15 kg",
            },
          },
        });
      },
      { generate: checkGenerate({}) },
    );
    const { core, client, mind, block, documents } = await setup(
      [{ name: EN.document, contents: filler }],
      {},
      EN.claim,
      [],
      undefined,
      model,
    );

    await core.checkSentences(
      await readInput(core, mind.id, block, EN.claim, within([documents[0]?.id ?? ""])),
    );

    expect(await onlyMark(client)).toMatchObject({ state: "not-checked", reason: "malformed" });
  });

  test("a slower read cannot replace a newer result", async () => {
    let release = () => {};
    const paused = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    let held = false;
    const model = scriptedModel(
      (call) => {
        if (isCheckRun(call) && !held && call.results.some((result) => result.tool === "cite")) {
          held = true;
          return {
            text: "Verdict: unsupported\nCovered: pets\nNot covered: the weight limit",
            pause: { after: 0, until: paused },
          };
        }
        return checkReply(call, { [EN.claim]: { verdict: "supported", quote: EN.quote } });
      },
      { generate: checkGenerate({}) },
    );
    const { core, client, mind, block, documents } = await setup(
      [{ name: EN.document, contents: EN.quote }],
      {},
      EN.claim,
      [],
      undefined,
      model,
    );

    const older = core.checkSentences(
      await readInput(core, mind.id, block, EN.claim, within([documents[0]?.id ?? ""]), "older"),
    );
    await vi.waitFor(() => expect(held).toBe(true));
    await core.checkSentences(
      await readInput(core, mind.id, block, EN.claim, within([documents[0]?.id ?? ""]), "newer"),
    );
    expect(await onlyMark(client)).toMatchObject({ request: "newer", state: "supported" });

    release();
    await older;

    expect(await onlyMark(client)).toMatchObject({ request: "newer", state: "supported" });
  });

  test("a partial read leaves the previous mark unchanged when stopped", async () => {
    const previous: ClaimCheckAttributes = {
      id: "previous-not-found",
      request: "earlier-search",
      action: "check-against-documents",
      state: "unsupported",
      reason: null,
      detail: null,
      providerId: null,
      modelId: null,
      text: EN.claim,
      evidence: null,
      says: null,
      unsupported: null,
      calculation: null,
      citedCaseUnchecked: false,
      citedCaseFound: false,
      scope: { folderId: null, widened: false },
      versions: [],
      excluded: [],
      checkedAt: "2026-10-27T00:00:00.000Z",
    };
    const filler = Array.from(
      { length: 6000 },
      (_, index) => `Unrelated lease paragraph ${index} with ordinary words.`,
    ).join("\n");
    const plan = { [EN.claim]: { verdict: "unsupported" as const } };
    const { core, client, mind, block, documents } = await setup(
      [{ name: EN.document, contents: filler }],
      plan,
      EN.claim,
      [],
      previous,
    );
    const requestId = crypto.randomUUID();
    const before = await onlyMark(client);
    expect(before).toMatchObject(previous);
    core.on("documentCheck.progress", (event) => {
      if (event.requestId === requestId && event.pages > 0) void core.cancelCheck(requestId);
    });

    const result = await core.checkSentences(
      await readInput(core, mind.id, block, EN.claim, within([documents[0]?.id ?? ""]), requestId),
    );

    expect(result).toEqual({ kind: "cancelled" });
    expect(await onlyMark(client)).toEqual(before);
  });

  test("whole-read consent is separate from checks and nothing is sent on a decline", async () => {
    const calls: ModelCall[] = [];
    const plan = { [EN.claim]: { verdict: "supported" as const, quote: EN.quote } };
    const { core, mind, block, documents } = await setup(
      [{ name: EN.document, contents: EN.quote }],
      plan,
      EN.claim,
      calls,
    );
    const saved = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (!saved.service) throw new Error("The test provider has no service.");
    const requested = nextEvent(core, "consent.requested");

    const running = core.checkSentences(
      await readInput(core, mind.id, block, EN.claim, within([documents[0]?.id ?? ""]), undefined, {
        model: { providerId: saved.id, modelId: "claude-haiku-5-5" },
      }),
    );
    const request = await requested;
    expect(request.flow.id).toBe("document-check");
    expect(request.newKinds).toContain("whole-document");
    await core.respondToConsent(request.requestId, false);

    expect(await running).toMatchObject({
      kind: "not-ready",
      readiness: { ready: false, reason: "consent-declined" },
    });
    expect(calls).toHaveLength(0);
    expect(await core.listDataFlows()).toContainEqual(
      expect.objectContaining({
        flow: expect.objectContaining({ id: "checks" }),
        consent: "accepted",
      }),
    );
  });

  test("planning refuses an empty pick or too many Documents without a model call", async () => {
    const files = Array.from({ length: 26 }, (_, index) => ({
      name: `Document-${index}.md`,
      contents: `Text ${index}`,
    }));
    const calls: ModelCall[] = [];
    const { core, mind, documents, block } = await setup(files, {}, EN.claim, calls);
    const ids = documents.map((each) => each.id);
    const sentence = whole(block, EN.claim.length);

    expect(
      await core.planDocumentCheck({ mindId: mind.id, ...sentence, within: within(ids) }),
    ).toEqual({
      kind: "too-many",
      documents: 26,
      most: 25,
    });
    expect(
      await core.planDocumentCheck({ mindId: mind.id, ...sentence, within: within(["missing"]) }),
    ).toEqual({
      kind: "nothing-to-read",
    });
    expect(calls).toHaveLength(0);
  });

  test("reads current coverage and leaves older marks with their old action", () => {
    const current = readClaimCheck({
      id: "whole",
      action: "check-against-document",
      state: "unsupported",
      read: { pages: 2, of: 4 },
    });
    expect(current).toMatchObject({ action: "check-against-document", read: { pages: 2, of: 4 } });
    const older = readClaimCheck({ id: "older", action: "future-action", state: "unsupported" });
    expect(older).toMatchObject({ action: "find-support" });
    expect(older?.read).toBeUndefined();
  });
});

const handedText = (calls: readonly ModelCall[]) =>
  calls
    .filter(isCheckRun)
    .flatMap((call) => call.results.map((result) => result.text))
    .join("\n");

const WALLED = [
  {
    language: "en" as const,
    claim: "Termination needs 90 days' notice.",
    inside: { name: "Client A lease.txt", contents: "Termination needs 90 days' notice." },
    outside: { name: "Other lease.txt", contents: "Termination needs 90 days' notice too." },
    folder: "Client A",
  },
  {
    language: "zh-CN" as const,
    claim: "解约需提前90天通知。",
    inside: { name: "甲方租约.txt", contents: "解约需提前90天通知。" },
    outside: { name: "其他租约.txt", contents: "解约也需提前90天通知。" },
    folder: "甲方",
  },
];

describe("Check against a Document across a Folder wall", () => {
  async function walled(example: (typeof WALLED)[number]) {
    const calls: ModelCall[] = [];
    const model = scriptedModel(
      (call) => {
        calls.push(call);
        return checkReply(call, { [sentenceOf(call)]: { verdict: "unsupported" } });
      },
      { generate: checkGenerate({}) },
    );
    const result = await setUpWithDocuments(model, [example.inside, example.outside]);
    const { core } = result;
    await core.updateSettings({ user: { language: example.language } });
    const [inside, outside] = result.documents as [Document, Document];
    const folder = await core.createLibraryGroup({ name: example.folder, description: "" });
    await core.assignDocumentGroup(inside.id, folder.id);
    await core.updateLibraryGroup(folder.id, {
      name: folder.name,
      description: folder.description,
      keepInside: true,
    });
    const note = async (folderId: string | null) => {
      const mind = await core.createMind({ title: "Lease", ...(folderId && { folderId }) });
      const client = await connectToMind(core, mind.id);
      const block = paragraph(text(example.claim));
      writeMind(client, [block]);
      await client.settled();
      return { mind, client, block };
    };
    return { ...result, calls, inside, outside, folder, note };
  }

  test.each(WALLED)(
    "from inside a wall, picks and reads only what is behind it ($language)",
    async (example) => {
      const { core, calls, inside, outside, folder, note } = await walled(example);
      const { mind, client, block } = await note(folder.id);

      const sentence = whole(block, example.claim.length);
      expect(
        await core.planDocumentCheck({
          mindId: mind.id,
          ...sentence,
          within: within([outside.id]),
        }),
      ).toEqual({ kind: "nothing-to-read" });
      expect(calls).toHaveLength(0);

      const both = { folderIds: [folder.id], tagIds: [], documentIds: [outside.id] };
      expect(
        await core.planDocumentCheck({ mindId: mind.id, ...sentence, within: both }),
      ).toMatchObject({ kind: "ready", documents: [{ documentId: inside.id }] });
      await core.checkSentences(await readInput(core, mind.id, block, example.claim, both));

      const handed = handedText(calls);
      expect(handed).toContain(example.inside.contents);
      expect(handed).not.toContain(example.outside.contents);
      expect(await onlyMark(client)).toMatchObject({
        action: "check-against-document",
        versions: [{ documentId: inside.id }],
      });
    },
  );

  test.each(WALLED)(
    "from outside a wall, never picks or reads what it keeps inside ($language)",
    async (example) => {
      const { core, calls, inside, outside, folder, note } = await walled(example);
      const { mind, client, block } = await note(null);

      const sentence = whole(block, example.claim.length);
      for (const kept of [within([inside.id]), { ...within([]), folderIds: [folder.id] }]) {
        expect(
          await core.planDocumentCheck({ mindId: mind.id, ...sentence, within: kept }),
        ).toEqual({ kind: "nothing-to-read" });
      }
      expect(calls).toHaveLength(0);

      await core.checkSentences(
        await readInput(core, mind.id, block, example.claim, within([inside.id, outside.id])),
      );

      const handed = handedText(calls);
      expect(handed).toContain(example.outside.contents);
      expect(handed).not.toContain(example.inside.contents);
      expect(await onlyMark(client)).toMatchObject({ versions: [{ documentId: outside.id }] });
    },
  );
});

const PARTS = [
  {
    language: "en" as const,
    sentence: "Rent is due monthly and the tenant may keep a cat.",
    found: "Rent is due monthly",
    missing: "the tenant may keep a cat",
    rent: { name: "Rent.md", contents: "Rent is due monthly." },
    pets: { name: "Pets.md", contents: "The tenant may keep a cat." },
  },
  {
    language: "zh-CN" as const,
    sentence: "租金按月支付，租户可以养一只猫。",
    found: "租金按月支付",
    missing: "租户可以养一只猫",
    rent: { name: "租金.md", contents: "租金按月支付。" },
    pets: { name: "宠物.md", contents: "租户可以养一只猫。" },
  },
];

describe("Check against a Document, part by part", () => {
  async function parted(example: (typeof PARTS)[number]) {
    const part = (words: string): ClaimPartPlan => {
      const start = example.sentence.indexOf(words);
      return { kind: "fact", span: { start, end: start + words.length } };
    };
    const calls: ModelCall[] = [];
    const model = scriptedModel(
      (call) => {
        calls.push(call);
        const said = sentenceOf(call);
        const handed = JSON.stringify(call.results);
        const source = said === example.found ? example.rent : example.pets;
        return checkReply(call, {
          [said]: handed.includes(source.contents)
            ? { verdict: "supported", quote: source.contents }
            : { verdict: "unsupported" },
        });
      },
      {
        generate(call) {
          if (!call.system.startsWith("You sort the sentences")) return checkGenerate({})(call);
          const sentences = listedSentences(call.prompt).map(({ number, text: said }) => ({
            number,
            parts: (said === example.sentence ? [example.found, example.missing] : [said]).map(
              (words) => ({ kind: "fact", text: words }),
            ),
          }));
          return { text: JSON.stringify({ sentences }) };
        },
      },
    );
    const result = await setUpWithDocuments(model, [example.rent]);
    const { core, client, mind } = result;
    await core.updateSettings({ user: { language: example.language } });
    const block = paragraph(text(example.sentence));
    writeMind(client, [block]);
    await client.settled();
    await core.checkMind({ requestId: crypto.randomUUID(), mindId: mind.id, mode: "all" });
    const sources = await createTempDataFolder();
    const [pets] = (await addAndProcess(core, [
      await writeSourceFile(sources, example.pets.name, example.pets.contents),
    ])) as [Document];
    const before = await onlyMark(client);
    return {
      ...result,
      calls,
      block,
      pets,
      before,
      found: part(example.found),
      missing: part(example.missing),
    };
  }

  const verdicts = (check: ClaimCheckAttributes) => check.parts?.map((each) => each.verdict);
  const askedAbout = (calls: readonly ModelCall[]) => [
    ...new Set(calls.filter(isCheckRun).map(sentenceOf)),
  ];

  test.each(PARTS)(
    "reads only the parts not found, and keeps the others' Citations ($language)",
    async (example) => {
      const { core, client, mind, block, calls, pets, before, found, missing } =
        await parted(example);
      expect(verdicts(before)).toEqual(["supported", "unsupported"]);
      expect(before.parts?.map((each) => each.span)).toEqual([found.span, missing.span]);
      const sent = calls.length;

      await core.checkSentences(
        await readInput(core, mind.id, block, example.sentence, within([pets.id])),
      );

      expect(askedAbout(calls.slice(sent))).toEqual([example.missing]);
      const check = await onlyMark(client);
      expect(check).toMatchObject({ action: "check-against-document", state: "supported" });
      expect(verdicts(check)).toEqual(["supported", "supported"]);
      expect(check.parts?.[0]?.evidence).toEqual(before.parts?.[0]?.evidence);
      expect(check.parts?.[1]?.evidence[0]).toMatchObject({ documentId: pets.id });
      expect(check.read?.pages).toBe(check.read?.of);
    },
  );

  test.each(PARTS)(
    "sizes the read by the parts it will check, so its cost counts each ($language)",
    async (example) => {
      const { core, client, mind, block, pets, before, found } = await parted(example);
      const sentence = whole(block, example.sentence.length);
      const open = await core.planDocumentCheck({
        mindId: mind.id,
        ...sentence,
        within: within([pets.id]),
      });
      const both = await core.planDocumentCheck({
        mindId: mind.id,
        ...sentence,
        part: { id: before.id, span: found.span },
        within: within([pets.id]),
      });
      expect(open).toMatchObject({ kind: "ready", parts: 1 });
      expect(both).toMatchObject({ kind: "ready", parts: 1 });

      const fresh = paragraph(text(example.sentence));
      writeMind(client, [fresh]);
      await client.settled();
      const unsorted = await core.planDocumentCheck({
        mindId: mind.id,
        ...whole(fresh, example.sentence.length),
        within: within([pets.id]),
      });
      expect(unsorted).toMatchObject({ kind: "ready", parts: null });
    },
  );

  test.each(PARTS)("reads one part when asked about it ($language)", async (example) => {
    const { core, client, mind, block, calls, pets, before, found, missing } =
      await parted(example);
    const sent = calls.length;

    await core.checkSentences(
      await readInput(core, mind.id, block, example.sentence, within([pets.id]), undefined, {
        part: { id: before.id, span: found.span },
      }),
    );

    expect(askedAbout(calls.slice(sent))).toEqual([example.found]);
    const check = await onlyMark(client);
    // The Rent Document isn't in the pick, so the part read against it alone isn't found there.
    expect(verdicts(check)).toEqual(["unsupported", "unsupported"]);
    expect(check.parts?.[1]).toEqual(before.parts?.[1]);
    expect(check.parts?.map((each) => each.span)).toEqual([found.span, missing.span]);
  });
});

describe("The cost a whole read asks", () => {
  test("counts every window once for each part it reads", async () => {
    const sentence = "Rent is due monthly and the tenant may keep a cat.";
    const rent = "Rent is due monthly";
    const cat = "the tenant may keep a cat";
    const calls: ModelCall[] = [];
    const model = scriptedModel(
      (call) => {
        calls.push(call);
        return checkReply(call, { [sentenceOf(call)]: { verdict: "unsupported" } });
      },
      {
        generate(call) {
          if (!call.system.startsWith("You sort the sentences")) return checkGenerate({})(call);
          const sentences = listedSentences(call.prompt).map(({ number, text: said }) => ({
            number,
            parts: (said === sentence ? [rent, cat] : [said]).map((words) => ({
              kind: "fact",
              text: words,
            })),
          }));
          return { text: JSON.stringify({ sentences }) };
        },
      },
    );
    const filler = Array.from(
      { length: 6000 },
      (_, index) => `Unrelated paragraph ${index} with ordinary words.`,
    ).join("\n");
    const { core, client, mind, documents } = await setUpWithDocuments(model, [
      { name: "Long.md", contents: filler },
    ]);
    const block = paragraph(text(sentence));
    writeMind(client, [block]);
    await client.settled();
    const provider = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (!provider.service) throw new Error("The test provider has no service.");
    await core.allowDataFlow("checks", provider.service.id);
    await core.allowDataFlow("document-check", provider.service.id);
    const chosen = { providerId: provider.id, modelId: "claude-haiku-5-5" };
    await core.checkMind({
      requestId: crypto.randomUUID(),
      mindId: mind.id,
      mode: "all",
      model: chosen,
    });
    const before = await onlyMark(client);
    const span = before.parts?.[0]?.span;
    if (!span) throw new Error("The sentence has no parts.");
    const picked = within([documents[0]?.id ?? ""]);
    const callsOf = async (part?: { id: string; span: { start: number; end: number } }) => {
      const plan = await core.planDocumentCheck({
        mindId: mind.id,
        ...whole(block, sentence.length),
        ...(part && { part }),
        within: picked,
        model: chosen,
      });
      if (plan.kind !== "ready" || plan.estimate?.billing !== "per-token") {
        throw new Error("The read has no per-token estimate.");
      }
      return { plan, calls: plan.estimate.calls, most: plan.estimate.upTo?.calls ?? 0 };
    };
    const one = await callsOf({ id: before.id, span });
    const open = await callsOf();

    expect(one.plan.parts).toBe(1);
    expect(open.plan.parts).toBe(2);
    expect(open.most).toBe(2 * one.most);
    const sent = calls.length;
    await core.checkSentences({
      ...checkInput(mind.id, block, sentence, picked),
      plan: open.plan.id,
      model: chosen,
    });
    const read = calls.slice(sent).filter(isCheckRun).length;
    expect(read).toBeGreaterThan(one.calls);
    expect(read).toBeLessThanOrEqual(open.calls);
  });
});

describe("A whole read the User replaced", () => {
  const A_TEXT = `Alpha lease. ${EN.quote}.`;
  const B_TEXT = `Bravo lease. ${EN.quote}.`;

  async function allowed(allow = true) {
    const calls: ModelCall[] = [];
    const plan = { [EN.claim]: { verdict: "supported" as const, quote: EN.quote } };
    const result = await setup(
      [
        { name: "A.md", contents: A_TEXT },
        { name: "B.md", contents: B_TEXT },
      ],
      plan,
      EN.claim,
      calls,
    );
    const provider = await result.core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (!provider.service) throw new Error("The test provider has no service.");
    if (allow) await result.core.allowDataFlow("document-check", provider.service.id);
    const model = { providerId: provider.id, modelId: "claude-haiku-5-5" };
    const [a, b] = result.documents as [Document, Document];
    return { ...result, calls, model, a, b };
  }

  async function planned(
    core: Core,
    mindId: string,
    block: { attrs: { id: string } },
    picked: SearchScope,
    model?: { providerId: string; modelId: string },
  ) {
    const plan = await core.planDocumentCheck({
      mindId,
      ...whole(block, EN.claim.length),
      within: picked,
      ...(model && { model }),
    });
    if (plan.kind !== "ready") throw new Error("The pick can't be read.");
    return plan.id;
  }

  test("sends nothing for a plan a newer pick replaced, or for another pick", async () => {
    const { core, client, mind, block, calls, model, a, b } = await allowed();
    const first = await planned(core, mind.id, block, within([a.id]));
    const second = await planned(core, mind.id, block, within([b.id]));

    await expect(
      core.checkSentences({
        ...checkInput(mind.id, block, EN.claim, within([a.id])),
        plan: first,
        model,
      }),
    ).rejects.toThrow();
    await expect(
      core.checkSentences({
        ...checkInput(mind.id, block, EN.claim, within([a.id])),
        plan: second,
        model,
      }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
    expect(await marks(client)).toEqual([]);

    await core.checkSentences({
      ...checkInput(mind.id, block, EN.claim, within([b.id])),
      plan: second,
      model,
    });
    expect(await onlyMark(client)).toMatchObject({
      state: "supported",
      scope: { chosen: { documentIds: [b.id] } },
    });
  });

  test("a pick replaced while its consent is asked sends nothing once consent is given", async () => {
    const { core, client, mind, block, calls, model, a, b } = await allowed(false);
    const first = await planned(core, mind.id, block, within([a.id]), model);
    const requested = nextEvent(core, "consent.requested");
    const reading = core.checkSentences({
      ...checkInput(mind.id, block, EN.claim, within([a.id])),
      plan: first,
      model,
    });
    const request = await requested;
    await planned(core, mind.id, block, within([b.id]), model);
    await core.respondToConsent(request.requestId, true);

    expect(await reading).toEqual({ kind: "cancelled" });
    expect(calls.filter(isCheckRun)).toHaveLength(0);
    expect(handedText(calls)).not.toContain("Alpha lease");
    expect(await marks(client)).toEqual([]);
  });

  test("a newer pick stops a read already running, and nothing more of it is sent", async () => {
    const filler = Array.from(
      { length: 6000 },
      (_, index) => `Unrelated alpha paragraph ${index} with ordinary words.`,
    ).join("\n");
    const calls: ModelCall[] = [];
    const { core, client, mind, block, documents } = await setup(
      [
        { name: "A.md", contents: filler },
        { name: "B.md", contents: B_TEXT },
      ],
      { [EN.claim]: { verdict: "unsupported" } },
      EN.claim,
      calls,
    );
    const [a, b] = documents as [Document, Document];
    const input = await readInput(core, mind.id, block, EN.claim, within([a.id]));
    let sentWhenReplaced = -1;
    core.on("documentCheck.progress", (event) => {
      if (sentWhenReplaced >= 0 || event.pages === 0) return;
      sentWhenReplaced = calls.filter(isCheckRun).length;
      void core.planDocumentCheck({
        mindId: mind.id,
        ...whole(block, EN.claim.length),
        within: within([b.id]),
      });
    });

    expect(await core.checkSentences(input)).toEqual({ kind: "cancelled" });
    expect(sentWhenReplaced).toBeGreaterThan(0);
    expect(calls.filter(isCheckRun)).toHaveLength(sentWhenReplaced);
    expect(await marks(client)).toEqual([]);
  });

  test("a whole read without its plan, or with a forged, empty or replaced one, sends nothing", async () => {
    const { core, client, mind, block, calls, model, a } = await allowed();
    const input = { ...checkInput(mind.id, block, EN.claim, within([a.id])), model };
    const replaced = await planned(core, mind.id, block, within([a.id]));
    await planned(core, mind.id, block, within([a.id]));

    await expect(core.checkSentences(input)).rejects.toThrow();
    for (const plan of ["forged", "", replaced]) {
      await expect(core.checkSentences({ ...input, plan })).rejects.toThrow();
    }
    expect(calls).toHaveLength(0);
    expect(await marks(client)).toEqual([]);
  });

  test("a plan is for its own sentence: another sentence, or new words, send nothing", async () => {
    const { core, client, mind, block, calls, model, a } = await allowed();
    const other = "Rent is due monthly.";
    const second = paragraph(text(other));
    writeMind(client, [block, second]);
    await client.settled();
    const plan = await planned(core, mind.id, block, within([a.id]));

    await expect(
      core.checkSentences({ ...checkInput(mind.id, second, other, within([a.id])), plan, model }),
    ).rejects.toThrow();
    writeMind(client, [{ ...block, content: [text(EN.claim.replace("15", "16"))] }, second]);
    await client.settled();
    await expect(
      core.checkSentences({ ...checkInput(mind.id, block, EN.claim, within([a.id])), plan, model }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
    expect(await marks(client)).toEqual([]);
  });

  test("waits for a check already running on the sentence, sending nothing", async () => {
    let release = () => {};
    const paused = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    let held = false;
    const calls: ModelCall[] = [];
    const model = scriptedModel(
      (call) => {
        calls.push(call);
        if (isCheckRun(call) && !held && call.results.some((result) => result.tool === "cite")) {
          held = true;
          return { text: "Verdict: supported", pause: { after: 0, until: paused } };
        }
        return checkReply(call, { [EN.claim]: { verdict: "supported", quote: EN.quote } });
      },
      { generate: checkGenerate({}) },
    );
    const { core, mind, block, documents } = await setup(
      [{ name: EN.document, contents: EN.quote }],
      {},
      EN.claim,
      [],
      undefined,
      model,
    );
    const ordinary = core.checkSentences({
      requestId: "ordinary",
      mindId: mind.id,
      action: "check-against-documents",
      ...whole(block, EN.claim.length),
    });
    await vi.waitFor(() => expect(held).toBe(true));
    const sent = calls.length;

    try {
      await expect(
        core.checkSentences(
          await readInput(core, mind.id, block, EN.claim, within([documents[0]?.id ?? ""])),
        ),
      ).rejects.toThrow();
      expect(calls).toHaveLength(sent);
    } finally {
      release();
    }
    await ordinary;
  });

  test("a read that ends after its Note was closed still marks the sentence", async () => {
    let release = () => {};
    const paused = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    let held = false;
    const model = scriptedModel(
      (call) => {
        if (isCheckRun(call) && !held && call.results.some((result) => result.tool === "cite")) {
          held = true;
          return { text: "Verdict: supported", pause: { after: 0, until: paused } };
        }
        return checkReply(call, { [EN.claim]: { verdict: "supported", quote: EN.quote } });
      },
      { generate: checkGenerate({}) },
    );
    const { core, mind, block, documents } = await setup(
      [{ name: EN.document, contents: EN.quote }],
      {},
      EN.claim,
      [],
      undefined,
      model,
    );
    const reading = core.checkSentences(
      await readInput(core, mind.id, block, EN.claim, within([documents[0]?.id ?? ""])),
    );
    await vi.waitFor(() => expect(held).toBe(true));
    await core.closeMind(mind.id);

    release();
    expect(await reading).toMatchObject({ kind: "checked", checked: 1 });

    const reopened = await connectToMind(core, mind.id);
    expect(await onlyMark(reopened)).toMatchObject({
      action: "check-against-document",
      state: "supported",
    });
  });

  test("a slower read cannot replace a newer ordinary check", async () => {
    let release = () => {};
    const paused = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    let held = false;
    const model = scriptedModel(
      (call) => {
        if (isCheckRun(call) && !held && call.results.some((result) => result.tool === "cite")) {
          held = true;
          return { text: "Verdict: unsupported", pause: { after: 0, until: paused } };
        }
        return checkReply(call, { [EN.claim]: { verdict: "supported", quote: EN.quote } });
      },
      { generate: checkGenerate({}) },
    );
    const { core, client, mind, block, documents } = await setup(
      [{ name: EN.document, contents: EN.quote }],
      {},
      EN.claim,
      [],
      undefined,
      model,
    );

    const older = core.checkSentences(
      await readInput(core, mind.id, block, EN.claim, within([documents[0]?.id ?? ""]), "older"),
    );
    await vi.waitFor(() => expect(held).toBe(true));
    await core.checkSentences({
      requestId: "ordinary",
      mindId: mind.id,
      action: "check-against-documents",
      ...whole(block, EN.claim.length),
    });
    expect(await onlyMark(client)).toMatchObject({ request: "ordinary", state: "supported" });

    release();
    await older;

    expect(await onlyMark(client)).toMatchObject({ request: "ordinary", state: "supported" });
  });
});

const ABSENT = [
  {
    language: "en" as const,
    sentence: "The lease has no break clause.",
    absent: "break clause",
    line: (page: number, line: number) =>
      `Page ${page} line ${line} has ordinary lease words on rent and repairs.`,
    clause: "Either party may end this lease early with three months' notice.",
  },
  {
    language: "zh-CN" as const,
    sentence: "租约中没有提前解约条款。",
    absent: "提前解约条款",
    line: (page: number, line: number) => `第${page}页第${line}行是关于租金和维修的普通条款。`,
    clause: "任何一方提前三个月通知即可提前解除本租约。",
  },
];

describe("Check against a Document, on a sentence that says something is absent", () => {
  /** A pick of `pages` pages, the clause on `clauseOn` if any, read whole on a cloud model. */
  async function readAbsence(
    example: (typeof ABSENT)[number],
    pages: number,
    clauseOn: number | null,
  ) {
    const calls: ModelCall[] = [];
    const judged: string[] = [];
    const plan = { [example.sentence]: { verdict: "unsupported" as const, absence: true } };
    const model = scriptedModel(
      (call) => {
        calls.push(call);
        return checkReply(call, plan);
      },
      {
        generate: (call) => {
          // Each look at the quote finds the clause there.
          if (call.system.startsWith("A sentence the User wrote says something is absent")) {
            return { text: `Judgement: ${call.prompt.includes(example.clause) ? "there" : "not"}` };
          }
          if (!call.system.startsWith("Read the whole Documents")) return checkGenerate(plan)(call);
          judged.push(call.prompt);
          const holding = shownPassages(call.prompt).find((each) =>
            each.text.includes(example.clause),
          );
          return {
            text: JSON.stringify(
              holding
                ? {
                    absent: example.absent,
                    absence: "contained",
                    citations: [{ marker: 1, passage: holding.id, quote: example.clause }],
                  }
                : { absent: example.absent, absence: "holds" },
            ),
          };
        },
      },
    );
    const lease = buildPdf(
      Array.from({ length: pages }, (_, page) => {
        const lines = Array.from({ length: 30 }, (_, line) =>
          page + 1 === clauseOn && line === 14 ? example.clause : example.line(page + 1, line + 1),
        );
        return example.language === "zh-CN" ? { chineseLines: lines } : { lines };
      }),
    );
    const result = await setUpWithDocuments(model, [{ name: "Lease.pdf", contents: lease }]);
    const { core, client, mind, documents } = result;
    await core.updateSettings({ user: { language: example.language } });
    const block = paragraph(text(example.sentence));
    writeMind(client, [block]);
    await client.settled();
    const provider = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (!provider.service) throw new Error("The test provider has no service.");
    await core.allowDataFlow("document-check", provider.service.id);
    const chosen = { providerId: provider.id, modelId: "claude-haiku-5-5" };
    const input = await readInput(
      core,
      mind.id,
      block,
      example.sentence,
      within([documents[0]?.id ?? ""]),
      undefined,
      { model: chosen },
    );
    const planned = await core.planDocumentCheck({
      mindId: mind.id,
      ...whole(block, example.sentence.length),
      within: within([documents[0]?.id ?? ""]),
      model: chosen,
    });
    if (planned.kind !== "ready" || planned.estimate?.billing !== "per-token") {
      throw new Error("The read has no per-token estimate.");
    }
    await core.checkSentences({ ...input, plan: planned.id });
    return { check: await onlyMark(client), calls, judged, estimate: planned.estimate.calls };
  }

  test.each(ABSENT)(
    "a 60-page pick without it settles the absence as Supported, every page read ($language)",
    async (example) => {
      const { check, judged } = await readAbsence(example, 60, null);
      expect(check).toMatchObject({ action: "check-against-document", state: "supported" });
      expect(check.read).toEqual({ pages: 60, of: 60 });
      expect(check.readDocuments?.[0]?.locations.length).toBe(60);
      expect(judged.length).toBeGreaterThan(0);
      for (const prompt of judged) expect(prompt).not.toContain(example.clause);
    },
  );

  test.each(ABSENT)(
    "a 60-page pick with it on page 47 is Contradicted, quoting page 47 ($language)",
    async (example) => {
      const { check } = await readAbsence(example, 60, 47);
      expect(check.state).toBe("contradicted");
      expect(check.evidence).toMatchObject({ quote: example.clause, pageFrom: 47 });
    },
  );

  test.each(ABSENT)(
    "a short pick's estimate counts its absence judgement ($language)",
    async (example) => {
      const { check, calls, judged, estimate } = await readAbsence(example, 12, null);
      expect(check.state).toBe("supported");
      expect(judged).toHaveLength(1);
      expect(calls.length + judged.length).toBe(3);
      // A read sends 1.25 times the requests it plans, as Claude Haiku 5.5's did.
      expect(estimate).toBe(4);
    },
  );
});

const SPLIT = [
  {
    language: "en" as const,
    sentence: "The lease has no break clause.",
    line: (page: number, line: number) =>
      `L${String(page).padStart(3, "0")}-${String(line).padStart(2, "0")} has ordinary lease words on rent and repairs.`,
    first: "Either party may end this lease early",
    middle: "and the notice must be in writing and signed",
    second: "with three months notice to the other.",
    pad: "~",
    twoParts: {
      sentence: "The lease has no break clause and no parking.",
      parts: ["The lease has no break clause", "no parking"],
    },
    // Pages a 4,096-token window reads in one, two and three windows.
    windowPages: [8, 18, 28],
  },
  {
    language: "zh-CN" as const,
    sentence: "租约中没有提前解约条款。",
    line: (page: number, line: number) =>
      `L${String(page).padStart(3, "0")}-${String(line).padStart(2, "0")} 是关于租金和维修的普通租约条款。`,
    first: "任何一方提前三个月",
    middle: "并须以书面形式送达对方",
    second: "书面通知即可解除本租约。",
    pad: "，",
    twoParts: {
      sentence: "租约中没有提前解约条款，也没有停车位。",
      parts: ["租约中没有提前解约条款", "也没有停车位"],
    },
    windowPages: [6, 14, 20],
  },
];

/** What a streamed request sent the model, counted as the estimate counts text. */
function sentTokens({ options }: ModelCall): number {
  const partTokens = (part: (typeof options.prompt)[number]["content"][number]) => {
    if (typeof part === "string") return estimateTokens(part);
    if (part.type === "text" || part.type === "reasoning") return estimateTokens(part.text);
    if (part.type === "tool-call") return estimateTokens(JSON.stringify(part.input));
    if (part.type === "tool-result") {
      const { output } = part;
      return estimateTokens(
        output.type === "text" || output.type === "error-text"
          ? output.value
          : JSON.stringify(output),
      );
    }
    return 0;
  };
  return (
    estimateTokens(JSON.stringify(options.tools ?? [])) +
    options.prompt.reduce(
      (sum, message) =>
        sum +
        (typeof message.content === "string"
          ? estimateTokens(message.content)
          : message.content.reduce((inner, part) => inner + partTokens(part), 0)),
      0,
    )
  );
}

interface ReadOptions {
  /** A cloud model whose cost the plan estimates; a local one with small windows when absent. */
  priced?: { kind: "openrouter" | "anthropic"; modelId: string };
  sentence?: string;
  parts?: readonly string[];
  /** The sentence says nothing is absent: its check finds it not stated. */
  ordinary?: boolean;
  /** The Note is checked before the read, so the sentence's parts have results. */
  checkedFirst?: boolean;
  /** What each look at the quote a window's judgement gives finds. */
  look?: (quote: string) => "there" | "elsewhere" | "not";
}

/** A 16,385-token context: windows of 4,096 tokens. */
const SMALL = { kind: "openrouter" as const, modelId: "openai/gpt-3.5-turbo" };
/** A 200,000-token context: windows of 48,000 tokens. */
const LARGE = { kind: "anthropic" as const, modelId: "claude-haiku-5-5" };

describe("A whole read's windows, on a sentence that says something is absent", () => {
  /**
   * A Note's absence sentence read whole by a model whose small window takes several windows: a
   * local one, or a priced one whose cost the plan estimates. `parts`: the sentence's parts, sorted
   * by a check of the Note before the read. A second look at a quote finds a conflict only when
   * the quote opens the clause.
   */
  async function readWindows(
    example: (typeof SPLIT)[number],
    pages: readonly (readonly string[])[],
    judge: (prompt: string, index: number) => string,
    {
      priced,
      sentence = example.sentence,
      parts,
      ordinary = false,
      checkedFirst = parts !== undefined,
      look = (quote) => (quote.includes(example.first) ? "there" : "not"),
    }: ReadOptions = {},
  ) {
    const runs: ModelCall[] = [];
    const judged: { system: string; prompt: string }[] = [];
    const looks: { system: string; prompt: string }[] = [];
    let reading = false;
    const verdict = { verdict: "unsupported" as const, absence: !ordinary };
    const plan = Object.fromEntries([sentence, ...(parts ?? [])].map((each) => [each, verdict]));
    const model = scriptedModel(
      (call) => {
        if (reading) runs.push(call);
        return checkReply(call, plan);
      },
      {
        generate: (call) => {
          if (call.system.startsWith("You sort the sentences")) {
            const sorted = listedSentences(call.prompt).map(({ number, text: said }) => ({
              number,
              parts: (said === sentence && parts ? parts : [said]).map((words) => ({
                kind: "fact",
                text: words,
              })),
            }));
            return { text: JSON.stringify({ sentences: sorted }) };
          }
          if (call.system.startsWith("A sentence the User wrote says something is absent")) {
            looks.push({ system: call.system, prompt: call.prompt });
            const quote = /<quote[^>]*>\n([\s\S]*?)\n<\/quote>/.exec(call.prompt)?.[1] ?? "";
            return { text: `Judgement: ${look(quote)}` };
          }
          if (!call.system.startsWith("Read the whole Documents")) return checkGenerate(plan)(call);
          // The check that sorts the parts first leaves them to the read.
          if (!reading) return { text: "not a judgement" };
          judged.push({ system: call.system, prompt: call.prompt });
          return { text: judge(call.prompt, judged.length - 1) };
        },
      },
    );
    const ollamaModels: CoreAdapters["ollamaModels"] = {
      describe: async () => ({
        digest: null,
        capabilities: ["completion", "tools"],
        contextLength: 12288,
        parameters: null,
        support: "tools",
        chat: true,
        remote: false,
        settings: { numCtx: 12288, outputTokens: 1024, keepAlive: "5m", think: false },
      }),
      loaded: async () => true,
      running: async () => true,
    };
    const pdf = buildPdf(
      pages.map((lines) =>
        example.language === "zh-CN" ? { chineseLines: [...lines] } : { lines: [...lines] },
      ),
    );
    const { core, client, mind, documents } = await setUpWithDocuments(
      model,
      [{ name: "Lease.pdf", contents: pdf }],
      { ollamaModels },
    );
    await core.updateSettings({ user: { language: example.language } });
    const block = paragraph(text(sentence));
    writeMind(client, [block]);
    await client.settled();
    let chosen: PlanDocumentCheckInput["model"];
    if (priced) {
      const provider = await core.saveChatProvider({ ...priced, apiKey: "sk-test" });
      if (!provider.service) throw new Error("The test provider has no service.");
      await core.allowDataFlow("checks", provider.service.id);
      await core.allowDataFlow("document-check", provider.service.id);
      chosen = { providerId: provider.id, modelId: priced.modelId };
    }
    if (checkedFirst) {
      await core.checkMind({
        requestId: crypto.randomUUID(),
        mindId: mind.id,
        mode: "all",
        ...(chosen && { model: chosen }),
      });
      const sorted = await onlyMark(client);
      expect(sorted.parts?.length).toBe(parts?.length ?? 1);
    }
    const picked = within([documents[0]?.id ?? ""]);
    const planned = await core.planDocumentCheck({
      mindId: mind.id,
      ...whole(block, sentence.length),
      within: picked,
      ...(chosen && { model: chosen }),
    });
    if (planned.kind !== "ready") throw new Error(`The pick can't be read: ${planned.kind}.`);
    reading = true;
    await core.checkSentences({
      ...checkInput(mind.id, block, sentence, picked),
      plan: planned.id,
      ...(chosen && { model: chosen }),
    });
    return {
      check: await onlyMark(client),
      judged: judged.map((each) => each.prompt),
      judgements: judged,
      looks,
      runs,
      estimate: planned.estimate,
    };
  }
  const pagesOf = (example: (typeof SPLIT)[number], count: number) =>
    Array.from({ length: count }, (_, page) =>
      Array.from({ length: 30 }, (_, line) => example.line(page + 1, line + 1)),
    );
  const HOLDS = JSON.stringify({ absent: "break clause", absence: "holds" });
  const containing = (passage: string | undefined, quote: string) =>
    JSON.stringify({
      absent: "break clause",
      absence: "contained",
      citations: [{ marker: 1, passage, quote }],
    });
  /** A judgement that finds the clause only when its first and last words are in front of it. */
  const judgeOf =
    (example: (typeof SPLIT)[number]) =>
    (prompt: string): string => {
      if (!prompt.includes(example.first) || !prompt.includes(example.second)) return HOLDS;
      const holding = shownPassages(prompt).find((each) => each.text.includes(example.first));
      return containing(holding?.id, example.first);
    };
  /** Where a judged window's own text ends: the id of its last line. */
  const lastLine = (prompt: string) => [...prompt.matchAll(/L(\d{3})-(\d{2})/g)].at(-1);
  /** Each Passage a judged window shows, counted as one Passage shown alone is. */
  const blocksOf = (prompt: string) =>
    [...prompt.matchAll(/<passage\b[^>]*>[\s\S]*?<\/passage>/g)].map(([block]) => ({
      block,
      tokens: estimateTokens(block.replace(/^<passage id="[^"]+"/, '<passage id="P1"')),
    }));
  const tokensOf = (blocks: readonly { tokens: number }[]) =>
    blocks.reduce((sum, each) => sum + each.tokens, 0);
  /**
   * The pages with a clause of about 900 tokens that ends two lines after line `edge` (counted
   * from 0 through the pages), so that nearly all of it comes before. Each line keeps its id and its length, so the Passages and windows
   * stay where they were.
   */
  const clauseAt = (example: (typeof SPLIT)[number], count: number, edge: number) => {
    const pages = pagesOf(example, count);
    const lineAt = (index: number) => {
      const lines = pages[Math.floor(index / 30)];
      if (!lines || lines[index % 30] === undefined) throw new Error("No such line.");
      return { lines, at: index % 30 };
    };
    const put = (index: number, words: string) => {
      const { lines, at } = lineAt(index);
      const was = lines[at] ?? "";
      lines[at] = `${was.slice(0, 8)}${words}`.padEnd(was.length, example.pad);
    };
    const end = edge + 2;
    let start = end;
    const clause = () =>
      Array.from({ length: end - start + 1 }, (_, offset) => {
        const { lines, at } = lineAt(start + offset);
        return lines[at];
      }).join("\n");
    while (estimateTokens(clause()) < 900) start--;
    put(start, example.first);
    for (let index = start + 1; index < end; index++) put(index, example.middle);
    put(end, example.second);
    return pages;
  };

  test.each(SPLIT)(
    "holds over every window only when each holds it, every page read ($language)",
    async (example) => {
      const all = await readWindows(example, pagesOf(example, 24), () => HOLDS);
      expect(all.judged.length).toBeGreaterThanOrEqual(3);
      expect(all.check).toMatchObject({ state: "supported", read: { pages: 24, of: 24 } });

      const unjudged = await readWindows(example, pagesOf(example, 24), (_, index) =>
        index === 1 ? "not a judgement" : HOLDS,
      );
      expect(unjudged.check.state).toBe("not-checked");

      // A page with no text to read, as a scanned one may be, leaves the rest unproven.
      const blank = pagesOf(example, 24);
      blank[23] = [];
      const unread = await readWindows(example, blank, () => HOLDS);
      expect(unread.check).toMatchObject({ state: "not-checked", reason: "absence-read-limit" });
    },
  );

  test.each(SPLIT)(
    "finds a 900-token clause cut at each window's edge, and one in the last window ($language)",
    async (example) => {
      const judge = judgeOf(example);
      const found = await readWindows(example, pagesOf(example, 24), () => HOLDS);
      expect(found.judged.length).toBeGreaterThanOrEqual(3);
      // Each window after the first opens with the fewest whole Passages that end the one before
      // and reach 1,000 tokens.
      const unnamed = ({ block }: { block: string }) => block.replace(/^<passage id="[^"]+"/, "");
      for (const [index, prompt] of found.judged.entries()) {
        if (index === 0) continue;
        const before = blocksOf(found.judged[index - 1] ?? "");
        const shown = blocksOf(prompt);
        let carried = 1;
        while (carried < before.length && tokensOf(before.slice(-carried)) < 1000) carried++;
        expect(shown.slice(0, carried).map(unnamed)).toEqual(before.slice(-carried).map(unnamed));
        const next = shown[carried];
        expect(next && before.map(unnamed).includes(unnamed(next))).toBe(false);
      }
      const edges = found.judged.slice(0, -1).map((prompt) => {
        const end = lastLine(prompt);
        if (!end) throw new Error("A window holds no line.");
        return { page: Number(end[1]), line: Number(end[2]) };
      });
      /** Whether the window that ends at edge `index` holds the clause's start without its end. */
      const cut = (judged: readonly string[], index: number) =>
        (judged[index] ?? "").includes(example.first) &&
        !(judged[index] ?? "").includes(example.second);
      const lineOf = (prompt: string) => {
        const end = lastLine(prompt);
        return end ? (Number(end[1]) - 1) * 30 + Number(end[2]) - 1 : -1;
      };
      for (const [index, edge] of edges.entries()) {
        // The clause's words move where its Passages, and so that window, end: it is put again
        // where the edge now falls, until it ends at most six lines after it, nearly all before.
        let at = (edge.page - 1) * 30 + edge.line - 1;
        let read = await readWindows(example, clauseAt(example, 24, at), judge);
        const settled = () => {
          const fell = lineOf(read.judged[index] ?? "");
          return fell >= at - 4 && fell < at + 2;
        };
        for (let tries = 0; tries < 6 && !settled(); tries++) {
          at = lineOf(read.judged[index] ?? "");
          read = await readWindows(example, clauseAt(example, 24, at), judge);
        }
        expect(settled()).toBe(true);
        expect(cut(read.judged, index)).toBe(true);
        expect(read.check.state).toBe("contradicted");
        expect(read.check.evidence?.quote).toBe(example.first);
      }
      const last = await readWindows(example, clauseAt(example, 24, 23 * 30 + 19), judge);
      expect(last.check.state).toBe("contradicted");
      expect(last.check.evidence?.quote).toBe(example.first);
    },
  );

  test.each(SPLIT)(
    "a clause two looks find there Contradicts; one a look rejects is Not checked, never Supported; a true absence is Supported ($language)",
    async (example) => {
      const pages = clauseAt(example, 24, 11 * 30 + 14);
      const there = await readWindows(example, pages, judgeOf(example));
      expect(there.check).toMatchObject({
        state: "contradicted",
        evidence: { quote: example.first },
      });
      expect(there.looks).toHaveLength(2);
      expect(there.looks.map((each) => each.prompt)).toEqual([
        expect.stringContaining(example.first),
        expect.stringContaining(example.first),
      ]);

      const rejected = await readWindows(example, pages, judgeOf(example), { look: () => "not" });
      expect(rejected.check).toMatchObject({ state: "not-checked", reason: "absence-unconfirmed" });
      expect(rejected.looks.length).toBeGreaterThan(0);

      // Its reason survives the Note it is saved in (#1443).
      const elsewhere = await readWindows(example, pages, judgeOf(example), {
        look: () => "elsewhere",
      });
      expect(elsewhere.check).toMatchObject({
        state: "not-checked",
        reason: "absence-other-document",
      });
      expect(elsewhere.looks).toHaveLength(1);

      // A quote about rent the second window's judgement gives as the clause.
      const unrelated = await readWindows(example, pagesOf(example, 24), (prompt, index) => {
        if (index !== 1) return HOLDS;
        const [first] = shownPassages(prompt);
        return containing(first?.id, first?.text.slice(0, 20) ?? "");
      });
      expect(unrelated.check).toMatchObject({
        state: "not-checked",
        reason: "absence-unconfirmed",
      });

      const absent = await readWindows(example, pagesOf(example, 24), () => HOLDS);
      expect(absent.check).toMatchObject({ state: "supported", read: { pages: 24, of: 24 } });
      expect(absent.looks).toHaveLength(0);
    },
  );

  test.each(SPLIT)(
    "the estimate is the requests a read sends and their input as the provider counts it, from one window to a 220-page pick ($language)",
    async (example) => {
      const ordinary = {
        en: "The lease sets a pet deposit.",
        "zh-CN": "租约规定了宠物押金。",
      }[example.language];
      const reads: { pages: number; windows: number | null; options: ReadOptions }[] = [
        ...example.windowPages.map((pages, index) => ({
          pages,
          windows: index + 1,
          options: { priced: SMALL },
        })),
        ...example.windowPages.map((pages, index) => ({
          pages,
          windows: index + 1,
          options: { priced: SMALL, ...example.twoParts },
        })),
        // Over 40 pages, a sentence its check found it can't read whole, and one it found not stated.
        { pages: 220, windows: null, options: { priced: LARGE, checkedFirst: true } },
        {
          pages: 220,
          windows: null,
          options: { priced: LARGE, checkedFirst: true, sentence: ordinary, ordinary: true },
        },
      ];
      for (const { pages, windows, options } of reads) {
        const read = await readWindows(example, pagesOf(example, pages), () => HOLDS, options);
        const parts = options.parts?.length ?? 1;
        const runs = read.runs.length / 2;
        if (windows !== null) expect(runs).toBe(windows * parts);
        expect(read.check.state).toBe(options.ordinary ? "unsupported" : "supported");
        expect(read.judged).toHaveLength(options.ordinary ? 0 : runs);
        const { estimate } = read;
        if (estimate?.billing !== "per-token") throw new Error("No per-token estimate.");
        // A read sends 1.25 times the requests it plans, as Claude Haiku 5.5's did: each turn
        // more sends a verdict's request again, an average one, from the prompt cache.
        const planned = read.runs.length + read.judged.length;
        const turns = Math.round(1.25 * planned) - planned;
        expect(estimate.calls).toBe(planned + turns);
        const verdicts = read.runs
          .filter((call) => call.results.some((result) => result.tool === "search_documents"))
          .map(sentTokens);
        const again = verdicts.reduce((sum, each) => sum + each, 0) / verdicts.length;
        // Each request is billed for all of its prompt: its instructions, Tools and messages.
        const sent =
          read.runs.reduce((sum, call) => sum + sentTokens(call), 0) +
          read.judgements.reduce(
            (sum, each) => sum + estimateTokens(each.system) + estimateTokens(each.prompt),
            0,
          ) +
          turns * again;
        const written =
          runs * (SEARCH_OUTPUT_TOKENS + VERDICT_OUTPUT_TOKENS) +
          read.judged.length * 400 +
          turns * VERDICT_OUTPUT_TOKENS;
        // Claude Haiku 5.5 counted up to 1.41 tokens for each of this computer's; a provider not
        // measured is counted at 1.5.
        const counted = (options.priced?.kind === "anthropic" ? 1.45 : 1.5) * sent;
        expect(Math.abs(estimate.tokens - written - counted)).toBeLessThanOrEqual(0.02 * counted);
        // At its most, each window a part reads takes the eleven calls of its Run, two asks for
        // its evidence, the judgement, four comparisons of a quote and two looks at one.
        expect(estimate.upTo?.calls).toBe(20 * runs);
      }
    },
  );
});

describe("The estimate a whole read's cost question shows", () => {
  test("prices what a read likely sends as its provider counts it, and every request it may send only as the most", async () => {
    const db = openDatabase(join(await createTempDataFolder(), DATABASE_FILE));
    const meter = createMeter({ db, now: () => new Date(), cap: () => null });
    const model: MeteredModel = {
      providerId: "provider",
      kind: "openai",
      modelId: "model",
      flow: "document-check",
      billing: "per-token",
      price: { currency: "USD", input: 1, output: 5, cacheRead: 0.1 },
      maxOutput: undefined,
      ollamaCloud: false,
    };
    // A turn more sends the verdict's 58,000 again, which the prompt cache gives back.
    const likely = [
      { inputTokens: 10_000, outputTokens: 100 },
      { inputTokens: 58_000, outputTokens: 500 },
      { inputTokens: 48_500, outputTokens: 400 },
      { inputTokens: 58_000, outputTokens: 500, cached: true },
    ];
    const most = [
      { inputTokens: 10_000, outputTokens: 8_000 },
      { inputTokens: 58_000, outputTokens: 8_000 },
      { inputTokens: 1_200, outputTokens: 300 },
    ];

    const estimate = meter.estimateRead(model, { likely, most });

    if (estimate.billing !== "per-token") throw new Error("No per-token estimate.");
    // As a provider with no measured count may count it, 1.5 tokens for each: its tokens, and its
    // price, the cache's tokens at the cache's price.
    expect(estimate).toMatchObject({ calls: 4, tokens: 263_250 });
    expect(estimate.cost?.amount).toBeCloseTo((174_750 + 87_000 * 0.1 + 1_500 * 5) / 1e6, 10);
    expect(estimate.upTo).toMatchObject({ calls: 3, tokens: 120_100 });
    expect(estimate.upTo?.cost?.amount).toBeCloseTo((69_200 + 16_300 * 5) / 1e6, 10);

    // Anthropic: 1.45 tokens for each, and the most with all of its input written to the cache.
    const anthropic = meter.estimateRead({ ...model, kind: "anthropic" }, { likely, most });
    if (anthropic.billing !== "per-token") throw new Error("No per-token estimate.");
    expect(anthropic).toMatchObject({ calls: 4, tokens: 254_525 });
    expect(anthropic.cost?.amount).toBeCloseTo((168_925 + 84_100 * 0.1 + 1_500 * 5) / 1e6, 10);
    expect(anthropic.upTo).toMatchObject({ calls: 3, tokens: 116_640 });
    expect(anthropic.upTo?.cost?.amount).toBeCloseTo((69_200 * 1.25 + 16_300 * 5) / 1e6, 10);

    // A prompt over a tier's threshold is priced at the tier, its length as the provider may count
    // it (1.5 times): what is likely sent, so counted; the most, as the meter reserves it.
    const tiered = meter.estimateRead(
      {
        ...model,
        price: {
          currency: "USD",
          input: 1,
          output: 5,
          tiers: [{ above: 100_000, input: 5, output: 25 }],
        },
      },
      {
        likely: [{ inputTokens: 120_000, outputTokens: 500 }],
        most: [
          { inputTokens: 80_000, outputTokens: 1_000 },
          { inputTokens: 60_000, outputTokens: 1_000 },
        ],
      },
    );
    if (tiered.billing !== "per-token") throw new Error("No per-token estimate.");
    expect(tiered.cost?.amount).toBeCloseTo((180_000 * 5 + 500 * 25) / 1e6, 10);
    expect(tiered.upTo?.cost?.amount).toBeCloseTo(
      (80_000 * 5 + 1_000 * 25 + 60_000 * 1 + 1_000 * 5) / 1e6,
      10,
    );
  });
});
