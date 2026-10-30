import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { expect, test } from "vitest";
import {
  ATTRIBUTION_SHA256,
  type AttributionRequest,
  observeAttribution,
} from "../../eval/attribution/adapter";
import frozen from "../../eval/attribution/cases.json";
import {
  ATTRIBUTION_PILOT_CASES,
  type AttributionPilotPlan,
  createAttributionPilotBudget,
  EMPTY_SOURCE_DIFF_SHA256,
  validateAttributionPilot,
} from "../../eval/attribution/pilot";
import { scoreAttributionSet } from "../../eval/attribution/scoring";
import type { ClaimCheckResult } from "../../src/core";
import { partWithResult, resultFromParts } from "../../src/shared/claimParts";
import { createTempDataFolder } from "../helpers/core";

const hashes = {
  adapter: "c".repeat(64),
  scorer: "d".repeat(64),
  host: "e".repeat(64),
  entry: "f".repeat(64),
};
const pins = { before: "a".repeat(40), after: "b".repeat(40) };
const pilot: AttributionPilotPlan = {
  phase: "pilot",
  arm: "after",
  model: "claude-sonnet-5-5",
  capUSD: 2,
  pins,
  sourceHead: pins.after,
  sourceDiffSHA256: EMPTY_SOURCE_DIFF_SHA256,
  fixtureSHA256: ATTRIBUTION_SHA256,
  caseIds: ATTRIBUTION_PILOT_CASES,
  sharedHashes: hashes,
  expectedSharedHashes: hashes,
};
const importedDocuments = frozen.sources.map((source, index) => ({
  sourceId: source.id,
  documentId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
}));
function receipt(
  model: AttributionPilotPlan["model"],
  sampleIds: readonly string[] = ATTRIBUTION_PILOT_CASES,
) {
  return {
    manifest: { ...pilot, model },
    completed: true,
    stopReason: null,
    ledger: {
      version: 1,
      task: "attribution-pilot",
      capUSD: 2,
      chargedUSD: 0,
      entries: sampleIds.map((id, index) => ({
        request: index + 1,
        caseId: id,
        arm: "after",
        model,
        sourceHead: pins.after,
        chargedUSD: 0,
        maximumUSD: 1,
        status: "settled",
        outcome: "complete",
        usage: {
          known: true,
          cacheComplete: true,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      })),
      pins,
      fixtureSHA256: ATTRIBUTION_SHA256,
      caseIds: ATTRIBUTION_PILOT_CASES,
      sharedHashes: hashes,
      stopKind: null,
    },
    importedDocuments,
    rows: sampleIds.map((id, index) => {
      const sample = frozen.cases.find((sample) => sample.id === id);
      if (!sample) throw new Error("Missing frozen case.");
      const proof =
        sample.gold.sourceEvidence.find(
          (proof) =>
            proof.role === "decisive-surrounding-context" ||
            proof.role === "newer-current-conflict",
        ) ?? sample.gold.sourceEvidence[0];
      const profile = frozen.profiles.find((profile) => profile.id === sample.profileId);
      const source = frozen.sources.find(
        (source) => source.id === (proof?.sourceId ?? profile?.inScopeSourceIds[0]),
      );
      const document = importedDocuments.find((document) => document.sourceId === source?.id);
      if (!source || !document) throw new Error("Missing frozen Source.");
      const evidence = {
        passageId: "passage",
        documentId: document.documentId,
        documentName: source.title,
        contentHash: source.sha256,
        pageFrom: null,
        pageTo: null,
        location: null,
        quote: proof?.quote ?? source.text,
        check: "found" as const,
        checkReason: null,
      };
      const verdict = sample.gold.nativeVerdict;
      if (verdict !== "supported" && verdict !== "unsupported" && verdict !== "contradicted")
        throw new Error("Invalid verdict.");
      const judgment: ClaimCheckResult = {
        verdict,
        evidence,
        says: null,
        unsupported: null,
        calculation: null,
        citedCaseUnchecked: false,
        citedCaseFound: false,
        versions: [],
        excluded: [],
      };
      const target = sample.gold.facetTargets[0];
      const facet = target?.facet;
      if (facet !== undefined && facet !== "source" && facet !== "speaker" && facet !== "time")
        throw new Error("Invalid facet.");
      const part = partWithResult(
        {
          kind: "fact",
          span: target?.span ?? { start: 0, end: sample.text.length },
          ...(facet !== undefined && { facet: { kind: facet } }),
        },
        judgment,
      );
      return {
        id,
        status: "returned",
        error: null,
        result: resultFromParts([part]),
        requests: [index + 1],
        ms: 1,
      };
    }),
  };
}
function sealed(value: unknown) {
  const bytes = JSON.stringify(value);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}
function full(
  receipts = [sealed(receipt("claude-haiku-5-5")), sealed(receipt("claude-sonnet-5-5"))],
) {
  return {
    ...pilot,
    phase: "full",
    capUSD: 3.75,
    caseIds: frozen.cases.map((sample) => sample.id),
    pilotReceiptHashes: receipts.map((receipt) => receipt.sha256),
  };
}
async function options(
  receipts = [sealed(receipt("claude-haiku-5-5")), sealed(receipt("claude-sonnet-5-5"))],
) {
  return {
    plan: full(receipts),
    pilotReceipts: receipts,
    ledgerPath: join(await createTempDataFolder(), "full.json"),
    price: { currency: "USD" as const, input: 0.1, output: 0.5, cacheRead: 0.01 },
    reservationPrice: { currency: "USD" as const, input: 0.1, output: 0.5, cacheRead: 0.01 },
    defaultOutputTokens: 128000,
    cacheWritePolicy: "5m" as const,
  };
}

test("full admission requires two passing candidate pilots and keeps all40 ordered cases", async () => {
  const ready = createAttributionPilotBudget(await options());
  expect(ready.stopped()).toBe(false);
  expect(ready.snapshot()).toMatchObject({
    phase: "full",
    capUSD: 3.75,
    caseIds: frozen.cases.map((sample) => sample.id),
  });
});

test.each(["dry", "", "another"])("default and unknown phases never admit: %s", async (phase) => {
  const config = await options();
  expect(() =>
    createAttributionPilotBudget({ ...config, plan: { ...config.plan, phase } }),
  ).toThrow();
  expect(() => readFileSync(config.ledgerPath)).toThrow();
});

test.each([
  { capUSD: 3.76 },
  { capUSD: 0 },
  { capUSD: NaN },
  { caseIds: ATTRIBUTION_PILOT_CASES },
  { caseIds: frozen.cases.map((sample) => sample.id).reverse() },
  { pilotReceiptHashes: undefined },
  { sourceHead: pins.before },
])("full refuses changed phase admission: %j", async (change) => {
  const config = await options();
  expect(() =>
    createAttributionPilotBudget({ ...config, plan: { ...config.plan, ...change } }),
  ).toThrow();
});

test("the legacy pilot remains capped at two dollars and needs no promotion reports", () => {
  expect(() => validateAttributionPilot(pilot)).not.toThrow();
  expect(() => validateAttributionPilot({ ...pilot, capUSD: 2.01 })).toThrow();
});

test.each([
  ["missing rows", (r: ReturnType<typeof receipt>) => ({ ...r, rows: r.rows.slice(1) })],
  [
    "baseline receipt",
    (r: ReturnType<typeof receipt>) => ({
      ...r,
      manifest: { ...r.manifest, arm: "before", sourceHead: pins.before },
    }),
  ],
  [
    "wrong head",
    (r: ReturnType<typeof receipt>) => ({
      ...r,
      manifest: { ...r.manifest, sourceHead: "0".repeat(40) },
    }),
  ],
  [
    "unapproved model",
    (r: ReturnType<typeof receipt>) => ({ ...r, manifest: { ...r.manifest, model: "another" } }),
  ],
  [
    "wrong fixture",
    (r: ReturnType<typeof receipt>) => ({
      ...r,
      manifest: { ...r.manifest, fixtureSHA256: "0".repeat(64) },
    }),
  ],
  [
    "wrong host",
    (r: ReturnType<typeof receipt>) => ({
      ...r,
      manifest: { ...r.manifest, sharedHashes: { ...hashes, host: "0".repeat(64) } },
    }),
  ],
  [
    "unknown hold",
    (r: ReturnType<typeof receipt>) => ({
      ...r,
      ledger: { ...r.ledger, entries: r.ledger.entries.map((e) => ({ ...e, status: "unknown" })) },
    }),
  ],
  [
    "wrong ledger phase",
    (r: ReturnType<typeof receipt>) => ({ ...r, ledger: { ...r.ledger, phase: "full" } }),
  ],
  [
    "wrong ledger case inventory",
    (r: ReturnType<typeof receipt>) => ({ ...r, ledger: { ...r.ledger, caseIds: [] } }),
  ],
  [
    "wrong ledger hashes",
    (r: ReturnType<typeof receipt>) => ({
      ...r,
      ledger: { ...r.ledger, sharedHashes: { ...hashes, host: "0".repeat(64) } },
    }),
  ],
  ["stopped", (r: ReturnType<typeof receipt>) => ({ ...r, stopReason: "admission-refused" })],
  [
    "partial finally receipt",
    (r: ReturnType<typeof receipt>) => ({ ...r, importedDocuments: undefined }),
  ],
  [
    "native miss",
    (r: ReturnType<typeof receipt>) => ({
      ...r,
      rows: r.rows.map((row) => ({ ...row, result: { ...row.result, verdict: "unsupported" } })),
    }),
  ],
  [
    "unstarted",
    (r: ReturnType<typeof receipt>) => ({
      ...r,
      rows: r.rows.map((row) => ({ ...row, status: "not-executed" })),
    }),
  ],
  [
    "missing facet",
    (r: ReturnType<typeof receipt>) => ({
      ...r,
      rows: r.rows.map((row) => ({ ...row, result: { ...row.result, parts: [] } })),
    }),
  ],
  [
    "pending facet",
    (r: ReturnType<typeof receipt>) => ({
      ...r,
      rows: r.rows.map((row) => ({
        ...row,
        result: {
          ...row.result,
          parts: row.result.parts?.map((part) => ({ ...part, verdict: "checking" })),
        },
      })),
    }),
  ],
  [
    "failed facet",
    (r: ReturnType<typeof receipt>) => ({
      ...r,
      rows: r.rows.map((row) => ({
        ...row,
        result: {
          ...row.result,
          parts: row.result.parts?.map((part) => ({
            ...part,
            verdict: "not-checked",
            reason: "malformed",
          })),
        },
      })),
    }),
  ],
  [
    "malformed facet",
    (r: ReturnType<typeof receipt>) => ({
      ...r,
      rows: r.rows.map((row) => ({
        ...row,
        result: {
          ...row.result,
          parts: row.result.parts?.map((part) => ({ ...part, facet: { kind: "another" } })),
        },
      })),
    }),
  ],
  [
    "duplicate facet",
    (r: ReturnType<typeof receipt>) => ({
      ...r,
      rows: r.rows.map((row) => ({
        ...row,
        result: {
          ...row.result,
          parts: [...(row.result.parts ?? []), ...(row.result.parts ?? [])],
        },
      })),
    }),
  ],
  [
    "no facet proof",
    (r: ReturnType<typeof receipt>) => ({
      ...r,
      rows: r.rows.map((row) => ({
        ...row,
        result: {
          ...row.result,
          parts: row.result.parts?.map((part) => ({ ...part, evidence: [] })),
        },
      })),
    }),
  ],
  [
    "unfound quote",
    (r: ReturnType<typeof receipt>) => ({
      ...r,
      rows: r.rows.map((row) => ({
        ...row,
        result: {
          ...row.result,
          parts: row.result.parts?.map((part) => ({
            ...part,
            evidence: part.evidence.map((cite) => ({ ...cite, quote: "Not in the Source." })),
          })),
        },
      })),
    }),
  ],
] as const)("promotion refuses %s before a provider factory", async (_name, change) => {
  const receipts = [
    sealed(change(receipt("claude-haiku-5-5"))),
    sealed(receipt("claude-sonnet-5-5")),
  ];
  const config = await options(receipts);
  let factories = 0;
  expect(() => {
    createAttributionPilotBudget(config);
    factories++;
  }).toThrow();
  expect(factories).toBe(0);
  expect(() => readFileSync(config.ledgerPath)).toThrow();
});

test("missing reports, duplicate models and changed bytes cannot promote", async () => {
  const config = await options();
  expect(() => createAttributionPilotBudget({ ...config, pilotReceipts: [] })).toThrow();
  expect(() =>
    createAttributionPilotBudget({
      ...config,
      pilotReceipts: config.pilotReceipts.map((r) => ({ ...r, bytes: `${r.bytes} ` })),
    }),
  ).toThrow("hash");
  const first = receipt("claude-sonnet-5-5");
  const duplicate = await options([sealed(first), sealed({ ...first, completed: false })]);
  expect(() => createAttributionPilotBudget(duplicate)).toThrow();
  const malformed = await options([sealed(null), config.pilotReceipts[1] ?? sealed(null)]);
  expect(() => createAttributionPilotBudget(malformed)).toThrow();
});

test("settled baseline requests do not decide candidate promotion", async () => {
  const reports = [receipt("claude-haiku-5-5"), receipt("claude-sonnet-5-5")];
  for (const report of reports) {
    const first = report.ledger.entries[0];
    if (!first) throw new Error("Missing measured request.");
    report.ledger.entries.push({ ...first, arm: "before", sourceHead: pins.before });
  }
  const config = await options(reports.map(sealed));
  expect(createAttributionPilotBudget(config).stopped()).toBe(false);
});

test("an Unsupported focused time row cannot hide behind an ordinary Contradicted part", async () => {
  const report = receipt("claude-haiku-5-5");
  const row = report.rows.find((row) => row.id === "T02-en");
  if (!row || row.result.verdict === "not-checked" || !row.result.parts)
    throw new Error("Missing time result.");
  const ordinary = partWithResult({ kind: "fact", span: { start: 27, end: 29 } }, row.result);
  const parts = row.result.parts.map((part) => ({ ...part, verdict: "unsupported" as const }));
  row.result = resultFromParts([...parts, ordinary]);
  expect(row.result.verdict).toBe("contradicted");
  const config = await options([sealed(report), sealed(receipt("claude-sonnet-5-5"))]);
  expect(() => createAttributionPilotBudget(config)).toThrow();
});

test.each(["input", "output", "cacheRead", "cacheWrite"] as const)(
  "reported usage %s must be present, finite and nonnegative",
  async (field) => {
    for (const value of [undefined, -1, NaN, Infinity]) {
      const report = receipt("claude-haiku-5-5");
      const malformed = {
        ...report,
        ledger: {
          ...report.ledger,
          entries: report.ledger.entries.map((entry) => ({
            ...entry,
            usage: { ...entry.usage, [field]: value },
          })),
        },
      };
      const config = await options([sealed(malformed), sealed(receipt("claude-sonnet-5-5"))]);
      expect(() => createAttributionPilotBudget(config)).toThrow();
    }
  },
);

test("reported cache partitions cannot exceed the reported total input", async () => {
  const report = receipt("claude-haiku-5-5");
  const malformed = {
    ...report,
    ledger: {
      ...report.ledger,
      entries: report.ledger.entries.map((entry) => ({
        ...entry,
        usage: { ...entry.usage, input: 1, cacheRead: 1, cacheWrite: 1 },
      })),
    },
  };
  const config = await options([sealed(malformed), sealed(receipt("claude-sonnet-5-5"))]);
  expect(() => createAttributionPilotBudget(config)).toThrow();
});

test("full unknown usage retains its hold and phase cannot reset a ledger", async () => {
  const config = await options();
  const guard = createAttributionPilotBudget(config);
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: "Measured." }],
      finishReason: { unified: "stop", raw: undefined },
      warnings: [],
      usage: {
        inputTokens: {
          total: undefined,
          noCache: undefined,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: undefined, text: undefined, reasoning: undefined },
      },
    }),
  });
  await observeAttribution(() => model, guard.hooks)
    .factory({ kind: "anthropic", modelId: pilot.model, apiKey: null, baseUrl: null })
    .doGenerate({ prompt: [], maxOutputTokens: 300 });
  const saved = readFileSync(config.ledgerPath, "utf8");
  expect(guard.snapshot()).toMatchObject({
    phase: "full",
    stopKind: "unknown-usage",
    entries: [{ status: "unknown" }],
  });
  expect(createAttributionPilotBudget(config).stopped()).toBe(true);
  expect(() => createAttributionPilotBudget({ ...config, plan: pilot })).toThrow("ledger");
  expect(readFileSync(config.ledgerPath, "utf8")).toBe(saved);
  const changed = { ...guard.snapshot(), pilotReceiptHashes: ["0".repeat(64), "1".repeat(64)] };
  writeFileSync(config.ledgerPath, JSON.stringify(changed));
  expect(() => createAttributionPilotBudget(config)).toThrow("ledger");
});

