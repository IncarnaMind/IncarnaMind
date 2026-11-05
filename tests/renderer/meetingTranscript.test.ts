import { beforeAll, describe, expect, test } from "vitest";
import type {
  Document,
  DocumentGroupAssignment,
  DocumentTextMatch,
  LibraryGroup,
  Mind,
} from "../../src/core/api";
import { agentFolderRows } from "../../src/renderer/src/agentFolders";
import { isListedDocument } from "../../src/renderer/src/meetingTranscript";
import type * as Palette from "../../src/renderer/src/palette";
import {
  type ScopeLibrary,
  scopeChips,
  scopeChoices,
  scopeCounts,
} from "../../src/renderer/src/scope";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

/*
 * One meeting is one item (#2528): a Meeting's Transcript has no row of its own. A hit inside it
 * is its Note's, and a scope picks it by its Note's name.
 */

let palette: typeof Palette;

beforeAll(async () => {
  // The palette reaches the store, which reads the bridge the preload exposes.
  const bridge = new Proxy({}, { get: () => () => () => undefined });
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: bridge,
  };
  palette = await import("../../src/renderer/src/palette");
});

const en = (key: MessageKey, params?: MessageParams) => translate("en", key, params);
const zh = (key: MessageKey, params?: MessageParams) => translate("zh-CN", key, params);
const AT = "2026-10-13T09:00:00.000Z";

const note = (id: string, title: string, folderId: string | null): Mind => ({
  id,
  title,
  autoTitle: "",
  kind: "mind",
  createdAt: AT,
  updatedAt: AT,
  folderId,
});

const document = (id: string, name: string, meetingMindId: string | null): Document =>
  ({
    id,
    name,
    title: null,
    kind: meetingMindId === null ? "pdf" : "transcript",
    status: "ready",
    fileStatus: "available",
    meetingMindId,
  }) as Document;

const folder = (id: string, name: string): LibraryGroup => ({
  id,
  name,
  description: "",
  parentId: null,
  countsOwnFiles: false,
  keepInside: false,
  createdAt: AT,
  updatedAt: AT,
});

const hit = (documentId: string, atMs: number | null): DocumentTextMatch => ({
  documentId,
  passageId: `p-${documentId}`,
  pageFrom: 1,
  pageTo: 1,
  excerpt: "…the launch moves to November…",
  highlights: [{ start: 5, end: 11 }],
  atMs,
});

const weekly = note("m-weekly", "Weekly call", "g-harbour");
const lease = document("d-lease", "Pier lease", null);
const transcript = document("d-transcript", "Transcript · Weekly call", weekly.id);
const orphan = document("d-orphan", "Transcript · Old call", "m-gone");

describe("A meeting's Transcript in the lists", () => {
  test("has no row of its own; any other Document does", () => {
    expect([lease, transcript, orphan].filter(isListedDocument)).toEqual([lease]);
  });

  test("counts in no Folder an agent may read, nor in Not in a Folder", () => {
    const filed: Pick<DocumentGroupAssignment, "documentId" | "groupId">[] = [
      { documentId: lease.id, groupId: "g-harbour" },
    ];
    expect(agentFolderRows([folder("g-harbour", "Harbour")], [lease, transcript], filed)).toEqual([
      { id: "g-harbour", name: "Harbour", documents: 1 },
    ]);
  });
});

describe("A hit inside a meeting's Transcript", () => {
  test("is its Note's, with the time the words were said, in English and Chinese", () => {
    const [english] = palette.documentTextGroup(
      [hit(transcript.id, 727_000)],
      [transcript],
      [weekly],
      en,
    );
    expect(english?.items).toEqual([
      expect.objectContaining({
        kind: "passage",
        documentId: transcript.id,
        mindId: weekly.id,
        name: "Weekly call · Transcript, 12:07",
        meta: "",
      }),
    ]);
    const [chinese] = palette.documentTextGroup(
      [hit(transcript.id, 727_000)],
      [transcript],
      [weekly],
      zh,
    );
    expect(chinese?.items[0]).toMatchObject({ name: "Weekly call · 转写稿 12:07" });
    const [timeless] = palette.documentTextGroup(
      [hit(transcript.id, null)],
      [transcript],
      [weekly],
      en,
    );
    expect(timeless?.items[0]).toMatchObject({ name: "Weekly call · Transcript" });
  });

  test("of a Note that isn't here shows nothing, while another Document's hit is its own", () => {
    const groups = palette.documentTextGroup(
      [hit(orphan.id, 1_000), hit(lease.id, null)],
      [orphan, lease],
      [weekly],
      en,
    );
    expect(groups[0]?.items).toEqual([
      expect.objectContaining({ documentId: lease.id, mindId: null, name: "Pier lease" }),
    ]);
  });
});

describe("A meeting in a Search scope", () => {
  const library = (withNotes: boolean): ScopeLibrary => ({
    folders: [],
    groups: [folder("g-harbour", "Harbour")],
    tags: [],
    documents: [lease, transcript],
    assignments: [],
    ...(withNotes && { minds: [weekly], t: en }),
  });
  const none = { folderIds: [], tagIds: [], documentIds: [] };

  test("is picked by its Note's name, and its Transcript goes in the scope", () => {
    const documents = scopeChoices(library(true), none, "weekly").filter(
      (choice) => choice.kind === "document",
    );
    expect(documents).toEqual([
      expect.objectContaining({ id: transcript.id, name: "Weekly call · Transcript" }),
    ]);
    // Without its Notes the picker has no name for it, so it offers it nowhere.
    expect(scopeChoices(library(false), none, "weekly")).toEqual([]);
    expect(scopeChoices(library(false), none, "pier").map((choice) => choice.id)).toEqual([
      lease.id,
    ]);
  });

  test("names its chip as its Note's, and counts in its Note's Folder", () => {
    const chips = scopeChips(library(true), { ...none, documentIds: [transcript.id] });
    expect(chips.map((chip) => chip.name)).toEqual(["Weekly call · Transcript"]);
    expect(scopeCounts(library(true)).get("g-harbour")).toBe(1);
    expect(scopeCounts(library(false)).get("g-harbour")).toBe(0);
  });
});
