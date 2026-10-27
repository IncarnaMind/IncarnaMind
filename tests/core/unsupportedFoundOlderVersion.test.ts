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

/*
 * The version before a check says it found a Passage about the sentence
 * (#1608): its core is this one with the newest content schema it understands
 * set back to 28, whose editor strips the reason's `found`, so the card would
 * say Not found.
 */
vi.mock("../../src/core/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  CONTENT_SCHEMA_VERSION: 28,
}));

/** The content schema version `found` came with: what a Mind written since records. */
const FOUND = 29;

const SENTENCE = "The tenant may keep a pet with the landlord's written consent.";

const foundMark = {
  id: "check-1",
  request: "r1",
  action: "check-against-documents",
  state: "unsupported",
  reason: null,
  detail: null,
  text: SENTENCE,
  evidence: null,
  says: null,
  unsupported: {
    reason: "No Document states anything about a pet.",
    covered: null,
    uncovered: null,
    found: true,
  },
  scope: { folderId: null, widened: false },
  versions: [],
  excluded: [],
  checkedAt: "2026-10-25T10:00:00.000Z",
};

function mindWithFoundMark(): Y.Doc {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.setAttribute("id", "block-1");
  const text = new Y.XmlText();
  text.insert(0, SENTENCE, { [CLAIM_CHECK_MARK]: foundMark });
  paragraph.insert(0, [text]);
  doc.getXmlFragment(MIND_CONTENT_FIELD).push([paragraph]);
  doc.getMap(MIND_SETTINGS_FIELD).set(CONTENT_SCHEMA_VERSION_KEY, FOUND);
  return doc;
}

const sentenceOf = (doc: Y.Doc) => {
  const paragraph = doc.getXmlFragment(MIND_CONTENT_FIELD).get(0);
  const text = paragraph instanceof Y.XmlElement ? paragraph.get(0) : null;
  if (!(text instanceof Y.XmlText)) throw new Error("No sentence.");
  return text;
};

const foundOf = (doc: Y.Doc) => {
  const attributes: Record<string, unknown> | undefined = sentenceOf(doc).toDelta()[0]?.attributes;
  return readClaimCheck(attributes?.[CLAIM_CHECK_MARK])?.unsupported?.found;
};

describe("a version from before a check says it found a Passage about the sentence", () => {
  test("opens the Mind read-only and keeps `found`, so it doesn't lose Unsupported for Not found", async () => {
    expect(CONTENT_SCHEMA_VERSION).toBe(28);
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Lease" });
    await core.applyMindUpdate(mind.id, Y.encodeStateAsUpdate(mindWithFoundMark()));

    const opened = await core.openMind(mind.id);
    expect(opened.access).toBe("read-only");
    expect(foundOf(docFrom(opened.state))).toBe(true);

    // Its editor, which doesn't know `found`, would write the reason back without it: refused.
    const doc = docFrom(opened.state);
    const sent: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => sent.push(update));
    const { found: _found, ...withoutFound } = foundMark.unsupported;
    sentenceOf(doc).format(0, SENTENCE.length, {
      [CLAIM_CHECK_MARK]: { ...foundMark, unsupported: withoutFound },
    });
    await expect(core.applyMindUpdate(mind.id, sent[0] as Uint8Array)).rejects.toThrow(
      MindReadOnlyError,
    );

    expect(foundOf(docFrom((await core.openMind(mind.id)).state))).toBe(true);
  });
});

function docFrom(state: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc;
}
