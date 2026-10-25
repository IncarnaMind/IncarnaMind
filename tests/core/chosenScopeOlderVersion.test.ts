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
 * The version before a check in the Mind's chosen scope (#1623): its core is this one with the
 * newest content schema it understands set back to 25, whose card would name the Mind's Folder,
 * or every Document, for a check made in one Document.
 */
vi.mock("../../src/core/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  CONTENT_SCHEMA_VERSION: 25,
}));

/** The content schema version `chosen` came with: what a Mind written since records. */
const CHOSEN = 26;

const SENTENCE = "The Employee may work from home two days a week.";
const SCOPE = { folderIds: [], tagIds: [], documentIds: ["agreement"] };

describe("a version from before checks in the Mind's chosen scope", () => {
  // protects=a version that doesn't know `chosen` opens a Mind holding it read-only, so it can't misname where the check looked, and can't drop or overwrite the Mind's scope; fails_when=it opens writable, or its write reaches the stored scope; no_claim=how the newer version shows it.
  test("opens a Mind with a check made in its chosen scope read-only, and its writes can't touch the Mind's scope", async () => {
    expect(CONTENT_SCHEMA_VERSION).toBe(25);
    const doc = new Y.Doc();
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.setAttribute("id", "block-1");
    const text = new Y.XmlText();
    text.insert(0, SENTENCE, {
      [CLAIM_CHECK_MARK]: {
        id: "check-1",
        request: "r1",
        action: "check-against-documents",
        state: "supported",
        text: SENTENCE,
        scope: {
          folderId: null,
          widened: false,
          chosen: { folderIds: [], tagIds: [], documentIds: ["agreement"] },
        },
        versions: [],
        excluded: [],
        checkedAt: "2026-10-23T09:00:00.000Z",
      },
    });
    paragraph.insert(0, [text]);
    doc.getXmlFragment(MIND_CONTENT_FIELD).push([paragraph]);
    const settings = doc.getMap(MIND_SETTINGS_FIELD);
    settings.set(CONTENT_SCHEMA_VERSION_KEY, CHOSEN);
    settings.set("scope", SCOPE);

    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Summary" });
    await core.applyMindUpdate(mind.id, Y.encodeStateAsUpdate(doc));

    const opened = await core.openMind(mind.id);
    expect(opened.access).toBe("read-only");

    // Its window, which doesn't know the Mind's scope, picks a model and clears the scope: refused.
    const theirs = new Y.Doc();
    Y.applyUpdate(theirs, opened.state);
    const sent: Uint8Array[] = [];
    theirs.on("update", (update: Uint8Array) => sent.push(update));
    theirs.transact(() => {
      const shared = theirs.getMap(MIND_SETTINGS_FIELD);
      shared.set("model", { providerId: "p", modelId: "m" });
      shared.delete("scope");
    });
    await expect(core.applyMindUpdate(mind.id, sent[0] as Uint8Array)).rejects.toThrow(
      MindReadOnlyError,
    );
    const stored = new Y.Doc();
    Y.applyUpdate(stored, (await core.openMind(mind.id)).state);
    expect(stored.getMap(MIND_SETTINGS_FIELD).get("scope")).toEqual(SCOPE);
  });
});
