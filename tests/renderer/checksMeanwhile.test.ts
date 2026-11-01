import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CheckMindResult, CoreBridge, MindCheckPlan, RunEstimate } from "../../src/core/api";

/*
 * A Check of a Note goes by the checks running when it acts, not by those running before it
 * waited on the Note to open, its plan or its estimate (#2302): each test holds that wait while
 * another check of the Note starts or ends, then lets it go.
 */

const bridge = vi.hoisted(() => ({
  on: () => () => undefined,
  planMindCheck: vi.fn<CoreBridge["planMindCheck"]>(),
  planContradictionCheck: vi.fn<CoreBridge["planContradictionCheck"]>(),
  estimateRun: vi.fn<CoreBridge["estimateRun"]>(),
  checkMind: vi.fn<CoreBridge["checkMind"]>(),
  checkContradictions: vi.fn<CoreBridge["checkContradictions"]>(),
  holdMindCheck: vi.fn<CoreBridge["holdMindCheck"]>(),
  cancelCheck: vi.fn<CoreBridge["cancelCheck"]>(),
}));
const opening = vi.hoisted(() => ({ note: Promise.resolve() }));
vi.mock("../../src/renderer/src/core", () => ({ core: bridge }));
vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: {
    getState: () => ({ openMind: () => opening.note, settings: { language: "en" } }),
  },
}));
vi.mock("../../src/renderer/src/layoutSlice", () => ({
  frontTabOfMind: () => ({ id: "tab" }),
  groupsMerged: () => false,
}));

const perToken: RunEstimate = {
  billing: "per-token",
  calls: 12,
  tokens: 24_000,
  cost: { amount: 0.36, currency: "USD" },
  cap: null,
  spentTowardCap: null,
  setAsideTowardCap: null,
};
const twelveSentences: MindCheckPlan = {
  kind: "ready",
  sentences: 12,
  findsClaims: false,
  inFolder: false,
  model: null,
};

const { setCheckRunning, useChecks } = await import("../../src/renderer/src/checks");
const { startContradictionCheck, useContradictions } = await import(
  "../../src/renderer/src/contradictions"
);
const { checkMind, startMindCheck, useMindCheck } = await import(
  "../../src/renderer/src/mindCheck"
);

/** A check of the Note that runs until the test ends it. */
const anotherCheckRuns = () =>
  setCheckRunning("mind", { requestId: "another", action: "whole-mind" });

beforeEach(() => {
  vi.clearAllMocks();
  opening.note = Promise.resolve();
  bridge.planContradictionCheck.mockResolvedValue({ kind: "ready", claims: 4, model: null });
  bridge.planMindCheck.mockResolvedValue(twelveSentences);
  bridge.estimateRun.mockResolvedValue(perToken);
  bridge.checkMind.mockResolvedValue({ kind: "cancelled" });
  bridge.checkContradictions.mockResolvedValue({ kind: "cancelled" });
  bridge.holdMindCheck.mockResolvedValue(true);
  bridge.cancelCheck.mockResolvedValue(undefined);
  useChecks.setState({ running: {} });
  useContradictions.setState({ asking: {} });
  useMindCheck.setState({ asking: {}, unchanged: {} });
});

describe("Check for contradictions", () => {
  test("starts when the check running as it was asked for ended while the Note opened", async () => {
    anotherCheckRuns();
    const note = Promise.withResolvers<void>();
    opening.note = note.promise;
    bridge.estimateRun.mockResolvedValue({ billing: "free" });

    const starting = startContradictionCheck("mind");
    setCheckRunning("mind", null);
    note.resolve();
    await starting;

    expect(bridge.checkContradictions).toHaveBeenCalledOnce();
  });

  test("starts nothing more while a check still runs once the Note is shown", async () => {
    anotherCheckRuns();

    await startContradictionCheck("mind");

    expect(bridge.planContradictionCheck).not.toHaveBeenCalled();
    expect(useChecks.getState().running.mind).toEqual({
      requestId: "another",
      action: "whole-mind",
    });
  });

  test.each([
    ["no question beside a check that started while it was planned", true],
    ["its question with the estimate when no other check started", false],
  ])("shows %s", async (_, started) => {
    const estimating = Promise.withResolvers<RunEstimate>();
    bridge.estimateRun.mockReturnValue(estimating.promise);

    const starting = startContradictionCheck("mind");
    await vi.waitFor(() => expect(bridge.estimateRun).toHaveBeenCalled());
    if (started) anotherCheckRuns();
    estimating.resolve(perToken);
    await starting;

    expect(useContradictions.getState().asking.mind === undefined).toBe(started);
    expect(useChecks.getState().running.mind !== undefined).toBe(started);
  });
});

describe("The one Check and Check every sentence again", () => {
  test("pressed twice while the Note's question is put away, it checks once", async () => {
    useMindCheck.setState({
      asking: {
        mind: {
          requestId: "asked",
          mode: "added",
          allDocuments: false,
          count: 12,
          inFolder: false,
          watch: null,
          estimate: null,
          unestimated: false,
        },
      },
    });
    const freeing = Promise.withResolvers<void>();
    bridge.cancelCheck.mockReturnValueOnce(freeing.promise);
    const checking = Promise.withResolvers<CheckMindResult>();
    bridge.checkMind.mockReturnValue(checking.promise);

    const presses = [checkMind("mind", "all"), checkMind("mind", "all")];
    freeing.resolve();
    await vi.waitFor(() => expect(bridge.checkMind).toHaveBeenCalled());
    checking.resolve({ kind: "cancelled" });
    await Promise.all(presses);

    expect(bridge.cancelCheck).toHaveBeenCalledWith("asked");
    expect(bridge.checkMind).toHaveBeenCalledOnce();
    expect(useChecks.getState().running.mind).toBeUndefined();
  });

  test.each([
    ["no question beside a check that started while it was planned", true],
    ["its question when no other check started", false],
  ])("shows %s", async (_, started) => {
    const planning = Promise.withResolvers<MindCheckPlan>();
    bridge.planMindCheck.mockReturnValue(planning.promise);
    const checking = Promise.withResolvers<CheckMindResult>();
    bridge.checkMind.mockReturnValue(checking.promise);

    const starting = startMindCheck("mind", "added");
    await vi.waitFor(() => expect(bridge.planMindCheck).toHaveBeenCalled());
    const other = started ? checkMind("mind", "all") : Promise.resolve();
    planning.resolve(twelveSentences);
    const outcome = await starting;

    expect(useMindCheck.getState().asking.mind === undefined).toBe(started);
    expect(outcome?.kind).toBe(started ? "running" : "asked");
    checking.resolve({ kind: "cancelled" });
    await other;
  });
});
