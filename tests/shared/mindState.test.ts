import { expect, test } from "vitest";
import * as Y from "yjs";
import { CLAIM_CHECK_MARK, MIND_CONTENT_FIELD } from "../../src/core/api";
import { fingerprintOfMind } from "../../src/shared/mindState";
import { targetHash } from "../../src/shared/proposals";

const sentence = "Revenue was £4,980m, up from £4,860m a year earlier.";
const mark = { id: "check-1", state: "supported", text: sentence, kept: null };

/** A Note of one checked sentence, as the Yjs document of the copy that wrote its mark. */
function noteWith(check: Record<string, unknown>): Y.Doc {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.setAttribute("id", "p");
  const text = new Y.XmlText(sentence);
  paragraph.insert(0, [text]);
  doc.getXmlFragment(MIND_CONTENT_FIELD).insert(0, [paragraph]);
  text.format(0, sentence.length, { [CLAIM_CHECK_MARK]: check });
  return doc;
}

/** The same Note in another copy, which has only what the update carried. */
function takenBy(doc: Y.Doc): Y.Doc {
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
  return other;
}

// An editor sets a check's `fromAnswer` to undefined when it writes a check that names no Answer
// (#2313), and `remainder` when the check has none; the update leaves both keys out.
test.each([
  { writer: "the schedule's copy", taker: "the core", key: "fromAnswer" },
  { writer: "the core", taker: "the schedule's copy", key: "fromAnswer" },
  { writer: "the schedule's copy", taker: "the core", key: "remainder" },
])("a check's $key set to undefined in $writer reads as no $key in $taker", ({ key }) => {
  const written = noteWith({ ...mark, [key]: undefined });
  const taken = takenBy(written);
  expect(fingerprintOfMind(written)).toBe(fingerprintOfMind(taken));
  expect(fingerprintOfMind(written)).toBe(fingerprintOfMind(noteWith(mark)));
});

test("a check's fromAnswer that names an Answer travels with the update and is read", () => {
  const written = noteWith({ ...mark, fromAnswer: "answer-1" });
  expect(fingerprintOfMind(takenBy(written))).toBe(fingerprintOfMind(written));
  expect(fingerprintOfMind(written)).not.toBe(fingerprintOfMind(noteWith(mark)));
});

test("a Note with no undefined value has the fingerprint it had before", () => {
  const doc = noteWith({ ...mark, fromAnswer: "answer-1" });
  const paragraph = doc.getXmlFragment(MIND_CONTENT_FIELD).get(0);
  expect(paragraph.toString()).toBe(
    `<paragraph id="p"><claimCheck fromAnswer="answer-1" id="check-1" kept="null" state="supported" text="${sentence}">${sentence}</claimCheck></paragraph>`,
  );
  expect(fingerprintOfMind(doc)).toBe(targetHash(targetHash(paragraph.toString())));
});
