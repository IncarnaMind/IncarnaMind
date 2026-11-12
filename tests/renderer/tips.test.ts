import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ tips: {} as Record<string, number> }));
vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: {
    getState: () => ({
      settings: { device: { tips: state.tips } },
      updateSettings: async (patch: { device: { tips: Record<string, number> } }) => {
        state.tips = patch.device.tips;
      },
    }),
  },
}));

import { closeTip, offerTip, releaseTip, restoreTip } from "../../src/renderer/src/tips";

beforeEach(() => {
  releaseTip("citation-style", "note");
  releaseTip("connect-app", "note");
  state.tips = {};
});

describe("contextual device tips", () => {
  test.each(["citation-style", "connect-app"] as const)(
    "%s automatically offers at most twice across mounts",
    (id) => {
      expect(offerTip(id, "note")).toBe(true);
      expect(state.tips[id]).toBe(1);
      releaseTip(id, "note");
      expect(offerTip(id, "note")).toBe(true);
      expect(state.tips[id]).toBe(2);
      releaseTip(id, "note");
      expect(offerTip(id, "note")).toBe(false);
    },
  );

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

  // protects=a count a device stored for a tip that no longer exists (#1031 took "transcript-word" away) stays as it is and gets in no other tip's way; fails_when=reading or writing the counts drops, rewrites or trips over a stored key no tip has; no_claim=that the core loads such a key, which "settings survive a restart" in the settings tests covers.
  test("a count stored for a tip that is gone stays as it is, and the other tips offer as before", () => {
    state.tips = { "transcript-word": 2 };
    expect(offerTip("citation-style", "note")).toBe(true);
    expect(state.tips).toEqual({ "transcript-word": 2, "citation-style": 1 });
    closeTip("citation-style");
    expect(state.tips).toEqual({ "transcript-word": 2, "citation-style": 2 });
  });
});
