import { describe, expect, test } from "vitest";
import type { Document, LibraryGroup } from "../../src/core/api";
import { reviewIds, reviewSummary, toReviewOf } from "../../src/renderer/src/toReview";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

const en = (key: MessageKey, params?: MessageParams) => translate("en", key, params);
const zh = (key: MessageKey, params?: MessageParams) => translate("zh-CN", key, params);

const doc = (id: string) => ({ id, name: id }) as Document;
const folder = (id: string, name = id): LibraryGroup => ({
  id,
  name,
  description: "",
  countsOwnFiles: false,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});
const waiting = (documentId: string, groupId: string | null, suggested = true) => ({
  documentId,
  groupId,
  suggested,
});

describe("what To review holds", () => {
  const finance = folder("finance", "Finance");
  const thesis = folder("thesis", "Thesis");
  const documents = ["a", "b", "c", "d", "e"].map(doc);

  test("lists the Documents waiting in a Suggested Folder, by Folder with the most first", () => {
    const review = toReviewOf(
      documents,
      [finance, thesis],
      [
        waiting("a", "thesis"),
        waiting("b", "finance"),
        waiting("c", "thesis"),
        waiting("d", "finance", false),
      ],
    );

    expect(review.count).toBe(3);
    expect(review.groups.map((each) => [each.folder.id, each.documents.map((d) => d.id)])).toEqual([
      ["thesis", ["a", "c"]],
      ["finance", ["b"]],
    ]);
    expect(reviewIds(review)).toEqual(["a", "c", "b"]);
  });

  test("keeps the Folders in their order when as many wait in each", () => {
    const review = toReviewOf(
      documents,
      [finance, thesis],
      [waiting("a", "thesis"), waiting("b", "finance")],
    );
    expect(review.groups.map((each) => each.folder.id)).toEqual(["finance", "thesis"]);
  });

  test("leaves out a Document in no Folder, one whose Folder is gone and one that is not on the page", () => {
    const review = toReviewOf(
      [doc("a"), doc("b"), doc("c")],
      [finance],
      [
        waiting("a", null),
        waiting("b", "deleted"),
        waiting("c", "finance"),
        waiting("x", "finance"),
      ],
    );
    expect(reviewIds(review)).toEqual(["c"]);
    expect(review.count).toBe(1);
  });

  test("holds nothing when nothing waits", () => {
    expect(toReviewOf(documents, [finance], [waiting("a", "finance", false)])).toEqual({
      count: 0,
      groups: [],
    });
    expect(toReviewOf([], [], [])).toEqual({ count: 0, groups: [] });
  });

  test("keeps each group in the order the Documents were given in", () => {
    const review = toReviewOf(
      [doc("c"), doc("a"), doc("b")],
      [finance],
      [waiting("a", "finance"), waiting("b", "finance"), waiting("c", "finance")],
    );
    expect(reviewIds(review)).toEqual(["c", "a", "b"]);
  });
});

describe("the summary line", () => {
  const finance = folder("finance", "Finance");
  const thesis = folder("thesis", "Thesis");
  const docs = Array.from({ length: 12 }, (_, at) => doc(`d${at}`));
  const sorted = toReviewOf(
    docs,
    [finance, thesis],
    docs.map((each, at) => waiting(each.id, at < 8 ? "finance" : "thesis")),
  );

  test("says how many were sorted and where, in English", () => {
    expect(reviewSummary(sorted, en)).toBe("Sorted 12 Documents: 8 → Finance, 4 → Thesis");
  });

  test("says it in Chinese, with the Folders quoted", () => {
    expect(reviewSummary(sorted, zh)).toBe("已整理 12 个文档：8 个 → “Finance”，4 个 → “Thesis”");
  });

  test("says one Document in the singular", () => {
    const one = toReviewOf([doc("a")], [finance], [waiting("a", "finance")]);
    expect(reviewSummary(one, en)).toBe("Sorted 1 Document: 1 → Finance");
    expect(reviewSummary(one, zh)).toBe("已整理 1 个文档：1 个 → “Finance”");
  });
});
