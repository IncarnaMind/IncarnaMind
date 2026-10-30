import type { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  type CoreBridge,
  type RunEstimate,
} from "../../src/core/api";
import { ClaimChecks } from "../../src/renderer/src/editor/claimChecks";
import { sentencesToCheck } from "../../src/renderer/src/editor/healthCounts";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { headlessEditor } from "../helpers/editor";

const bridge = vi.hoisted(() => ({
  planMindCheck: vi.fn<CoreBridge["planMindCheck"]>(),
  planContradictionCheck: vi.fn<CoreBridge["planContradictionCheck"]>(),
  estimateRun: vi.fn<CoreBridge["estimateRun"]>(),
  checkMind: vi.fn<CoreBridge["checkMind"]>(),
  holdMindCheck: vi.fn<CoreBridge["holdMindCheck"]>(),
  cancelCheck: vi.fn<CoreBridge["cancelCheck"]>(),
}));
const opened = vi.hoisted(() => ({
  editor: null as Editor | null,
  doc: null as Y.Doc | null,
  language: "en" as "en" | "zh-CN",
}));
vi.mock("../../src/renderer/src/core", () => ({ core: bridge }));
vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: {
    getState: () => ({ openMind: async () => {}, settings: { language: opened.language } }),
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
vi.mock("../../src/renderer/src/editor/openEditors", () => ({
  mindEditor: () => opened.editor && { state: opened.editor.state, isDestroyed: false },
  whenMindEditor: async () => opened.editor && { state: opened.editor.state, isDestroyed: false },
}));
vi.mock("../../src/renderer/src/editor/proposalReview", () => ({
  editorDoc: () => opened.doc,
}));
vi.mock("../../src/renderer/src/modelInUse", () => ({ modelInUseOf: () => null }));

const estimate: RunEstimate = {
  billing: "per-token",
  calls: 2,
  tokens: 1000,
  cost: { amount: 0.01, currency: "USD" },
  cap: { amount: 5, currency: "USD" },
  spentTowardCap: { amount: 1, currency: "USD" },
  setAsideTowardCap: null,
};
const languages = [
  { language: "en", old: "Penguins live in cold seas.", word: "Penguins", next: "Puffins" },
  { language: "zh-CN", old: "企鹅生活在寒冷的海洋中。", word: "企鹅", next: "海雀" },
] as const;

beforeEach(async () => {
  vi.clearAllMocks();
  bridge.planContradictionCheck.mockResolvedValue({ kind: "no-folder" });
  bridge.estimateRun.mockResolvedValue(estimate);
  bridge.checkMind.mockResolvedValue({ kind: "cancelled" });
  bridge.holdMindCheck.mockResolvedValue(true);
  bridge.cancelCheck.mockResolvedValue(undefined);
  opened.doc = new Y.Doc();
  const { useMindCheck } = await import("../../src/renderer/src/mindCheck");
  useMindCheck.setState({ asking: {}, unchanged: {} });
});

afterEach(() => {
  opened.editor = null;
  opened.doc?.destroy();
  opened.doc = null;
});

function oldCheck(text: string, id: string): ClaimCheckAttributes {
  return {
    id,
    request: "original-request",
    action: "check-against-documents",
    state: "supported",
    reason: null,
    detail: null,
    providerId: "local",
    modelId: "scripted",
    text,
    evidence: null,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: false },
    versions: [],
    excluded: [],
    checkedAt: "2026-10-29T09:00:00.000Z",
  };
}

function note(
  row: (typeof languages)[number],
  count: number,
  owned: boolean,
  added = false,
): Editor {
  opened.language = row.language;
  const editor = headlessEditor([...noteExtensions(), ClaimChecks]);
  editor.commands.setContent({
    type: "doc",
    content: Array.from({ length: count + Number(added) }, (_, index) => ({
      type: "paragraph",
      attrs: { id: `block-${index}` },
      content: [
        {
          type: "text",
          text: row.old,
          ...(owned &&
            index < count && {
              marks: [{ type: CLAIM_CHECK_MARK, attrs: oldCheck(row.old, `check-${index}`) }],
            }),
        },
      ],
    })),
  });
  const positions: number[] = [];
  editor.state.doc.forEach((_node, offset) => {
    positions.push(offset + 1);
  });
  for (const position of positions.reverse())
    editor.view.dispatch(
      editor.state.tr.insertText(row.next, position, position + row.word.length),
    );
  opened.editor = editor;
  return editor;
}

