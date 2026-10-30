import { getSchema, type JSONContent } from "@tiptap/core";
import { expect, test } from "vitest";
import { CITATION_NODE, CLAIM_CHECK_MARK, type ClaimCheckAttributes } from "../../src/core/api";
import { claimsOf } from "../../src/renderer/src/editor/claimChecks";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";

const schema = getSchema(noteExtensions());

function checked(text: string, via: string[]): ClaimCheckAttributes {
  return {
    id: "id-check",
    request: "r1",
    action: "check-against-documents",
    state: "supported",
    reason: null,
    detail: null,
    providerId: null,
    modelId: null,
    text,
    evidence: null,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: false },
    versions: [],
    excluded: [],
    checkedAt: "2026-10-30T09:00:00.000Z",
    recordCites: [{ raw: "Id. at 46:1", outcome: "supported", via }],
  };
}

const docOf = (before: string, check: ClaimCheckAttributes) => {
  const mark = [{ type: CLAIM_CHECK_MARK, attrs: check }];
  const blocks: JSONContent[] = [
    { type: "paragraph", attrs: { id: "before" }, content: [{ type: "text", text: before }] },
    {
      type: "paragraph",
      attrs: { id: "this" },
      content: [
        { type: "text", text: "He left (Id. at 46:1) ", marks: mark },
        {
          type: CITATION_NODE,
          attrs: { documentId: "memo", documentName: "Memo", quote: "He left", check: "found" },
        },
        { type: "text", text: ".", marks: mark },
      ],
    },
  ];
  return schema.nodeFromJSON({ type: "doc", content: blocks });
};

const context = { versions: null, folderId: null, scope: null };

test("an Id. in a sentence with a Citation reads the Note as it holds the sentence, Citation and all", () => {
  // Checks read the sentence without its Citation; its record cites, with it, as they were checked.
  const check = checked("He left (Id. at 46:1) .", ["Smith Dep. 45:3"]);
  const shown = (before: string) => claimsOf(docOf(before, check), context).claims[0]?.shown;

  expect(shown("He said yes (Smith Dep. 45:3).")).toEqual({ state: "supported" });
  expect(shown("He said yes (Jones Dep. 45:3).")).toEqual({
    state: "needs-recheck",
    why: "referent",
  });
});
