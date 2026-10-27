import { getSchema, type JSONContent } from "@tiptap/core";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import {
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  MIND_CONTENT_FIELD,
  type SearchScope,
} from "../../src/core/api";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { chooseHomeNextStep, type HomeNote } from "../../src/renderer/src/homeNextStep";
import { readNoteState } from "../../src/renderer/src/noteState";
import { translate } from "../../src/shared/i18n";
import { setMindScope } from "../../src/shared/mindScope";
import { recordCheckUnread } from "../../src/shared/unreadFiles";

/*
 * A check's own scope — a Folder, a Tag, or Documents the User picked — that could not read a
 * file may be missing evidence: the badge and Recent stay amber, and Home must not call the note
 * ready. A search of all Documents stays green with the unread count.
 */

const AT = "2026-10-26T12:00:00.000Z";
const SENTENCE = "Spring tides happen at new and full moon.";
const schema = getSchema(noteExtensions());
const mind = {
  id: "own",
  title: "Tides",
  autoTitle: "",
  kind: "mind",
  folderId: null,
  createdAt: AT,
  updatedAt: AT,
};

function checked(scope: ClaimCheckAttributes["scope"]): JSONContent {
  const attrs: ClaimCheckAttributes = {
    id: "check",
    request: "r1",
    action: "check-against-documents",
    state: "supported",
    reason: null,
    detail: null,
    providerId: null,
    modelId: null,
    text: SENTENCE,
    evidence: null,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope,
    versions: [],
    excluded: [],
    checkedAt: AT,
  };
  return {
    type: "paragraph",
    content: [{ type: "text", text: SENTENCE, marks: [{ type: CLAIM_CHECK_MARK, attrs }] }],
  };
}

/** The note the check ran in, with one supported claim and one file its scope couldn't read. */
function readingOf(scope: ClaimCheckAttributes["scope"], search: SearchScope | null) {
  const doc = new Y.Doc();
  prosemirrorToYXmlFragment(
    schema.nodeFromJSON({ type: "doc", content: [checked(scope)] }),
    doc.getXmlFragment(MIND_CONTENT_FIELD),
  );
  if (search) setMindScope(doc, search);
  recordCheckUnread(
    doc,
    "r1",
    [
      {
        id: "locked",
        name: "Locked.pdf",
        reason: "password",
        extension: null,
        documentId: null,
        pages: [],
      },
    ],
    new Set(["r1"]),
  );
  const reading = readNoteState({
    doc,
    documents: [],
    keptCitationTexts: [],
    folderId: scope.folderId,
  });
  doc.destroy();
  return reading;
}

const homeNote = (reading: ReturnType<typeof readingOf>): HomeNote => ({
  mind,
  health: reading.health,
  state: reading.state,
});

const choose = (reading: ReturnType<typeof readingOf>, exported: boolean) =>
  chooseHomeNextStep({
    hasDocuments: true,
    answers: [],
    note: homeNote(reading),
    exported,
    saved: null,
  });

const CASES: readonly {
  name: string;
  scope: ClaimCheckAttributes["scope"];
  search: SearchScope | null;
  narrowed: boolean;
}[] = [
  {
    name: "a Folder",
    scope: { folderId: "tides", widened: false },
    search: null,
    narrowed: true,
  },
  {
    name: "a Tag",
    scope: {
      folderId: null,
      widened: false,
      chosen: { folderIds: [], tagIds: ["tag-tides"], documentIds: [] },
    },
    search: { folderIds: [], tagIds: ["tag-tides"], documentIds: [] },
    narrowed: true,
  },
  {
    name: "Documents the User picked",
    scope: {
      folderId: null,
      widened: false,
      chosen: { folderIds: [], tagIds: [], documentIds: ["doc-tides"] },
    },
    search: { folderIds: [], tagIds: [], documentIds: ["doc-tides"] },
    narrowed: true,
  },
  {
    name: "all Documents",
    scope: { folderId: null, widened: false },
    search: null,
    narrowed: false,
  },
];

const UNREAD = {
  en: "“Tides” · 1 file couldn’t be read",
  "zh-CN": "“Tides” · 1 个文件未能读取",
} as const;

describe("Home and a file a check could not read", () => {
  test.each(CASES)("$name, before and after the first export", ({ scope, search, narrowed }) => {
    const reading = readingOf(scope, search);
    expect(reading.health.toCheck).toHaveLength(0);
    expect(reading.health.unsupported).toHaveLength(0);
    if (narrowed) {
      expect(reading.state).toMatchObject({ kind: "needs-look", look: 0, unread: 1 });
      expect(reading.state?.unreadMatters).toBe(true);
      expect(choose(reading, false)).toMatchObject({ kind: "look", count: 0 });
      expect(choose(reading, true)).toMatchObject({ kind: "look", count: 0 });
      for (const language of ["en", "zh-CN"] as const) {
        expect(
          translate(language, "home.next.unread", {
            mind: "Tides",
            files: translate(language, "unread.count.one", { count: "1" }),
          }),
        ).toBe(UNREAD[language]);
      }
      return;
    }
    // A search of all Documents leaves the note green with the count, as the badge and Recent do.
    expect(reading.state).toMatchObject({ kind: "checked", unread: 1, unreadMatters: false });
    expect(choose(reading, false)).toMatchObject({ kind: "export" });
    expect(choose(reading, true)).toBeNull();
  });
});
