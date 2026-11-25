import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type {
  Document,
  LibrarySnapshot,
  Meeting,
  Settings,
  WindowLayout,
} from "../../src/core/api";

/*
 * Record a meeting with a Document in front (#3762): its Note goes in the Folder the Library
 * places that Document in, and in none when it places it in none. A linked folder's file names a
 * folder on disk, not a Folder of the Library, so it never chooses the Note's Folder.
 */

type Stores = typeof import("../../src/renderer/src/store") &
  typeof import("../../src/renderer/src/meetings");
let stores: Stores;
const createMeeting = vi.fn(
  async (_input?: { folderId: string }) =>
    ({ id: "meeting", mindId: "note", kind: "meeting", status: "ready" }) as Meeting,
);

beforeAll(async () => {
  const bridge = new Proxy(
    {},
    {
      get: (_target, key) =>
        key === "createMeeting"
          ? createMeeting
          : key === "startMeeting"
            ? async () => undefined
            : () => () => undefined,
    },
  );
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: bridge,
  };
  stores = {
    ...(await import("../../src/renderer/src/store")),
    ...(await import("../../src/renderer/src/meetings")),
  };
});

afterEach(() => {
  createMeeting.mockClear();
  stores.useAppStore.setState({ layout: null, documents: [], library: null });
});

/** A window whose front tab is this Document, which the Library places in `groupId`, if any. */
function documentInFront(document: Partial<Document>, groupId: string | null) {
  stores.useAppStore.setState({
    settings: { device: {}, meetingAudio: "both" } as unknown as Settings,
    changeLayout: async () => null,
    layout: {
      focusedGroupId: "group",
      groups: [
        {
          id: "group",
          activeTabId: "tab",
          tabs: [{ id: "tab", item: { kind: "document", documentId: "doc" }, preview: false }],
        },
      ],
    } as unknown as WindowLayout,
    documents: [{ id: "doc", folderId: null, ...document } as Document],
    library: {
      groups: groupId ? [{ id: groupId, name: "Harbour" }] : [],
      assignments: groupId ? [{ documentId: "doc", groupId, status: "assigned" }] : [],
    } as unknown as LibrarySnapshot,
  });
}

describe("Record a meeting with a Document in front", () => {
  // protects=the meeting's Note goes in the Library Folder its Document is placed in, and in none when that Document is in none, never in the folder on disk a linked folder's file names (#3762); fails_when=the Note is filed under a folder on disk's id, which no Folder of the Library has, so it shows in no Folder
  test("files the Note where the Library places the Document, and nowhere for a linked file it places nowhere", async () => {
    documentInFront({ folderId: "linked-folder-on-disk" }, "harbour-folder");
    await stores.useMeetings.getState().record();
    expect(createMeeting).toHaveBeenLastCalledWith({ folderId: "harbour-folder" });

    documentInFront({ folderId: "linked-folder-on-disk" }, null);
    await stores.useMeetings.getState().record();
    expect(createMeeting).toHaveBeenLastCalledWith(undefined);
  });
});
