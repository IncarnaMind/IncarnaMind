import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CoreBridge, MindCheckPlan, RunEstimate } from "../../src/core/api";

const bridge = vi.hoisted(() => ({
  planMindCheck: vi.fn<CoreBridge["planMindCheck"]>(),
  planContradictionCheck: vi.fn<CoreBridge["planContradictionCheck"]>(),
  estimateRun: vi.fn<CoreBridge["estimateRun"]>(),
  checkMind: vi.fn<CoreBridge["checkMind"]>(),
  checkContradictions: vi.fn<CoreBridge["checkContradictions"]>(),
  checkSentences: vi.fn<CoreBridge["checkSentences"]>(),
  findMindClaims: vi.fn<CoreBridge["findMindClaims"]>(),
  holdMindCheck: vi.fn<CoreBridge["holdMindCheck"]>(),
  cancelCheck: vi.fn<CoreBridge["cancelCheck"]>(),
}));
const running = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const rewriting = vi.hoisted(() => ({ current: {} as Record<string, string> }));
const { noteBusy } = vi.hoisted(() => ({ noteBusy: vi.fn() }));
vi.mock("../../src/renderer/src/editWithAi", () => ({ noteBusy }));
vi.mock("../../src/renderer/src/core", () => ({ core: bridge }));
const store = vi.hoisted(() => ({ language: "en" as "en" | "zh-CN" }));
vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: {
    getState: () => ({ openMind: async () => {}, settings: { language: store.language } }),
  },
}));
vi.mock("../../src/renderer/src/checks", () => ({
  withCheckAll: (problem: { kind: string; chosen?: unknown }, checkAll: () => void) =>
    problem.kind === "no-documents" && problem.chosen ? { ...problem, checkAll } : problem,
  useChecks: { getState: () => ({ running: running.current, rewriting: rewriting.current }) },
  dismissCheckProblem: vi.fn(),
  setCheckCardOpen: vi.fn(),
  setCheckProblem: vi.fn(),
  setCheckRunning: vi.fn(),
  setCheckSmallModel: vi.fn(),
}));

vi.mock("../../src/renderer/src/layoutSlice", () => ({
  frontTabOfMind: () => ({ id: "tab" }),
  groupsMerged: () => false,
}));

// A Note is open, with one sentence to check that cites a Document: the contradiction watch has work.
const editor = { isDestroyed: false, state: {} };
vi.mock("../../src/renderer/src/editor/openEditors", () => ({
  mindEditor: () => editor,
  whenMindEditor: async () => editor,
}));
vi.mock("../../src/renderer/src/editor/proposalReview", () => ({
  editorDoc: () => ({ getMap: () => new Map() }),
}));
vi.mock("../../src/renderer/src/editor/healthCounts", () => ({
  sentencesToCheck: () => [
    {
      from: 1,
      to: 9,
      text: "A cited claim.",
      claim: null,
      citations: [{ attributes: {}, at: 3, pos: 9 }],
      blockId: "block-1",
      inTable: false,
      state: { kind: "to-check", fresh: true, why: "none" },
    },
  ],
}));
vi.mock("../../src/renderer/src/editor/opinionLocations", () => ({
  opinionSentenceRanges: () => [],
}));
vi.mock("../../src/renderer/src/editor/editSelection", () => ({
  selectionForEdit: () => ({
    from: { blockId: "block-1", offset: 0 },
    to: { blockId: "block-1", offset: 8 },
    text: "A cited claim.",
    range: { from: 1, to: 9 },
  }),
}));
vi.mock("../../src/renderer/src/modelInUse", () => ({ modelInUseOf: () => null }));

// The Note's last full watch, as the renderer reads it: a clean one unless a test says otherwise.
const watchRecord = vi.hoisted(() => ({
  current: null as null | { stop: { reason: string; resetsAt: string | null } | null },
}));
vi.mock("../../src/shared/contradictionWatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/contradictionWatch")>()),
  contradictionWatchOf: () => watchRecord.current,
}));

const plan: MindCheckPlan = {
  kind: "ready",
  sentences: 1,
  findsClaims: false,
  inFolder: true,
  model: null,
};
const estimate: RunEstimate = {
  billing: "per-token",
  calls: 2,
  tokens: 1000,
  cost: { amount: 1.4, currency: "USD" },
  cap: null,
  spentTowardCap: null,
  setAsideTowardCap: null,
};

/** A spending cap makes the price line show, so a Check that is not the card's one press asks. */
const askByCap = () =>
  bridge.estimateRun.mockResolvedValue({
    ...estimate,
    cap: { amount: 20, currency: "USD" },
    spentTowardCap: { amount: 1.25, currency: "USD" },
  });

/** A run below $1 with no cap: the ways in that are not the card's one press run at once. */
const belowThePrice = () =>
  bridge.estimateRun.mockResolvedValue({ ...estimate, cost: { amount: 0.4, currency: "USD" } });

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  bridge.planMindCheck.mockResolvedValue(plan);
  bridge.planContradictionCheck.mockResolvedValue({ kind: "no-folder" });
  bridge.estimateRun.mockResolvedValue(estimate);
  bridge.checkMind.mockResolvedValue({ kind: "cancelled" });
  bridge.holdMindCheck.mockResolvedValue(true);
  bridge.cancelCheck.mockResolvedValue(undefined);
  bridge.checkContradictions.mockResolvedValue({ kind: "cancelled" });
  watchRecord.current = { stop: null };
  running.current = {};
  store.language = "en";
  const { useMindCheck } = await import("../../src/renderer/src/mindCheck");
  useMindCheck.setState({ asking: {}, unchanged: {} });
});

describe("Asking before checking against Documents added since", () => {
  test.each([true, false])("the ask uses the planned scope (inFolder: %s)", async (inFolder) => {
    askByCap();
    bridge.planMindCheck.mockResolvedValue({ ...plan, inFolder });
    const { startMindCheck, useMindCheck, checkMind } = await import(
      "../../src/renderer/src/mindCheck"
    );
    await startMindCheck("mind", "added");
    expect(useMindCheck.getState().asking.mind).toMatchObject({ count: 1, inFolder });
    expect(bridge.checkMind).not.toHaveBeenCalled();
    await checkMind("mind", "added");
    expect(bridge.checkMind).toHaveBeenCalledOnce();
    expect(useMindCheck.getState().asking.mind).toBeUndefined();
  });

  test("a failed estimate still asks and sends no check until the User agrees", async () => {
    const error = new Error("Estimate unavailable");
    bridge.estimateRun.mockRejectedValue(error);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { startMindCheck, useMindCheck, checkMind } = await import(
      "../../src/renderer/src/mindCheck"
    );
    await startMindCheck("mind", "added");
    expect(useMindCheck.getState().asking.mind).toMatchObject({
      count: 1,
      estimate: null,
      unestimated: true,
    });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("mind"), error);
    expect(bridge.checkMind).not.toHaveBeenCalled();
    await checkMind("mind", "added");
    expect(bridge.checkMind).toHaveBeenCalledOnce();
  });

  test.each(["free", "plan"] as const)("a known %s model checks at once", async (billing) => {
    bridge.estimateRun.mockResolvedValue({ billing });
    const { startMindCheck, useMindCheck } = await import("../../src/renderer/src/mindCheck");
    await startMindCheck("mind", "added");
    expect(bridge.checkMind).toHaveBeenCalledOnce();
    expect(bridge.cancelCheck).toHaveBeenCalledOnce();
    expect(useMindCheck.getState().asking.mind).toBeUndefined();
  });
});

