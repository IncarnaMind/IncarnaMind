/**
 * After a check, only what needs the reader is marked (#3358): a sentence with no mark beside it
 * was found Supported. What needs a look, what wasn't checked, a check still running and a first
 * reading keep their marks; with every result shown, every checked sentence has one again.
 */
import { getSchema, type JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { CLAIM_CHECK_MARK, type ClaimCheckAttributes } from "../../src/core";
import { claimsOf, markShown } from "../../src/renderer/src/editor/claimChecks";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { everyCheckResultOf, setEveryCheckResult } from "../../src/shared/everyCheckResult";

const schema = getSchema(noteExtensions());

function checked(
  sentence: string,
  state: ClaimCheckAttributes["state"],
  more: Partial<ClaimCheckAttributes> = {},
): JSONContent {
  const check: ClaimCheckAttributes = {
    id: `check-${sentence}`,
    request: "r1",
    action: "check-against-documents",
    state,
    reason: null,
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
    checkedAt: "2026-11-18T10:00:00.000Z",
    ...more,
  };
  return {
    type: "paragraph",
    content: [{ type: "text", text: sentence, marks: [{ type: CLAIM_CHECK_MARK, attrs: check }] }],
  };
}

const SENTENCES: [string, JSONContent][] = [
  ["supported", checked("Tides turn twice a day.", "supported")],
  ["unsupported", checked("The harbour opens at noon.", "unsupported")],
  ["contradicted", checked("Boats leave at dusk.", "contradicted")],
  ["not checked", checked("The quay is 40 metres long.", "not-checked", { reason: "refused" })],
  ["checking", checked("The pier was built in 1890.", "checking")],
  [
    "own view",
    checked("It is the prettiest harbour.", "unsupported", {
      unsupported: { word: "own-view" } as ClaimCheckAttributes["unsupported"],
    }),
  ],
];

const shownOf = (everyResult: boolean) => {
  const doc = schema.nodeFromJSON({ type: "doc", content: SENTENCES.map(([, node]) => node) });
  const { claims } = claimsOf(doc, {
    footing: "not-yet-known",
    versions: null,
    folderId: null,
    scope: null,
  });
  return claims.map((claim) => [claim.shown.state, markShown(claim, everyResult)]);
};

describe("Which marks show after a check", () => {
  // protects=by default a Supported sentence and its writer's own view show no mark, while what needs a look, what wasn't checked and a check still running do, so a sentence with nothing beside it is a Supported one and never one not checked; with every result shown, every mark shows (#3358); fails_when=a Supported mark shows by default, a Not checked or needs-a-look mark is hidden, or every result leaves one out; no_claim=the marks' look.
  test("only what needs the reader, unless every result is shown", () => {
    expect(shownOf(false)).toEqual([
      ["supported", false],
      ["unsupported", true],
      ["contradicted", true],
      ["not-checked", true],
      ["checking", true],
      ["own-view", false],
    ]);
    expect(shownOf(true).every(([, shown]) => shown)).toBe(true);
  });

  // protects=the switch is kept in the Note's own settings, off until the User turns it on, so it goes wherever the Note goes and another copy of the Note sees it (#3358); fails_when=it starts on, isn't kept, or doesn't reach another copy; no_claim=where the switch is drawn.
  test("the switch is the Note's own, off by default, and reaches another copy", () => {
    const here = new Y.Doc();
    const there = new Y.Doc();
    here.on("update", (update: Uint8Array) => Y.applyUpdate(there, update));
    expect(everyCheckResultOf(here)).toBe(false);
    setEveryCheckResult(here, true);
    expect(everyCheckResultOf(there)).toBe(true);
    setEveryCheckResult(here, false);
    expect(everyCheckResultOf(there)).toBe(false);
  });
});
