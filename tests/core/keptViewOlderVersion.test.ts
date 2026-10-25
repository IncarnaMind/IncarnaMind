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
import { createTempDataFolder, startCore } from "../helpers/core";

/*
 * The version before Keep as my view (#1111): its core is this one with the
 * newest content schema it understands set back to 24, whose editor strips
 * the mark's `kept`, so the sentence would count and be checked again.
 */
vi.mock("../../src/core/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  CONTENT_SCHEMA_VERSION: 24,
}));

/** The content schema version `kept` came with: what a Mind written since records. */
const KEPT = 25;

const SENTENCE = "Experiments usually show quasi-Newton methods are faster.";

const keptMark = {
  id: "check-1",
  request: "r1",
  action: "check-against-documents",
  state: "unsupported",
  reason: null,
  detail: null,
  text: SENTENCE,
  evidence: null,
  says: null,
  unsupported: { reason: null, covered: "the speed comparison", uncovered: "robustness" },
  scope: { folderId: null, widened: false },
  versions: [],
  excluded: [],
  checkedAt: "2026-10-18T09:00:00.000Z",
  kept: true,
};

function mindWithKeptMark(): Y.Doc {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.setAttribute("id", "block-1");
  const text = new Y.XmlText();
  text.insert(0, SENTENCE, { [CLAIM_CHECK_MARK]: keptMark });
  paragraph.insert(0, [text]);
  doc.getXmlFragment(MIND_CONTENT_FIELD).push([paragraph]);
  doc.getMap(MIND_SETTINGS_FIELD).set(CONTENT_SCHEMA_VERSION_KEY, KEPT);
  return doc;
}

describe("a version from before Keep as my view", () => {
  // protects=a version that doesn't know `kept` opens a Mind holding it read-only, so its editor can't strip it; fails_when=it opens writable, or takes the mark back without `kept`; no_claim=how the newer version shows it.
  test("opens a Mind with a sentence kept as the User's view read-only, so it can't drop it", async () => {
    expect(CONTENT_SCHEMA_VERSION).toBe(24);
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Tutorial notes" });
    await core.applyMindUpdate(mind.id, Y.encodeStateAsUpdate(mindWithKeptMark()));

    const opened = await core.openMind(mind.id);
    expect(opened.access).toBe("read-only");

    // Its editor, which doesn't know `kept`, would write the mark back without it: refused.
    const doc = new Y.Doc();
    Y.applyUpdate(doc, opened.state);
    const sent: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => sent.push(update));
    const paragraph = doc.getXmlFragment(MIND_CONTENT_FIELD).get(0);
    const text = paragraph instanceof Y.XmlElement ? paragraph.get(0) : null;
    if (!(text instanceof Y.XmlText)) throw new Error("No sentence.");
    const { kept: _kept, ...stripped } = keptMark;
    text.format(0, SENTENCE.length, { [CLAIM_CHECK_MARK]: stripped });
    await expect(core.applyMindUpdate(mind.id, sent[0] as Uint8Array)).rejects.toThrow(
      MindReadOnlyError,
    );
  });
});
