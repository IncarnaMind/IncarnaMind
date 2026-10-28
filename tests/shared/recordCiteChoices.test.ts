import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import type { CitationLocation } from "../../src/core/api";
import { MIND_SETTINGS_FIELD } from "../../src/core/api";
import { readRecordCiteChoices, writeRecordCiteChoice } from "../../src/shared/recordCiteChoices";

const location: CitationLocation = {
  kind: "page",
  from: 45,
  to: 46,
  printed: { from: "45", to: "46" },
  lines: { from: 3, to: 2 },
};

const settings = () => new Y.Doc().getMap(MIND_SETTINGS_FIELD);
const choice = (documentId: string, contentHash = `${documentId}-hash`) => ({
  documentId,
  contentHash,
  location,
});

describe("record-cite choices in a Note's existing settings", () => {
  test("stores a versioned source by alias with its exact deposition Location", () => {
    const map = settings();
    writeRecordCiteChoice(map, "smith dep", choice("doc-1"));
    expect(readRecordCiteChoices(map).choices["smith dep"]).toEqual(choice("doc-1"));
    expect(structuredClone(readRecordCiteChoices(map))).toEqual(readRecordCiteChoices(map));
  });

  test("replaces and deletes only one alias, with no stored previous referent", () => {
    const map = settings();
    writeRecordCiteChoice(map, "smith dep", choice("doc-1"));
    writeRecordCiteChoice(map, "ex 7", choice("doc-2"));
    writeRecordCiteChoice(map, "smith dep", choice("doc-3"));
    expect(readRecordCiteChoices(map)).toEqual({
      previous: null,
      choices: { "smith dep": choice("doc-3"), "ex 7": choice("doc-2") },
    });
    writeRecordCiteChoice(map, "smith dep", null);
    expect(readRecordCiteChoices(map).choices).toEqual({ "ex 7": choice("doc-2") });
    expect(map.get("recordCites:smith dep")).toBeUndefined();
    expect(map.get("recordCites:ex 7")).toEqual(choice("doc-2"));
  });

  test("drops malformed, unversioned and legacy aggregate choices instead of guessing", () => {
    const map = settings();
    map.set("recordCites", {
      previous: choice("doc-1"),
      choices: { legacy: choice("doc-1") },
    });
    map.set("recordCites:good", choice("doc-1"));
    map.set("recordCites:missingId", { contentHash: "hash", location });
    map.set("recordCites:missingHash", { documentId: "doc-2", location });
    map.set("recordCites:badLocation", {
      documentId: "doc-2",
      contentHash: "hash",
      location: { kind: "page", from: 0, to: 2 },
    });
    expect(readRecordCiteChoices(map)).toEqual({
      previous: null,
      choices: { good: choice("doc-1") },
    });
  });

  test("concurrent choices of different aliases both survive a sync", () => {
    const one = new Y.Doc();
    const two = new Y.Doc();
    writeRecordCiteChoice(one.getMap(MIND_SETTINGS_FIELD), "smith dep", choice("doc-1"));
    writeRecordCiteChoice(two.getMap(MIND_SETTINGS_FIELD), "ex 7", choice("doc-2"));
    const fromOne = Y.encodeStateAsUpdate(one);
    const fromTwo = Y.encodeStateAsUpdate(two);
    Y.applyUpdate(one, fromTwo);
    Y.applyUpdate(two, fromOne);
    for (const doc of [one, two]) {
      expect(readRecordCiteChoices(doc.getMap(MIND_SETTINGS_FIELD)).choices).toEqual({
        "smith dep": choice("doc-1"),
        "ex 7": choice("doc-2"),
      });
    }
  });
});
