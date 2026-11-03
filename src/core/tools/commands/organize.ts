/**
 * Organize by what the Documents say (#1421): the Library's own Organize, on the Documents named
 * or found, or those in no Folder, with the Folder the request names among those it may choose,
 * made for it if there is none. Organize reads each and suggests a Folder; its suggestions wait in
 * To review (#241) for the User, and nothing moves before they accept. One Undo takes back the
 * suggestions it made and the Folder.
 */
import type { AssignmentState, DocumentGroupAssignment } from "../../api";
import {
  type Checker,
  type CommandsCore,
  documentItem,
  documentsOf,
  folderNamed,
  holdsAny,
  inApp,
  needs,
  plural,
  unmake,
} from "./run";

/** What the Library's Organize hasn't finished with: Undo puts such a Document back with none. */
const unfinished = (item: DocumentGroupAssignment) =>
  item.status === "pending" || item.status === "classifying" || item.status === "waiting";

const stateOf = (item: DocumentGroupAssignment | undefined): AssignmentState => {
  if (!item) return { assignment: null, tagging: null };
  const { documentId: _id, tagging, ...assignment } = item;
  return { assignment, tagging: tagging ?? null };
};

/** As it was before Organize ran, except one it hadn't finished with, which goes back with none (#1391). */
const wasBefore = (item: DocumentGroupAssignment | undefined): AssignmentState =>
  item && !unfinished(item) ? stateOf(item) : { assignment: null, tagging: stateOf(item).tagging };

async function assignmentsOf(core: CommandsCore, ids: readonly string[]) {
  const { assignments } = await core.getLibrary();
  const wanted = new Set(ids);
  return new Map(
    assignments
      .filter((each) => wanted.has(each.documentId))
      .map((each) => [each.documentId, each]),
  );
}

/** The User's Documents in no Folder, as the Library's Organize sorts them; the examples never. */
async function inNoFolder(core: CommandsCore) {
  const [documents, { assignments }] = await Promise.all([core.listDocuments(), core.getLibrary()]);
  const filed = new Set(
    assignments.filter((each) => each.groupId !== null).map((each) => each.documentId),
  );
  const own = [];
  for (const document of documents) {
    if (!filed.has(document.id) && !(await core.isExampleDocument(document.id))) own.push(document);
  }
  return own;
}

export const organizeChecker: Checker = async (input, { core }) => {
  const name = needs(input.folder, "error.commands.noFolderName");
  const documents =
    input.ids.length > 0 ? await documentsOf(core, input.ids) : await inNoFolder(core);
  const items = documents.map((each) => documentItem(each));
  const ids = documents.map((each) => each.id);
  return {
    ...inApp("documents.organize", items, name, async () => {
      const before = await assignmentsOf(core, ids);
      const { folder, made } = await folderNamed(core, name, input.about ?? "");
      try {
        if (ids.length > 0) await core.classifyDocuments(ids);
      } catch (error) {
        if (made) await unmake(core, "folder", folder.id);
        throw error;
      }
      /** Whether its Undo removed the Folder it made; false: kept for what the User filed in it. */
      let removed: boolean | null = null;
      const names = documents.slice(0, 10).map((each) => `“${documentItem(each).name}”`);
      return {
        done: { items, into: { kind: "folder", id: folder.id, name: folder.name, made } },
        step: {
          undo: async () => {
            const now = await assignmentsOf(core, ids);
            for (const id of ids) {
              const current = now.get(id);
              // One the User accepted or moved since is theirs: it stays where they put it.
              if (current?.source === "user") continue;
              await core.restoreAssignment(id, wasBefore(before.get(id)), stateOf(current));
            }
            if (!made || removed === false) return null;
            if (await holdsAny(core, folder.id)) {
              removed = false;
              return { kind: "folder", name: folder.name };
            }
            await core.deleteLibraryGroup(folder.id);
            removed = true;
            return null;
          },
          redo: async () => {
            if (removed) await core.restore([{ kind: "folder", id: folder.id }]);
            removed = null;
            if (ids.length > 0) await core.classifyDocuments(ids);
          },
        },
        said:
          ids.length === 0
            ? `No Document is in no Folder, so Organize had nothing to sort.${made ? ` It made the Folder “${folder.name}”.` : ""}`
            : `Organize is reading ${plural(ids.length, "Document")} (${names.join(", ")}${ids.length > names.length ? ", …" : ""}) and suggests a Folder for each from what it says, “${folder.name}”${made ? ", which this made," : ""} among them. Its suggestions wait in To review for the User to accept; nothing has moved, and nothing moves before they accept it.`,
      };
    }),
    // Organize only suggests: nothing moves, so nothing counts towards the Answer's limit.
    changes: false,
  };
};
