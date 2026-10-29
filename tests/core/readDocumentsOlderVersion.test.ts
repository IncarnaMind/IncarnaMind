import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  CLAIM_CHECK_MARK,
  CONTENT_SCHEMA_VERSION,
  CONTENT_SCHEMA_VERSION_KEY,
  MIND_CONTENT_FIELD,
  MIND_SETTINGS_FIELD,
  MindReadOnlyError,
} from "../../src/core";
import { readClaimCheck } from "../../src/shared/claimChecks";
import { createTempDataFolder, startCore } from "../helpers/core";

vi.mock("../../src/core/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  CONTENT_SCHEMA_VERSION: 34,
}));

const SENTENCE = "The lease has no break clause.";
const readDocuments = [
  {
    documentId: "lease",
    documentName: "Lease.pdf",
    contentHash: "hash-1",
    locations: [{ kind: "page" as const, from: 1, to: 2 }],
  },
];
const mark = {
  id: "check-1",
  request: "r1",
  action: "check-against-documents",
  state: "supported",
  reason: null,
  detail: null,
  text: SENTENCE,
  evidence: null,
  says: null,
  unsupported: null,
  scope: { folderId: null, widened: false },
  versions: [],
  excluded: [],
  checkedAt: "2026-10-29T10:00:00.000Z",
  readDocuments,
};

function mindWithWholeRead(): Y.Doc {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.setAttribute("id", "block-1");
  const text = new Y.XmlText();
  text.insert(0, SENTENCE, { [CLAIM_CHECK_MARK]: mark });
  paragraph.insert(0, [text]);
  doc.getXmlFragment(MIND_CONTENT_FIELD).push([paragraph]);
  doc.getMap(MIND_SETTINGS_FIELD).set(CONTENT_SCHEMA_VERSION_KEY, 35);
  return doc;
}

function docFrom(state: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc;
}

function sentenceOf(doc: Y.Doc): Y.XmlText {
  const paragraph = doc.getXmlFragment(MIND_CONTENT_FIELD).get(0);
  const text = paragraph instanceof Y.XmlElement ? paragraph.get(0) : null;
  if (!(text instanceof Y.XmlText)) throw new Error("No sentence.");
  return text;
}

function locationsOf(doc: Y.Doc) {
  const attributes: Record<string, unknown> | undefined = sentenceOf(doc).toDelta()[0]?.attributes;
  return readClaimCheck(attributes?.[CLAIM_CHECK_MARK])?.readDocuments;
}

describe("a version from before whole-read absence evidence", () => {
  test("opens the Note read-only and never strips its read Locations", async () => {
    expect(CONTENT_SCHEMA_VERSION).toBe(34);
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Lease" });
    await core.applyMindUpdate(mind.id, Y.encodeStateAsUpdate(mindWithWholeRead()));

    const opened = await core.openMind(mind.id);
    expect(opened.access).toBe("read-only");
    expect(locationsOf(docFrom(opened.state))).toEqual(readDocuments);

    const doc = docFrom(opened.state);
    const sent: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => sent.push(update));
    const { readDocuments: _readDocuments, ...withoutWholeRead } = mark;
    sentenceOf(doc).format(0, SENTENCE.length, { [CLAIM_CHECK_MARK]: withoutWholeRead });
    await expect(core.applyMindUpdate(mind.id, sent[0] as Uint8Array)).rejects.toThrow(
      MindReadOnlyError,
    );
    expect(locationsOf(docFrom((await core.openMind(mind.id)).state))).toEqual(readDocuments);
  });
});
