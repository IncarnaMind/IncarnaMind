import { expect, test } from "vitest";
import type { LinkedFolder } from "../../src/core/api";
import { unreadAskKey } from "../../src/shared/unreadFiles";

// Each Answer shown asks the core for its scope's unread files again only when this key changes.

type Asked = Parameters<typeof unreadAskKey>[0][number];
const ready = (id: string, linkedFolderId: string | null = "scale"): Asked => ({
  id,
  status: "ready",
  failure: null,
  fileStatus: "available",
  unreadParts: null,
  unreadPartsUnknown: false,
  linkedFolderId,
});
const folders: Pick<LinkedFolder, "id" | "unsupportedFiles">[] = [
  { id: "scale", unsupportedFiles: 0 },
  { id: "harbour", unsupportedFiles: 1 },
];
const library = [ready("d1"), ready("tides", "harbour")];
const key = (documents: readonly Asked[], linked = folders) => unreadAskKey(documents, linked);

test("Documents that import into a Linked folder holding no unread file don't change it", () => {
  const before = key(library);
  const imported = [...library, ...Array.from({ length: 2000 }, (_, i) => ready(`n${i}`))];
  expect(key(imported)).toBe(before);
  expect(key([...library, { ...ready("n0"), status: "queued" }])).toBe(before);
  expect(key([...library, ready("own", null)])).toBe(before);
});

test("a Document added to or taken from a Linked folder holding unread files changes it", () => {
  const before = key(library);
  expect(key([...library, ready("lamps", "harbour")])).not.toBe(before);
  expect(key([ready("d1")])).not.toBe(before);
});

test("a Document that fails, has no text, is read in part or can't say what it left unread changes it", () => {
  const before = key(library);
  const failed: Asked = {
    ...ready("d3"),
    status: "failed",
    failure: { reason: "password-protected", message: "" },
  };
  expect(key([...library, failed])).not.toBe(before);
  expect(key([...library, { ...ready("d3"), status: "no-text" }])).not.toBe(before);
  const cut = {
    ...ready("d3"),
    unreadParts: { hiddenSheets: ["Old"], rowsCut: [], sheetsNotRead: [] },
  };
  expect(key([...library, cut])).not.toBe(before);
  expect(key([...library, { ...ready("d3"), unreadPartsUnknown: true }])).not.toBe(before);
});

test("a failed Document that goes, is read again for another reason or goes missing changes it", () => {
  const failed: Asked = {
    ...ready("d3"),
    status: "failed",
    failure: { reason: "password-protected", message: "" },
  };
  const before = key([...library, failed]);
  expect(key(library)).not.toBe(before);
  expect(key([...library, { ...failed, failure: { reason: "unreadable", message: "" } }])).not.toBe(
    before,
  );
  expect(key([...library, { ...failed, fileStatus: "missing" }])).not.toBe(before);
});

test("a Linked folder's count of files in a format not read changes it", () => {
  const more = [
    { id: "scale", unsupportedFiles: 0 },
    { id: "harbour", unsupportedFiles: 2 },
  ];
  expect(key(library, more)).not.toBe(key(library));
});
