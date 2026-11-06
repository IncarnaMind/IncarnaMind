import { beforeEach, describe, expect, test, vi } from "vitest";
import type {
  Document,
  DocumentGroupAssignment,
  LibraryGroup,
  LibrarySnapshot,
  ProviderErrorKind,
} from "../../src/core/api";

/*
 * The Folders Organize made for a run (#2308): Undo, or a run that never started, takes away
 * only those that hold nothing, a Conversation filed in one since included; and when a run
 * fails, its own failure is what the User is told, even if taking the Folders back fails too.
 */

const bridge = vi.hoisted(() => ({
  groups: [] as LibraryGroup[],
  conversations: [] as { id: string; folderId: string | null }[],
  deleted: [] as string[],
  deleteFails: false,
}));

vi.mock("../../src/renderer/src/core", () => ({
  core: {
    on: () => () => undefined,
    getLibrary: async () => ({
      groups: bridge.groups.filter((group) => !bridge.deleted.includes(group.id)),
      assignments: [],
      settings: {
        classifier: { kind: "chat", choice: { providerId: "anthropic", modelId: "haiku" } },
        organizeWith: null,
        automatic: false,
        taggingStopped: [],
      },
    }),
    listConversations: async () => bridge.conversations,
    deleteLibraryGroup: async (id: string) => {
      if (bridge.deleteFails) throw new Error("The Folder couldn't be deleted.");
      bridge.deleted.push(id);
      return { minds: [], conversations: [] };
    },
    proposeFolders: async () => bridge.groups,
    classifyDocuments: async () => {
      throw new Error("The model is down.");
    },
  },
}));

const { removeEmpty } = await import("../../src/renderer/src/organizeRun");
const { organizeDocuments } = await import("../../src/renderer/src/organizeDocuments");
const { useAppStore } = await import("../../src/renderer/src/store");
const { documentsOfCause } = await import("../../src/renderer/src/organizeFix");

const folder = (id: string, name: string): LibraryGroup => ({
  id,
  name,
  description: "",
  parentId: null,
  countsOwnFiles: false,
  keepInside: false,
  createdAt: "",
  updatedAt: "",
});

beforeEach(() => {
  bridge.groups = [folder("f-tax", "Tax"), folder("f-trips", "Trips")];
  bridge.conversations = [];
  bridge.deleted = [];
  bridge.deleteFails = false;
  useAppStore.setState({ minds: [], library: null });
});

describe("the Folders Organize made", () => {
  test("one a Conversation was filed into since stays; the empty one goes", async () => {
    bridge.conversations = [{ id: "c-1", folderId: "f-trips" }];

    expect(await removeEmpty(bridge.groups)).toEqual(["f-tax"]);
    expect(bridge.deleted).toEqual(["f-tax"]);
  });

  test("a run that fails says its own failure, even when taking its Folders back fails too", async () => {
    await useAppStore.getState().refreshLibrary();
    useAppStore.setState((state) =>
      state.library ? { library: { ...state.library, groups: [] } } : {},
    );
    bridge.deleteFails = true;
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(organizeDocuments(["d-1"])).rejects.toThrow("The model is down.");
    expect(logged).toHaveBeenCalledWith(
      "The Folders Organize made couldn't be taken back.",
      expect.objectContaining({ message: "The Folder couldn't be deleted." }),
    );
    logged.mockRestore();
  });
});

describe("the Documents a cause covers", () => {
  test("the credit list spans To review's blocks, and leaves another cause and a manual place out (#2535)", () => {
    const doc = (id: string): Document =>
      ({ id, name: id, tagging: "tagged", linkedFolderId: null }) as Document;
    const held = (
      documentId: string,
      kind: ProviderErrorKind,
      over: Partial<DocumentGroupAssignment> = {},
    ): DocumentGroupAssignment =>
      ({
        documentId,
        groupId: null,
        source: "automatic",
        suggested: false,
        status: "failed",
        error: { kind, message: "" },
        model: null,
        ...over,
      }) as DocumentGroupAssignment;
    useAppStore.setState({
      documents: [
        doc("unsorted-1"),
        doc("unsorted-2"),
        doc("suggested"),
        doc("refused"),
        doc("manual"),
      ],
      examples: null,
      otherExamples: [],
      library: {
        groups: [],
        deletedGroups: [],
        assignments: [
          held("unsorted-1", "out-of-credit"),
          held("unsorted-2", "out-of-credit"),
          held("suggested", "out-of-credit", { groupId: "f-invoice", suggested: true }),
          held("refused", "auth"),
          held("manual", "out-of-credit", { groupId: "f-invoice", source: "user" }),
        ],
        settings: {
          classifier: { kind: "automatic" },
          organizeWith: null,
          automatic: false,
          taggingStopped: [],
        },
        automaticDefault: false,
      } as LibrarySnapshot,
    });
    expect(documentsOfCause("credit")).toEqual(["unsorted-1", "unsorted-2", "suggested"]);
    expect(documentsOfCause("keyRefused")).toEqual(["refused"]);
  });
});
