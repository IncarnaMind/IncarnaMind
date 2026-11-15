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
import { pendingPart } from "../../src/shared/claimParts";
import { createTempDataFolder, startCore } from "../helpers/core";

/* The version before a part of a check could rest on its Passage or keep a first reading: this core with the newest content schema it understands set back to 59. */
vi.mock("../../src/core/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  CONTENT_SCHEMA_VERSION: 59,
}));

/** The content schema version `restsOnPassage` and `firstReading` came with (#3118). */
const RESTS_ON_PASSAGE = 60;

const SENTENCE = "Spring tides come at new and full moon.";
const part = {
  ...pendingPart({ span: { start: 0, end: SENTENCE.length }, kind: "fact" }),
  verdict: "supported" as const,
  providerId: "openrouter",
  modelId: "perplexity/pplx-decider-v1.2",
  checkedAt: "2026-11-15T10:00:00.000Z",
  restsOnPassage: true as const,
  firstReading: {
    verdict: "supported" as const,
    providerId: "openrouter",
    modelId: "perplexity/pplx-decider-v1.2",
  },
};
const mark = {
  id: "check-1",
  request: "r1",
  action: "check-against-documents",
  state: "supported",
  reason: null,
  detail: null,
  providerId: "openrouter",
  modelId: "perplexity/pplx-decider-v1.2",
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
  checkedAt: "2026-11-15T10:00:00.000Z",
  parts: [part],
};

function sentenceOf(doc: Y.Doc): Y.XmlText {
  const paragraph = doc.getXmlFragment(MIND_CONTENT_FIELD).get(0);
  const text = paragraph instanceof Y.XmlElement ? paragraph.get(0) : null;
  if (!(text instanceof Y.XmlText)) throw new Error("No sentence.");
  return text;
}

function keptOf(state: Uint8Array) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const stored: { parts?: { restsOnPassage?: true; firstReading?: unknown }[] } | undefined =
    sentenceOf(doc).toDelta()[0]?.attributes?.[CLAIM_CHECK_MARK];
  return stored?.parts?.map((each) => [each.restsOnPassage, each.firstReading !== undefined]);
}

describe("a version from before a Mark could rest on its Passage", () => {
  // protects=a version that doesn't know `restsOnPassage` and `firstReading` opens the Note read-only, so it can't write a check's part again without them and show a line the Mark withholds as its quote; fails_when=the older version may write the part without the two fields
  test("opens the Note read-only and never strips what its parts keep", async () => {
    expect(CONTENT_SCHEMA_VERSION).toBe(59);
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Tides" });
    const written = new Y.Doc();
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.setAttribute("id", "block-1");
    const text = new Y.XmlText();
    text.insert(0, SENTENCE, { [CLAIM_CHECK_MARK]: mark });
    paragraph.insert(0, [text]);
    written.getXmlFragment(MIND_CONTENT_FIELD).push([paragraph]);
    written.getMap(MIND_SETTINGS_FIELD).set(CONTENT_SCHEMA_VERSION_KEY, RESTS_ON_PASSAGE);
    await core.applyMindUpdate(mind.id, Y.encodeStateAsUpdate(written));

    const opened = await core.openMind(mind.id);
    expect(opened.access).toBe("read-only");
    expect(keptOf(opened.state)).toEqual([[true, true]]);

    const doc = new Y.Doc();
    Y.applyUpdate(doc, opened.state);
    const sent: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => sent.push(update));
    const { restsOnPassage: _rests, firstReading: _reading, ...stripped } = part;
    sentenceOf(doc).format(0, SENTENCE.length, {
      [CLAIM_CHECK_MARK]: { ...mark, parts: [stripped] },
    });
    await expect(core.applyMindUpdate(mind.id, sent[0] as Uint8Array)).rejects.toThrow(
      MindReadOnlyError,
    );
    expect(keptOf((await core.openMind(mind.id)).state)).toEqual([[true, true]]);
  });
});
