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
}));
vi.mock("../../src/renderer/src/core", () => ({ core: bridge }));
vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: {
    getState: () => ({ openMind: async () => {}, settings: { language: "en" } }),
  },
}));
vi.mock("../../src/renderer/src/checks", () => ({
  useChecks: { getState: () => ({ running: {} }) },
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

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  bridge.planMindCheck.mockResolvedValue(plan);
  bridge.planContradictionCheck.mockResolvedValue({ kind: "no-folder" });
  bridge.estimateRun.mockResolvedValue(estimate);
  bridge.checkMind.mockResolvedValue({ kind: "cancelled" });
  bridge.checkContradictions.mockResolvedValue({ kind: "cancelled" });
  watchRecord.current = { stop: null };
  const { useMindCheck } = await import("../../src/renderer/src/mindCheck");
  useMindCheck.setState({ asking: {}, unchanged: {} });
});

describe("Asking before checking against Documents added since", () => {
  test.each([true, false])("the ask uses the planned scope (inFolder: %s)", async (inFolder) => {
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
    expect(useMindCheck.getState().asking.mind).toBeUndefined();
  });
});

describe("Check this note", () => {
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
  });

  test("with nothing changed but Documents added since, it asks about those instead of saying nothing changed", async () => {
    bridge.planMindCheck.mockImplementation(async (_mind, mode) =>
      mode === "changed" ? unchanged : plan,
    );
    const { startCheck, useMindCheck } = await import("../../src/renderer/src/mindCheck");
    await startCheck("mind");
    expect(useMindCheck.getState().unchanged.mind).toBeUndefined();
    expect(useMindCheck.getState().asking.mind).toMatchObject({ mode: "added", count: 1 });
    expect(bridge.checkMind).not.toHaveBeenCalled();
  });

  test("what changed is checked as before, and the line goes", async () => {
    const { startCheck, useMindCheck } = await import("../../src/renderer/src/mindCheck");
    useMindCheck.setState({ unchanged: { mind: true } });
    await startCheck("mind");
    expect(bridge.planMindCheck.mock.calls).toEqual([["mind", "changed", false]]);
    expect(bridge.checkMind).toHaveBeenCalledWith(expect.objectContaining({ mode: "changed" }));
    expect(useMindCheck.getState().unchanged.mind).toBeUndefined();
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

  test("in a Folder the ask keeps the one count (#1909) and remembers that the Check watches too", async () => {
    bridge.planMindCheck.mockResolvedValue({ ...plan, sentences: 1, findsClaims: true });
    bridge.planContradictionCheck.mockResolvedValue({ kind: "ready", claims: 4, model: null });
    const { startCheck, useMindCheck } = await import("../../src/renderer/src/mindCheck");
    await startCheck("mind");
    // One count: the sentences, not the sentences plus the Folder's cited claims.
    expect(useMindCheck.getState().asking.mind).toMatchObject({
      count: 1,
      watch: { claims: 4 },
      inFolder: true,
    });
    // The estimate prices what the run sends: the sentence, and the cited sentence the watch adds.
    expect(bridge.estimateRun).toHaveBeenCalledWith({ items: 2, each: "check" });
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
    expect(useMindCheck.getState().asking.mind).toBeUndefined();
  });
});
