import { generateText } from "ai";
import { describe, expect, test } from "vitest";
import {
  type AnswerUsage,
  CITATION_NODE,
  type Citation,
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  type ClaimCheckResult,
} from "../../src/core";
import type { NodeJSON } from "../../src/core/answers/blocks";
import { createUncitedCheck, uncitedFacts } from "../../src/core/answers/checks/uncited";
import type { CheckScope } from "../../src/core/answers/checks/verify";
import { resolveCapabilities } from "../../src/core/providers/capabilities";
import { pageBlocks } from "../../src/shared/answerBlocks";
import { withoutClaimCheckMarks } from "../../src/shared/claimCheckBlocks";
import { checkingModel } from "../helpers/checks";
import { createTempDataFolder, startCore } from "../helpers/core";
import { scriptedModel } from "../helpers/models";

const CLAIM = "Revenue was $1,200 million.";
const QUOTE = "Revenue was $1,482.6 million.";
const citation: Citation = {
  passageId: "passage",
  documentId: "report",
  documentName: "Report",
  contentHash: "hash",
  pageFrom: 1,
  pageTo: 1,
  location: null,
  quote: QUOTE,
  check: "found",
  checkReason: null,
};
const paragraph = (...content: NodeJSON[]): NodeJSON => ({ type: "paragraph", content });
const text = (value: string): NodeJSON => ({ type: "text", text: value });
const cited: NodeJSON = { type: CITATION_NODE, attrs: { ...citation } };

const result = (verdict: "supported" | "contradicted"): ClaimCheckResult => ({
  verdict,
  evidence: citation,
  says: verdict === "supported" ? "The report supports it." : "The report gives another figure.",
  unsupported: null,
  calculation: null,
  citedCaseUnchecked: false,
  citedCaseFound: false,
  versions: [],
  excluded: [],
});

const scope: CheckScope = {
  scope: { documentIds: null, excluded: new Map() },
  marked: { folderId: null, widened: false },
  wanted: null,
};
const usage = (): AnswerUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
});

describe("Uncited figures eligible for a background check", () => {
  test("figures and quoted facts are candidates; cited and plain sentences are not", () => {
    const blocks = [
      paragraph(text(CLAIM)),
      paragraph(text("The report says “the exact words quoted”.")),
      paragraph(text(CLAIM), cited),
      paragraph(text("A general observation without a number.")),
      paragraph(text("I didn't find the 2024 revenue figure.")),
      paragraph(text("未找到 2024 年收入。")),
      paragraph(text("The Documents don't state 2024 revenue.")),
    ];

    expect(uncitedFacts(blocks).map((sentence) => sentence.text)).toEqual([
      CLAIM,
      "The report says “the exact words quoted”.",
    ]);
  });
});

async function prepared() {
  const core = startCore(await createTempDataFolder());
  const provider = await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  return {
    model: checkingModel({ [CLAIM]: { verdict: "supported", quote: QUOTE } }),
    provider,
    modelId: "local-model",
    capabilities: resolveCapabilities({}),
    summarizesReasoning: false,
  };
}

const withResult = (
  check: ClaimCheckAttributes,
  next: ClaimCheckResult,
  at: string,
): ClaimCheckAttributes => ({
  ...check,
  state: next.verdict,
  reason: next.verdict === "not-checked" ? next.reason : null,
  detail: next.verdict === "not-checked" ? next.detail : null,
  evidence: next.verdict === "not-checked" ? null : next.evidence,
  says: next.verdict === "not-checked" ? null : next.says,
  unsupported: next.verdict === "not-checked" ? null : next.unsupported,
  calculation: next.verdict === "not-checked" ? null : next.calculation,
  checkedAt: at,
});

