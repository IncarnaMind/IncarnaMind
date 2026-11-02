import { describe, expect, test } from "vitest";
import type { Document, DocumentStatus, LibraryGroup, Tag } from "../../src/core/api";
import {
  documentOrFolderChoices,
  documentOrFolderScope,
  keptFrom,
} from "../../src/renderer/src/components/documentOrFolder";
import type { ScopeLibrary } from "../../src/renderer/src/scope";

const group = (id: string, name: string): LibraryGroup => ({
  id,
  name,
  description: "",
  parentId: null,
  countsOwnFiles: false,
  keepInside: false,
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
  readHiddenSheets: false,
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

  describe("a Folder that keeps its work inside it", () => {
    const filed = (groupId: string, documentId: string, source: "user" | "automatic") => ({
      groupId,
      documentId,
      source,
      suggested: false,
      status: "classified" as const,
      error: null,
      model: null,
    });
    const matter = { ...group("g-matter", "Matter"), keepInside: true };
    const zhMatter = { ...group("g-zh-matter", "案件"), keepInside: true };
    const brief = doc("d-brief", "Brief");
    const zhBrief = doc("d-zh-brief", "答辩状");
    const suggested = doc("d-suggested", "Suggested");
    const walled: ScopeLibrary = {
      ...library,
      groups: [finance, chinese, empty, matter, zhMatter],
      documents: [lease, rental, scan, brief, zhBrief, suggested],
      assignments: [
        ...(library.assignments ?? []),
        filed(matter.id, brief.id, "user"),
        filed(zhMatter.id, zhBrief.id, "user"),
        filed(matter.id, suggested.id, "automatic"),
      ],
    };
    const kept = (wall: string | null, query = "") =>
      Object.fromEntries(
        documentOrFolderChoices(walled, query).map((choice) => [
          choice.id,
          keptFrom(walled, choice, wall),
        ]),
      );

    test("from inside, can read only its Folder and what the User filed in it", () => {
      for (const [wall, own, filed] of [
        [matter.id, matter.id, brief.id],
        [zhMatter.id, zhMatter.id, zhBrief.id],
      ] as const) {
        const reasons = kept(wall);
        expect(reasons[own]).toBeNull();
        expect(reasons[filed]).toBeNull();
        const outside = Object.entries(reasons).filter(([id]) => id !== own && id !== filed);
        expect(outside.length).toBeGreaterThan(0);
        for (const [, why] of outside) expect(why).toBe("outside");
      }
      expect(kept(zhMatter.id, "dbz")).toEqual({ [zhBrief.id]: null });
    });

    test("from outside, names the wall that keeps a Folder or Document inside it", () => {
      const reasons = kept(null);
      expect(reasons[matter.id]).toEqual({ inside: "Matter" });
      expect(reasons[brief.id]).toEqual({ inside: "Matter" });
      expect(reasons[suggested.id]).toEqual({ inside: "Matter" });
      expect(reasons[zhMatter.id]).toEqual({ inside: "案件" });
      expect(kept(null, "dbz")).toEqual({ [zhBrief.id]: { inside: "案件" } });
      for (const free of [finance.id, chinese.id, lease.id, rental.id]) {
        expect(reasons[free]).toBeNull();
      }
    });
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
