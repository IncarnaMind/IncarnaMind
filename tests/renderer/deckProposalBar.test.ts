import { describe, expect, it } from "vitest";
import type { DeckProposalItem } from "../../src/core/api";
import {
  formatDeckPlace,
  formatDeckReceipt,
} from "../../src/renderer/src/viewer/slides/deckProposalFormat";
import { translate } from "../../src/shared/i18n";

const tEn = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
  translate("en", key, params);
const tZh = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
  translate("zh-CN", key, params);

describe("DeckProposalBar formatting (#149 part 2)", () => {
  // protects=table cell proposals show exact 1-based row/column without double-incrementing; fails_when=Row 1, Column 2 renders as Row 2, Column 3
  it("formats 1-based table cell coordinates without adding 1 again", () => {
    const item: DeckProposalItem = {
      change: { kind: "cell", slide: 1, shape: "5", row: 0, column: 1, paragraphs: ["19"] },
      placeKind: "table",
      shapeLabel: "Metrics Table",
      cell: { row: 1, column: 2 },
      before: "17",
      after: "19",
      targetFingerprint: "fp",
      defaultFit: null,
      overflow: null,
    };
    expect(formatDeckPlace(item, tEn)).toBe("Table · row 1, col 2");
    expect(formatDeckPlace(item, tZh)).toBe("表格 · 第 1 行第 2 列");
  });

  // protects=AI deck receipt includes the kept-state-let-go line when an older kept version was released; fails_when=letGo timestamp is dropped from the receipt
  it("shows when an older kept version was let go in the AI receipt", () => {
    const receipt = {
      undoId: "u1",
      unchanged: 2,
      changed: 1,
      total: 3,
      letGo: ["2026-11-25T10:00:00.000Z"],
    };
    expect(formatDeckReceipt(receipt, tEn, "en")).toContain("let go of the version kept");
    expect(formatDeckReceipt(receipt, tZh, "zh-CN")).toContain("已移除");
  });
});
