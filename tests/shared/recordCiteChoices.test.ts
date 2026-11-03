import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { MIND_SETTINGS_FIELD } from "../../src/core/api";
import { readRecordCiteChoices, writeRecordCiteChoice } from "../../src/shared/recordCiteChoices";

const settings = () => new Y.Doc().getMap(MIND_SETTINGS_FIELD);
const choice = (documentId: string, contentHash = `${documentId}-hash`) => ({
  documentId,
  contentHash,
});

describe("record-cite choices in a Note's settings", () => {
  test("keep a source's Document with the version it was chosen at", () => {
    const map = settings();
    writeRecordCiteChoice(map, "smith dep", choice("doc-1"));
    expect(readRecordCiteChoices(map)["smith dep"]).toEqual(choice("doc-1"));
    expect(structuredClone(readRecordCiteChoices(map))).toEqual(readRecordCiteChoices(map));
  });

  test("one key for each source: choosing again replaces only that source's", () => {
    const map = settings();
    writeRecordCiteChoice(map, "smith dep", choice("doc-1"));
    writeRecordCiteChoice(map, "bates:PL:000123:000123", choice("doc-2"));
    writeRecordCiteChoice(map, "bates:PL:000200:000200", choice("doc-4"));
    writeRecordCiteChoice(map, "smith dep", choice("doc-3"));
    expect(readRecordCiteChoices(map)).toEqual({
      "smith dep": choice("doc-3"),
      "bates:PL:000123:000123": choice("doc-2"),
      "bates:PL:000200:000200": choice("doc-4"),
    });
    expect(map.get("recordCites:smith dep")).toEqual(choice("doc-3"));
  });

  test("drop malformed, unversioned and old aggregate values instead of guessing", () => {
    const map = settings();
    map.set("recordCites", { previous: choice("doc-1"), choices: { legacy: choice("doc-1") } });
    map.set("recordCites:good", { ...choice("doc-1"), location: { kind: "page", from: 3, to: 3 } });
    map.set("recordCites:missingId", { contentHash: "hash" });
    map.set("recordCites:missingHash", { documentId: "doc-2" });
    map.set("recordCites:empty", { documentId: "", contentHash: "" });
    expect(readRecordCiteChoices(map)).toEqual({ good: choice("doc-1") });
  });

  test("choices of two sources made at once both survive a sync", () => {
    const one = new Y.Doc();
    const two = new Y.Doc();
    writeRecordCiteChoice(one.getMap(MIND_SETTINGS_FIELD), "smith dep", choice("doc-1"));
    writeRecordCiteChoice(two.getMap(MIND_SETTINGS_FIELD), "ex 7", choice("doc-2"));
    const fromOne = Y.encodeStateAsUpdate(one);
    const fromTwo = Y.encodeStateAsUpdate(two);
    Y.applyUpdate(one, fromTwo);
    Y.applyUpdate(two, fromOne);
    for (const doc of [one, two]) {
      expect(readRecordCiteChoices(doc.getMap(MIND_SETTINGS_FIELD))).toEqual({
        "smith dep": choice("doc-1"),
        "ex 7": choice("doc-2"),
      });
    }
  });
});