describe("The uncited background checker", () => {
  test("publishes on a small local model, starts one phase and leaves absence reports out", async () => {
    const model = { ...(await prepared()), parameters: 4_500_000_000 };
    const published: ClaimCheckAttributes[] = [];
    let phases = 0;
    await createUncitedCheck({
      prepare: async (answer) => answer,
      claimCheck: async () => result("contradicted"),
      citedNow: (cited) => cited,
      withResult,
      claimTimeLimitMs: 1_000,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    })({
      answerId: "answer",
      mindId: null,
      blocks: [
        paragraph(text(CLAIM)),
        paragraph(text("Unfortunately, I didn't find the $3.2 million figure in the Documents.")),
        paragraph(text("I was unable to find the 2024 revenue figure.")),
        paragraph(text("我在文档中没有找到2024年的营收数据（3.2亿元）。")),
        paragraph(text("The Documents don't include any 2024 figures.")),
      ],
      prepared: model,
      scope,
      searchable: 1,
      usage: usage(),
      signal: new AbortController().signal,
      checking: () => phases++,
      publish: (check) => published.push(check),
    });

    expect(phases).toBe(1);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      state: "contradicted",
      text: CLAIM,
      evidence: { quote: QUOTE },
    });
  });

  test("Stop after one result keeps it and never starts the next", async () => {
    const model = await prepared();
    const controller = new AbortController();
    const published: ClaimCheckAttributes[] = [];
    let calls = 0;
    await createUncitedCheck({
      prepare: async (answer) => answer,
      claimCheck: async () => {
        calls++;
        return result("supported");
      },
      citedNow: (cited) => cited,
      withResult,
      claimTimeLimitMs: 1_000,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    })({
      answerId: "answer",
      mindId: null,
      blocks: Array.from({ length: 13 }, () => paragraph(text(CLAIM))),
      prepared: model,
      scope,
      searchable: 1,
      usage: usage(),
      signal: controller.signal,
      checking: () => undefined,
      publish: (check) => {
        published.push(check);
        if (published.length === 1) controller.abort();
      },
    });

    expect(calls).toBe(1);
    expect(published).toHaveLength(1);
    expect(published[0]?.state).toBe("supported");
  });

  test("a preparation refusal publishes nothing", async () => {
    const model = await prepared();
    const published: ClaimCheckAttributes[] = [];
    let calls = 0;
    await createUncitedCheck({
      prepare: async () => null,
      claimCheck: async () => {
        calls++;
        return result("supported");
      },
      citedNow: (cited) => cited,
      withResult,
      claimTimeLimitMs: 1_000,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    })({
      answerId: "answer",
      mindId: null,
      blocks: [paragraph(text(CLAIM))],
      prepared: model,
      scope,
      searchable: 1,
      usage: usage(),
      signal: new AbortController().signal,
      checking: () => undefined,
      publish: (check) => published.push(check),
    });

    expect(calls).toBe(0);
    expect(published).toHaveLength(0);
  });

  test("bounds checks and gives every remaining sentence a reason", async () => {
    const model = await prepared();
    const published: ClaimCheckAttributes[] = [];
    await createUncitedCheck({
      prepare: async (answer) => answer,
      claimCheck: async () => ({
        verdict: "not-checked",
        reason: "cost-cap",
        detail: null,
        versions: [],
        excluded: [],
      }),
      citedNow: (cited) => cited,
      withResult,
      claimTimeLimitMs: 1_000,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    })({
      answerId: "answer",
      mindId: null,
      blocks: Array.from({ length: 13 }, () => paragraph(text(CLAIM))),
      prepared: model,
      scope,
      searchable: 1,
      usage: usage(),
      signal: new AbortController().signal,
      checking: () => undefined,
      publish: (check) => published.push(check),
    });

    expect(published).toHaveLength(13);
    expect(published.slice(0, 12).every((check) => check.reason === "cost-cap")).toBe(true);
    expect(published[12]?.reason).toBe("too-many");
  });

  test.each([
    { reason: "plan-limit", detail: null },
    { reason: "failed", detail: "Provider unavailable" },
  ] as const)("publishes a $reason outcome instead of dropping it", async ({ reason, detail }) => {
    const model = await prepared();
    const published: ClaimCheckAttributes[] = [];
    await createUncitedCheck({
      prepare: async (answer) => answer,
      claimCheck: async () => ({
        verdict: "not-checked",
        reason,
        detail,
        versions: [],
        excluded: [],
      }),
      citedNow: (cited) => cited,
      withResult,
      claimTimeLimitMs: 1_000,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    })({
      answerId: "answer",
      mindId: null,
      blocks: [paragraph(text(CLAIM))],
      prepared: model,
      scope,
      searchable: 1,
      usage: usage(),
      signal: new AbortController().signal,
      checking: () => undefined,
      publish: (check) => published.push(check),
    });

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ state: "not-checked", reason, detail });
  });

  test("a claim-finder failure leaves every candidate not checked", async () => {
    const model = {
      ...(await prepared()),
      model: scriptedModel(() => ({ text: "No claims." }), {
        generate: () => ({ text: "Not JSON." }),
      }),
    };
    const published: ClaimCheckAttributes[] = [];
    let calls = 0;
    await createUncitedCheck({
      prepare: async (answer) => answer,
      claimCheck: async () => {
        calls++;
        return result("supported");
      },
      citedNow: (cited) => cited,
      withResult,
      claimTimeLimitMs: 1_000,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    })({
      answerId: "answer",
      mindId: null,
      blocks: [paragraph(text(CLAIM))],
      prepared: model,
      scope,
      searchable: 1,
      usage: usage(),
      signal: new AbortController().signal,
      checking: () => undefined,
      publish: (check) => published.push(check),
    });

    expect(calls).toBe(0);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ state: "not-checked", reason: "empty" });
  });

  test("model calls through the checker join the Answer's total", async () => {
    const model = await prepared();
    const total = usage();
    await createUncitedCheck({
      prepare: async (answer) => answer,
      claimCheck: async (request) => {
        await generateText({ model: request.model.model, prompt: "Reply briefly." });
        return result("supported");
      },
      citedNow: (cited) => cited,
      withResult,
      claimTimeLimitMs: 1_000,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    })({
      answerId: "answer",
      mindId: null,
      blocks: [paragraph(text(CLAIM))],
      prepared: model,
      scope,
      searchable: 1,
      usage: total,
      signal: new AbortController().signal,
      checking: () => undefined,
      publish: () => undefined,
    });

    expect(total.inputTokens).toBeGreaterThan(0);
    expect(total.outputTokens).toBeGreaterThan(0);
  });
});

