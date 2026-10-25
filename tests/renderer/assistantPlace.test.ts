import { describe, expect, test } from "vitest";
import { type AssistantPlace, DEFAULT_ASSISTANT } from "../../src/core/api";
import {
  BOTTOM_MIN,
  bottomHeight,
  bottomMax,
  CARD_MIN_HEIGHT,
  CARD_MIN_WIDTH,
  FLOAT_MIN,
  floatAt,
  floatRect,
  foldsInMenu,
  GAP,
  groupsMergedAt,
  HEADER,
  QUESTION_LEAVES,
  questionHeight,
  questionMax,
  restoredSize,
  SIDE_MIN,
  SNAP_DISTANCE,
  shownDock,
  sideWidth,
  snapZones,
  WINDOW_EDGE,
  zoneAt,
} from "../../src/renderer/src/assistantPlace";

/*
 * Where the assistant is drawn and how big (#253): the rules, without a window.
 */

const place = (change: Partial<AssistantPlace> = {}): AssistantPlace => ({
  ...DEFAULT_ASSISTANT,
  ...change,
});
const WINDOW = { width: 1440, height: 900 };

describe("where it is drawn", () => {
  test("a new window's assistant is docked on the right, 320px wide", () => {
    expect(shownDock(place(), 1440)).toBe("right");
    expect(DEFAULT_ASSISTANT.width).toBe(320);
  });

  test("under 1,000px a side dock is drawn at the bottom, and its choice is kept", () => {
    for (const dock of ["right", "left"] as const) {
      expect(shownDock(place({ dock }), 999)).toBe("bottom");
      expect(shownDock(place({ dock }), 1000)).toBe(dock);
    }
    expect(shownDock(place({ dock: "float" }), 900)).toBe("float");
    expect(shownDock(place({ dock: "bottom" }), 1600)).toBe("bottom");
  });
});

describe("sizes", () => {
  test("a side dock stays between 280px and what leaves the card 360px", () => {
    const room = 1100;
    expect(sideWidth(100, room)).toBe(SIDE_MIN);
    expect(sideWidth(420.4, room)).toBe(420);
    expect(sideWidth(5000, room)).toBe(room - GAP - CARD_MIN_WIDTH);
    // With no room to give, it keeps its minimum.
    expect(sideWidth(360, 500)).toBe(SIDE_MIN);
  });

  test("a bottom dock stays between its minimum and what leaves the card its height", () => {
    const room = 860;
    expect(bottomHeight(DEFAULT_ASSISTANT.height, room)).toBe(300);
    expect(bottomHeight(10, room)).toBe(BOTTOM_MIN);
    expect(bottomHeight(5000, room)).toBe(room - GAP - CARD_MIN_HEIGHT);
  });

  // protects=while a question waits, the bottom dock grows to the height it needs, up to the column less the card's tab strip, and never below the User's own height (#1400); fails_when=it stays short, covers the tabs, or shrinks; no_claim=how the height needed is measured.
  test("a waiting question grows the bottom dock to fit it, leaving the card its tab strip", () => {
    const room = 500;
    expect(questionHeight(300, 420, room)).toBe(420);
    expect(questionHeight(300, 900, room)).toBe(room - QUESTION_LEAVES);
    expect(questionHeight(300, 200, room)).toBe(300);
    // The same largest height for the User's own while the question waits.
    expect(bottomHeight(440, room, questionMax(room))).toBe(440);
    expect(bottomHeight(440, room)).toBe(bottomMax(room));
  });

  test("a double-click restores the default size of where it is", () => {
    const moved = place({
      width: 500,
      height: 420,
      float: {
        ...DEFAULT_ASSISTANT.float,
        width: 640,
        height: 700,
        corner: "bottom-left",
        x: 30,
        y: 40,
      },
    });
    expect(restoredSize(moved, "right")).toEqual({ width: 320 });
    expect(restoredSize(moved, "left")).toEqual({ width: 320 });
    expect(restoredSize(moved, "bottom")).toEqual({ height: 300 });
    // A floating box keeps its corner and its distance to it.
    expect(restoredSize(moved, "float")).toEqual({
      float: { width: 380, height: 520, corner: "bottom-left", x: 30, y: 40 },
    });
  });
});

