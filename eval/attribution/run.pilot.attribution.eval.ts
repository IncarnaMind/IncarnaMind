import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { createAiSdkChatModel } from "../../src/core";
import { catalogFacts } from "../../src/core/providers/catalog";
import type { Price } from "../../src/core/providers/catalog/types";
import { type AttributionDryRow, runAttributionCases } from "./adapter";
import {
  ATTRIBUTION_FULL_CASES,
  ATTRIBUTION_PILOT_CASES,
  ATTRIBUTION_PILOT_MODELS,
  ATTRIBUTION_RECOVERY_CASES,
  type AttributionPilotPlan,
  attributionPilotJSON,
  createAttributionPilotBudget,
  validateAttributionPilot,
} from "./pilot";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
function reportRefs(value: unknown) {
  const refs: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(refs) || refs.length !== 2)
    throw new Error("Two hashed report paths are required.");
  return refs.map((ref: unknown) => {
    if (
      typeof ref !== "object" ||
      ref === null ||
      !("path" in ref) ||
      typeof ref.path !== "string" ||
      ref.path === "" ||
      !("sha256" in ref) ||
      typeof ref.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(ref.sha256)
    )
      throw new Error("Two hashed report paths are required.");
    return { bytes: readFileSync(ref.path, "utf8"), sha256: ref.sha256 };
  });
}
function priceOf(value: unknown): Price {
  if (
    typeof value !== "object" ||
    value === null ||
    !("currency" in value) ||
    value.currency !== "USD" ||
    !("input" in value) ||
    typeof value.input !== "number" ||
    !("output" in value) ||
    typeof value.output !== "number" ||
    !("cacheRead" in value) ||
    typeof value.cacheRead !== "number" ||
    ![value.input, value.output, value.cacheRead].every(
      (number) => Number.isFinite(number) && number >= 0,
    )
  )
    throw new Error("A complete frozen USD pilot rate snapshot is required.");
  return { currency: "USD", input: value.input, output: value.output, cacheRead: value.cacheRead };
}