describe("Check this note", () => {
  test("asked for while a rewrite works in the Note, says the Note is busy and plans nothing", async () => {
    rewriting.current = { mind: "check-rent" };
    try {
      const { startMindCheck } = await import("../../src/renderer/src/mindCheck");
      expect(await startMindCheck("mind", "changed")).toEqual({ kind: "busy" });
      expect(noteBusy).toHaveBeenCalledWith("mind");
      expect(bridge.holdMindCheck).not.toHaveBeenCalled();
      expect(bridge.planMindCheck).not.toHaveBeenCalled();
    } finally {
      rewriting.current = {};
    }
  });

  const SINCE = "2026-10-02T14:20:00.000Z";
  const unchanged: MindCheckPlan = { kind: "unchanged", since: SINCE };

  test("a failed plan offers a retry that re-plans the same note", async () => {
    const error = new Error("The check could not be planned.");
    bridge.planMindCheck.mockRejectedValueOnce(error);
    const { startCheck } = await import("../../src/renderer/src/mindCheck");
    const { setCheckProblem } = await import("../../src/renderer/src/checks");
    await startCheck("mind");
    const problem = vi.mocked(setCheckProblem).mock.calls.at(-1)?.[1];
    if (problem?.kind !== "failed" || !problem.retry)
      throw new Error("A failed check has no retry.");
    problem.retry();
    await vi.waitFor(() => expect(bridge.checkMind).toHaveBeenCalledOnce());
    expect(bridge.planMindCheck.mock.calls).toEqual([
      ["mind", "changed", false],
      ["mind", "changed", false],
    ]);
  });

  test("a failed plan's retry asks, as the Check it was started through", async () => {
    const error = new Error("The check could not be planned.");
    bridge.planMindCheck.mockRejectedValueOnce(error);
    const { startMindCheck, useMindCheck } = await import("../../src/renderer/src/mindCheck");
    const { setCheckProblem } = await import("../../src/renderer/src/checks");
    await startMindCheck("mind", "all");
    const problem = vi.mocked(setCheckProblem).mock.calls.at(-1)?.[1];
    if (problem?.kind !== "failed" || !problem.retry)
      throw new Error("A failed check has no retry.");
    problem.retry();
    await vi.waitFor(() => expect(useMindCheck.getState().asking.mind).toBeDefined());
    expect(bridge.checkMind).not.toHaveBeenCalled();
  });

  test("Check all Documents re-plans and asks, as the Check it was started through", async () => {
    const noDocuments: MindCheckPlan = {
      kind: "no-documents",
      folderId: "folder",
      chosen: {
        scope: { folderIds: ["folder"], tagIds: [], documentIds: [] },
        onlyLeftOut: false,
      },
    };
    bridge.planMindCheck.mockResolvedValueOnce(noDocuments);
    const { startMindCheck, useMindCheck } = await import("../../src/renderer/src/mindCheck");
    const { setCheckProblem } = await import("../../src/renderer/src/checks");
    await startMindCheck("mind", "all");
    const problem = vi.mocked(setCheckProblem).mock.calls.at(-1)?.[1];
    if (problem?.kind !== "no-documents" || !problem.checkAll)
      throw new Error("A Check with no Documents offers no check of all of them.");
    problem.checkAll();
    await vi.waitFor(() => expect(useMindCheck.getState().asking.mind).toBeDefined());
    expect(bridge.planMindCheck).toHaveBeenLastCalledWith("mind", "all", true);
    expect(bridge.checkMind).not.toHaveBeenCalled();
  });

  // protects=#2313: widening to all Documents is a new run, so it re-plans and asks when its price is over the line; fails_when=it spends across all Documents unpriced; no_claim=the below-the-line case.
  test("the one Check's Check all Documents re-plans and asks under the cap", async () => {
    const noDocuments: MindCheckPlan = {
      kind: "no-documents",
      folderId: "folder",
      chosen: {
        scope: { folderIds: ["folder"], tagIds: [], documentIds: [] },
        onlyLeftOut: false,
      },
    };
    bridge.planMindCheck.mockResolvedValueOnce(noDocuments);
    const { startCheck, useMindCheck } = await import("../../src/renderer/src/mindCheck");
    const { setCheckProblem } = await import("../../src/renderer/src/checks");
    await startCheck("mind");
    const problem = vi.mocked(setCheckProblem).mock.calls.at(-1)?.[1];
    if (problem?.kind !== "no-documents" || !problem.checkAll)
      throw new Error("A Check with no Documents offers no check of all of them.");
    problem.checkAll();
    await vi.waitFor(() => expect(useMindCheck.getState().asking.mind).toBeDefined());
    expect(bridge.planMindCheck).toHaveBeenLastCalledWith("mind", "changed", true);
    expect(bridge.checkMind).not.toHaveBeenCalled();
  });

  // protects=#2313: the same widening under the line runs at once; fails_when=it asks for a run too cheap to price; no_claim=the asking case above.
  test("the one Check's Check all Documents runs at once below the line", async () => {
    const noDocuments: MindCheckPlan = {
      kind: "no-documents",
      folderId: "folder",
      chosen: {
        scope: { folderIds: ["folder"], tagIds: [], documentIds: [] },
        onlyLeftOut: false,
      },
    };
    bridge.planMindCheck.mockResolvedValueOnce(noDocuments);
    belowThePrice();
    const { startCheck } = await import("../../src/renderer/src/mindCheck");
    const { setCheckProblem } = await import("../../src/renderer/src/checks");
    await startCheck("mind");
    const problem = vi.mocked(setCheckProblem).mock.calls.at(-1)?.[1];
    if (problem?.kind !== "no-documents" || !problem.checkAll)
      throw new Error("A Check with no Documents offers no check of all of them.");
    problem.checkAll();
    await vi.waitFor(() => expect(bridge.checkMind).toHaveBeenCalledOnce());
    expect(bridge.checkMind.mock.calls[0]?.[0]).toMatchObject({
      mindId: "mind",
      mode: "changed",
      allDocuments: true,
    });
  });

  // protects=#2313: a run whose chosen scope held nothing offers Check all Documents that re-plans and asks; fails_when=it runs across all Documents from the old result; no_claim=the plan-time case above.
  test("a run whose chosen scope held nothing re-plans and asks when widened", async () => {
    bridge.checkMind.mockResolvedValueOnce({
      kind: "no-documents",
      folderId: "folder",
      chosen: {
        scope: { folderIds: ["folder"], tagIds: [], documentIds: [] },
        onlyLeftOut: false,
      },
    });
    const { startCheck, useMindCheck } = await import("../../src/renderer/src/mindCheck");
    const { setCheckProblem } = await import("../../src/renderer/src/checks");
    await startCheck("mind");
    expect(bridge.checkMind).toHaveBeenCalledOnce();
    const problem = vi.mocked(setCheckProblem).mock.calls.at(-1)?.[1];
    if (problem?.kind !== "no-documents" || !problem.checkAll)
      throw new Error("A run with no Documents offers no check of all of them.");
    problem.checkAll();
    await vi.waitFor(() => expect(useMindCheck.getState().asking.mind).toBeDefined());
    expect(bridge.planMindCheck).toHaveBeenLastCalledWith("mind", "changed", true);
    expect(bridge.checkMind).toHaveBeenCalledOnce();
  });

  test("a whole-Note check whose model failed retries at once, without asking or planning", async () => {
    bridge.checkMind.mockResolvedValueOnce({
      kind: "failed",
      error: { kind: "provider", message: "Overloaded" },
    });
    const { checkMind, useMindCheck } = await import("../../src/renderer/src/mindCheck");
    const { setCheckProblem } = await import("../../src/renderer/src/checks");
    await checkMind("mind", "all");
    const problem = vi.mocked(setCheckProblem).mock.calls.at(-1)?.[1];
    if (problem?.kind !== "find-failed") throw new Error("No failure to retry.");
    problem.retry();
    await vi.waitFor(() => expect(bridge.checkMind).toHaveBeenCalledTimes(2));
    expect(bridge.planMindCheck).not.toHaveBeenCalled();
    expect(useMindCheck.getState().asking.mind).toBeUndefined();
  });

  test("a failed check retries its existing mode and scope", async () => {
    bridge.checkMind.mockRejectedValueOnce(new Error("The check stopped."));
    const { checkMind } = await import("../../src/renderer/src/mindCheck");
    const { setCheckProblem } = await import("../../src/renderer/src/checks");
    await checkMind("mind", "all", { allDocuments: true });
    const problem = vi.mocked(setCheckProblem).mock.calls.at(-1)?.[1];
    if (problem?.kind !== "failed" || !problem.retry)
      throw new Error("A failed check has no retry.");
    problem.retry();
    await vi.waitFor(() => expect(bridge.checkMind).toHaveBeenCalledTimes(2));
    expect(bridge.checkMind.mock.calls[1]?.[0]).toMatchObject({
      mindId: "mind",
      mode: "all",
      allDocuments: true,
    });
  });

  test("a failed check of chosen figures retries those figures, never the whole note", async () => {
    bridge.checkMind.mockRejectedValueOnce(new Error("The check stopped."));
    const { checkMind } = await import("../../src/renderer/src/mindCheck");
    const { setCheckProblem } = await import("../../src/renderer/src/checks");
    await checkMind("mind", "all", { figureIds: ["f1", "f2"] });
    const problem = vi.mocked(setCheckProblem).mock.calls.at(-1)?.[1];
    if (problem?.kind !== "failed" || !problem.retry)
      throw new Error("A failed check has no retry.");
    problem.retry();
    await vi.waitFor(() => expect(bridge.checkMind).toHaveBeenCalledTimes(2));
    expect(bridge.checkMind.mock.calls[1]?.[0]).toMatchObject({
      mindId: "mind",
      mode: "all",
      figureIds: ["f1", "f2"],
    });
  });

  test("a check of chosen figures whose model fails retries those figures without planning the note", async () => {
    bridge.checkMind.mockResolvedValueOnce({
      kind: "failed",
      error: { kind: "provider", message: "Overloaded" },
    });
    const { checkMind } = await import("../../src/renderer/src/mindCheck");
    const { setCheckProblem } = await import("../../src/renderer/src/checks");
    await checkMind("mind", "all", { figureIds: ["f1"] });
    const problem = vi.mocked(setCheckProblem).mock.calls.at(-1)?.[1];
    if (problem?.kind !== "find-failed") throw new Error("No failure to retry.");
    problem.retry();
    await vi.waitFor(() => expect(bridge.checkMind).toHaveBeenCalledTimes(2));
    expect(bridge.checkMind.mock.calls[1]?.[0]).toMatchObject({ figureIds: ["f1"] });
    expect(bridge.planMindCheck).not.toHaveBeenCalled();
  });

  test("when nothing changed it asks no model and opens the card on the line that says so", async () => {
    bridge.planMindCheck.mockResolvedValue(unchanged);
    const { startCheck, useMindCheck } = await import("../../src/renderer/src/mindCheck");
    const { setCheckCardOpen, setCheckProblem, setCheckRunning } = await import(
      "../../src/renderer/src/checks"
    );
    await startCheck("mind");
    expect(bridge.planMindCheck.mock.calls).toEqual([
      ["mind", "changed", false],
      ["mind", "added", false],
    ]);
    expect(bridge.findMindClaims).not.toHaveBeenCalled();
    expect(bridge.estimateRun).not.toHaveBeenCalled();
    expect(bridge.checkMind).not.toHaveBeenCalled();
    expect(bridge.checkSentences).not.toHaveBeenCalled();
    expect(setCheckRunning).not.toHaveBeenCalled();
    expect(setCheckProblem).not.toHaveBeenCalled();
    expect(useMindCheck.getState().unchanged.mind).toBe(true);
    expect(setCheckCardOpen).toHaveBeenCalledWith("tab", true);
    expect(bridge.cancelCheck).toHaveBeenCalledOnce();
  });

  test("with nothing changed but Documents added since, it checks those instead of saying nothing changed", async () => {
    bridge.planMindCheck.mockImplementation(async (_mind, mode) =>
      mode === "changed" ? unchanged : plan,
    );
    const { startCheck, useMindCheck } = await import("../../src/renderer/src/mindCheck");
    await startCheck("mind");
    expect(useMindCheck.getState().unchanged.mind).toBeUndefined();
    expect(bridge.checkMind).toHaveBeenCalledWith(expect.objectContaining({ mode: "added" }));
    expect(useMindCheck.getState().asking.mind).toBeUndefined();
  });

  test("what changed is checked as before, and the line goes", async () => {
    const { startCheck, useMindCheck } = await import("../../src/renderer/src/mindCheck");
    useMindCheck.setState({ unchanged: { mind: true } });
    await startCheck("mind");
    expect(bridge.planMindCheck.mock.calls).toEqual([["mind", "changed", false]]);
    expect(bridge.checkMind).toHaveBeenCalledWith(expect.objectContaining({ mode: "changed" }));
    expect(useMindCheck.getState().unchanged.mind).toBeUndefined();
    expect(bridge.cancelCheck).toHaveBeenCalledOnce();
  });

  test("a Note with no claim says so, not that nothing changed", async () => {
    bridge.planMindCheck.mockResolvedValue({ kind: "nothing" });
    const { startCheck, useMindCheck } = await import("../../src/renderer/src/mindCheck");
    const { setCheckProblem } = await import("../../src/renderer/src/checks");
    await startCheck("mind");
    expect(setCheckProblem).toHaveBeenCalledWith("mind", { kind: "no-claims" });
    expect(useMindCheck.getState().unchanged.mind).toBeUndefined();
    expect(bridge.checkMind).not.toHaveBeenCalled();
  });

  test("the card's price line prices the sentence and the cited sentence the watch adds", async () => {
    bridge.planMindCheck.mockResolvedValue({ ...plan, sentences: 1, findsClaims: true });
    bridge.planContradictionCheck.mockResolvedValue({ kind: "ready", claims: 4, model: null });
    const { checkEstimate, planCheckThisMind } = await import("../../src/renderer/src/mindCheck");
    const estimate = await checkEstimate("mind", await planCheckThisMind("mind"));
    expect(bridge.estimateRun).toHaveBeenCalledWith({ items: 2, each: "check" });
    expect(estimate.kind === "price" ? estimate.line.title : "").toContain("About $1.40");
  });

  test("when the last full watch was complete, a small run of what changed watches only its own cited sentence", async () => {
    bridge.planMindCheck.mockResolvedValue({ ...plan, sentences: 1 });
    bridge.planContradictionCheck.mockResolvedValue({ kind: "ready", claims: 4, model: null });
    bridge.checkMind.mockResolvedValue({
      kind: "checked",
      sentences: 1,
      checked: 1,
      smallModel: false,
      stop: null,
    });
    const { startCheck, useMindCheck } = await import("../../src/renderer/src/mindCheck");
    await startCheck("mind");
    expect(useMindCheck.getState().asking.mind).toBeUndefined();
    expect(bridge.checkMind).toHaveBeenCalledOnce();
    expect(bridge.checkSentences).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "contradiction-watch",
        from: { blockId: "block-1", offset: 0 },
        to: { blockId: "block-1", offset: 8 },
      }),
    );
    expect(bridge.checkContradictions).not.toHaveBeenCalled();
  });

  test("with no full watch recorded, the Check watches every cited sentence, as a check the User asked for does", async () => {
    watchRecord.current = null;
    bridge.planMindCheck.mockResolvedValue({ ...plan, sentences: 1 });
    bridge.planContradictionCheck.mockResolvedValue({ kind: "ready", claims: 4, model: null });
    bridge.checkMind.mockResolvedValue({
      kind: "checked",
      sentences: 1,
      checked: 1,
      smallModel: false,
      stop: null,
    });
    const { startCheck } = await import("../../src/renderer/src/mindCheck");
    await startCheck("mind");
    expect(bridge.checkMind).toHaveBeenCalledOnce();
    // Every cited sentence, through the run that writes the record, and none scoped.
    expect(bridge.checkContradictions).toHaveBeenCalledOnce();
    expect(bridge.checkSentences).not.toHaveBeenCalled();
  });

  test("when the last full watch stopped at the cap, the Check watches every cited sentence again", async () => {
    watchRecord.current = { stop: { reason: "cost-cap", resetsAt: null } };
    bridge.planMindCheck.mockResolvedValue({ ...plan, sentences: 1 });
    bridge.planContradictionCheck.mockResolvedValue({ kind: "ready", claims: 4, model: null });
    bridge.checkMind.mockResolvedValue({
      kind: "checked",
      sentences: 1,
      checked: 1,
      smallModel: false,
      stop: null,
    });
    const { startCheck } = await import("../../src/renderer/src/mindCheck");
    await startCheck("mind");
    expect(bridge.checkContradictions).toHaveBeenCalledOnce();
    expect(bridge.checkSentences).not.toHaveBeenCalled();
  });

  test("a model failure in the sentences stops the contradictions too", async () => {
    bridge.planMindCheck.mockResolvedValue({ ...plan, findsClaims: true });
    bridge.planContradictionCheck.mockResolvedValue({ kind: "ready", claims: 2, model: null });
    bridge.checkMind.mockResolvedValue({
      kind: "failed",
      error: { kind: "provider", message: "no" },
    });
    const { startCheck, confirmCheck } = await import("../../src/renderer/src/mindCheck");
    await startCheck("mind");
    await confirmCheck("mind");
    expect(bridge.checkMind).toHaveBeenCalledOnce();
    expect(bridge.checkSentences).not.toHaveBeenCalled();
  });

  test("a claims check that throws stops the contradictions too", async () => {
    bridge.planMindCheck.mockResolvedValue({ ...plan, findsClaims: true });
    bridge.planContradictionCheck.mockResolvedValue({ kind: "ready", claims: 2, model: null });
    bridge.checkMind.mockRejectedValue(new Error("no"));
    const { startCheck, confirmCheck } = await import("../../src/renderer/src/mindCheck");
    await startCheck("mind");
    await confirmCheck("mind");
    expect(bridge.checkMind).toHaveBeenCalledOnce();
    expect(bridge.checkSentences).not.toHaveBeenCalled();
  });

  test("a run stopped by the spending cap or a plan's limit stops the contradictions too", async () => {
    bridge.planMindCheck.mockResolvedValue({ ...plan, findsClaims: true });
    bridge.planContradictionCheck.mockResolvedValue({ kind: "ready", claims: 2, model: null });
    bridge.checkMind.mockResolvedValue({
      kind: "checked",
      sentences: 1,
      checked: 0,
      smallModel: false,
      stop: { reason: "cost-cap" },
    });
    const { startCheck, confirmCheck } = await import("../../src/renderer/src/mindCheck");
    await startCheck("mind");
    await confirmCheck("mind");
    expect(bridge.checkMind).toHaveBeenCalledOnce();
    expect(bridge.checkSentences).not.toHaveBeenCalled();
    expect(bridge.checkContradictions).not.toHaveBeenCalled();
  });
});

