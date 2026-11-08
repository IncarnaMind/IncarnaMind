import { expect, test } from "vitest";
import type { Document, LinkedFolder } from "../../src/core/api";
import { unreadAskKey } from "../../src/shared/unreadFiles";

/*
 * Each Answer shown asks the core for its scope's unread files again only when what could be unread
 * changes. While 2,000 Documents imported, asking at every new Document made 2,622 calls on the main
 * process (#2772).
 */

type Asked = Pick<Document, "id" | "status" | "failure" | "fileStatus" | "unreadParts">;
const ready = (id: string): Asked => ({
  id,
  status: "ready",
  failure: null,
  fileStatus: "available",
  unreadParts: null,
});
const folder: Pick<LinkedFolder, "id" | "unsupportedFiles"> = { id: "f1", unsupportedFiles: 2 };
const library = [ready("d1"), ready("d2")];

test("Documents that import and become ready don't change it", () => {
  const before = unreadAskKey(library, [folder]);
  const imported = [...library, ...Array.from({ length: 2000 }, (_, i) => ready(`n${i}`))];
  expect(unreadAskKey(imported, [folder])).toBe(before);
  expect(unreadAskKey([...library, { ...ready("n0"), status: "queued" }], [folder])).toBe(before);
  expect(unreadAskKey([...library, { ...ready("n0"), status: "extracting" }], [folder])).toBe(
    before,
  );
});

test("a Document that fails, has no text or is read in part changes it, and so does one that goes", () => {
  const failed: Asked = {
    ...ready("d3"),
    status: "failed",
    failure: { reason: "password-protected", message: "" },
  };
  const before = unreadAskKey(library, [folder]);
  expect(unreadAskKey([...library, failed], [folder])).not.toBe(before);
  expect(unreadAskKey([...library, { ...ready("d3"), status: "no-text" }], [folder])).not.toBe(
    before,
  );
  const cut = {
    ...ready("d3"),
    unreadParts: { hiddenSheets: ["Old"], rowsCut: [], sheetsNotRead: [] },
  };
  expect(unreadAskKey([...library, cut], [folder])).not.toBe(before);
  expect(unreadAskKey(library, [folder])).not.toBe(unreadAskKey([...library, failed], [folder]));
});

test("a Linked folder's count of files in a format not read changes it", () => {
  expect(unreadAskKey(library, [{ ...folder, unsupportedFiles: 3 }])).not.toBe(
    unreadAskKey(library, [folder]),
  );
});