describe("floating", () => {
  test("a box keeps its distance to its corner as the window changes", () => {
    const float = { width: 380, height: 520, corner: "bottom-right", x: 24, y: 32 } as const;
    expect(floatRect(float, false, WINDOW)).toEqual({
      left: 1036,
      top: 348,
      width: 380,
      height: 520,
    });
    expect(floatRect(float, false, { width: 1200, height: 800 })).toEqual({
      left: 796,
      top: 248,
      width: 380,
      height: 520,
    });
  });

  test("a box is kept inside the window, at least its minimum, and folds to its header where its top was", () => {
    const float = { width: 2000, height: 100, corner: "top-left", x: -50, y: 5000 } as const;
    const rect = floatRect(float, false, WINDOW);
    expect(rect.width).toBe(WINDOW.width - 2 * WINDOW_EDGE);
    expect(rect.height).toBe(FLOAT_MIN.height);
    expect(rect.left).toBe(WINDOW_EDGE);
    expect(rect.top + rect.height).toBe(WINDOW.height - WINDOW_EDGE);
    const folded = floatRect({ ...float, height: 400, y: 100 }, true, WINDOW);
    expect(folded).toMatchObject({ top: 100, height: HEADER });
  });

  test("a box dropped somewhere keeps the window's nearest corner and its distance to it", () => {
    expect(floatAt({ left: 100, top: 80, width: 380, height: 520 }, WINDOW)).toEqual({
      width: 380,
      height: 520,
      corner: "top-left",
      x: 100,
      y: 80,
    });
    expect(floatAt({ left: 1000, top: 360, width: 380, height: 520 }, WINDOW)).toEqual({
      width: 380,
      height: 520,
      corner: "bottom-right",
      x: 60,
      y: 20,
    });
    // Where it was dropped is where it is drawn.
    const rect = { left: 640, top: 300, width: 400, height: 300 };
    expect(floatRect(floatAt(rect, WINDOW), false, WINDOW)).toEqual(rect);
  });
});

describe("dragging the header", () => {
  const area = { left: 264, top: 8, width: 1168, height: 884 };

  test("the edges are zones: the right and the left in a wide window, the bottom always", () => {
    const zones = snapZones(area, place(), 1440);
    expect(zones.map((zone) => zone.dock).sort()).toEqual(["bottom", "left", "right"]);
    const right = zones.find((zone) => zone.dock === "right");
    expect(right?.rect).toEqual({
      left: area.left + area.width - 320,
      top: 8,
      width: 320,
      height: 884,
    });
    expect(snapZones(area, place(), 999).map((zone) => zone.dock)).toEqual(["bottom"]);
  });

  test("near an edge its zone is lit; the nearest wins; elsewhere it floats", () => {
    const zones = snapZones(area, place(), 1440);
    const right = area.left + area.width;
    const bottom = area.top + area.height;
    expect(zoneAt({ x: right - 10, y: 400 }, area, zones)).toBe("right");
    expect(zoneAt({ x: area.left + 20, y: 400 }, area, zones)).toBe("left");
    expect(zoneAt({ x: 800, y: bottom - 30 }, area, zones)).toBe("bottom");
    expect(zoneAt({ x: right - 40, y: bottom - 10 }, area, zones)).toBe("bottom");
    expect(zoneAt({ x: 800, y: 400 }, area, zones)).toBeNull();
    expect(zoneAt({ x: right - SNAP_DISTANCE, y: 400 }, area, zones)).toBeNull();
  });
});

describe("the groups", () => {
  test("merge in a narrow window, or when the card is narrower than a 1,000px window gives it", () => {
    expect(groupsMergedAt(999, 900)).toBe(true);
    expect(groupsMergedAt(1440, null)).toBe(false);
    // Beside a side dock at 1,280px the card is 648px: the groups share one strip.
    expect(groupsMergedAt(1280, 648)).toBe(true);
    // Folded to the rail, or at the bottom, the room comes back.
    expect(groupsMergedAt(1280, 964)).toBe(false);
    expect(groupsMergedAt(1000, 736)).toBe(false);
  });
});

describe("Fold", () => {
  test("is in ⋯ only on Windows docked right, where the header holds the window's buttons (#657)", () => {
    expect(foldsInMenu("overlay", "right")).toBe(true);
    for (const dock of ["left", "bottom", "float"] as const) {
      expect(foldsInMenu("overlay", dock)).toBe(false);
    }
    for (const titleBar of ["inset", "native"] as const) {
      expect(foldsInMenu(titleBar, "right")).toBe(false);
    }
  });
});
