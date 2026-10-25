import { describe, expect, test } from "vitest";
import type { DocumentGroupAssignment, TaggingState } from "../../src/core/api";
import { isNotSorted, isSorted } from "../../src/renderer/src/organizeOutcome";

/*
 * What the Library says of a Document when Organize is done or not (#1928): "Not sorted" for
 * one it couldn't sort, and "All sorted" only once every Document is settled — never for one
 * Organize stopped short of, or has not reached.
 */

type Held = Pick<DocumentGroupAssignment, "status" | "groupId" | "source" | "suggested">;

const held = (over: Partial<Held> = {}): Held => ({
  status: "classified",
  groupId: null,
  source: "automatic",
  suggested: false,
  ...over,
});

const says = (item: Held | undefined, tagging: TaggingState = "tagged") => ({
  notSorted: isNotSorted(item),
  sorted: isSorted(item, tagging),
});

describe("what Organize says of a Document", () => {
  test("one it couldn't sort is Not sorted, and the Library isn't all sorted", () => {
    expect(says(held({ status: "failed" }))).toEqual({ notSorted: true, sorted: false });
  });

  test("one the model left in no Folder on purpose is sorted", () => {
    expect(says(held())).toEqual({ notSorted: false, sorted: true });
  });

  test("one the User turned down is settled, even after a run that failed", () => {
    // A Reject finishes the Document (see the core's reject): no Folder, classified, no error.
    expect(says(held())).toEqual({ notSorted: false, sorted: true });
  });

  test("a Folder Organize suggested still waits: neither sorted nor one it couldn't sort", () => {
    expect(says(held({ groupId: "finance", suggested: true }))).toEqual({
      notSorted: false,
      sorted: false,
    });
  });

  test("a Suggested Folder whose re-run failed still waits, not one it couldn't sort", () => {
    expect(says(held({ groupId: "finance", suggested: true, status: "failed" }))).toEqual({
      notSorted: false,
      sorted: false,
    });
  });

  test("one the User accepted, or filed by hand, is sorted", () => {
    expect(says(held({ groupId: "finance", source: "user" }))).toEqual({
      notSorted: false,
      sorted: true,
    });
    expect(says(held({ source: "user" }))).toEqual({ notSorted: false, sorted: true });
  });

  test("one Organize stopped short of is not sorted, and not one it couldn't sort either", () => {
    expect(says(held(), "stopped")).toEqual({ notSorted: false, sorted: false });
  });

  test("one still waiting, or never given to Organize, is not sorted", () => {
    expect(says(held({ status: "pending" }), "pending")).toEqual({
      notSorted: false,
      sorted: false,
    });
    expect(says(held({ status: "waiting" }), "waiting-for-provider")).toEqual({
      notSorted: false,
      sorted: false,
    });
    expect(says(undefined)).toEqual({ notSorted: false, sorted: false });
  });
});
