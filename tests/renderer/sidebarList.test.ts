import { describe, expect, test } from "vitest";
import type { Document } from "../../src/core/api";
import {
  FIRST_DOCUMENTS,
  heldWhileAdding,
  moreDocumentsToShow,
} from "../../src/renderer/src/sidebarList";

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

describe("the sidebar's list while a batch of Documents is added", () => {
  const doc = (id: string) => ({ id }) as Document;

  test("lists the Documents it had when the batch began, and none that arrive meanwhile", () => {
    const documents = [doc("new-2"), doc("new-1"), doc("old-2"), doc("old-1")];
    expect(heldWhileAdding(documents, ["old-2", "old-1"])).toEqual([doc("old-2"), doc("old-1")]);
  });

  test("is the same list, untouched, when nothing is being added", () => {
    const documents = [doc("a"), doc("b")];
    expect(heldWhileAdding(documents, null)).toBe(documents);
  });

  test("keeps the order the Library counts them in", () => {
    const documents = ["d", "c", "b", "a"].map(doc);
    expect(heldWhileAdding(documents, ["d", "b", "a"]).map((each) => each.id)).toEqual([
      "d",
      "b",
      "a",
    ]);
  });

  test("leaves out one deleted while the batch is being added", () => {
    expect(heldWhileAdding([doc("b")], ["a", "b"])).toEqual([doc("b")]);
  });
});