describe("A Check another window runs or plans", () => {
  test("a Note another window keeps is refused before this window plans", async () => {
    bridge.holdMindCheck.mockResolvedValue(false);
    const { startCheck } = await import("../../src/renderer/src/mindCheck");
    const { setCheckCardOpen, setCheckProblem } = await import("../../src/renderer/src/checks");

    expect(await startCheck("mind")).toEqual({ kind: "running" });
    expect(bridge.planMindCheck).not.toHaveBeenCalled();
    expect(bridge.checkMind).not.toHaveBeenCalled();
    expect(setCheckProblem).toHaveBeenCalledWith("mind", { kind: "running" });
    expect(setCheckCardOpen).toHaveBeenCalledWith("tab", true);
  });

  // protects=a Check pressed while a check runs in the Note, such as one of what the assistant wrote, opens the card that shows it with Stop (#2830); fails_when=the press does nothing the User can see, or starts a second run; no_claim=what the card shows.
  test("a Check pressed while the Note's check runs opens its card and starts nothing", async () => {
    running.current.mind = { requestId: "write", action: "whole-mind" };
    const { startCheckAsking } = await import("../../src/renderer/src/mindCheck");
    const { setCheckCardOpen } = await import("../../src/renderer/src/checks");

    expect(await startCheckAsking("mind")).toEqual({ kind: "running" });
    expect(setCheckCardOpen).toHaveBeenCalledWith("tab", true);
    expect(bridge.holdMindCheck).not.toHaveBeenCalled();
    expect(bridge.checkMind).not.toHaveBeenCalled();
  });

  test("the core's running result is handed back, so a window's card never says Done", async () => {
    bridge.checkMind.mockResolvedValue({ kind: "running" });
    const { startCheck } = await import("../../src/renderer/src/mindCheck");

    expect(await startCheck("mind")).toEqual({ kind: "running" });
    expect(bridge.holdMindCheck).toHaveBeenCalledOnce();
    expect(bridge.cancelCheck).toHaveBeenCalled();
  });

  // protects=a Check that finds this window already running one frees the Note and starts nothing; fails_when=its hold stays and every window says already checking; no_claim=what the other run was.
  test("a Check that finds a run already on frees its Note", async () => {
    bridge.planMindCheck.mockImplementation(async () => {
      running.current.mind = { requestId: "other", action: "whole-mind" };
      return plan;
    });
    const { startCheck } = await import("../../src/renderer/src/mindCheck");

    expect(await startCheck("mind")).toEqual({ kind: "running" });
    expect(bridge.cancelCheck).toHaveBeenCalled();
  });

  // protects=a core run that throws before taking the Note frees it, and the assistant's card is never Done; fails_when=the hold leaks or the card says Done; no_claim=what the core said.
  test("a Check whose core run throws frees its Note and is never Done", async () => {
    belowThePrice();
    bridge.checkMind.mockRejectedValue(new Error("The check couldn’t start."));
    const { checkFromAssistant, startCheck } = await import("../../src/renderer/src/mindCheck");

    await expect(startCheck("mind")).resolves.toMatchObject({ kind: "threw" });
    expect(bridge.cancelCheck).toHaveBeenCalled();
    await expect(checkFromAssistant("mind")).rejects.toThrow("The check couldn’t start.");
  });

  test("a question keeps the Note until the User answers: Check runs that request", async () => {
    askByCap();
    bridge.planMindCheck.mockResolvedValue({ ...plan, findsClaims: true });
    const { startMindCheck, confirmCheck, useMindCheck } = await import(
      "../../src/renderer/src/mindCheck"
    );

    expect(await startMindCheck("mind", "changed")).toMatchObject({ kind: "asked" });
    const asking = useMindCheck.getState().asking.mind;
    expect(asking?.requestId).toEqual(expect.any(String));
    expect(bridge.cancelCheck).not.toHaveBeenCalled();

    await confirmCheck("mind");
    expect(useMindCheck.getState().asking.mind).toBeUndefined();
    expect(bridge.checkMind).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: asking?.requestId }),
    );
  });

  // protects=the assistant's Check that asks says it waits for the User's OK on the Note, then its line follows the answer: Not now declines it, a click into the page keeps the same question, Check runs it to its result, and Esc, the badge's × or the Note closing close it, in English and Chinese (#2252); fails_when=the question changes before an answer, or an answer leaves it up; no_claim=what the run checks.
  test.each([
    {
      language: "en" as const,
      waiting: "The check starts when you confirm it on the note.",
      declined: "The check didn’t run: you chose Not now on the note.",
      closed: "The check didn’t run: the question on the note was closed.",
      estimate: ["About $1.40", "1K tokens", "$1.25 of $20.00 used this month"],
    },
    {
      language: "zh-CN" as const,
      waiting: "在笔记里确认后，核对才会开始。",
      declined: "核对未开始：你在笔记里选择了“暂不”。",
      closed: "核对未开始：笔记里的提问已关闭。",
      estimate: ["约 $1.40", "1000 token", "本月已用 $1.25，上限 $20.00"],
    },
  ])("the assistant's Check waits, then takes the answer ($language)", async (words) => {
    store.language = words.language;
    askByCap();
    bridge.planMindCheck.mockResolvedValue({ ...plan, findsClaims: true });
    const { cardClosed, checkFromAssistant, confirmCheck, dismissMindCheck, useMindCheck } =
      await import("../../src/renderer/src/mindCheck");
    const { translate } = await import("../../src/shared/i18n");
    expect(translate(words.language, "mindCheck.waitingForOk")).toBe(words.waiting);
    expect(translate(words.language, "mindCheck.declined")).toBe(words.declined);
    expect(translate(words.language, "mindCheck.closed")).toBe(words.closed);

    const declined = checkFromAssistant("mind", true, true);
    await vi.waitFor(() => expect(useMindCheck.getState().asking.mind).toBeDefined());
    expect(useMindCheck.getState().asking.mind?.estimate?.parts).toEqual(words.estimate);
    expect(bridge.checkMind).not.toHaveBeenCalled();
    dismissMindCheck("mind");
    await expect(declined).rejects.toMatchObject({ wording: { key: "mindCheck.declined" } });

    bridge.checkMind.mockResolvedValue({
      kind: "checked",
      sentences: 1,
      checked: 1,
      smallModel: false,
      stop: null,
    });
    const checked = checkFromAssistant("mind", true, true);
    await vi.waitFor(() => expect(useMindCheck.getState().asking.mind).toBeDefined());
    cardClosed("mind", "outside");
    expect(useMindCheck.getState().asking.mind?.estimate?.parts).toEqual(words.estimate);
    await confirmCheck("mind");
    await expect(checked).resolves.toBeUndefined();
    expect(bridge.checkMind).toHaveBeenCalledOnce();

    for (const how of ["escape", "toggle", "note"] as const) {
      const closed = checkFromAssistant("mind", true, true);
      await vi.waitFor(() => expect(useMindCheck.getState().asking.mind).toBeDefined());
      cardClosed("mind", how);
      await expect(closed).rejects.toMatchObject({ wording: { key: "mindCheck.closed" } });
    }
  });

  // protects=a question that gives way to another Check (a second request, Check every sentence again, a retry) settles as closed, never as Not now (#2252); fails_when=the card says the User chose Not now when they started another Check; no_claim=the new Check's own ask.
  test.each(["request", "every-sentence", "retry"] as const)(
    "a question giving way to another Check settles as closed (%s)",
    async (how) => {
      askByCap();
      bridge.planMindCheck.mockResolvedValue({ ...plan, findsClaims: true });
      const { checkFromAssistant, startMindCheck, checkMind, dismissMindCheck, useMindCheck } =
        await import("../../src/renderer/src/mindCheck");
      const first = checkFromAssistant("mind", true, true);
      await vi.waitFor(() => expect(useMindCheck.getState().asking.mind).toBeDefined());
      if (how === "request") {
        const second = checkFromAssistant("mind", true, true);
        await expect(first).rejects.toMatchObject({ wording: { key: "mindCheck.closed" } });
        await vi.waitFor(() => expect(useMindCheck.getState().asking.mind).toBeDefined());
        dismissMindCheck("mind");
        await expect(second).rejects.toMatchObject({ wording: { key: "mindCheck.declined" } });
        return;
      }
      if (how === "every-sentence") await startMindCheck("mind", "all");
      else await checkMind("mind", "changed");
      await expect(first).rejects.toMatchObject({ wording: { key: "mindCheck.closed" } });
      dismissMindCheck("mind");
    },
  );

  // protects=#2313: below $1 and without a spending cap the assistant's one Check runs at once; fails_when=it asks for a price it would not show; no_claim=the asking case above.
  test("below the price and the cap, the assistant's one Check runs at once", async () => {
    belowThePrice();
    bridge.planMindCheck.mockResolvedValue({ ...plan, findsClaims: true });
    bridge.checkMind.mockResolvedValue({
      kind: "checked",
      sentences: 1,
      checked: 1,
      smallModel: false,
      stop: null,
    });
    const { checkFromAssistant, useMindCheck } = await import("../../src/renderer/src/mindCheck");

    await expect(checkFromAssistant("mind")).resolves.toBeUndefined();
    expect(useMindCheck.getState().asking.mind).toBeUndefined();
    expect(bridge.checkMind).toHaveBeenCalledOnce();
  });

  // protects=a Check from ⌘K, Home or a line asks when its price is above $1 without a cap; fails_when=it spends at once with the price unseen; no_claim=the card's own one press.
  test("a Check from another way in asks above $1 without a cap", async () => {
    bridge.estimateRun.mockResolvedValue({ ...estimate, cost: { amount: 1.5, currency: "USD" } });
    const { startCheckAsking, useMindCheck } = await import("../../src/renderer/src/mindCheck");

    expect(await startCheckAsking("mind")).toMatchObject({ kind: "asked" });
    expect(useMindCheck.getState().asking.mind?.estimate?.parts[0]).toBe("About $1.50");
    expect(bridge.checkMind).not.toHaveBeenCalled();
  });

  // protects=a Check from ⌘K, Home or a line runs at once below $1 without a cap; fails_when=it asks for a price it would not show; no_claim=the asking case above.
  test("a Check from another way in runs at once below $1 with no cap", async () => {
    belowThePrice();
    const { startCheckAsking, useMindCheck } = await import("../../src/renderer/src/mindCheck");

    await startCheckAsking("mind");
    expect(bridge.checkMind).toHaveBeenCalledOnce();
    expect(useMindCheck.getState().asking.mind).toBeUndefined();
  });

  // protects=#2313: a Check opened by the question still checks the Folder's other Documents after the User's OK, as its price included them; fails_when=confirmCheck drops the question's watch and only the claims are checked; no_claim=the claims' own check.
  test("the User's OK keeps the Folder check its price included", async () => {
    askByCap();
    bridge.planMindCheck.mockResolvedValue({ ...plan, findsClaims: true });
    bridge.planContradictionCheck.mockResolvedValue({ kind: "ready", claims: 4, model: null });
    watchRecord.current = { stop: { reason: "stopped", resetsAt: null } };
    bridge.checkMind.mockResolvedValue({
      kind: "checked",
      sentences: 1,
      checked: 1,
      smallModel: false,
      stop: null,
    });
    const { startCheckAsking, confirmCheck } = await import("../../src/renderer/src/mindCheck");

    expect(await startCheckAsking("mind")).toMatchObject({ kind: "asked" });
    await confirmCheck("mind");
    await vi.waitFor(() => expect(bridge.checkContradictions).toHaveBeenCalledOnce());
    expect(bridge.checkMind).toHaveBeenCalledOnce();
    expect(bridge.checkSentences).not.toHaveBeenCalled();
  });

  // protects=#2313: the card's press with no price asks with the Folder watch its question carries; fails_when=the forced question drops the watch and the OK runs only the claims; no_claim=the priced question above.
  test("the card's press with no price keeps the Folder watch in its question", async () => {
    bridge.estimateRun.mockRejectedValue(new Error("Estimate unavailable"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    bridge.planMindCheck.mockResolvedValue({ ...plan, findsClaims: true });
    bridge.planContradictionCheck.mockResolvedValue({ kind: "ready", claims: 4, model: null });
    watchRecord.current = { stop: { reason: "stopped", resetsAt: null } };
    bridge.checkMind.mockResolvedValue({
      kind: "checked",
      sentences: 1,
      checked: 1,
      smallModel: false,
      stop: null,
    });
    const { confirmCheck, startCheckUnpriced, useMindCheck } = await import(
      "../../src/renderer/src/mindCheck"
    );

    expect(await startCheckUnpriced("mind")).toMatchObject({ kind: "asked" });
    expect(useMindCheck.getState().asking.mind).toMatchObject({ watch: { claims: 4 } });
    await confirmCheck("mind");
    await vi.waitFor(() => expect(bridge.checkContradictions).toHaveBeenCalledOnce());
    expect(bridge.checkSentences).not.toHaveBeenCalled();
  });

  // protects=#2313: the couldn't-estimate line is literal in both languages; fails_when=one language's words drift; no_claim=the question's other lines.
  test.each(["en", "zh-CN"] as const)(
    "the couldn't-estimate line is literal in %s",
    async (language) => {
      const { translate } = await import("../../src/shared/i18n");
      expect(translate(language, "mindCheck.ask.unestimated")).toBe(
        language === "en" ? "The cost couldn’t be estimated" : "无法估算费用",
      );
    },
  );

  // protects=#2313: the card's press asks with the couldn't-estimate line when its estimate failed, rather than spending unpriced; fails_when=it runs at once with no price; no_claim=the estimate it would show.
  test("the card's press asks when its estimate failed", async () => {
    const error = new Error("Estimate unavailable");
    bridge.estimateRun.mockRejectedValue(error);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { checkEstimate, planCheckThisMind, startCheckUnpriced, useMindCheck } = await import(
      "../../src/renderer/src/mindCheck"
    );

    expect(await checkEstimate("mind", await planCheckThisMind("mind"))).toEqual({
      kind: "unknown",
    });
    expect(await startCheckUnpriced("mind")).toMatchObject({ kind: "asked" });
    expect(useMindCheck.getState().asking.mind).toMatchObject({
      count: 1,
      estimate: null,
      unestimated: true,
    });
    expect(bridge.checkMind).not.toHaveBeenCalled();
  });

  // protects=#2313: the card's press asks while its estimate is still pending, rather than spending unpriced; fails_when=it waits for the price instead of asking, or runs; no_claim=the estimate.
  test("the card's press asks while its estimate is still pending", async () => {
    bridge.estimateRun.mockReturnValue(new Promise(() => {}));
    const { startCheckUnpriced, useMindCheck } = await import("../../src/renderer/src/mindCheck");

    expect(await startCheckUnpriced("mind")).toMatchObject({ kind: "asked" });
    expect(useMindCheck.getState().asking.mind).toMatchObject({ unestimated: true });
    expect(bridge.estimateRun).not.toHaveBeenCalled();
    expect(bridge.checkMind).not.toHaveBeenCalled();
  });

  // protects=#2313: an estimate under the threshold runs the card's press at once, as its price line is not needed; fails_when=it asks though the run is cheap; no_claim=the price it would show.
  test("the card's press runs at once when its estimate is under the threshold", async () => {
    belowThePrice();
    const { checkEstimate, planCheckThisMind, startCheck, useMindCheck } = await import(
      "../../src/renderer/src/mindCheck"
    );

    expect(await checkEstimate("mind", await planCheckThisMind("mind"))).toEqual({ kind: "none" });
    await startCheck("mind");
    expect(bridge.checkMind).toHaveBeenCalledOnce();
    expect(useMindCheck.getState().asking.mind).toBeUndefined();
  });

  // protects=#2313: a plan made since the price shown asks and prices again; fails_when=the press runs at once on the old price; no_claim=the same plan running at once below.
  test("the card's press asks again when a plan was made since it priced", async () => {
    const fresh: MindCheckPlan = { ...plan, sentences: 5 };
    bridge.planMindCheck.mockResolvedValue(fresh);
    const { startCheck, useMindCheck } = await import("../../src/renderer/src/mindCheck");

    expect(
      await startCheck("mind", {
        mode: "changed",
        allDocuments: false,
        plan: { ...plan, sentences: 1 },
        watch: null,
      }),
    ).toMatchObject({ kind: "asked" });
    expect(bridge.checkMind).not.toHaveBeenCalled();
    expect(useMindCheck.getState().asking.mind).toMatchObject({ count: 5 });
  });

  // protects=#2313: the plan the press priced runs at once; fails_when=it asks though nothing changed since that price; no_claim=the plan made since above.
  test("the card's press runs at once when the plan made at it is the one it priced", async () => {
    const fresh: MindCheckPlan = { ...plan, sentences: 5 };
    bridge.planMindCheck.mockResolvedValue(fresh);
    const { startCheck } = await import("../../src/renderer/src/mindCheck");

    await startCheck("mind", {
      mode: "changed",
      allDocuments: false,
      plan: { ...fresh },
      watch: null,
    });
    expect(bridge.checkMind).toHaveBeenCalledOnce();
  });

  // protects=#2313: a Folder watch made since the price shown asks and prices again, as a changed plan does; fails_when=the press runs on the new watch's price unseen; no_claim=the same plan and watch running at once.
  test("the card's press asks again when the Folder watch changed since it priced", async () => {
    const fresh: MindCheckPlan = { ...plan, sentences: 5 };
    bridge.planMindCheck.mockResolvedValue(fresh);
    bridge.planContradictionCheck.mockResolvedValue({ kind: "ready", claims: 4, model: null });
    const { startCheck, useMindCheck } = await import("../../src/renderer/src/mindCheck");

    expect(
      await startCheck("mind", {
        mode: "changed",
        allDocuments: false,
        plan: { ...fresh },
        watch: { claims: 2 },
      }),
    ).toMatchObject({ kind: "asked" });
    expect(bridge.checkMind).not.toHaveBeenCalled();
    expect(useMindCheck.getState().asking.mind).toMatchObject({
      count: 5,
      watch: { claims: 4 },
    });
  });

  // protects=#2313: the plan and the Folder watch the press priced run at once; fails_when=the watch comparison asks a second time for a price already shown; no_claim=the watch made since above.
  test("the card's press runs at once when the Folder watch is the one it priced", async () => {
    const fresh: MindCheckPlan = { ...plan, sentences: 5 };
    bridge.planMindCheck.mockResolvedValue(fresh);
    bridge.planContradictionCheck.mockResolvedValue({ kind: "ready", claims: 4, model: null });
    const { startCheck, useMindCheck } = await import("../../src/renderer/src/mindCheck");

    await startCheck("mind", {
      mode: "changed",
      allDocuments: false,
      plan: { ...fresh },
      watch: { claims: 4 },
    });
    expect(bridge.checkMind).toHaveBeenCalledOnce();
    expect(useMindCheck.getState().asking.mind).toBeUndefined();
  });

  // protects=a question's hold is freed when its confirmed run throws before taking the Note; fails_when=the Note stays held until the window closes; no_claim=what the core said.
  test("a question confirmed whose run throws frees the Note it kept", async () => {
    askByCap();
    bridge.planMindCheck.mockResolvedValue({ ...plan, findsClaims: true });
    bridge.checkMind.mockRejectedValue(new Error("The run couldn’t start."));
    const { checkFromAssistant, confirmCheck, useMindCheck } = await import(
      "../../src/renderer/src/mindCheck"
    );

    const checked = checkFromAssistant("mind", true, true);
    checked.catch(() => undefined);
    await vi.waitFor(() => expect(useMindCheck.getState().asking.mind).toBeDefined());
    const requestId = useMindCheck.getState().asking.mind?.requestId;
    expect(requestId).toEqual(expect.any(String));
    await confirmCheck("mind");

    expect(bridge.cancelCheck).toHaveBeenCalledWith(requestId);
    await expect(checked).rejects.toThrow("The run couldn’t start.");
  });

  // protects=a question confirmed while another Check runs starts none and frees the Note the question kept; fails_when=the hold leaks or a run starts; no_claim=the other run.
  test("a question confirmed while this window runs a Check frees the Note it kept", async () => {
    askByCap();
    bridge.planMindCheck.mockResolvedValue({ ...plan, findsClaims: true });
    const { checkFromAssistant, confirmCheck, useMindCheck } = await import(
      "../../src/renderer/src/mindCheck"
    );

    const checked = checkFromAssistant("mind", true, true);
    checked.catch(() => undefined);
    await vi.waitFor(() => expect(useMindCheck.getState().asking.mind).toBeDefined());
    const requestId = useMindCheck.getState().asking.mind?.requestId;
    running.current.mind = { requestId: "other", action: "whole-mind" };
    await confirmCheck("mind");

    expect(bridge.checkMind).not.toHaveBeenCalled();
    expect(bridge.cancelCheck).toHaveBeenCalledWith(requestId);
    await expect(checked).rejects.toMatchObject({
      wording: { key: "mindCheck.alreadyChecking" },
    });
  });

  // protects=a stopped Check's card is never Done; fails_when=the card says Done after the User stopped it; no_claim=what the stopped run checked.
  test("a stopped Check ends the assistant's card as Stopped", async () => {
    belowThePrice();
    const { checkFromAssistant } = await import("../../src/renderer/src/mindCheck");

    await expect(checkFromAssistant("mind")).rejects.toMatchObject({
      wording: { key: "run.stopped.cancelled" },
    });
  });

  // protects=a plan with nothing to check is never Done; fails_when=the card says Done while nothing was checked; no_claim=what the plan found.
  test("a plan with nothing to check ends the assistant's card as nothing to check", async () => {
    bridge.planMindCheck.mockResolvedValue({ kind: "nothing" });
    const { checkFromAssistant } = await import("../../src/renderer/src/mindCheck");

    await expect(checkFromAssistant("mind")).rejects.toMatchObject({
      wording: { key: "mindCheck.nothingToCheck" },
    });
    expect(bridge.checkMind).not.toHaveBeenCalled();
  });

  // protects=Check every sentence again asked while this window checks the Note says it is already checking; fails_when=it starts a second Check or the card says Done; no_claim=the run already on.
  test("Check every sentence again says it is already checking while this window checks", async () => {
    running.current.mind = { requestId: "other", action: "whole-mind" };
    const { checkFromAssistant } = await import("../../src/renderer/src/mindCheck");

    await expect(checkFromAssistant("mind", true)).rejects.toMatchObject({
      wording: { key: "mindCheck.alreadyChecking" },
    });
    expect(bridge.holdMindCheck).not.toHaveBeenCalled();
    expect(bridge.checkMind).not.toHaveBeenCalled();
  });

  // protects=the Note a Check kept is freed only after its watch, never between the claims and the watch; fails_when=another window can start between the two parts; no_claim=what the watch checks.
  test("a Check frees its Note only after its watch ends", async () => {
    belowThePrice();
    bridge.planMindCheck.mockResolvedValue({ ...plan, findsClaims: true });
    bridge.planContradictionCheck.mockResolvedValue({ kind: "ready", claims: 4, model: null });
    bridge.checkMind.mockResolvedValue({
      kind: "checked",
      sentences: 1,
      checked: 1,
      smallModel: false,
      stop: null,
    });
    let release!: () => void;
    const watching = new Promise<{
      kind: "checked";
      sentences: number;
      checked: number;
      smallModel: boolean;
    }>((done) => {
      release = () => done({ kind: "checked", sentences: 1, checked: 1, smallModel: false });
    });
    bridge.checkSentences.mockReturnValueOnce(watching);
    const { checkFromAssistant, useMindCheck } = await import("../../src/renderer/src/mindCheck");

    const done = checkFromAssistant("mind");
    await vi.waitFor(() => expect(bridge.checkSentences).toHaveBeenCalled());
    const requestId = bridge.checkMind.mock.calls[0]?.[0]?.requestId;
    expect(useMindCheck.getState().asking.mind).toBeUndefined();
    expect(bridge.cancelCheck).not.toHaveBeenCalledWith(requestId);

    release();
    await expect(done).resolves.toBeUndefined();
    expect(bridge.cancelCheck).toHaveBeenCalledWith(requestId);
  });

  // protects=a throw after the claims still settles the answer, never a stuck "Running"; fails_when=the assistant waits forever or the Note stays held; no_claim=what the watch checks.
  test("a throw in the watch settles the assistant's reply and frees the Note", async () => {
    belowThePrice();
    bridge.planMindCheck.mockResolvedValue({ ...plan, findsClaims: true });
    bridge.planContradictionCheck.mockResolvedValue({ kind: "ready", claims: 4, model: null });
    bridge.checkMind.mockResolvedValue({
      kind: "checked",
      sentences: 1,
      checked: 1,
      smallModel: false,
      stop: null,
    });
    const { setCheckRunning } = await import("../../src/renderer/src/checks");
    vi.mocked(setCheckRunning)
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("The watch couldn’t start.");
      });
    const { checkFromAssistant, useMindCheck } = await import("../../src/renderer/src/mindCheck");

    const done = checkFromAssistant("mind");
    // Attached now: the run may throw before the assertions below yield to it.
    const failed = expect(done).rejects.toThrow("The watch couldn’t start.");
    await vi.waitFor(() => expect(bridge.checkMind).toHaveBeenCalled());
    const requestId = bridge.checkMind.mock.calls[0]?.[0]?.requestId;
    expect(useMindCheck.getState().asking.mind).toBeUndefined();
    await failed;
    const { setCheckProblem } = await import("../../src/renderer/src/checks");
    expect(setCheckProblem).toHaveBeenCalledWith(
      "mind",
      expect.objectContaining({ kind: "failed" }),
    );
    expect(bridge.cancelCheck).toHaveBeenCalledWith(requestId);
  });

  // protects=a plan that throws while the Note is held frees it; fails_when=the hold outlives a failed plan; no_claim=what the plan needed.
  test("a plan that throws frees the Note it held", async () => {
    bridge.planMindCheck.mockRejectedValue(new Error("The plan couldn’t be made."));
    const { checkFromAssistant, useMindCheck } = await import("../../src/renderer/src/mindCheck");

    await expect(checkFromAssistant("mind")).rejects.toThrow("The plan couldn’t be made.");
    expect(useMindCheck.getState().asking.mind).toBeUndefined();
    expect(bridge.cancelCheck).toHaveBeenCalled();
  });

  test("a Check whose model fails ends the assistant's card as the failure", async () => {
    belowThePrice();
    bridge.checkMind.mockResolvedValue({
      kind: "failed",
      error: { kind: "provider", message: "Overloaded" },
    });
    const { checkFromAssistant } = await import("../../src/renderer/src/mindCheck");

    await expect(checkFromAssistant("mind")).rejects.toThrow("Overloaded");
  });

  test("Not now frees the Note its question kept", async () => {
    bridge.planMindCheck.mockResolvedValue({ ...plan, findsClaims: true });
    const { dismissMindCheck, startMindCheck, useMindCheck } = await import(
      "../../src/renderer/src/mindCheck"
    );

    await startMindCheck("mind", "changed");
    const requestId = useMindCheck.getState().asking.mind?.requestId;
    dismissMindCheck("mind");

    expect(useMindCheck.getState().asking.mind).toBeUndefined();
    expect(bridge.cancelCheck).toHaveBeenCalledWith(requestId);
  });

  test("the assistant's Check says it is already checking, and a Check that runs does not", async () => {
    belowThePrice();
    const { checkFromAssistant } = await import("../../src/renderer/src/mindCheck");
    bridge.holdMindCheck.mockResolvedValue(false);
    await expect(checkFromAssistant("mind")).rejects.toMatchObject({
      wording: { key: "mindCheck.alreadyChecking" },
    });

    bridge.holdMindCheck.mockResolvedValue(true);
    bridge.checkMind.mockResolvedValue({
      kind: "checked",
      sentences: 1,
      checked: 1,
      smallModel: false,
      stop: null,
    });
    await expect(checkFromAssistant("mind")).resolves.toBeUndefined();
  });
});

