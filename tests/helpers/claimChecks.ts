import type { JSONContent } from "@tiptap/core";
import { CLAIM_CHECK_MARK, type ClaimCheckAttributes } from "../../src/core/api";

export function checked(
  sentence: string,
  state: ClaimCheckAttributes["state"],
  reason: ClaimCheckAttributes["reason"] = null,
  more: Partial<ClaimCheckAttributes> = {},
): JSONContent {
  const check: ClaimCheckAttributes = {
    id: `check-${sentence.length}-${state}`,
    request: "r1",
    action: "check-against-documents",
    state,
    reason,
    detail: null,
    providerId: null,
    modelId: null,
    text: sentence,
    evidence: null,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: false },
    versions: [],
    excluded: [],
    checkedAt: "2026-10-12T09:00:00.000Z",
    ...more,
  };
  return { type: "text", text: sentence, marks: [{ type: CLAIM_CHECK_MARK, attrs: check }] };
}
