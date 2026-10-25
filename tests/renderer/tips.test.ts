import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ tips: {} as Record<string, number> }));
vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: { getState: () => ({
    settings: { device: { tips: state.tips } },
    updateSettings: async (patch: { device: { tips: Record<string, number> } }) => { state.tips = patch.device.tips; },
  }) },
}));
import { closeTip, offerTip, releaseTip, restoreTip } from "../../src/renderer/src/tips";

beforeEach(() => {
  releaseTip("citation-style", "note");
  releaseTip("connect-app", "note");
  state.tips = {};
});

describe("contextual device tips", () => {
  test.each(["citation-style", "connect-app"] as const)("%s automatically offers at most twice across mounts", (id) => {
    expect(offerTip(id, "note")).toBe(true);
    expect(state.tips[id]).toBe(1);
    releaseTip(id, "note");
    expect(offerTip(id, "note")).toBe(true);
    expect(state.tips[id]).toBe(2);
    releaseTip(id, "note");
    expect(offerTip(id, "note")).toBe(false);
  });

  test("closing ends automatic offers; explicit Undo can restore without changing their count", () => {
    expect(offerTip("citation-style", "note")).toBe(true);
    closeTip("citation-style");
    expect(state.tips["citation-style"]).toBe(2);
    expect(offerTip("citation-style", "note")).toBe(false);
    restoreTip("citation-style", "note");
    expect(offerTip("connect-app", "note")).toBe(false);
    expect(state.tips["citation-style"]).toBe(2);
    releaseTip("citation-style", "note");
    expect(offerTip("connect-app", "note")).toBe(true);
  });

  test("unmounting another offer does not clear the one still shown", () => {
    expect(offerTip("citation-style", "note")).toBe(true);
    releaseTip("connect-app", "note");
    expect(offerTip("connect-app", "note")).toBe(false);
  });
});