async function settledHistory(spend: 2.8 | 2.81) {
  const config = await options();
  const price = { currency: "USD" as const, input: 2, output: 10, cacheRead: 0.1 };
  const guard = createAttributionPilotBudget({ ...config, price, reservationPrice: price });
  const measured: AttributionRequest = {
    number: 1,
    caseId: "N01-en",
    mode: "generate",
    kind: "check",
    status: "complete",
    ms: 0,
    usage: {
      input: 800000,
      output: spend === 2.8 ? 120000 : 121000,
      cacheRead: 0,
      cacheWrite: 0,
      known: true,
      cacheComplete: true,
    },
    reply: "",
    messages: [],
    tools: [],
    results: [],
    inputKinds: [],
    responseKinds: [],
    responseModel: null,
    temperature: null,
    outputTokens: 128000,
    seed: null,
    error: null,
  };
  guard.hooks.before?.(measured, { prompt: [], maxOutputTokens: 300 });
  const history = guard.snapshot();
  history.entries = history.entries.map((entry) => ({
    ...entry,
    status: "settled",
    outcome: "complete",
    maximumUSD: 3.5,
    chargedUSD: spend,
    usage: measured.usage,
  }));
  history.chargedUSD = spend;
  writeFileSync(config.ledgerPath, JSON.stringify(history));
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: "Completed." }],
      warnings: [],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 10, text: 10, reasoning: undefined },
      },
    }),
  });
  const observed = observeAttribution(() => model, guard.hooks);
  observed.requests.push(measured);
  return {
    config,
    guard,
    model,
    wrapped: observed.factory({
      kind: "anthropic",
      modelId: pilot.model,
      apiKey: null,
      baseUrl: null,
    }),
  };
}

