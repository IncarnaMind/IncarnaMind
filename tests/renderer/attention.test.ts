import { describe, expect, test } from "vitest";
import type { Document, DocumentGroupAssignment } from "../../src/core/api";
import { attentionIds, attentionOrder } from "../../src/renderer/src/attention";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

const en = (key: MessageKey, params?: MessageParams) => translate("en", key, params);

const doc = (id: string, over: Partial<Document> = {}): Document =>
  ({
    id,
    name: id,
    title: null,
    kind: "text",
    status: "ready",
    tagging: "tagged",
    createdAt: "2026-10-01T00:00:00.000Z",
    modifiedAt: "2026-10-01T00:00:00.000Z",
    ...over,
  }) as Document;

const held = (
  documentId: string,
  over: Partial<DocumentGroupAssignment> = {},
): DocumentGroupAssignment =>
  ({
    documentId,
    groupId: null,
    source: "automatic",
    status: "classified",
    error: null,
    model: null,
    ...over,
  }) as DocumentGroupAssignment;

describe("what the sidebar says needs attention", () => {
  test("a Document Organize failed on, or one still waiting", () => {
    expect(
      attentionIds(
        [doc("a"), doc("b"), doc("c")],
        [held("a", { status: "failed" }), held("b", { status: "waiting" }), held("c")],
      ),
    ).toEqual(["a", "b"]);
  });

  test("not one the User settled by hand, even when a later run failed", () => {
    expect(attentionIds([doc("a")], [held("a", { status: "failed", source: "user" })])).toEqual([]);
  });

  test("waiting for a rate limit, a refused key or a plan's limit is a status of its own", () => {
    expect(
      attentionIds(
        [doc("a"), doc("b"), doc("c")],
        [
          held("a", { status: "waiting", error: { kind: "rate-limit", message: "" } }),
          held("b", { status: "waiting", error: { kind: "auth", message: "" } }),
          held("c", { status: "waiting", error: { kind: "plan-limit", message: "" } }),
        ],
      ),
    ).toEqual([]);
  });

  test("a failed run is one whatever it met", () => {
    expect(
      attentionIds(
        [doc("a")],
        [held("a", { status: "failed", error: { kind: "rate-limit", message: "" } })],
      ),
    ).toEqual(["a"]);
  });
});

describe("the order Review walks them in", () => {
  test("those Organize couldn't sort first, then the page's order", () => {
    const documents = [
      doc("waiting", { name: "A waiting" }),
      doc("filed", { name: "B filed" }),
      doc("unsorted", { name: "C unsorted" }),
    ];
    const assignments = [
      held("filed", { groupId: "finance", status: "failed" }),
      held("unsorted", { status: "failed" }),
      held("waiting", { status: "waiting" }),
    ];
    expect(
      attentionOrder(
        documents,
        assignments,
        { key: "name", direction: "asc", foldersFirst: true },
        en,
        "en",
      ),
    ).toEqual(["unsorted", "waiting", "filed"]);
  });

  test("nothing when nothing needs attention", () => {
    expect(attentionOrder([doc("a")], [held("a")], null, en, "en")).toEqual([]);
  });
});