describe("Check every sentence again", () => {
  test("on a model billed per token asks first with the estimate, and the line goes; agreed, it checks for real", async () => {
    const { startMindCheck, useMindCheck, checkMind } = await import(
      "../../src/renderer/src/mindCheck"
    );
    useMindCheck.setState({ unchanged: { mind: true } });
    await startMindCheck("mind", "all");
    expect(bridge.planMindCheck).toHaveBeenCalledWith("mind", "all", false);
    expect(bridge.checkMind).not.toHaveBeenCalled();
    expect(useMindCheck.getState().unchanged.mind).toBeUndefined();
    expect(useMindCheck.getState().asking.mind).toMatchObject({ mode: "all", count: 1 });
    await checkMind("mind", "all");
    expect(bridge.checkMind).toHaveBeenCalledWith(expect.objectContaining({ mode: "all" }));
    expect(bridge.checkContradictions).not.toHaveBeenCalled();
  });

  test.each(["free", "plan"] as const)("on a known %s model it checks at once", async (billing) => {
    bridge.estimateRun.mockResolvedValue({ billing });
    const { startMindCheck, useMindCheck } = await import("../../src/renderer/src/mindCheck");
    await startMindCheck("mind", "all");
    expect(bridge.checkMind).toHaveBeenCalledWith(expect.objectContaining({ mode: "all" }));
    expect(bridge.cancelCheck).toHaveBeenCalledOnce();
    expect(useMindCheck.getState().asking.mind).toBeUndefined();
  });
});