test("settled spend2.81 refuses the next affordable request before provider and durably stops", async () => {
  const { guard, model, wrapped, config } = await settledHistory(2.81);
  await expect(wrapped.doGenerate({ prompt: [], maxOutputTokens: 300 })).rejects.toThrow("settled");
  expect(model.doGenerateCalls).toHaveLength(0);
  expect(guard.snapshot()).toMatchObject({
    capUSD: 3.75,
    chargedUSD: 2.81,
    stopKind: "settled-spend",
  });
  expect(guard.snapshot().entries).toHaveLength(1);
  expect(
    createAttributionPilotBudget({
      ...config,
      price: { currency: "USD", input: 2, output: 10, cacheRead: 0.1 },
      reservationPrice: { currency: "USD", input: 2, output: 10, cacheRead: 0.1 },
    }).stopped(),
  ).toBe(true);
});

test("exactly2.80 allows the affordable request and its final settlement may cross the stop", async () => {
  const { guard, model, wrapped } = await settledHistory(2.8);
  await wrapped.doGenerate({ prompt: [], maxOutputTokens: 300 });
  expect(model.doGenerateCalls).toHaveLength(1);
  expect(guard.snapshot().chargedUSD).toBeGreaterThan(2.8);
  expect(guard.snapshot().entries).toHaveLength(2);
  expect(guard.snapshot().entries.every((entry) => entry.status === "settled")).toBe(true);
  expect(guard.snapshot().stopKind).toBeNull();
  expect(guard.stopped()).toBe(false);
});

