import { getSchema, type JSONContent } from "@tiptap/core";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import type { AnswerToolCall, ConversationMessage } from "../../src/core/api";
import { MIND_CONTENT_FIELD } from "../../src/core/api";
import {
  type ArrivingInMind,
  arrivingInMind,
  arrivingNow,
} from "../../src/renderer/src/arrivingChanges";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { pendingProposals, recordProposalRequest } from "../../src/shared/proposals";

/*
 * What a card leaves out of a Note's waiting count (#1325): only the changes this window is
 * applying at once, because their Answer was asked here and is still answering or applying. An
 * asked change whose Answer was stopped mid-write, or whose apply found the text changed, still
 * waits, and must count.
 */

const schema = getSchema(noteExtensions());
const MIND = "mind";
let next = 0;
const id = () => `c${++next}`;

const text = (value: string, marks?: JSONContent["marks"]): JSONContent => ({
  type: "text",
  text: value,
  ...(marks && { marks }),
});

/** A paragraph reworded under a request: its old words struck and the new ones added there. */
const reworded = (old: string, now: string, request: string): JSONContent => {
  const ref = { id: id(), request };
  return {
    type: "paragraph",
    attrs: { id: id() },
    content: [
      text(old, [{ type: "proposalDelete", attrs: ref }]),
      text(now, [{ type: "proposalInsert", attrs: ref }]),
    ],
  };
};

/** A Mind with changes under `requests`, and each request's record: `asked` or not. */
function mind(requests: readonly { request: string; asked: boolean }[]) {
  const doc = new Y.Doc();
  const blocks = prosemirrorToYXmlFragment(
    schema.nodeFromJSON({
      type: "doc",
      content: requests.flatMap(({ request }) => [
        reworded("The quarter was good.", "The quarter was solid.", request),
      ]),
    }),
    doc.getXmlFragment(MIND_CONTENT_FIELD),
  );
  for (const { request, asked } of requests) {
    recordProposalRequest(doc, request, {
      source: "answer-added",
      providerId: "provider",
      modelId: "model",
      createdAt: "2026-10-31T00:00:00.000Z",
      ...(asked && { requested: "edit" as const }),
    });
  }
  return { doc, blocks };
}

const call = (request: string): AnswerToolCall => ({
  id: `call-${++next}`,
  tool: "edit_mind",
  source: "minds",
  input: {},
  status: "done",
  resultCount: null,
  mindChange: { mindId: MIND, created: false, request, proposals: 1, changed: 1 },
});

/** How many of the Mind's pending changes the card still counts. */
const stillWaiting = (doc: Y.Doc, arrived: ArrivingInMind): number =>
  pendingProposals(doc.getXmlFragment(MIND_CONTENT_FIELD)).filter(
    (each) => !arrivingNow(doc, each.request, arrived),
  ).length;

const answer = (answerId: string, ...requests: string[]): ConversationMessage =>
  ({
    kind: "answer",
    id: answerId,
    toolCalls: requests.map(call),
  }) as unknown as ConversationMessage;

describe("The changes a card leaves out (#1325)", () => {
  // protects=a change asked before a restart, whose Answer is now stopped and never applies it, still counts; fails_when=it is left out for being asked in the Note's record; no_claim=how the card draws the count.
  test("a waiting asked change counts after a restart, with no Answer in flight", () => {
    const { doc } = mind([{ request: "r1", asked: true }]);
    // The window that asked is gone: nothing in this window is answering or applying.
    const arrived = arrivingInMind([], MIND, new Set());

    expect(arrived).toEqual({ requests: new Set(), known: new Set(), open: false });
    expect(arrivingNow(doc, "r1", arrived)).toBe(false);
    expect(stillWaiting(doc, arrived)).toBe(1);
  });

  // protects=an asked change whose apply returned nothing, because the User changed that text, still counts; fails_when=it is left out for being asked in the Note's record; no_claim=the reason the apply found nothing.
  test("a waiting asked change counts when its apply returns nothing", () => {
    const { doc } = mind([{ request: "r1", asked: true }]);
    // The stopped Answer is still in the thread, but not arriving: nothing is applying it.
    const arrived = arrivingInMind([answer("a1", "r1")], MIND, new Set());

    expect(arrived.requests).toEqual(new Set());
    expect(arrivingNow(doc, "r1", arrived)).toBe(false);
    expect(stillWaiting(doc, arrived)).toBe(1);
  });

  test("an asked change whose Answer is still arriving is left out", () => {
    const { doc } = mind([{ request: "r1", asked: true }]);
    const arrived = arrivingInMind([answer("a1", "r1")], MIND, new Set(["a1"]));

    expect(arrived.requests).toEqual(new Set(["r1"]));
    expect(arrivingNow(doc, "r1", arrived)).toBe(true);
    expect(stillWaiting(doc, arrived)).toBe(0);
  });

  test("a new request no Answer names yet is left out while an Answer is arriving, and counts after", () => {
    const { doc } = mind([{ request: "r2", asked: true }]);
    const thread = [answer("a1", "r1")];

    expect(arrivingNow(doc, "r2", arrivingInMind(thread, MIND, new Set(["a1"])))).toBe(true);
    expect(arrivingNow(doc, "r2", arrivingInMind(thread, MIND, new Set()))).toBe(false);
  });

  // protects=the core applies the asked part of an Answer's requests alone; fails_when=an unasked request beside an asked one is left out and its warning goes; no_claim=how the core decides to hold.
  test("only the asked part of an Answer's requests is left out", () => {
    const { doc } = mind([
      { request: "r1", asked: true },
      { request: "r2", asked: false },
    ]);
    const arrived = arrivingInMind([answer("a1", "r1", "r2")], MIND, new Set(["a1"]));

    expect(arrived.requests).toEqual(new Set(["r1", "r2"]));
    expect(arrivingNow(doc, "r1", arrived)).toBe(true);
    expect(arrivingNow(doc, "r2", arrived)).toBe(false);
  });

  test("an Answer's requests in another Note are no one's here", () => {
    const { doc } = mind([{ request: "r1", asked: true }]);
    const other = {
      kind: "answer",
      id: "a1",
      toolCalls: [
        {
          ...call("r1"),
          mindChange: { mindId: "other", created: false, request: "r1", proposals: 1, changed: 1 },
        },
      ],
    } as unknown as ConversationMessage;

    expect(arrivingInMind([other], MIND, new Set(["a1"]))).toEqual({
      requests: new Set(),
      known: new Set(),
      open: true,
    });
    expect(arrivingNow(doc, "r1", arrivingInMind([other], MIND, new Set(["a1"])))).toBe(true);
  });
});
