import { beforeAll, describe, expect, test } from "vitest";
import type {
  Document,
  DocumentGroupAssignment,
  DocumentTextMatch,
  LibraryGroup,
  Mind,
} from "../../src/core/api";
import { agentFolderRows } from "../../src/renderer/src/agentFolders";
import { documentOrFolderChoices } from "../../src/renderer/src/components/documentOrFolder";
import {
  folderIdOfDocument,
  isListedDocument,
  meetingHitsOf,
} from "../../src/renderer/src/meetingTranscript";
import type * as Palette from "../../src/renderer/src/palette";
import {
  blockedFrom,
  meetingChoices,
  type ScopeLibrary,
  scopeChips,
  scopeChoices,
  scopeCounts,
} from "../../src/renderer/src/scope";
import { keptInsideName, scopeOutsideWalls } from "../../src/renderer/src/walls";
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
  const meetingGroupsOf = (found: DocumentTextMatch[], translate: typeof en) =>
    palette.meetingTextGroup(
      palette.meetingTextItems(found, [transcript, lease, orphan], [weekly], translate),
    );

  test("is its Note's, in its own Said in meetings group, with the time as its Transcript shows it, in English and Chinese", () => {
    const [english] = meetingGroupsOf([hit(transcript.id, 7_000)], en);
    expect(english?.id).toBe("meetingText");
    expect(english?.items).toEqual([
      expect.objectContaining({
        kind: "passage",
        documentId: transcript.id,
        mindId: weekly.id,
        name: "Weekly call · Transcript, 00:07",
        meta: "",
      }),
    ]);
    const [chinese] = meetingGroupsOf([hit(transcript.id, 727_000)], zh);
    expect(chinese?.items[0]).toMatchObject({ name: "Weekly call · 转写稿 12:07" });
    const [timeless] = meetingGroupsOf([hit(transcript.id, null)], en);
    expect(timeless?.items[0]).toMatchObject({ name: "Weekly call · Transcript" });
  });

  test("is never under the Documents' words, where another Document's hit is its own", () => {
    const groups = palette.documentTextGroup(
      [hit(transcript.id, 1_000), hit(orphan.id, 1_000), hit(lease.id, null)],
      [transcript, orphan, lease],
      en,
    );
    expect(groups.map((group) => group.id)).toEqual(["documentText"]);
    expect(groups[0]?.items).toEqual([
      expect.objectContaining({ documentId: lease.id, mindId: null, name: "Pier lease" }),
    ]);
  });

  test("of a Note that isn't here shows nothing", () => {
    expect(meetingGroupsOf([hit(orphan.id, 1_000)], en)).toEqual([]);
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

  test('is found in the "@" picker by words said in it, as its Note\'s choice, in English and Chinese', () => {
    const found = new Map([
      [transcript.id, hit(transcript.id, 1_000)],
      [lease.id, hit(lease.id, null)],
    ]);
    expect(
      meetingChoices(library(true), none, found, []).map(({ id, name, meeting }) => ({
        id,
        name,
        meeting,
      })),
    ).toEqual([{ id: transcript.id, name: "Weekly call · Transcript, 00:01", meeting: true }]);
    expect(meetingChoices({ ...library(true), t: zh }, none, found, [])[0]?.name).toBe(
      "Weekly call · 转写稿 00:01",
    );
    // Not twice: once offered by its name, or once in the scope, and never without its Note.
    const byName = scopeChoices(library(true), none, "weekly");
    expect(meetingChoices(library(true), none, found, byName)).toEqual([]);
    expect(
      meetingChoices(library(true), { ...none, documentIds: [transcript.id] }, found, []),
    ).toEqual([]);
    expect(meetingChoices(library(false), none, found, [])).toEqual([]);
  });

  test("Check against a Document… offers it by its Note's name and counts it in its Note's Folder", () => {
    const choices = documentOrFolderChoices(library(true), "");
    expect(choices.find((choice) => choice.id === "g-harbour")).toMatchObject({ count: 1 });
    expect(choices.filter((choice) => choice.kind === "document").map((each) => each.name)).toEqual(
      ["Pier lease", "Weekly call · Transcript"],
    );
  });
});

