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

// No Note is open here: the Check runs its claims, and the contradiction watch needs an editor.
vi.mock("../../src/renderer/src/editor/openEditors", () => ({
  mindEditor: () => null,
  whenMindEditor: async () => null,
}));
vi.mock("../../src/renderer/src/modelInUse", () => ({ modelInUseOf: () => null }));

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

describe("The one Check", () => {
  const SINCE = "2026-10-02T14:20:00.000Z";
  const unchanged: MindCheckPlan = { kind: "unchanged", since: SINCE };

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
      watch: true,
      inFolder: true,
    });
    // The estimate still prices what the run sends: with no Note open, the claims alone.
    expect(bridge.estimateRun).toHaveBeenCalledWith({ items: 1, each: "check" });
  });

  test("a start whose run begins at once does not ask, and the watch waits for its sentences", async () => {
    bridge.planMindCheck.mockResolvedValue({ ...plan, sentences: 1 });
    bridge.planContradictionCheck.mockResolvedValue({ kind: "ready", claims: 4, model: null });
    const { startCheck, useMindCheck } = await import("../../src/renderer/src/mindCheck");
    await startCheck("mind");
    // A small run of what changed asks nothing, as before.
    expect(useMindCheck.getState().asking.mind).toBeUndefined();
    expect(bridge.checkMind).toHaveBeenCalledOnce();
    // No editor: no cited sentence to hand the watch, and nothing sent with its action.
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