describe("The Figure schedule's Check", () => {
  // protects=#2313: a check of chosen figures asks above $1 like every other way in, its count the figures' sentences, in English and Chinese; fails_when=it spends at once with the price unseen; no_claim=the below-the-line case.
  test.each(["en", "zh-CN"] as const)(
    "the chosen figures' Check asks above $1 in %s",
    async (language) => {
      store.language = language;
      bridge.planMindCheck.mockResolvedValue({ ...plan, sentences: 3 });
      bridge.estimateRun.mockResolvedValue({ ...estimate, cost: { amount: 1.5, currency: "USD" } });
      const { startFigureCheckAsking, useMindCheck } = await import(
        "../../src/renderer/src/mindCheck"
      );

      expect(await startFigureCheckAsking("mind", ["f1", "f2"])).toMatchObject({
        kind: "asked",
      });
      const asking = useMindCheck.getState().asking.mind;
      expect(asking?.estimate?.parts[0]).toBe(language === "en" ? "About $1.50" : "约 $1.50");
      expect(asking?.figureIds).toEqual(["f1", "f2"]);
      expect(bridge.planMindCheck).toHaveBeenLastCalledWith("mind", "all", false, ["f1", "f2"]);
      expect(bridge.estimateRun).toHaveBeenCalledWith({ items: 3, each: "check" });
      expect(bridge.checkMind).not.toHaveBeenCalled();
    },
  );

  // protects=#2313: the User's OK checks the figures the question named, never the whole Note; fails_when=the run drops them and checks everything; no_claim=the whole-Note question.
  test("the User's OK checks those figures, never the whole note", async () => {
    askByCap();
    bridge.planMindCheck.mockResolvedValue({ ...plan, sentences: 2 });
    bridge.checkMind.mockResolvedValue({
      kind: "checked",
      sentences: 2,
      checked: 2,
      smallModel: false,
      stop: null,
    });
    const { startFigureCheckAsking, confirmCheck } = await import(
      "../../src/renderer/src/mindCheck"
    );

    expect(await startFigureCheckAsking("mind", ["f1", "f2"])).toMatchObject({ kind: "asked" });
    await confirmCheck("mind");
    expect(bridge.checkMind).toHaveBeenCalledWith(
      expect.objectContaining({ mindId: "mind", mode: "all", figureIds: ["f1", "f2"] }),
    );
    expect(bridge.checkContradictions).not.toHaveBeenCalled();
  });

  // protects=#2313: below $1 and without a cap the chosen figures are checked at once, as every other way in runs; fails_when=it asks for a price it would not show; no_claim=the asking case above.
  test("the chosen figures' Check runs at once below $1", async () => {
    belowThePrice();
    const { startFigureCheckAsking, useMindCheck } = await import(
      "../../src/renderer/src/mindCheck"
    );

    await startFigureCheckAsking("mind", ["f1"]);
    expect(bridge.checkMind).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "all", figureIds: ["f1"] }),
    );
    expect(useMindCheck.getState().asking.mind).toBeUndefined();
  });

  // protects=#2313: a figure run whose confirmed start throws retries those figures, never the whole Note; fails_when=its Try again checks everything; no_claim=the figures it checks.
  test("a failed figure check retries those figures", async () => {
    askByCap();
    bridge.planMindCheck.mockResolvedValue({ ...plan, sentences: 1 });
    const { startFigureCheckAsking, confirmCheck } = await import(
      "../../src/renderer/src/mindCheck"
    );
    const { setCheckProblem, setCheckRunning } = await import("../../src/renderer/src/checks");
    vi.mocked(setCheckRunning).mockImplementationOnce(() => {
      throw new Error("The run couldn’t start.");
    });

    await startFigureCheckAsking("mind", ["f1"]);
    await confirmCheck("mind");
    const problem = vi.mocked(setCheckProblem).mock.calls.at(-1)?.[1];
    if (problem?.kind !== "failed" || !problem.retry)
      throw new Error("A failed check has no retry.");
    problem.retry();
    await vi.waitFor(() => expect(bridge.checkMind).toHaveBeenCalledOnce());
    expect(bridge.checkMind.mock.calls[0]?.[0]).toMatchObject({
      mode: "all",
      figureIds: ["f1"],
    });
  });

  // protects=#2313: a failed estimate asks with the couldn't-estimate line rather than spending unpriced; fails_when=it runs at once with no price; no_claim=the estimate it would show.
  test("the chosen figures' Check asks when its estimate fails", async () => {
    bridge.estimateRun.mockRejectedValue(new Error("Estimate unavailable"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { startFigureCheckAsking, useMindCheck } = await import(
      "../../src/renderer/src/mindCheck"
    );

    expect(await startFigureCheckAsking("mind", ["f1"])).toMatchObject({ kind: "asked" });
    expect(useMindCheck.getState().asking.mind).toMatchObject({
      count: 1,
      estimate: null,
      unestimated: true,
      figureIds: ["f1"],
    });
    expect(bridge.checkMind).not.toHaveBeenCalled();
  });
});

