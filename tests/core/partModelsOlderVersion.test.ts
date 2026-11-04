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

/*
 * The version before each part of a check kept the model and time that judged it (#1667): a
 * build that reads one content schema older than this one.
 */
const real = vi.hoisted(() => ({ version: 0 }));

vi.mock("../../src/core/api", async (importOriginal) => {
  const actual = await importOriginal<{ CONTENT_SCHEMA_VERSION: number }>();
  real.version = actual.CONTENT_SCHEMA_VERSION;
  return { ...actual, CONTENT_SCHEMA_VERSION: actual.CONTENT_SCHEMA_VERSION - 1 };
});

const SENTENCE = "Rent is due monthly and the tenant may keep a cat.";
const judged = (start: number, end: number, modelId: string, checkedAt: string) => ({
  ...pendingPart({ span: { start, end }, kind: "fact" }),
  verdict: "unsupported" as const,
  unsupported: { reason: null, covered: null, uncovered: null },
  decidingEvidence: null,
  providerId: "anthropic",
  modelId,
  checkedAt,
});
const parts = [
  judged(0, 19, "claude-haiku-5-5", "2026-11-04T14:20:00.000Z"),
  judged(24, 50, "claude-sonnet-5-5", "2026-11-04T14:25:00.000Z"),
];
const mark = {
  id: "check-1",
  request: "r1",
  action: "check-against-documents",
  state: "unsupported",
  reason: null,
  detail: null,
  providerId: "anthropic",
  modelId: "claude-sonnet-5-5",
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
  checkedAt: "2026-11-04T14:25:00.000Z",
  parts,
};

function mindWithPartModels(): Y.Doc {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.setAttribute("id", "block-1");
  const text = new Y.XmlText();
  text.insert(0, SENTENCE, { [CLAIM_CHECK_MARK]: mark });
  paragraph.insert(0, [text]);
  doc.getXmlFragment(MIND_CONTENT_FIELD).push([paragraph]);
  doc.getMap(MIND_SETTINGS_FIELD).set(CONTENT_SCHEMA_VERSION_KEY, real.version);
  return doc;
}

function sentenceOf(state: Uint8Array): Y.XmlText {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const paragraph = doc.getXmlFragment(MIND_CONTENT_FIELD).get(0);
  const text = paragraph instanceof Y.XmlElement ? paragraph.get(0) : null;
  if (!(text instanceof Y.XmlText)) throw new Error("No sentence.");
  return text;
}

const modelsOf = (state: Uint8Array) => {
  const stored: { parts?: { modelId?: string }[] } | undefined =
    sentenceOf(state).toDelta()[0]?.attributes?.[CLAIM_CHECK_MARK];
  return stored?.parts?.map((part) => part.modelId);
};

describe("a version from before each part kept its model", () => {
  // protects=a build one content schema older opens a Note whose parts keep their models read-only, so it can't write the parts again without them and name the newest model for every part (#1667); fails_when=a Note one schema newer opens to edit, or an update without the parts' models is kept; no_claim=that this version's number was raised, which the comments and corrections tests pin.
  test("opens the Note read-only and never strips its parts' models", async () => {
    expect(CONTENT_SCHEMA_VERSION).toBe(real.version - 1);
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Lease" });
    await core.applyMindUpdate(mind.id, Y.encodeStateAsUpdate(mindWithPartModels()));

    const opened = await core.openMind(mind.id);
    expect(opened.access).toBe("read-only");
    expect(modelsOf(opened.state)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);

    const doc = new Y.Doc();
    Y.applyUpdate(doc, opened.state);
    const sent: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => sent.push(update));
    const paragraph = doc.getXmlFragment(MIND_CONTENT_FIELD).get(0);
    const text = paragraph instanceof Y.XmlElement ? paragraph.get(0) : null;
    if (!(text instanceof Y.XmlText)) throw new Error("No sentence.");
    const stripped = parts.map(({ providerId: _p, modelId: _m, checkedAt: _c, ...part }) => part);
    text.format(0, SENTENCE.length, { [CLAIM_CHECK_MARK]: { ...mark, parts: stripped } });
    await expect(core.applyMindUpdate(mind.id, sent[0] as Uint8Array)).rejects.toThrow(
      MindReadOnlyError,
    );
    expect(modelsOf((await core.openMind(mind.id)).state)).toEqual([
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
    ]);
  });
});