const recoveryCases = {
  "claude-haiku-5-5": ["N03-en", "S01-en", "S01-zh-CN", "T07-en", "T07-zh-CN"],
  "claude-sonnet-5-5": ["S02-en", "S02-zh-CN"],
};
const fixedHead = "1".repeat(40);
const fixedHashes = { ...hashes, host: "2".repeat(64), entry: "3".repeat(64) };
function originalFullReport(model: AttributionPilotPlan["model"]) {
  const ids = frozen.cases.map((sample) => sample.id);
  const report = receipt(model, ids);
  const failures = [
    ...recoveryCases[model],
    ...(model === "claude-sonnet-5-5"
      ? ["C02-en", "C02-zh-CN", "C03-zh-CN", "C05-en", "C05-zh-CN"]
      : []),
  ];
  const rows = report.rows.map((row) => {
    if (!failures.includes(row.id)) return row;
    const result = row.result;
    if (result.verdict === "not-checked") throw new Error("Missing original verdict.");
    const verdict = result.verdict === "supported" ? "unsupported" : "supported";
    const parts = result.parts?.map((part) => partWithResult(part, { ...result, verdict }));
    return { ...row, result: resultFromParts(parts ?? []) };
  });
  const originalPlan = { ...full(), model };
  return {
    ...report,
    rows,
    scores: scoreAttributionSet(
      frozen,
      new Map(importedDocuments.map((document) => [document.sourceId, document.documentId])),
      new Map(rows.map((row) => [row.id, row.result])),
    ),
    manifest: originalPlan,
    ledger: {
      ...report.ledger,
      phase: "full",
      capUSD: 3.75,
      caseIds: ids,
      pilotReceiptHashes: originalPlan.pilotReceiptHashes,
    },
  };
}
async function recoveryOptions(
  model: AttributionPilotPlan["model"] = "claude-haiku-5-5",
  spend = 0.2,
) {
  const config = await options();
  const originalAfterReports = [
    sealed(originalFullReport("claude-haiku-5-5")),
    sealed(originalFullReport("claude-sonnet-5-5")),
  ];
  const original = {
    version: 1,
    task: "attribution-pilot",
    phase: "full",
    capUSD: 3.75,
    chargedUSD: spend,
    pins,
    fixtureSHA256: ATTRIBUTION_SHA256,
    caseIds: config.plan.caseIds,
    sharedHashes: hashes,
    pilotReceiptHashes: config.plan.pilotReceiptHashes,
    stopKind: null,
    entries: [
      {
        id: "historical-id",
        run: "historical-run",
        request: 1,
        arm: "before",
        model,
        sourceHead: pins.before,
        caseId: "N01-en",
        maximumUSD: 3.5,
        chargedUSD: spend,
        status: "settled",
        outcome: "complete",
        usage: {
          input: 10,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          known: true,
          cacheComplete: true,
        },
      },
    ],
  };
  const lineage = {
    sourceHead: fixedHead,
    sharedHashes: fixedHashes,
    originalAfterReportHashes: originalAfterReports.map((report) => report.sha256),
    originalEntryCount: original.entries.length,
    originalChargedUSD: spend,
    originalLedgerSHA256: sealed(original).sha256,
    caseIds: recoveryCases,
  };
  const ledger = { ...original, recoveryLineage: lineage };
  writeFileSync(config.ledgerPath, JSON.stringify(ledger));
  return {
    ...config,
    originalAfterReports,
    longInputPrice: config.price,
    plan: {
      ...config.plan,
      phase: "recovery",
      model,
      pins: { ...pins, after: fixedHead },
      sourceHead: fixedHead,
      caseIds: recoveryCases[model],
      sharedHashes: fixedHashes,
      expectedSharedHashes: fixedHashes,
      recovery: {
        lineageSHA256: sealed(lineage).sha256,
        originalAfterReportHashes: lineage.originalAfterReportHashes,
      },
    },
    original,
    ledger,
  };
}

