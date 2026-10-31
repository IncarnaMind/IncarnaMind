import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Document, DocumentGroupAssignment, LibrarySnapshot } from "../../src/core/api";
import type { Translate } from "../../src/renderer/src/objects";
import { undoLines } from "../helpers/undoLines";

/*
 * The undo line Organize says (#763). It is asked once the Library has been read back, and a
 * model that answers at once has finished by then: the line is still said (#1391).
 */

const bridge = new Proxy({}, { get: () => () => () => undefined });

const doc = (id: string) =>
  ({ id, name: id, tags: [], linkedFolderId: null }) as unknown as Document;

const assignment = (
  documentId: string,
  status: DocumentGroupAssignment["status"],
  { groupId = null, suggested = false }: { groupId?: string | null; suggested?: boolean } = {},
): DocumentGroupAssignment => ({
  documentId,
  groupId,
  source: "automatic",
  suggested,
  status,
  error: null,
  model: null,
});

const snapshot = (assignments: DocumentGroupAssignment[]): LibrarySnapshot => ({
  groups: [
    {
      id: "g",
      name: "Research",
      description: "",
      countsOwnFiles: false,
      keepInside: false,
      createdAt: "",
      updatedAt: "",
    },
  ],
  deletedGroups: [],
  assignments,
  settings: {
    classifier: { kind: "automatic" },
    automatic: false,
    organizeWith: null,
    taggingStopped: [],
  },
  automaticDefault: false,
});

let useAppStore: typeof import("../../src/renderer/src/store").useAppStore;
let sayWhenOrganized: typeof import("../../src/renderer/src/organizeRun").sayWhenOrganized;
let useUndo: typeof import("../../src/renderer/src/undo").useUndo;
let words: Translate;
let said: ReturnType<typeof undoLines>["said"];

const ids = ["a", "b", "c"];
const organized = () =>
  ids.map((id) => assignment(id, "classified", { groupId: "g", suggested: true }));
const line = () => said(useUndo.getState().line?.change);

beforeAll(async () => {
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: {},
  };
  ({ useAppStore } = await import("../../src/renderer/src/store"));
  ({ sayWhenOrganized } = await import("../../src/renderer/src/organizeRun"));
  ({ useUndo } = await import("../../src/renderer/src/undo"));
  ({ translateNow: words } = await import("../../src/renderer/src/i18n"));
  ({ said } = undoLines(words));
});

beforeEach(() => {
  useAppStore.setState({
    documents: ids.map(doc),
    library: snapshot([assignment("a", "pending")]),
  });
  useUndo.setState({ line: null, done: [], undone: [], running: null, making: 0 });
});

describe("Organize's undo line", () => {
  test("is said when Organize has already finished by the time it is asked", () => {
    useAppStore.setState({ library: snapshot(organized()) });
    sayWhenOrganized(ids, new Map());
    expect(line()).toBe("Organize suggested a Folder for 3 Documents");
  });

  test("waits for the run to end, then says how many got a Suggested Folder", () => {
    useAppStore.setState({ library: snapshot(ids.map((id) => assignment(id, "pending"))) });
    sayWhenOrganized(ids, new Map());
    expect(line()).toBeUndefined();
    useAppStore.setState({ library: snapshot(organized()) });
    expect(line()).toBe("Organize suggested a Folder for 3 Documents");
  });

  test("says nothing when Organize worked nothing out", () => {
    useAppStore.setState({ library: snapshot(ids.map((id) => assignment(id, "pending"))) });
    sayWhenOrganized(ids, new Map());
    useAppStore.setState({ library: snapshot(ids.map((id) => assignment(id, "classified"))) });
    expect(line()).toBeUndefined();
  });

  test("waits no longer for a Document that went before it could be said", () => {
    useAppStore.setState({
      documents: [doc("a"), doc("b")],
      library: snapshot([assignment("a", "pending"), assignment("b", "pending")]),
    });
    sayWhenOrganized(ids, new Map());
    useAppStore.setState({
      documents: [doc("a"), doc("b")],
      library: snapshot([
        assignment("a", "classified", { groupId: "g", suggested: true }),
        assignment("b", "classified", { groupId: "g", suggested: true }),
      ]),
    });
    expect(line()).toBe("Organize suggested a Folder for 2 Documents");
  });

  test("says nothing when none of its Documents ever shows", () => {
    useAppStore.setState({ documents: [], library: snapshot([]) });
    sayWhenOrganized(ids, new Map());
    useAppStore.setState({ documents: [], library: snapshot([]) });
    expect(line()).toBeUndefined();
  });
});
