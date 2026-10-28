import { describe, expect, test } from "vitest";
import type { Document, DocumentGroupAssignment, TaggingState } from "../../src/core/api";
import {
  notSortedIds,
  organizeFailedIds,
  organizeStateOf,
  suggestedIds,
} from "../../src/renderer/src/organizeOutcome";

/*
 * The cases table (#1955): one state per live Document, by what the actions left it as, and the
 * lists every line reads from it. The row's mark, the title line, To review, ⌘K, Try again,
 * Accept all, Home, the pending count and Get info all use organizeStateOf.
 */

type Held = Pick<DocumentGroupAssignment, "status" | "groupId" | "source" | "suggested">;

const doc = (id: string, tagging: TaggingState = "tagged"): Pick<Document, "id" | "tagging"> => ({
  id,
  tagging,
});

const held = (over: Partial<Held> = {}): Held => ({
  status: "classified",
  groupId: null,
  source: "automatic",
  suggested: false,
  ...over,
});

const stateOf = (item: Held | undefined, tagging: TaggingState = "tagged") =>
  organizeStateOf(doc("a", tagging), item);

describe("what Organize says of a Document", () => {
  test("one it couldn't sort is Not sorted, and the Library isn't all sorted", () => {
    expect(stateOf(held({ status: "failed" }))).toEqual({
      run: "failed",
      place: "notSorted",
      suggested: false,
      manual: false,
    });
    expect(stateOf(held({ status: "failed" }), "failed").place).toBe("notSorted");
  });

  test("one the model left in no Folder on purpose is sorted", () => {
    expect(stateOf(held())).toEqual({
      run: "done",
      place: "sorted",
      suggested: false,
      manual: false,
    });
  });

  test("one the User filed, accepted, or left unfiled by hand is theirs", () => {
    expect(stateOf(held({ groupId: "finance", source: "user" }))).toEqual({
      run: "done",
      place: "sorted",
      suggested: false,
      manual: true,
    });
    expect(stateOf(held({ source: "user" })).place).toBe("sorted");
  });

  test("one the User left unfiled by hand and a later run failed is still the User's choice", () => {
    // The failed re-run keeps source "user" and no Folder; it may not outrank the decision.
    expect(stateOf(held({ source: "user", status: "failed" }))).toEqual({
      run: "failed",
      place: "sorted",
      suggested: false,
      manual: true,
    });
  });

  test("a Suggested Folder still waits, and one whose latest run failed still waits", () => {
    expect(stateOf(held({ groupId: "finance", suggested: true }))).toEqual({
      run: "done",
      place: "neither",
      suggested: true,
      manual: false,
    });
    expect(stateOf(held({ groupId: "finance", suggested: true, status: "failed" }))).toEqual({
      run: "failed",
      place: "neither",
      suggested: true,
      manual: false,
    });
    expect(stateOf(held({ groupId: "finance", suggested: true, status: "classifying" }))).toEqual({
      run: "working",
      place: "neither",
      suggested: true,
      manual: false,
    });
  });

  test("turning one down settles its place, while a retag the User asked for stays the tagger's", () => {
    // A Reject writes the assignment (no Folder, classified); the tagger may still be waiting.
    expect(stateOf(held(), "waiting-for-provider")).toEqual({
      run: "done",
      place: "sorted",
      suggested: false,
      manual: false,
    });
  });

  test("one Organize stopped short of is neither sorted nor one it couldn't sort", () => {
    expect(stateOf(held(), "stopped")).toEqual({
      run: "stopped",
      place: "neither",
      suggested: false,
      manual: false,
    });
  });

  test("one still waiting, or being worked on, is neither", () => {
    expect(stateOf(held({ status: "pending" })).run).toBe("working");
    expect(stateOf(held({ status: "classifying" })).run).toBe("working");
    expect(stateOf(held({ status: "waiting" }), "waiting-for-provider")).toEqual({
      run: "waiting",
      place: "neither",
      suggested: false,
      manual: false,
    });
    expect(stateOf(held({ status: "pending" })).place).toBe("neither");
  });

  test("one never given to Organize, or gone, has no state", () => {
    expect(stateOf(undefined)).toEqual({
      run: "none",
      place: "neither",
      suggested: false,
      manual: false,
    });
    expect(organizeStateOf(undefined, held())).toEqual({
      run: "none",
      place: "neither",
      suggested: false,
      manual: false,
    });
  });
});

describe("the lists every line reads from the one state", () => {
  test("a failed assignment of a Document that is gone leaves no state behind", () => {
    expect(
      notSortedIds(
        [doc("a"), doc("b", "failed")],
        [
          { documentId: "a", ...held() },
          { documentId: "b", ...held({ status: "failed" }) },
        ],
      ),
    ).toEqual(new Set(["b"]));
    expect(
      notSortedIds(
        [doc("a")],
        [
          { documentId: "a", ...held() },
          { documentId: "b", ...held({ status: "failed" }) },
        ],
      ),
    ).toEqual(new Set());
  });

  test("Try again offers the live Documents whose run failed and the User hasn't settled", () => {
    expect(
      organizeFailedIds(
        [doc("a"), doc("b"), doc("c")],
        [
          { documentId: "a", ...held({ status: "failed" }) },
          { documentId: "b", ...held({ source: "user", status: "failed" }) },
          { documentId: "c", ...held({ groupId: "finance", suggested: true, status: "failed" }) },
          { documentId: "gone", ...held({ status: "failed" }) },
        ],
      ),
    ).toEqual(new Set(["a", "c"]));
  });

  test("Accept all and Home count the live Documents whose Suggested Folder waits", () => {
    expect(
      suggestedIds(
        [doc("a"), doc("b")],
        [
          { documentId: "a", ...held({ groupId: "finance", suggested: true }) },
          { documentId: "b", ...held({ groupId: "finance", suggested: true, status: "failed" }) },
          { documentId: "gone", ...held({ groupId: "finance", suggested: true }) },
        ],
      ),
    ).toEqual(["a", "b"]);
  });

  test("waiting, settled and stopped Documents are not Not sorted", () => {
    expect(
      notSortedIds(
        [doc("a"), doc("b"), doc("c", "stopped")],
        [
          { documentId: "a", ...held({ groupId: "finance", suggested: true, status: "failed" }) },
          { documentId: "b", ...held({ source: "user", status: "failed" }) },
          { documentId: "c", ...held() },
        ],
      ),
    ).toEqual(new Set());
  });
});