test.each(["claude-haiku-5-5", "claude-sonnet-5-5"] as const)(
  "recovery admits only the approved original failures for %s without relabelling old spend",
  async (model) => {
    const config = await recoveryOptions(model);
    const bytes = readFileSync(config.ledgerPath, "utf8");
    const guard = createAttributionPilotBudget(config);
    expect(guard.stopped()).toBe(false);
    expect(guard.snapshot().pins).toEqual(pins);
    expect(guard.snapshot().sharedHashes).toEqual(hashes);
    expect(guard.snapshot().entries).toEqual(config.original.entries);
    expect(readFileSync(config.ledgerPath, "utf8")).toBe(bytes);
  },
);

function recoveryModel() {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: "Retained." }],
      warnings: [],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
    }),
  });
}

test.each([null, "T02-en", "C03-zh-CN"])(
  "recovery blocks setup or another case before provider: %s",
  async (caseId) => {
    const config = await recoveryOptions("claude-sonnet-5-5");
    const guard = createAttributionPilotBudget(config);
    const model = recoveryModel();
    const observed = observeAttribution(() => model, guard.hooks);
    observed.setCase(caseId);
    await expect(
      observed
        .factory({ kind: "anthropic", modelId: config.plan.model, apiKey: null, baseUrl: null })
        .doGenerate({ prompt: [], maxOutputTokens: 300 }),
    ).rejects.toThrow("recovery-case");
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(guard.snapshot()).toMatchObject({
      chargedUSD: config.original.chargedUSD,
      stopKind: "recovery-case",
    });
    expect(guard.snapshot().entries).toEqual(config.original.entries);
  },
);

