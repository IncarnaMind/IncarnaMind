import { describe, expect, test, vi } from "vitest";
import type { Document, DocumentGroupAssignment, LibraryGroup, Mind } from "../../src/core/api";
import {
  type ReadableLibrary,
  readableFrom,
} from "../../src/renderer/src/components/documentOrFolder";
import { documentOf } from "../helpers/storeDocuments";

/*
 * What a sentence's Document actions may open or read for a Note (#1554): ⌘K, the assistant and
 * Choose the Citation… take a Document only on the Note's side of a Folder wall, and only one with
 * text, as the shared picker offers them.
 */

vi.mock("../../src/renderer/src/core", () => ({ core: { on: () => () => undefined } }));

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
const document = (id: string, status: Document["status"] = "ready") => ({
  id,
  status,
  meetingMindId: null,
  speakers: null,
});

const library: ReadableLibrary = {
  groups: [folder("wall", "Client A", true), folder("general", "General")],
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

describe("A Document a Note's sentence may take now", () => {
  const note = (id: string, folderId: string | null): Mind => ({
    id,
    title: id,
    autoTitle: "",
    kind: "mind",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    folderId,
  });

  test("is its own meeting's Transcript, which is where its Note is", async () => {
    const { useAppStore } = await import("../../src/renderer/src/store");
    const { readableNow } = await import("../../src/renderer/src/readableDocuments");
    useAppStore.setState({
      minds: [note("meeting", "wall"), note("elsewhere", null)],
      documents: [documentOf("transcript", { meetingMindId: "meeting" })],
      library: {
        groups: [folder("wall", "Client A", true)],
        deletedGroups: [],
        assignments: [],
        settings: {
          classifier: { kind: "automatic" },
          automatic: false,
          organizeWith: null,
          taggingStopped: [],
        },
        automaticDefault: false,
      },
    });
    expect(readableNow("meeting", { kind: "document", id: "transcript" })).toBe(true);
    expect(readableNow("elsewhere", { kind: "document", id: "transcript" })).toBe(false);
  });
});