describe("Adding an Answer to a Note", () => {
  test("background claim marks are stripped rather than retained without evidence", () => {
    const check = withResult(
      {
        id: "check",
        request: "request",
        action: "check-against-documents",
        state: "checking",
        reason: null,
        detail: null,
        providerId: "provider",
        modelId: "model",
        text: CLAIM,
        evidence: null,
        says: null,
        unsupported: null,
        calculation: null,
        citedCaseUnchecked: false,
        citedCaseFound: false,
        scope: scope.marked,
        versions: [],
        excluded: [],
        checkedAt: "2026-01-01T00:00:00.000Z",
      },
      result("contradicted"),
      "2026-01-01T00:00:00.000Z",
    );
    const answer = { text: CLAIM, citations: [], figures: [], claimChecks: [check] };
    const blocks = pageBlocks(answer, "What was revenue?");

    expect(JSON.stringify(blocks)).not.toContain(CLAIM_CHECK_MARK);
  });

  test("selected Blocks drop only the claim marks", () => {
    const marked: NodeJSON[] = [
      {
        type: "listItem",
        content: [
          paragraph({
            type: "text",
            text: CLAIM,
            marks: [{ type: CLAIM_CHECK_MARK }, { type: "bold" }],
          }),
        ],
      },
    ];

    const stripped = withoutClaimCheckMarks(marked);
    expect(JSON.stringify(stripped)).not.toContain(CLAIM_CHECK_MARK);
    expect(stripped[0]?.content?.[0]?.content?.[0]?.marks).toEqual([{ type: "bold" }]);
  });
});