describe.each(languages)("Check after editing checked words ($language)", (row) => {
  test("a small owned recheck runs while its new words still need sorting", async () => {
    const editor = note(row, 1, true);
    expect(sentencesToCheck(editor.state)).toMatchObject([
      { claim: { check: { text: row.old } }, state: { kind: "to-check", fresh: false } },
    ]);
    bridge.planMindCheck.mockResolvedValue({
      kind: "ready",
      sentences: 1,
      findsClaims: true,
      inFolder: false,
      model: null,
    });
    const { startCheck, useMindCheck } = await import("../../src/renderer/src/mindCheck");
    await startCheck("mind");
    const { setCheckProblem } = await import("../../src/renderer/src/checks");
    expect(vi.mocked(setCheckProblem).mock.calls).toEqual([]);
    expect(bridge.checkMind).toHaveBeenCalledWith(expect.objectContaining({ mode: "changed" }));
    expect(useMindCheck.getState().asking.mind).toBeUndefined();
    expect(bridge.estimateRun).not.toHaveBeenCalled();
    expect(bridge.planMindCheck).toHaveBeenCalledWith("mind", "changed", false);
  });

  test.each([false, true])(
    "unmarked words still ask before cloud checking (addition: %s)",
    async (added) => {
      const editor = note(row, 1, added, added);
      const pending = sentencesToCheck(editor.state);
      expect(pending.some((place) => place.claim === null)).toBe(true);
      bridge.planMindCheck.mockResolvedValue({
        kind: "ready",
        sentences: pending.length,
        findsClaims: true,
        inFolder: false,
        model: null,
      });
      const { startCheck, useMindCheck, confirmCheck } = await import(
        "../../src/renderer/src/mindCheck"
      );
      await startCheck("mind");
      expect(bridge.checkMind).not.toHaveBeenCalled();
      expect(useMindCheck.getState().asking.mind).toMatchObject({ count: pending.length });
      await confirmCheck("mind");
      expect(bridge.checkMind).toHaveBeenCalledOnce();
    },
  );

  test.each(["free", "plan"] as const)(
    "new unmarked words retain first-check confirmation on %s billing",
    async (billing) => {
      note(row, 1, false);
      bridge.planMindCheck.mockResolvedValue({
        kind: "ready",
        sentences: 1,
        findsClaims: true,
        inFolder: false,
        model: null,
      });
      bridge.estimateRun.mockResolvedValue({ billing });
      const { startCheck, useMindCheck } = await import("../../src/renderer/src/mindCheck");
      await startCheck("mind");
      expect(bridge.checkMind).not.toHaveBeenCalled();
      expect(useMindCheck.getState().asking.mind).toMatchObject({ count: 1 });
    },
  );

  test.each(["missing", "count mismatch"] as const)(
    "an unverifiable inventory still asks (%s)",
    async (inventory) => {
      note(row, 2, true);
      if (inventory === "missing") opened.editor = null;
      bridge.planMindCheck.mockResolvedValue({
        kind: "ready",
        sentences: 1,
        findsClaims: true,
        inFolder: false,
        model: null,
      });
      const { startCheck, useMindCheck } = await import("../../src/renderer/src/mindCheck");
      await startCheck("mind");
      expect(bridge.checkMind).not.toHaveBeenCalled();
      expect(useMindCheck.getState().asking.mind).toMatchObject({ count: 1 });
    },
  );

  test("a quick recheck still stops at the Core spending cap", async () => {
    note(row, 1, true);
    bridge.planMindCheck.mockResolvedValue({
      kind: "ready",
      sentences: 1,
      findsClaims: true,
      inFolder: false,
      model: null,
    });
    bridge.checkMind.mockResolvedValue({
      kind: "checked",
      sentences: 1,
      checked: 0,
      smallModel: false,
      stop: { reason: "cost-cap" },
    });
    const { startCheck, useMindCheck } = await import("../../src/renderer/src/mindCheck");
    await startCheck("mind");
    expect(bridge.checkMind).toHaveBeenCalledOnce();
    expect(useMindCheck.getState().asking.mind).toBeUndefined();
  });

  test.each(["per-token", "free", "plan"] as const)(
    "a large owned recheck retains the %s policy",
    async (billing) => {
      note(row, 10, true);
      bridge.planMindCheck.mockResolvedValue({
        kind: "ready",
        sentences: 10,
        findsClaims: true,
        inFolder: false,
        model: null,
      });
      bridge.estimateRun.mockResolvedValue(billing === "per-token" ? estimate : { billing });
      const { startCheck, useMindCheck } = await import("../../src/renderer/src/mindCheck");
      await startCheck("mind");
      if (billing === "per-token") {
        expect(bridge.checkMind).not.toHaveBeenCalled();
        expect(useMindCheck.getState().asking.mind).toMatchObject({ count: 10 });
      } else {
        expect(bridge.checkMind).toHaveBeenCalledOnce();
        expect(useMindCheck.getState().asking.mind).toBeUndefined();
      }
    },
  );
});
