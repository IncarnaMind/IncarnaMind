import { beforeEach, describe, expect, test, vi } from "vitest";
import type {
  Document,
  DocumentGroupAssignment,
  LibrarySnapshot,
  ProviderErrorKind,
} from "../../src/core/api";

/*
 * An Organize that fails (#2308, #1569): its own failure is what the User is told, and it leaves
 * no run behind and no Review open; and the Documents each cause covers, for its fix.
 */

vi.mock("../../src/renderer/src/core", () => ({
  core: {
    on: () => () => undefined,
    getLibrary: async () => ({
      groups: [],
      assignments: [],
      settings: {
        classifier: { kind: "chat", choice: { providerId: "anthropic", modelId: "haiku" } },
        organizeWith: null,
        automatic: false,
        taggingStopped: [],
      },
    }),
    organizeLibrary: async () => {
      throw new Error("The model is down.");
    },
  },
}));

const { organizeDocuments } = await import("../../src/renderer/src/organizeDocuments");
const { useAppStore } = await import("../../src/renderer/src/store");
const { documentsOfCause } = await import("../../src/renderer/src/organizeFix");
const { useOrganizeReview } = await import("../../src/renderer/src/organizeReview");

beforeEach(() => {
  useAppStore.setState({ minds: [], library: null });
});

describe("an Organize that fails", () => {
  test("keeps the provider's sentence for its line's Details, and leaves no run behind and no Review open (#1569)", async () => {
    await useAppStore.getState().refreshLibrary();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(organizeDocuments(["d-1"])).resolves.toBeUndefined();
    expect(useOrganizeReview.getState()).toMatchObject({
      run: null,
      open: false,
      stopped: null,
      failed: { input: { documentIds: ["d-1"] }, details: "The model is down." },
    });
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe("the Documents a cause covers", () => {
  test("the credit list spans Documents in a Folder and in none, and leaves another cause and a manual place out (#2308)", () => {
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
        status: "failed",
        error: { kind, message: "" },
        model: null,
        ...over,
      }) as DocumentGroupAssignment;
    useAppStore.setState({
      documents: [
        doc("unsorted-1"),
        doc("unsorted-2"),
        doc("filed"),
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
          held("filed", "out-of-credit", { groupId: "f-invoice" }),
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
        reviewCount: 0,
      } as LibrarySnapshot,
    });
    expect(documentsOfCause("credit")).toEqual(["unsorted-1", "unsorted-2", "filed"]);
    expect(documentsOfCause("keyRefused")).toEqual(["refused"]);
  });
});
