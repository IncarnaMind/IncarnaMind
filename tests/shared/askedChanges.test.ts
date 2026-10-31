import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { type AnswerToolCall, MIND_CONTENT_FIELD, PROPOSAL_DELETE_MARK } from "../../src/core/api";
import { appliedAsAsked, askedFor } from "../../src/shared/askedChanges";
import { recordProposalRequest } from "../../src/shared/proposals";

const MIND = "mind-1";
const REQUEST = "request-1";

/** A Mind holding `text` of the User's, `request` recorded in it; `removes` marks the text for deletion. */
function mindHolding(
  text: string,
  { request = REQUEST, removes = false }: { request?: string; removes?: boolean } = {},
): Y.Doc {
  const doc = new Y.Doc();
  recordProposalRequest(doc, request, {
    source: "answer-added",
    providerId: "anthropic",
    modelId: "claude-haiku-5-5",
    createdAt: "2026-10-31T09:00:00.000Z",
    requested: "edit",
  });
  const block = new Y.XmlElement("paragraph");
  const content = new Y.XmlText();
  content.insert(0, text, removes ? { [PROPOSAL_DELETE_MARK]: { id: "proposal-1", request } } : {});
  block.insert(0, [content]);
  doc.getXmlFragment(MIND_CONTENT_FIELD).insert(0, [block]);
  return doc;
}

const editCall = (mindId: string, request: string): AnswerToolCall => ({
  id: "call-1",
  tool: "edit_mind",
  source: "minds",
  input: {},
  status: "done",
  resultCount: null,
  mindChange: { mindId, created: false, request, proposals: 1 },
});

describe("Whether the window applies an asked-for change at once (#880)", () => {
  // protects=a change that takes out most of the User's own text isn't applied, even though the User asked for it, so the core and the evals never read it as made; fails_when=it reads as applied; no_claim=how the window applies a change.
  test("a held change isn't applied", () => {
    const doc = mindHolding("The pension paragraph goes.", { removes: true });
    expect(askedFor(doc, REQUEST)).toBe(true);
    expect(appliedAsAsked(doc, { mindId: MIND, request: REQUEST }, [editCall(MIND, REQUEST)])).toBe(
      false,
    );
  });

  // protects=an asked-for change that keeps most of the text is applied; fails_when=it reads as waiting, so a claim it backs is flagged; no_claim=none beyond protects.
  test("an asked-for change that keeps most of the text is applied", () => {
    const doc = mindHolding("The pension paragraph goes.");
    expect(appliedAsAsked(doc, { mindId: MIND, request: REQUEST }, [editCall(MIND, REQUEST)])).toBe(
      true,
    );
  });

  // protects=a change recorded in the Mind but in no call's request isn't applied; fails_when=it reads as applied; no_claim=none beyond protects.
  test("a change no call asked for isn't applied", () => {
    const doc = mindHolding("The pension paragraph goes.", { request: "other-request" });
    expect(askedFor(doc, "other-request")).toBe(true);
    expect(
      appliedAsAsked(doc, { mindId: MIND, request: "other-request" }, [editCall(MIND, REQUEST)]),
    ).toBe(false);
  });
});
