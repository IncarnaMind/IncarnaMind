import type { JSONContent } from "@tiptap/core";
import { describe, expect, test, vi } from "vitest";
import type { ClaimCheckAttributes, CoreAdapters, Document, SearchScope } from "../../src/core";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { readClaimCheck } from "../../src/shared/claimChecks";
import { checkGenerate, checkingModel, checkReply, isCheckRun, type Plan } from "../helpers/checks";
import { type SourceFile, setUpWithDocuments } from "../helpers/citations";
import { nextEvent } from "../helpers/core";
import type { MindClient } from "../helpers/mindClient";
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
          return checkReply(call, {
            [example.claim]: handedLease
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
      expect((await onlyMark(client)).state).toBe("unsupported");
      const handed = calls
        .filter(isCheckRun)
        .flatMap((call) => call.results)
        .filter((result) => result.tool === "search_documents");
      expect(handed.length).toBeGreaterThan(0);
      expect(handed.some((result) => result.text.includes(leaseQuote))).toBe(false);

      const planBefore = await core.planDocumentCheck({
        mindId: mind.id,
        within: within([lease.id]),
      });
      expect(planBefore).toMatchObject({ kind: "ready", documents: [{ documentId: lease.id }] });

      const result = await core.checkSentences(
        checkInput(mind.id, block, example.claim, within([lease.id])),
      );

      expect(result).toMatchObject({ kind: "checked", sentences: 1, checked: 1 });
      const check = await onlyMark(client);
      expect(check).toMatchObject({
        action: "check-against-document",
        state: "supported",
        evidence: { documentId: lease.id, quote: leaseQuote, check: "found" },
        scope: { chosen: { documentIds: [lease.id] } },
      });
      expect(check.read?.pages).toBe(check.read?.of);
    },
  );

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
      checkInput(mind.id, block, EN.claim, within([documents[0]?.id ?? ""])),
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
      checkInput(mind.id, block, EN.claim, within([documents[0]?.id ?? ""])),
    );

    expect(calls.filter(isCheckRun).length).toBeGreaterThan(1);
    const check = await onlyMark(client);
    expect(check.state).toBe("unsupported");
    expect(check.read?.pages).toBe(check.read?.of);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(check.read?.of);
  });

  test("counts a page only when every supplied Passage on it reached the model", async () => {
    const document = buildPdf(
      Array.from({ length: 12 }, (_, page) => ({
        lines: Array.from(
          { length: 30 },
          (_, line) => `Page ${page + 1} line ${line + 1} has ordinary lease words for this check.`,
        ),
      })),
    );
    const calls: ModelCall[] = [];
    const quote = "Page 1 line 5 has ordinary lease words for this check.";
    const plan = { [EN.claim]: { verdict: "supported" as const, quote } };
    const ollamaModels: CoreAdapters["ollamaModels"] = {
      describe: async () => ({
        digest: null,
        capabilities: ["completion", "tools"],
        contextLength: 10240,
        parameters: null,
        support: "tools",
        chat: true,
        remote: false,
        settings: { numCtx: 10240, outputTokens: 1024, keepAlive: "5m", think: false },
      }),
      loaded: async () => true,
      running: async () => true,
    };
    const { core, client, mind, block, documents } = await setup(
      [{ name: "Lease-long.pdf", contents: document }],
      plan,
      EN.claim,
      calls,
      undefined,
      undefined,
      { ollamaModels },
    );

    await core.checkSentences(
      checkInput(mind.id, block, EN.claim, within([documents[0]?.id ?? ""])),
    );

    expect(JSON.stringify(calls.filter(isCheckRun))).not.toContain("Page 12 line 30");
    const check = await onlyMark(client);
    expect(check.state).toBe("supported");
    expect(check.read).toEqual({ pages: 7, of: 12 });
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

    await core.checkSentences({
      ...checkInput(mind.id, block, EN.claim, within([documents[0]?.id ?? ""]), requestId),
      model,
    });
    await client.settled();

    expect(reports - 1).toBeGreaterThan(1);
    expect(plan.estimate.calls).toBe((reports - 1) * 3);
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
      checkInput(result.mind.id, block, EN.claim, within([result.documents[0]?.id ?? ""])),
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
      checkInput(mind.id, block, EN.claim, within([documents[0]?.id ?? ""])),
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
      checkInput(mind.id, block, EN.claim, within([documents[0]?.id ?? ""]), "older"),
    );
    await vi.waitFor(() => expect(held).toBe(true));
    await core.checkSentences(
      checkInput(mind.id, block, EN.claim, within([documents[0]?.id ?? ""]), "newer"),
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
    core.on("documentCheck.progress", (event) => {
      if (event.requestId === requestId && event.pages > 0) void core.cancelCheck(requestId);
    });

    const result = await core.checkSentences(
      checkInput(mind.id, block, EN.claim, within([documents[0]?.id ?? ""]), requestId),
    );

    expect(result).toEqual({ kind: "cancelled" });
    const check = await onlyMark(client);
    expect(check).toEqual(previous);
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

    const running = core.checkSentences({
      ...checkInput(mind.id, block, EN.claim, within([documents[0]?.id ?? ""])),
      model: { providerId: saved.id, modelId: "claude-haiku-5-5" },
    });
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
    const { core, mind, documents } = await setup(files, {}, EN.claim, calls);
    const ids = documents.map((each) => each.id);

    expect(await core.planDocumentCheck({ mindId: mind.id, within: within(ids) })).toEqual({
      kind: "too-many",
      documents: 26,
      most: 25,
    });
    expect(await core.planDocumentCheck({ mindId: mind.id, within: within(["missing"]) })).toEqual({
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
