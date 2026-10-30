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
vi.mock("../../src/renderer/src/core", () => ({ core: bridge }));
vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: {
    getState: () => ({ openMind: async () => {}, settings: { language: "en" } }),
  },
}));
vi.mock("../../src/renderer/src/checks", () => ({
  useChecks: { getState: () => ({ running: running.current }) },
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
    bridge.checkMind.mockRejectedValue(new Error("The check couldn’t start."));
    const { checkFromAssistant, startCheck } = await import("../../src/renderer/src/mindCheck");

    await expect(startCheck("mind")).resolves.toMatchObject({ kind: "threw" });
    expect(bridge.cancelCheck).toHaveBeenCalled();
    await expect(checkFromAssistant("mind")).rejects.toThrow("The check couldn’t start.");
  });

  test("a question keeps the Note until the User answers: Check runs that request", async () => {
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

  // protects=the assistant's Check that asks ends as the answer, not as Done: confirmed it ends with the run, Not now it ends not allowed; fails_when=the card says Done while a question is unanswered; no_claim=the User's choice.
  test("the assistant's Check that asks ends as the answer", async () => {
    bridge.planMindCheck.mockResolvedValue({ ...plan, findsClaims: true });
    bridge.checkMind.mockResolvedValue({
      kind: "checked",
      sentences: 1,
      checked: 1,
      smallModel: false,
      stop: null,
    });
    const { checkFromAssistant, confirmCheck, dismissMindCheck, useMindCheck } = await import(
      "../../src/renderer/src/mindCheck"
    );

    const done = checkFromAssistant("mind");
    await vi.waitFor(() => expect(useMindCheck.getState().asking.mind).toBeDefined());
    await confirmCheck("mind");
    await expect(done).resolves.toBeUndefined();

    const refused = checkFromAssistant("mind");
    await vi.waitFor(() => expect(useMindCheck.getState().asking.mind).toBeDefined());
    dismissMindCheck("mind");
    await expect(refused).rejects.toMatchObject({ wording: { key: "commands.denied" } });
  });

  // protects=a question's hold is freed when its confirmed run throws before taking the Note; fails_when=the Note stays held until the window closes; no_claim=what the core said.
  test("a question confirmed whose run throws frees the Note it kept", async () => {
    bridge.planMindCheck.mockResolvedValue({ ...plan, findsClaims: true });
    bridge.checkMind.mockRejectedValue(new Error("The run couldn’t start."));
    const { checkFromAssistant, confirmCheck, useMindCheck } = await import(
      "../../src/renderer/src/mindCheck"
    );

    const done = checkFromAssistant("mind");
    await vi.waitFor(() => expect(useMindCheck.getState().asking.mind).toBeDefined());
    const requestId = useMindCheck.getState().asking.mind?.requestId;
    await confirmCheck("mind");

    expect(bridge.cancelCheck).toHaveBeenCalledWith(requestId);
    await expect(done).rejects.toThrow("The run couldn’t start.");
  });

  // protects=a question confirmed while another Check runs starts none, frees the Note the question kept, and is never Done; fails_when=the hold leaks or the card says Done; no_claim=the other run.
  test("a question confirmed while this window runs a Check frees the Note it kept", async () => {
    bridge.planMindCheck.mockResolvedValue({ ...plan, findsClaims: true });
    const { checkFromAssistant, confirmCheck, useMindCheck } = await import(
      "../../src/renderer/src/mindCheck"
    );

    const done = checkFromAssistant("mind");
    await vi.waitFor(() => expect(useMindCheck.getState().asking.mind).toBeDefined());
    const requestId = useMindCheck.getState().asking.mind?.requestId;
    running.current.mind = { requestId: "other", action: "whole-mind" };
    await confirmCheck("mind");

    expect(bridge.checkMind).not.toHaveBeenCalled();
    expect(bridge.cancelCheck).toHaveBeenCalledWith(requestId);
    await expect(done).rejects.toMatchObject({
      wording: { key: "mindCheck.alreadyChecking" },
    });
  });

  // protects=a stopped Check's card is never Done; fails_when=the card says Done after the User stopped it; no_claim=what the stopped run checked.
  test("a stopped Check ends the assistant's card as Stopped", async () => {
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
    const { checkFromAssistant, confirmCheck, useMindCheck } = await import(
      "../../src/renderer/src/mindCheck"
    );

    const done = checkFromAssistant("mind");
    await vi.waitFor(() => expect(useMindCheck.getState().asking.mind).toBeDefined());
    const requestId = useMindCheck.getState().asking.mind?.requestId;
    const confirmed = confirmCheck("mind");
    await vi.waitFor(() => expect(bridge.checkSentences).toHaveBeenCalled());
    expect(bridge.cancelCheck).not.toHaveBeenCalledWith(requestId);

    release();
    await confirmed;
    expect(bridge.cancelCheck).toHaveBeenCalledWith(requestId);
    await expect(done).resolves.toBeUndefined();
  });

  // protects=a throw after the claims still settles the answer, never a stuck "Running"; fails_when=the assistant waits forever or the Note stays held; no_claim=what the watch checks.
  test("a throw in the watch settles the assistant's reply and frees the Note", async () => {
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
    const { checkFromAssistant, confirmCheck, useMindCheck } = await import(
      "../../src/renderer/src/mindCheck"
    );

    const done = checkFromAssistant("mind");
    await vi.waitFor(() => expect(useMindCheck.getState().asking.mind).toBeDefined());
    const requestId = useMindCheck.getState().asking.mind?.requestId;
    await expect(confirmCheck("mind")).rejects.toThrow("The watch couldn’t start.");
    await expect(done).rejects.toThrow("The watch couldn’t start.");
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
    expect(useMindCheck.getState().asking.mind).toBeUndefined();
  });
});
