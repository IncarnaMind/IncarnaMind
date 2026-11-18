/**
 * A sentence whose figure is one over a data file's rows is checked by working the figure out
 * again (#3282): the check's model runs code over the whole file, and its verdict rests on that
 * run. Through the core's public interface, with a scripted model and a stand-in for Python.
 */
import { expect, test } from "vitest";
import type { ClaimCheckResult } from "../../src/core";
import { createFakeAnalysisRuntime, type FakeAnswer } from "../../src/core/analysis/fake";
import { ANALYSIS_TOOLS } from "../../src/core/tools";
import { isCheckRun } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";

const ORDERS = "Region,Month,Amount\nNorth,2026-01,120\nNorth,2026-02,150\nSouth,2026-01,80";
const CODE = 'result("north", inputs["orders"].query("Region == \'North\'")["Amount"].sum())';
const RIGHT = "North's orders came to 270 in 2026.";
const WRONG = "North's orders came to 350 in 2026.";
const total = (value: number): FakeAnswer => ({
  output: { results: [{ kind: "figure", name: "north", label: "North, 2026", unit: null, value }] },
});

/** Checks `claim` with a model that searches, runs `CODE` over the orders file `runs` times, then replies. */
async function checked(claim: string, reply: string, python: FakeAnswer | "none", runs = 1) {
  const calls: ModelCall[] = [];
  const model = scriptedModel(
    (call) => {
      if (!isCheckRun(call)) return { text: "" };
      calls.push(call);
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (searches.length === 0)
        return { calls: [{ tool: "search_documents", input: { query: "North orders 2026" } }] };
      const ran = call.results.filter((result) => result.tool === ANALYSIS_TOOLS.run).length;
      if (!call.tools.includes(ANALYSIS_TOOLS.run) || ran >= runs) return { text: reply };
      const [passage] = searches.flatMap((each) => shownPassages(each.text));
      const inputs = [{ name: "orders", passage: passage?.id }];
      return {
        calls: [{ tool: ANALYSIS_TOOLS.run, input: { title: "North, 2026", inputs, code: CODE } }],
      };
    },
    { generate: () => ({ text: "{}" }) },
  );
  const runtime =
    python === "none" ? undefined : createFakeAnalysisRuntime({ answer: () => python });
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
    ...(runtime && { analysisRuntime: runtime }),
  });
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-test",
    modelId: "claude-haiku-5-5",
  });
  if (saved.service) await core.allowDataFlow("checks", saved.service.id);
  const sources = await createTempDataFolder();
  await addAndProcess(core, [await writeSourceFile(sources, "Orders.csv", ORDERS)]);
  const result: ClaimCheckResult = await core.checkClaim({ claim });
  core.close();
  return { result, calls, jobs: runtime?.jobs ?? [] };
}

// protects=a sentence whose figure is over a data file's rows is Supported on a finished run with no quote: its evidence is the rows the code read, in the data file, and the check keeps the code, the rows and the figure for its card; fails_when=such a verdict is Not checked for want of a quote, its evidence isn't the data file's rows, or the working is lost; no_claim=that a model writes the right code or compares rightly
test("a figure over a data file's rows is supported on the run that worked it out", async () => {
  const { result, jobs } = await checked(
    RIGHT,
    "Verdict: supported\nExplanation: The rows of Orders.csv give 270 for North in 2026.\nEvidence: []",
    total(270),
  );

  expect(result.verdict).toBe("supported");
  if (result.verdict !== "supported") return;
  expect(result.evidence).toMatchObject({
    documentName: "Orders",
    location: { kind: "rows", from: 1, to: 4 },
    check: "found",
  });
  expect(result.parts?.[0]?.working).toMatchObject({
    title: "North, 2026",
    code: CODE,
    rows: [{ count: 3, citation: { documentName: "Orders" } }],
  });
  expect(jobs).toHaveLength(1);
  expect(jobs[0]?.inputs[0]).toMatchObject({ kind: "table", name: "orders" });
});

// protects=a figure the rows don't give reads Contradicted on the run, with the value the rows give offered in the sentence's place; fails_when=it reads Supported or Not checked, or the correction is lost; no_claim=that a model compares rightly
test("a figure the rows don't give is contradicted, with the rows' own value", async () => {
  const { result } = await checked(
    WRONG,
    "Verdict: contradicted\nExplanation: The rows of Orders.csv give 270 for North in 2026, not 350.\nEvidence: []\nChange 1: 350\nTo 1: 270",
    total(270),
  );

  expect(result.verdict).toBe("contradicted");
  if (result.verdict !== "contradicted") return;
  expect(result.evidence?.documentName).toBe("Orders");
  expect(result.correction).toMatchObject({ from: "350", choices: [{ wording: "270" }] });
});

// protects=a working that never finished leaves the sentence Not checked with the reason and the data file's name, whatever verdict the model wrote, and never a ✓; fails_when=a failed, timed-out or unavailable run reads Supported, Contradicted or Unsupported; no_claim=the words of each reason
test.each([
  [{ end: { kind: "error", message: "KeyError: 'Amount'", line: 1 } }, "rows-run-failed"],
  [{ end: { kind: "timed-out", limitMs: 60_000 } }, "rows-run-timed-out"],
  [{ end: { kind: "unavailable", reason: "start", detail: "No sandbox." } }, "rows-unavailable"],
] as const)("a run that ends as %j leaves the sentence not checked", async (python, reason) => {
  for (const verdict of ["supported", "not found"]) {
    const { result } = await checked(
      RIGHT,
      `Verdict: ${verdict}\nExplanation: The rows give 270.\nEvidence: []`,
      python,
      2,
    );
    expect(result).toMatchObject({ verdict: "not-checked", reason, detail: "Orders" });
  }
});

// protects=a check is offered the Analysis Tool only where Python can run; without it the sentence is judged from the Passages as before; fails_when=the Tool is offered with no runtime; no_claim=which models are offered it (tests/core/calculateCapabilities.test.ts)
test("with no Python on this computer, a check offers no Analysis", async () => {
  const { result, calls } = await checked(
    RIGHT,
    "Verdict: not found\nExplanation: No Passage gives North's total.\nEvidence: []",
    "none",
  );

  expect(calls.some((call) => call.tools.includes(ANALYSIS_TOOLS.run))).toBe(false);
  expect(result).toMatchObject({ verdict: "unsupported", unsupported: { word: "not-found" } });
});
