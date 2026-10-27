import { describe, expect, test } from "vitest";
import type { Document, DocumentStatus, LibraryGroup, Tag } from "../../src/core/api";
import {
  documentOrFolderChoices,
  documentOrFolderScope,
} from "../../src/renderer/src/components/documentOrFolder";
import type { ScopeLibrary } from "../../src/renderer/src/scope";

const group = (id: string, name: string): LibraryGroup => ({
  id,
  name,
  description: "",
  countsOwnFiles: false,
  createdAt: "",
  updatedAt: "",
});

const tag = (id: string, name: string): Tag => ({
  id,
  name,
  description: "",
  preset: false,
  colour: "gray",
  createdAt: "",
  updatedAt: "",
});

const doc = (id: string, name: string, status: DocumentStatus = "ready"): Document => ({
  id,
  name,
  title: null,
  kind: "pdf",
  contentHash: "",
  path: `/${id}.pdf`,
  fileStatus: "available",
  keptByApp: false,
  linkedFolderId: null,
  size: 0,
  pageCount: null,
  status,
  progress: null,
  scan: null,
  failure: null,
  unreadParts: null,
  unreadPartsUnknown: false,
  folderId: null,
  tags: [],
  tagging: "off",
  taggingError: null,
  creationDate: null,
  modifiedAt: null,
  web: null,
  reference: null,
  ownFile: null,
  notCited: false,
  found: null,
  importedAs: null,
  createdAt: "",
  updatedAt: "",
});

const finance = group("g-finance", "Finance");
const chinese = group("g-chinese", "财务");
const empty = group("g-empty", "Empty");
const lease = doc("d-lease", "Lease");
const rental = doc("d-rental", "租赁合同");
const scan = doc("d-scan", "Scan", "no-text");
const library: ScopeLibrary = {
  folders: [],
  groups: [finance, chinese, empty],
  tags: [tag("t-secret", "机密")],
  documents: [lease, rental, scan],
  assignments: [
    {
      groupId: finance.id,
      documentId: lease.id,
      source: "user",
      suggested: false,
      status: "classified",
      error: null,
      model: null,
    },
    {
      groupId: chinese.id,
      documentId: rental.id,
      source: "user",
      suggested: false,
      status: "classified",
      error: null,
      model: null,
    },
  ],
};

describe("Document-or-Folder choices", () => {
  test("match English and Chinese names, pinyin and initials, never Tags", () => {
    expect(documentOrFolderChoices(library, "lease").map((choice) => choice.id)).toEqual([
      lease.id,
    ]);
    expect(documentOrFolderChoices(library, "caiwu").map((choice) => choice.id)).toEqual([
      chinese.id,
    ]);
    expect(documentOrFolderChoices(library, "cw").map((choice) => choice.id)).toEqual([chinese.id]);
    expect(documentOrFolderChoices(library, "zulin").map((choice) => choice.id)).toEqual([
      rental.id,
    ]);
    expect(documentOrFolderChoices(library, "zl").map((choice) => choice.id)).toEqual([rental.id]);
    expect(documentOrFolderChoices(library, "").map((choice) => choice.kind)).not.toContain("tag");
  });

  test("return a SearchScope for exactly one Folder or Document", () => {
    const base = { name: "Chosen", path: [] as string[], documentKind: null } as const;
    expect(documentOrFolderScope({ ...base, kind: "folder", id: "f1" })).toEqual({
      folderIds: ["f1"],
      tagIds: [],
      documentIds: [],
    });
    expect(documentOrFolderScope({ ...base, kind: "document", id: "d1" })).toEqual({
      folderIds: [],
      tagIds: [],
      documentIds: ["d1"],
    });
  });
});
