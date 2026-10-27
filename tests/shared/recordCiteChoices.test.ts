import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import type { CitationLocation } from "../../src/core/api";
import { MIND_SETTINGS_FIELD } from "../../src/core/api";
import {
  readRecordCiteChoices,
  writePreviousRecordCite,
  writeRecordCiteChoice,
} from "../../src/shared/recordCiteChoices";

const location: CitationLocation = {
  kind: "page",
  from: 45,
  to: 46,
  printed: { from: "45", to: "46" },
  lines: { from: 3, to: 2 },
};

const settings = () => new Y.Doc().getMap(MIND_SETTINGS_FIELD);

describe("record-cite choices in a Note's existing settings", () => {
  test("stores a source by alias with its exact deposition Location", () => {
    const map = settings();
    writeRecordCiteChoice(map, "smith dep", { documentId: "doc-1", location });
    expect(readRecordCiteChoices(map).choices["smith dep"]).toEqual({
      documentId: "doc-1",
      location,
    });
    expect(structuredClone(readRecordCiteChoices(map))).toEqual(readRecordCiteChoices(map));
  });

  test("replaces only one alias and keeps the previous record item", () => {
    const map = settings();
    writeRecordCiteChoice(map, "smith dep", { documentId: "doc-1", location });
    writePreviousRecordCite(map, { documentId: "doc-1", location });
    writeRecordCiteChoice(map, "smith dep", { documentId: "doc-2", location });
    expect(readRecordCiteChoices(map).choices["smith dep"]?.documentId).toBe("doc-2");
    expect(readRecordCiteChoices(map).previous?.documentId).toBe("doc-1");
    writeRecordCiteChoice(map, "smith dep", null);
    expect(readRecordCiteChoices(map).choices["smith dep"]).toBeUndefined();
    expect(readRecordCiteChoices(map).previous?.documentId).toBe("doc-1");
  });

  test("drops malformed choices and invalid Locations instead of guessing", () => {
    const map = settings();
    map.set("recordCites", {
      previous: { documentId: "", location },
      choices: {
        good: { documentId: "doc-1", location },
        missingId: { location },
        badLocation: { documentId: "doc-2", location: { kind: "page", from: 0, to: 2 } },
      },
    });
    expect(readRecordCiteChoices(map)).toEqual({
      previous: null,
      choices: { good: { documentId: "doc-1", location } },
    });
  });
});