describe("The lines about meetings an earlier version filed apart", () => {
  test("say it in these words, one meeting and several, in English and Chinese", () => {
    expect(translate("en", "meetings.leftApart.one")).toBe(
      "1 meeting left apart from its Transcript, since each Folder keeps its work inside it",
    );
    expect(translate("en", "meetings.leftApart.other", { count: 3 })).toBe(
      "3 meetings left apart from their Transcripts, since each Folder keeps its work inside it",
    );
    expect(translate("en", "meetings.leftApart.show")).toBe("Show");
    expect(translate("zh-CN", "meetings.leftApart.one")).toBe(
      "1 场会议未与转写稿合并：笔记和转写稿所在的文件夹都只在本文件夹内工作",
    );
    expect(translate("zh-CN", "meetings.leftApart.other", { count: 3 })).toBe(
      "3 场会议未与转写稿合并：笔记和转写稿所在的文件夹都只在本文件夹内工作",
    );
    expect(translate("zh-CN", "meetings.leftApart.show")).toBe("查看");
    expect(translate("en", "meetings.joined", { meeting: "Weekly call", folder: "Vault" })).toBe(
      "“Weekly call” moved to “Vault” with its Transcript",
    );
    expect(translate("zh-CN", "meetings.joined", { meeting: "周会", folder: "Vault" })).toBe(
      "“周会”已随转写稿移到“Vault”",
    );
    expect(
      translate("en", "meetings.joined.transcript", { meeting: "Weekly call", folder: "Vault" }),
    ).toBe("The Transcript of “Weekly call” moved to “Vault”, beside its note");
    expect(
      translate("zh-CN", "meetings.joined.transcript", { meeting: "周会", folder: "Vault" }),
    ).toBe("“周会”的转写稿已移到“Vault”，与笔记放在一起");
    expect(translate("en", "error.transcript.tagWithNote")).toBe("Tag the meeting’s note instead.");
    expect(translate("zh-CN", "error.transcript.tagWithNote")).toBe("请改为给会议的笔记加标签。");
    // The Library's search lists meetings under Notes, as the sidebar does.
    expect(translate("en", "sidebar.notes")).toBe("Notes");
    expect(translate("zh-CN", "sidebar.notes")).toBe("笔记");
  });

  test("Don't cite the Transcript, and back, on the meeting Note's menus", () => {
    expect(translate("en", "evidence.notCited.transcript")).toBe("Don’t cite the Transcript");
    expect(translate("zh-CN", "evidence.notCited.transcript")).toBe("不引用转写稿");
    expect(translate("en", "evidence.citeAgain.transcript")).toBe("Cite the Transcript again");
    expect(translate("zh-CN", "evidence.citeAgain.transcript")).toBe("重新引用转写稿");
  });
});

describe("A meeting's Transcript is placed where its Note is", () => {
  const vault: LibraryGroup = { ...folder("g-vault", "Vault"), keepInside: true };
  const inVault = note("m-vault", "Weekly call", vault.id);
  const owned = document("d-owned", "Transcript · Weekly call", inVault.id);
  const filed = { documentId: lease.id, groupId: vault.id };
  const walls = {
    groups: [vault],
    assignments: [filed],
    documents: [lease, owned],
    minds: [inVault],
  };

  test("behind its Note's wall, as a Document filed there is", () => {
    expect(keptInsideName(walls, owned.id, null)).toBe("Vault");
    expect(keptInsideName(walls, owned.id, vault.id)).toBeNull();
    expect(keptInsideName({ ...walls, minds: [] }, owned.id, null)).toBeNull();
    const scope = { folderIds: [], tagIds: [], documentIds: [owned.id, lease.id] };
    expect(scopeOutsideWalls(walls, scope, null)?.documentIds).toEqual([]);
    expect(scopeOutsideWalls(walls, scope, vault.id)?.documentIds).toEqual([owned.id, lease.id]);
  });

  test("in Get info's Folder, its Note's", () => {
    const state = { library: { assignments: [filed] }, minds: [inVault] };
    expect(folderIdOfDocument(state, owned)).toBe(vault.id);
    expect(folderIdOfDocument(state, lease)).toBe(vault.id);
    expect(folderIdOfDocument({ ...state, minds: [] }, owned)).toBeNull();
  });

  test('so a Note behind the same wall may pick it in the "@" picker, and one outside may not', () => {
    const scope: ScopeLibrary = {
      folders: [],
      groups: [vault],
      tags: [],
      documents: [owned],
      assignments: [],
      minds: [inVault],
      t: en,
    };
    const [choice] = scopeChoices(scope, { folderIds: [], tagIds: [], documentIds: [] }, "weekly");
    expect(choice).toMatchObject({ id: owned.id, walled: vault.id, meeting: true });
    if (!choice) throw new Error("Not offered.");
    expect(blockedFrom(scope, choice, vault.id)).toBe(false);
    expect(blockedFrom(scope, choice, null)).toBe(true);
  });

  test("and the Library's search finds it as its Note's", () => {
    const found = new Map([
      [owned.id, hit(owned.id, 1_750)],
      [lease.id, hit(lease.id, null)],
    ]);
    expect(meetingHitsOf(found, [lease, owned], [inVault]).map((each) => each.note.id)).toEqual([
      inVault.id,
    ]);
    expect(meetingHitsOf(found, [lease, owned], [])).toEqual([]);
  });
});
