import { generateText } from "ai";
import { describe, expect, test } from "vitest";
import {
  type AnswerUsage,
  CITATION_NODE,
  type Citation,
  type ClaimCheckAttributes,
  type ClaimCheckResult,
} from "../../src/core";
import type { NodeJSON } from "../../src/core/answers/blocks";
import { createUncitedCheck, uncitedFacts } from "../../src/core/answers/checks/uncited";
import type { CheckScope } from "../../src/core/answers/checks/verify";
import { resolveCapabilities } from "../../src/core/providers/capabilities";
import { checkingModel } from "../helpers/checks";
import { createTempDataFolder, startCore } from "../helpers/core";

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
  test("figures and quoted facts count; cited, plain and absence sentences don't", () => {
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
  test("publishes on a small local model and starts only one checking phase", async () => {
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
      blocks: [paragraph(text(CLAIM))],
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
      blocks: [
        paragraph(text(CLAIM)),
        paragraph(text("The report says “the exact words quoted”.")),
      ],
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
