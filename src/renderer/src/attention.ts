/**
 * The Documents the sidebar's "Needs attention" status counts (#2308): Organize
 * failed on them, or waits for something the User can act on. Pure: no store,
 * no bridge, so the tests import it.
 */

import type { Document, DocumentGroupAssignment, LibraryGroup } from "../../core/api";
import type { Language } from "../../core/language";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { organizeStateOf } from "./organizeOutcome";
import { type Sort, sorted } from "./sort";
import { documentFields } from "./sortFields";
import { reviewIds, toReviewOf } from "./toReview";

type Translate = (key: MessageKey, params?: MessageParams) => string;

type Held = Pick<
  DocumentGroupAssignment,
  "documentId" | "status" | "groupId" | "source" | "suggested" | "error"
>;

/** Waiting for these is a status of its own, not a Document the sidebar sends the User to. */
const WAITING_STATUSES: ReadonlySet<string> = new Set(["rate-limit", "auth", "plan-limit"]);

export function attentionIds(
  documents: readonly Pick<Document, "id" | "tagging">[],
  assignments: readonly Held[],
): string[] {
  const held = new Map(assignments.map((item) => [item.documentId, item]));
  return documents.flatMap((document) => {
    const item = held.get(document.id);
    const state = organizeStateOf(document, item);
    if (state.manual) return [];
    if (state.run === "failed") return [document.id];
    const waits = state.run === "waiting" && !WAITING_STATUSES.has(item?.error?.kind ?? "");
    return waits ? [document.id] : [];
  });
}

/** The attention Documents in the order the Library shows them: To review's, then the page's. */
export function attentionOrder(
  documents: readonly Document[],
  folders: readonly LibraryGroup[],
  assignments: readonly DocumentGroupAssignment[],
  sort: Sort | null,
  t: Translate,
  language: Language,
): string[] {
  const attention = new Set(attentionIds(documents, assignments));
  if (attention.size === 0) return [];
  const held = new Map(assignments.map((item) => [item.documentId, item]));
  const ordered = sorted(documents, sort, documentFields(t), language);
  const notSorted = ordered.flatMap((document) =>
    organizeStateOf(document, held.get(document.id)).place === "notSorted" ? [document.id] : [],
  );
  const first = [...reviewIds(toReviewOf(ordered, folders, assignments)), ...notSorted].filter(
    (id) => attention.has(id),
  );
  const seen = new Set(first);
  return [
    ...first,
    ...ordered.flatMap((document) =>
      attention.has(document.id) && !seen.has(document.id) ? [document.id] : [],
    ),
  ];
}