test.skipIf(!process.env.INCARNAMIND_ATTRIBUTION_PHASE)(
  "explicitly funded attribution measurement",
  async () => {
    const root = resolve(__dirname, "../..");
    const phase = process.env.INCARNAMIND_ATTRIBUTION_PHASE ?? "dry";
    let recovery: { lineageSHA256: string; originalAfterReports: unknown } | undefined;
    if (phase === "recovery") {
      try {
        recovery = JSON.parse(process.env.INCARNAMIND_ATTRIBUTION_RECOVERY ?? "null");
        if (
          !recovery ||
          typeof recovery.lineageSHA256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(recovery.lineageSHA256)
        )
          throw new Error();
      } catch {
        throw new Error("The frozen recovery lineage is required.");
      }
    }
    const originalAfterReports = recovery ? reportRefs(recovery.originalAfterReports) : [];
    const pilotReceipts =
      phase === "full" || phase === "recovery"
        ? reportRefs(process.env.INCARNAMIND_ATTRIBUTION_PILOT_RECEIPTS ?? "null")
        : [];
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    const model = ATTRIBUTION_PILOT_MODELS.find(
      (id) => id === process.env.INCARNAMIND_ATTRIBUTION_MODEL,
    );
    if (!model) throw new Error("Select an approved attribution pilot model explicitly.");
    const arm = process.env.INCARNAMIND_ATTRIBUTION_ARM;
    if (arm !== "before" && arm !== "after") throw new Error("Select the source arm explicitly.");
    const fixtureSHA256 = sha256(readFileSync(join(root, "eval/attribution/cases.json"), "utf8"));
    const sourceChanges =
      git(
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        "src",
        "tests/helpers",
        "vitest.config.ts",
      ) + git("diff", "HEAD", "--", "src", "tests/helpers", "vitest.config.ts");
    const plan: AttributionPilotPlan = {
      phase,
      arm,
      model,
      capUSD: Number(process.env.INCARNAMIND_ATTRIBUTION_CAP_USD ?? "NaN"),
      pins: {
        before: process.env.INCARNAMIND_ATTRIBUTION_BEFORE_HEAD ?? "",
        after: process.env.INCARNAMIND_ATTRIBUTION_AFTER_HEAD ?? "",
      },
      sourceHead: git("rev-parse", "HEAD").trim(),
      sourceDiffSHA256: sha256(sourceChanges),
      fixtureSHA256,
      caseIds:
        phase === "recovery"
          ? ATTRIBUTION_RECOVERY_CASES[model]
          : phase === "full"
            ? ATTRIBUTION_FULL_CASES
            : ATTRIBUTION_PILOT_CASES,
      ...(recovery && {
        recovery: {
          lineageSHA256: recovery.lineageSHA256,
          originalAfterReportHashes: originalAfterReports.map((report) => report.sha256),
        },
      }),
      ...((phase === "full" || phase === "recovery") && {
        pilotReceiptHashes: pilotReceipts.map((receipt) => receipt.sha256),
      }),
      sharedHashes: {
        adapter: sha256(readFileSync(join(root, "eval/attribution/adapter.ts"), "utf8")),
        scorer: sha256(readFileSync(join(root, "eval/attribution/scoring.ts"), "utf8")),
        host: sha256(readFileSync(join(root, "eval/attribution/pilot.ts"), "utf8")),
        entry: sha256(
          readFileSync(join(root, "eval/attribution/run.pilot.attribution.eval.ts"), "utf8"),
        ),
      },
      expectedSharedHashes: {
        adapter: process.env.INCARNAMIND_ATTRIBUTION_ADAPTER_SHA256 ?? "",
        scorer: process.env.INCARNAMIND_ATTRIBUTION_SCORER_SHA256 ?? "",
        host: process.env.INCARNAMIND_ATTRIBUTION_HOST_SHA256 ?? "",
        entry: process.env.INCARNAMIND_ATTRIBUTION_ENTRY_SHA256 ?? "",
      },
    };
    validateAttributionPilot(plan);
    const ratesPath = process.env.INCARNAMIND_ATTRIBUTION_RATES;
    const ledgerPath = process.env.INCARNAMIND_ATTRIBUTION_LEDGER;
    if (!ratesPath || !ledgerPath)
      throw new Error("The frozen rate snapshot and shared pilot ledger path are required.");
    const ratesBytes = readFileSync(ratesPath, "utf8");
    if (sha256(ratesBytes) !== process.env.INCARNAMIND_ATTRIBUTION_RATES_SHA256)
      throw new Error("The pilot rate snapshot changed.");
    const rates: unknown = JSON.parse(ratesBytes);
    if (
      typeof rates !== "object" ||
      rates === null ||
      !("model" in rates) ||
      rates.model !== model ||
      !("price" in rates) ||
      !("reservationPrice" in rates)
    )
      throw new Error("The pilot rate snapshot has the wrong model or shape.");
    if (!("cacheWritePolicy" in rates) || rates.cacheWritePolicy !== "5m")
      throw new Error("The pilot snapshot must establish five-minute cache billing.");
    const facts = catalogFacts("anthropic", model);
    if (!facts?.maxOutput) throw new Error("The model's documented output limit is unavailable.");
    const budget = createAttributionPilotBudget({
      plan,
      pilotReceipts,
      originalAfterReports,
      ledgerPath,
      price: priceOf(rates.price),
      reservationPrice: priceOf(rates.reservationPrice),
      ...("longInputPrice" in rates ? { longInputPrice: priceOf(rates.longInputPrice) } : {}),
      defaultOutputTokens: facts.maxOutput,
      cacheWritePolicy:
        "cacheWritePolicy" in rates && rates.cacheWritePolicy === "5m" ? "5m" : "unknown",
    });
    if (budget.stopped()) throw new Error("The pilot has unresolved exposure and cannot resume.");
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("The authorized Anthropic test credential was not injected.");
    const encode = (value: unknown) => attributionPilotJSON(value, key);
    const directory = join(
      root,
      "test-results/attribution-eval",
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${arm}-${model}-${phase}`,
    );
    mkdirSync(directory, { recursive: true });
    const manifest = {
      ...plan,
      adapterSHA256: sha256(readFileSync(join(root, "eval/attribution/adapter.ts"), "utf8")),
      pilotHostSHA256: sha256(readFileSync(join(root, "eval/attribution/pilot.ts"), "utf8")),
      scorerSHA256: sha256(readFileSync(join(root, "eval/attribution/scoring.ts"), "utf8")),
      ratesSHA256: sha256(ratesBytes),
      outputPolicy:
        "defined app limits retained; only undefined limits made explicit at the proven128000 app/SDK default",
      defaultOutputTokens: facts.maxOutput,
    };
    writeFileSync(join(directory, "manifest.json"), `${encode(manifest)}\n`);
    const rows = new Map<string, AttributionDryRow>(
      plan.caseIds.map((id) => [
        id,
        {
          id,
          language: id.endsWith("zh-CN") ? "zh-CN" : "en",
          status: "not-executed",
          result: null,
          ms: 0,
          requests: [],
          error: null,
        },
      ]),
    );
    let completed = false;
    try {
      const result = await runAttributionCases({
        arm,
        mode: phase === "pilot" ? "pilot" : "full",
        model,
        provider: { kind: "anthropic", modelId: model, apiKey: key },
        createChatModel: (spec) => {
          if (spec.kind !== "anthropic" || spec.modelId !== model)
            throw new Error("The pilot attempted an unapproved provider or model.");
          return createAiSdkChatModel(spec);
        },
        caseIds: plan.caseIds,
        hooks: {
          prepare: budget.hooks.prepare,
          before(request, params) {
            budget.hooks.before?.(request, params);
            appendFileSync(
              join(directory, "requests.jsonl"),
              `${encode({ event: "admitted", request })}\n`,
            );
          },
          failed(error) {
            budget.hooks.failed?.(error);
          },
          settled(request) {
            budget.hooks.settled?.(request);
            appendFileSync(
              join(directory, "requests.jsonl"),
              `${encode({ event: "settled", request })}\n`,
            );
          },
        },
        stopped: budget.stopped,
        onCase: async (row) => {
          rows.set(row.id, row);
          appendFileSync(join(directory, "outcomes.jsonl"), `${encode(row)}\n`);
        },
      });
      writeFileSync(
        join(directory, "report.json"),
        `${encode({ ...result, manifest, ledger: budget.snapshot(), stopReason: budget.stopReason(), invoiceConfirmedUSD: null })}\n`,
      );
      completed = result.rows.every((row) => row.status !== "not-executed") && !budget.stopped();
    } catch {
      throw new Error("The attribution pilot stopped; inspect its retained receipts.");
    } finally {
      writeFileSync(
        join(directory, "receipt.json"),
        `${encode({ manifest, completed, rows: [...rows.values()], ledger: budget.snapshot(), stopReason: budget.stopReason(), invoiceConfirmedUSD: null })}\n`,
      );
    }
    if (!completed)
      throw new Error(
        "The attribution pilot is incomplete; unstarted cases and exposure were retained.",
      );
  },
);