test("recovery appends its real source head once and preserves every original ledger field and charge", async () => {
  const config = await recoveryOptions();
  const guard = createAttributionPilotBudget(config);
  const model = recoveryModel();
  const observed = observeAttribution(() => model, guard.hooks);
  observed.setCase("N03-en");
  await observed
    .factory({ kind: "anthropic", modelId: config.plan.model, apiKey: null, baseUrl: null })
    .doGenerate({ prompt: [], maxOutputTokens: 300 });
  const saved = guard.snapshot();
  expect(saved.entries.slice(0, config.original.entries.length)).toEqual(config.original.entries);
  expect(saved.entries.at(-1)).toMatchObject({
    sourceHead: fixedHead,
    caseId: "N03-en",
    model: config.plan.model,
    status: "settled",
  });
  expect(saved.pins).toEqual(pins);
  expect(saved.sharedHashes).toEqual(hashes);
  expect(saved.chargedUSD).toBeGreaterThan(config.original.chargedUSD);
  expect(createAttributionPilotBudget(config).stopped()).toBe(true);
});

test.each([
  { arm: "before" as const },
  { caseIds: ["T02-en"] },
  { caseIds: ["C03-zh-CN"] },
  { caseIds: [...recoveryCases["claude-haiku-5-5"]].reverse() },
  { sourceHead: "4".repeat(40) },
  { capUSD: 3.76 },
  { recovery: undefined },
  { pins: { ...pins, after: fixedHead, before: "4".repeat(40) } },
  {
    sharedHashes: { ...fixedHashes, host: "4".repeat(64) },
    expectedSharedHashes: { ...fixedHashes, host: "4".repeat(64) },
  },
])("recovery cannot escape its declared cases/source/cap: %j", async (change) => {
  const config = await recoveryOptions();
  expect(() =>
    createAttributionPilotBudget({ ...config, plan: { ...config.plan, ...change } }),
  ).toThrow();
});