describe("Check all Documents after a figures Check", () => {
  const noDocuments: MindCheckPlan = {
    kind: "no-documents",
    folderId: "folder",
    chosen: {
      scope: { folderIds: ["folder"], tagIds: [], documentIds: [] },
      onlyLeftOut: false,
    },
  };

  // protects=#2313: a figures run whose scope held nothing widens to the same figures, never the whole Note; fails_when=it plans and checks every sentence instead; no_claim=the figures' own run.
  test("a figures run with no Documents keeps those figures when widened", async () => {
    belowThePrice();
    bridge.planMindCheck.mockResolvedValue({ ...plan, sentences: 1 });
    bridge.checkMind.mockResolvedValueOnce(noDocuments);
    const { startFigureCheckAsking } = await import("../../src/renderer/src/mindCheck");
    const { setCheckProblem } = await import("../../src/renderer/src/checks");

    await startFigureCheckAsking("mind", ["f1"]);
    const problem = vi.mocked(setCheckProblem).mock.calls.at(-1)?.[1];
    if (problem?.kind !== "no-documents" || !problem.checkAll)
      throw new Error("A run with no Documents offers no check of all of them.");
    problem.checkAll();
    await vi.waitFor(() => expect(bridge.checkMind).toHaveBeenCalledTimes(2));
    expect(bridge.planMindCheck).toHaveBeenLastCalledWith("mind", "all", true, ["f1"]);
    expect(bridge.checkMind.mock.calls[1]?.[0]).toMatchObject({
      mode: "all",
      allDocuments: true,
      figureIds: ["f1"],
    });
  });

  // protects=#2313: a figures plan with no Documents widens to the same figures too; fails_when=its Check all Documents plans every sentence in the Note; no_claim=the widened run above.
  test("a figures plan with no Documents keeps those figures when widened", async () => {
    belowThePrice();
    bridge.planMindCheck.mockResolvedValueOnce(noDocuments).mockResolvedValue({
      ...plan,
      sentences: 2,
    });
    const { startFigureCheckAsking } = await import("../../src/renderer/src/mindCheck");
    const { setCheckProblem } = await import("../../src/renderer/src/checks");

    await startFigureCheckAsking("mind", ["f1", "f2"]);
    expect(bridge.checkMind).not.toHaveBeenCalled();
    const problem = vi.mocked(setCheckProblem).mock.calls.at(-1)?.[1];
    if (problem?.kind !== "no-documents" || !problem.checkAll)
      throw new Error("A plan with no Documents offers no check of all of them.");
    problem.checkAll();
    await vi.waitFor(() => expect(bridge.checkMind).toHaveBeenCalledOnce());
    expect(bridge.planMindCheck).toHaveBeenLastCalledWith("mind", "all", true, ["f1", "f2"]);
    expect(bridge.checkMind.mock.calls[0]?.[0]).toMatchObject({
      mode: "all",
      allDocuments: true,
      figureIds: ["f1", "f2"],
    });
  });
});

