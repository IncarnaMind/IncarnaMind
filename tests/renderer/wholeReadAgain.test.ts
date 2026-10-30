import { type Editor, getSchema, type JSONContent } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { expect, test, vi } from "vitest";
import * as Y from "yjs";
import { CLAIM_CHECK_MARK, type ClaimCheckAttributes } from "../../src/core/api";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";

/*
 * A whole read asked again from the check badge's Accept all and check goes through its card,
 * which sizes the read and asks its cost first (#1554): nothing is read from the badge itself.
 */

const checkSentences = vi.hoisted(() => vi.fn());
vi.mock("../../src/renderer/src/core", () => ({ core: { checkSentences } }));
vi.mock("../../src/renderer/src/editWithAi", () => ({ resolveProposalsIn: vi.fn() }));
vi.mock("../../src/renderer/src/modelInUse", () => ({ modelInUseOf: vi.fn() }));

const { acceptAndCheck, useChecks } = await import("../../src/renderer/src/checks");

const SENTENCE = "The lease allows pets up to 15 kg.";
const chosen = { folderIds: [], tagIds: [], documentIds: ["lease"] };
const check: ClaimCheckAttributes = {
  id: "not-found",
  request: "earlier",
  action: "check-against-documents",
  state: "unsupported",
  reason: null,
  detail: null,
  providerId: null,
  modelId: null,
  text: SENTENCE,
  evidence: null,
  says: null,
  unsupported: null,
  calculation: null,
  citedCaseUnchecked: false,
  citedCaseFound: false,
  scope: { folderId: null, widened: false },
  versions: [],
  excluded: [],
  checkedAt: "2026-10-30T00:00:00.000Z",
};

test("Accept all and check on a whole read opens its card to ask, reading nothing", async () => {
  const schema = getSchema(noteExtensions());
  const paragraph: JSONContent = {
    type: "paragraph",
    attrs: { id: "block-1" },
    content: [{ type: "text", text: SENTENCE, marks: [{ type: CLAIM_CHECK_MARK, attrs: check }] }],
  };
  const state = EditorState.create({
    doc: schema.nodeFromJSON({ type: "doc", content: [paragraph] }),
  });
  const editor = {
    isDestroyed: false,
    state,
    view: { dispatch: () => undefined },
  } as unknown as Editor;
  const shown: string[] = [];

  await acceptAndCheck(
    editor,
    "mind-1",
    new Y.Doc(),
    {
      kind: "waiting",
      changeIds: [],
      sentences: [
        { from: { blockId: "block-1", offset: 0 }, to: { blockId: "block-1", offset: 10 } },
      ],
      count: 1,
      action: "check-against-document",
      allDocuments: false,
      within: chosen,
    },
    (checkId) => shown.push(checkId),
  );

  expect(checkSentences).not.toHaveBeenCalled();
  expect(shown).toEqual(["not-found"]);
  expect(useChecks.getState().pickDocument["not-found"]).toEqual(chosen);
});