test.each(["cleared", "unknown", "relabeled"] as const)(
  "recovery refuses %s old history without changing its bytes",
  async (mutation) => {
    const config = await recoveryOptions();
    const damaged =
      mutation === "cleared"
        ? { ...config.ledger, entries: [], chargedUSD: 0 }
        : mutation === "unknown"
          ? {
              ...config.ledger,
              entries: config.ledger.entries.map((entry) => ({ ...entry, status: "unknown" })),
            }
          : { ...config.ledger, pins: config.plan.pins, sharedHashes: fixedHashes };
    const bytes = JSON.stringify(damaged);
    writeFileSync(config.ledgerPath, bytes);
    expect(() => createAttributionPilotBudget(config)).toThrow();
    expect(readFileSync(config.ledgerPath, "utf8")).toBe(bytes);
  },
);

test("recovery never creates a substitute ledger", async () => {
  const config = await recoveryOptions();
  const missing = join(await createTempDataFolder(), "missing.json");
  expect(() => createAttributionPilotBudget({ ...config, ledgerPath: missing })).toThrow(
    "original full ledger",
  );
  expect(() => readFileSync(missing)).toThrow();
});

test.each([2.8, 2.81])("recovery uses the same settled stop at %s", async (spend) => {
  const config = await recoveryOptions("claude-sonnet-5-5", spend);
  const guard = createAttributionPilotBudget(config);
  const model = recoveryModel();
  const observed = observeAttribution(() => model, guard.hooks);
  observed.setCase("S02-en");
  const call = observed
    .factory({ kind: "anthropic", modelId: config.plan.model, apiKey: null, baseUrl: null })
    .doGenerate({ prompt: [], maxOutputTokens: 300 });
  if (spend > 2.8) {
    await expect(call).rejects.toThrow("settled-spend");
    expect(model.doGenerateCalls).toHaveLength(0);
  } else {
    await call;
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(guard.stopped()).toBe(false);
  }
});

