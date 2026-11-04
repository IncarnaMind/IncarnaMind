import { describe, expect, test } from "vitest";
import type { DocumentGroupAssignment, LibraryGroup } from "../../src/core/api";
import { readableFrom } from "../../src/renderer/src/components/documentOrFolder";
import type { ScopeLibrary } from "../../src/renderer/src/scope";

/*
 * What a sentence's Document actions may open or read for a Note (#1554): ⌘K, the assistant and
 * Choose the Citation… take a Document only on the Note's side of a Folder wall, and only one with
 * text, as the shared picker offers them.
 */

const folder = (id: string, name: string, keepInside = false): LibraryGroup => ({
  id,
  name,
  description: "",
  parentId: null,
  countsOwnFiles: false,
  keepInside,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
});
const filed = (documentId: string, groupId: string): DocumentGroupAssignment => ({
  documentId,
  groupId,
  source: "user",
  suggested: false,
  status: "classified",
  error: null,
  model: null,
});
const document = (id: string, status = "ready") =>
  ({
    id,
    name: id,
    kind: "pdf",
    status,
    fileStatus: "available",
    folderId: null,
    tags: [],
  }) as never;

const library: ScopeLibrary = {
  folders: [],
  groups: [folder("wall", "Client A", true), folder("general", "General")],
  tags: [],
  documents: [document("lease"), document("notice"), document("scan", "no-text")],
  assignments: [filed("lease", "wall"), filed("notice", "general")],
};

describe("A Document a sentence's actions may take", () => {
  test("is one on the Note's side of a Folder wall", () => {
    expect(readableFrom(library, null, { kind: "document", id: "notice" })).toBe(true);
    expect(readableFrom(library, null, { kind: "document", id: "lease" })).toBe(false);
    expect(readableFrom(library, "wall", { kind: "document", id: "lease" })).toBe(true);
    expect(readableFrom(library, "wall", { kind: "document", id: "notice" })).toBe(false);
    expect(readableFrom(library, null, { kind: "folder", id: "wall" })).toBe(false);
    expect(readableFrom(library, null, { kind: "folder", id: "general" })).toBe(true);
  });

  test("is one with text", () => {
    expect(readableFrom(library, null, { kind: "document", id: "scan" })).toBe(false);
    expect(readableFrom(library, null, { kind: "document", id: "notice" })).toBe(true);
  });
});
