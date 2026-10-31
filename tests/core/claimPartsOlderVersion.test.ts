import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  type ClaimCheckPart,
  CONTENT_SCHEMA_VERSION,
  CONTENT_SCHEMA_VERSION_KEY,
  MIND_CONTENT_FIELD,
  MIND_SETTINGS_FIELD,
  MindReadOnlyError,
} from "../../src/core";
import { readOpinionSentences, writeOpinionSentences } from "../../src/shared/opinions";
import { createTempDataFolder, startCore } from "../helpers/core";

/*
 * The version before a sentence's check kept its parts (#2002): a build that reads one content
 * schema older than this one, whose editor writes a marked sentence back without the parts it
 * doesn't know, and whose settings don't know the opinions a check left out.
 */
const real = vi.hoisted(() => ({ version: 0 }));

vi.mock("../../src/core/api", async (importOriginal) => {
  const actual = await importOriginal<{ CONTENT_SCHEMA_VERSION: number }>();
  real.version = actual.CONTENT_SCHEMA_VERSION;
  return { ...actual, CONTENT_SCHEMA_VERSION: actual.CONTENT_SCHEMA_VERSION - 1 };
});

const FACT = "Revenue rose 8% in 2025";
const SENTENCE = `${FACT}, and we think the outlook is good.`;
const PURE = "We think the team did well.";
const OPINIONS = "opinionSentences";

const part = (start: number, end: number, kind: ClaimCheckPart["kind"]): ClaimCheckPart => ({
  span: { start, end },
  kind,
  verdict: kind === "fact" ? "supported" : null,
  evidence:
    kind === "fact"
      ? [
          {
            passageId: "passage",
            documentId: "results",
            documentName: "Results",
            contentHash: "v1",
            quote: "Revenue rose 8% in 2025.",
            pageFrom: 1,
            pageTo: 1,
            location: null,
            check: "found",
            checkReason: null,
          },
        ]
      : [],
  says: null,
  unsupported: null,
  calculation: null,
  reason: null,
  detail: null,
  versions: [{ documentId: "results", contentHash: "v1" }],
  excluded: [],
  citedCaseUnchecked: false,
  citedCaseFound: false,
});

const check: ClaimCheckAttributes = {
  id: "check-1",
  request: "run-1",
  action: "check-against-documents",
  state: "supported",
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
  versions: [{ documentId: "results", contentHash: "v1" }],
  excluded: [],
  checkedAt: "2026-10-29T12:00:00.000Z",
  parts: [part(0, FACT.length, "fact"), part(FACT.length + 2, SENTENCE.length - 1, "opinion")],
};

/** A Note with a sentence checked in parts and an opinion a check left out, written by this version. */
function newerNote(): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    const checked = new Y.XmlElement("paragraph");
    checked.setAttribute("id", "checked");
    const words = new Y.XmlText();
    words.insert(0, SENTENCE, { [CLAIM_CHECK_MARK]: check });
    checked.insert(0, [words]);
    const pure = new Y.XmlElement("paragraph");
    pure.setAttribute("id", "pure");
    const opinion = new Y.XmlText();
    opinion.insert(0, PURE);
    pure.insert(0, [opinion]);
    doc.getXmlFragment(MIND_CONTENT_FIELD).push([checked, pure]);
    doc.getMap(MIND_SETTINGS_FIELD).set(CONTENT_SCHEMA_VERSION_KEY, real.version);
  });
  writeOpinionSentences(doc, [
    {
      id: "opinion-1",
      blockId: "pure",
      text: PURE,
      occurrence: 0,
      parts: [part(0, PURE.length, "opinion")],
    },
  ]);
  return doc;
}

/** What the older editor sends after `change`, from the Note as it opened. */
function theirChange(state: Uint8Array, change: (doc: Y.Doc) => void): Uint8Array {
  const theirs = new Y.Doc();
  Y.applyUpdate(theirs, state);
  const sent: Uint8Array[] = [];
  theirs.on("update", (update: Uint8Array) => sent.push(update));
  theirs.transact(() => change(theirs));
  const [update] = sent;
  if (!update) throw new Error("The older editor changed nothing.");
  return update;
}

const markedWords = (doc: Y.Doc) => {
  const checked = doc
    .getXmlFragment(MIND_CONTENT_FIELD)
    .toArray()
    .find(
      (element): element is Y.XmlElement =>
        element instanceof Y.XmlElement && element.getAttribute("id") === "checked",
    );
  const [words] = checked?.toArray() ?? [];
  if (!(words instanceof Y.XmlText)) throw new Error("The checked sentence is gone.");
  return words;
};

const storedMark = (doc: Y.Doc) =>
  (markedWords(doc).toDelta() as { attributes?: Record<string, ClaimCheckAttributes> }[])[0]
    ?.attributes?.[CLAIM_CHECK_MARK];

describe("a version from before a sentence's check kept its parts", () => {
  // protects=a build one content schema older opens a Note holding a parts mark and the opinions a check left out read-only, so its editor can't write the mark back without its parts or drop the opinions; fails_when=the parts' version is not above the reader's, the Note opens writable, or either write reaches what is stored; no_claim=how the newer version shows them.
  test("opens a Note with parts read-only, and refuses a mark without parts and a dropped opinion list", async () => {
    expect(CONTENT_SCHEMA_VERSION).toBe(real.version - 1);
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Results" });
    await core.applyMindUpdate(mind.id, Y.encodeStateAsUpdate(newerNote()));

    const opened = await core.openMind(mind.id);
    expect(opened.access).toBe("read-only");

    // Its editor knows the mark but not its parts: it writes the mark back without them.
    const withoutParts = theirChange(opened.state, (doc) => {
      const { parts: _parts, ...known } = check;
      markedWords(doc).format(0, SENTENCE.length, { [CLAIM_CHECK_MARK]: known });
    });
    await expect(core.applyMindUpdate(mind.id, withoutParts)).rejects.toThrow(MindReadOnlyError);

    // Its settings don't know the opinions left out: it drops their key.
    const withoutOpinions = theirChange(opened.state, (doc) => {
      doc.getMap(MIND_SETTINGS_FIELD).delete(OPINIONS);
    });
    await expect(core.applyMindUpdate(mind.id, withoutOpinions)).rejects.toThrow(MindReadOnlyError);

    const stored = new Y.Doc();
    Y.applyUpdate(stored, (await core.openMind(mind.id)).state);
    expect(storedMark(stored)?.parts).toEqual(check.parts);
    expect(readOpinionSentences(stored).map((each) => each.text)).toEqual([PURE]);
    expect(stored.getMap(MIND_SETTINGS_FIELD).get(CONTENT_SCHEMA_VERSION_KEY)).toBe(real.version);
  });
});