test.each(["malformed", "successful", "unknown-usage", "wrong-ledger-fixture"] as const)(
  "recovery rechecks original reports rather than trusting stale scores: %s",
  async (mutation) => {
    const config = await recoveryOptions();
    const report = originalFullReport("claude-haiku-5-5");
    if (mutation === "successful") {
      const row = report.rows.find((row) => row.id === "N03-en");
      if (!row || row.result.verdict === "not-checked") throw new Error("Missing original result.");
      const result = row.result;
      row.result = resultFromParts(
        result.parts?.map((part) => partWithResult(part, { ...result, verdict: "unsupported" })) ??
          [],
      );
    }
    const changed =
      mutation === "wrong-ledger-fixture"
        ? { ...report, ledger: { ...report.ledger, fixtureSHA256: "0".repeat(64) } }
        : mutation === "malformed"
          ? { ...report, rows: report.rows.slice(1) }
          : mutation === "unknown-usage"
            ? {
                ...report,
                ledger: {
                  ...report.ledger,
                  entries: report.ledger.entries.map((entry) => ({
                    ...entry,
                    usage: { ...entry.usage, input: undefined },
                  })),
                },
              }
            : report;
    const reports = [sealed(changed), sealed(originalFullReport("claude-sonnet-5-5"))];
    const lineage = {
      ...config.ledger.recoveryLineage,
      originalAfterReportHashes: reports.map((report) => report.sha256),
    };
    writeFileSync(
      config.ledgerPath,
      JSON.stringify({ ...config.ledger, recoveryLineage: lineage }),
    );
    expect(() =>
      createAttributionPilotBudget({
        ...config,
        originalAfterReports: reports,
        plan: {
          ...config.plan,
          recovery: {
            lineageSHA256: sealed(lineage).sha256,
            originalAfterReportHashes: lineage.originalAfterReportHashes,
          },
        },
      }),
    ).toThrow();
  },
);

test("an unknown recovery request retains its new hold and all original charges on reopen", async () => {
  const config = await recoveryOptions();
  const guard = createAttributionPilotBudget(config);
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: "Incomplete billing." }],
      finishReason: { unified: "stop", raw: undefined },
      warnings: [],
      usage: {
        inputTokens: {
          total: undefined,
          noCache: undefined,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: undefined, text: undefined, reasoning: undefined },
      },
    }),
  });
  const observed = observeAttribution(() => model, guard.hooks);
  observed.setCase("N03-en");
  await observed
    .factory({ kind: "anthropic", modelId: config.plan.model, apiKey: null, baseUrl: null })
    .doGenerate({ prompt: [], maxOutputTokens: 300 });
  const saved = guard.snapshot();
  expect(saved.entries.slice(0, config.original.entries.length)).toEqual(config.original.entries);
  expect(saved.entries.at(-1)?.status).toBe("unknown");
  expect(saved.chargedUSD).toBeGreaterThan(config.original.chargedUSD);
  const bytes = readFileSync(config.ledgerPath, "utf8");
  expect(createAttributionPilotBudget(config).stopped()).toBe(true);
  expect(readFileSync(config.ledgerPath, "utf8")).toBe(bytes);
});
