import { describe, expect, test } from "vitest";
import type { Document, DocumentGroupAssignment, TaggingState } from "../../src/core/api";
import {
  notSortedIds,
  organizeFailedIds,
  organizeStateOf,
  suggestedIds,
} from "../../src/renderer/src/organizeOutcome";

/*
 * The cases table (#1955): what Organize says of one live Document, by what the actions left it
 * as, and which Documents every line answers about. The row's mark, the title line's counts, To
 * review and ⌘K all read organizeStateOf over the live Documents.
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
    expect(stateOf(held({ status: "failed" }))).toBe("notSorted");
    expect(stateOf(held({ status: "failed" }), "failed")).toBe("notSorted");
  });

  test("one the model left in no Folder on purpose is sorted", () => {
    expect(stateOf(held())).toBe("sorted");
  });

  test("one the User filed, accepted, or left unfiled by hand is sorted", () => {
    expect(stateOf(held({ groupId: "finance", source: "user" }))).toBe("sorted");
    expect(stateOf(held({ source: "user" }))).toBe("sorted");
  });

  test("one the User left unfiled by hand and a later run failed is still the User's choice", () => {
    // The failed re-run keeps source "user" and no Folder; it may not outrank the decision.
    expect(stateOf(held({ source: "user", status: "failed" }))).toBe("sorted");
  });

  test("one the User turned down is settled, even after a run that failed", () => {
    expect(stateOf(held())).toBe("sorted");
  });

  test("a Suggested Folder still waits, and one whose latest run failed still waits", () => {
    expect(stateOf(held({ groupId: "finance", suggested: true }))).toBe("suggested");
    expect(stateOf(held({ groupId: "finance", suggested: true, status: "failed" }))).toBe(
      "suggested",
    );
  });

  test("one Organize stopped short of is neither sorted nor one it couldn't sort", () => {
    expect(stateOf(held(), "stopped")).toBe("unsettled");
  });

  test("one still waiting, or never given to Organize, is neither", () => {
    expect(stateOf(held({ status: "pending" }), "pending")).toBe("unsettled");
    expect(stateOf(held({ status: "classifying" }), "tagging")).toBe("unsettled");
    expect(stateOf(held({ status: "waiting" }), "waiting-for-provider")).toBe("unsettled");
    expect(stateOf(undefined)).toBe("unsettled");
    expect(organizeStateOf(undefined, held())).toBe("unsettled");
  });
});

describe("which live Documents are Not sorted", () => {
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
    expect(notSortedIds([], [{ documentId: "b", ...held({ status: "failed" }) }])).toEqual(
      new Set(),
    );
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

  test("Accept all and Home's count follow live Documents only", () => {
    expect(
      suggestedIds(
        [doc("a")],
        [
          { documentId: "a", ...held({ groupId: "finance", suggested: true }) },
          { documentId: "gone", ...held({ groupId: "finance", suggested: true }) },
        ],
      ),
    ).toEqual(["a"]);
  });

  test("waiting, settled and stopped Documents are not among them", () => {
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