describe("The re-check after a figure change", () => {
  // protects=#2313: the re-check asks above $1 and checks only what changed, with no Folder watch; fails_when=the one Check's Folder watch comes back on this path; no_claim=the run it prices.
  test("asks above $1, plans what changed, and carries no Folder watch", async () => {
    const { startChangedCheckAsking, useMindCheck, confirmCheck } = await import(
      "../../src/renderer/src/mindCheck"
    );
    bridge.planMindCheck.mockResolvedValue({ ...plan, sentences: 2 });
    bridge.checkMind.mockResolvedValue({
      kind: "checked",
      sentences: 2,
      checked: 2,
      smallModel: false,
      stop: null,
    });

    expect(await startChangedCheckAsking("mind")).toMatchObject({ kind: "asked" });
    expect(bridge.planMindCheck).toHaveBeenCalledWith("mind", "changed", false);
    expect(bridge.planContradictionCheck).not.toHaveBeenCalled();
    expect(useMindCheck.getState().asking.mind).toMatchObject({
      mode: "changed",
      count: 2,
      watch: null,
    });
    await confirmCheck("mind");
    expect(bridge.checkMind).toHaveBeenCalledWith(
      expect.objectContaining({ mindId: "mind", mode: "changed", allDocuments: false }),
    );
    expect(bridge.checkContradictions).not.toHaveBeenCalled();
    expect(bridge.checkSentences).not.toHaveBeenCalled();
  });

  // protects=#2313: below $1 and without a cap the re-check runs at once, as every other way in runs; fails_when=it asks for a price it would not show; no_claim=the asking case above.
  test("runs at once below $1", async () => {
    belowThePrice();
    const { startChangedCheckAsking, useMindCheck } = await import(
      "../../src/renderer/src/mindCheck"
    );

    await startChangedCheckAsking("mind");
    expect(bridge.checkMind).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "changed", allDocuments: false }),
    );
    expect(useMindCheck.getState().asking.mind).toBeUndefined();
  });

  // protects=#2313: a failed estimate asks with the couldn't-estimate line rather than spending unpriced; fails_when=it runs at once with no price; no_claim=the estimate it would show.
  test("asks when its estimate fails", async () => {
    bridge.estimateRun.mockRejectedValue(new Error("Estimate unavailable"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { startChangedCheckAsking, useMindCheck } = await import(
      "../../src/renderer/src/mindCheck"
    );

    expect(await startChangedCheckAsking("mind")).toMatchObject({ kind: "asked" });
    expect(useMindCheck.getState().asking.mind).toMatchObject({ unestimated: true, watch: null });
    expect(bridge.checkMind).not.toHaveBeenCalled();
  });
});
