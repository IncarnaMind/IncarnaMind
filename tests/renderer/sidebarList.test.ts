import { describe, expect, test } from "vitest";
import { FIRST_DOCUMENTS, moreDocumentsToShow } from "../../src/renderer/src/sidebarList";

/** The steps each click of "Show N more Documents" would list, for a list of `documents`. */
function clicksToEnd(documents: number): number[] {
  const left = documents - FIRST_DOCUMENTS;
  const steps: number[] = [];
  let revealed = 0;
  while (revealed < left) {
    const step = moreDocumentsToShow(revealed, left - revealed);
    steps.push(step);
    revealed += step;
  }
  return steps;
}

describe("the sidebar's Show more row", () => {
  test("lists 50 more at first, then twice as many each click, until the rest", () => {
    expect(clicksToEnd(1_731)).toEqual([50, 100, 200, 400, 800, 176]);
  });

  test("reaches the end of 1,731 Documents in a handful of clicks, not 35", () => {
    expect(clicksToEnd(1_731).length).toBeLessThanOrEqual(6);
  });

  test("lists all that is left when that is fewer than the next step", () => {
    expect(clicksToEnd(55)).toEqual([50]);
    expect(clicksToEnd(54)).toEqual([49]);
  });

  test("has nothing to list once it has listed every Document", () => {
    expect(clicksToEnd(FIRST_DOCUMENTS)).toEqual([]);
    expect(clicksToEnd(3)).toEqual([]);
  });
});
