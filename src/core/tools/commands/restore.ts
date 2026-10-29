/**
 * Bringing back what is in Recently deleted, by its name (#1421): put back where it was, as the
 * Library's own Restore puts it, and taken back with Undo, which deletes it again. When something
 * else there has the same name, the User says which in the tray: the model never picks one.
 */
import { formatDateTime } from "../../../shared/dates";
import { translate } from "../../../shared/i18n";
import type { CommandItem, DeletedItem, UserQuestion } from "../../api";
import { InvalidInputError, NotFoundError } from "../../errors";
import type { Language } from "../../language";
import { type Checker, type CommandAsking, type CommandsCore, inApp, plural } from "./run";

/** At most this many to choose from, the most recently deleted first. */
const MOST_OFFERED = 4;

const sameName = (a: DeletedItem, b: DeletedItem) =>
  a.name.normalize("NFKC").trim().toLowerCase() === b.name.normalize("NFKC").trim().toLowerCase();

function deletedOf(deleted: readonly DeletedItem[], ids: readonly string[]): DeletedItem[] {
  return [...new Set(ids)].map((id) => {
    const item = deleted.find((each) => each.id === id);
    if (!item) throw new NotFoundError({ key: "error.commands.noDeleted", values: { id } });
    return item;
  });
}

/** Deletes them again, as the Library's Undo of a Restore does. */
async function deleteAgain(core: CommandsCore, items: readonly DeletedItem[]): Promise<void> {
  const documents = items.filter((item) => item.kind === "document").map((item) => item.id);
  if (documents.length > 0) await core.deleteDocuments(documents);
  for (const { kind, id } of items) {
    if (kind === "mind") await core.deleteMind(id);
    else if (kind === "conversation") await core.deleteConversation(id);
    else if (kind === "folder") await core.deleteLibraryGroup(id);
    else if (kind === "tag") await core.deleteTag(id);
  }
}

/** The question for one name several things in Recently deleted have, and what each option is. */
function whichOf(
  namesakes: readonly DeletedItem[],
  folders: ReadonlyMap<string, string>,
  language: Language,
): { question: UserQuestion; byLabel: Map<string, DeletedItem> } {
  const offered = [...namesakes]
    .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
    .slice(0, MOST_OFFERED);
  const byLabel = new Map<string, DeletedItem>();
  for (const item of offered) {
    const folder = item.groupId ? folders.get(item.groupId) : undefined;
    const base = translate(
      language,
      folder ? "commands.restore.which.in" : "commands.restore.which.loose",
      { date: formatDateTime(item.deletedAt, language), folder: folder ?? "" },
    );
    let label = base;
    for (let count = 2; byLabel.has(label); count++) label = `${base} (${count})`;
    byLabel.set(label, item);
  }
  return {
    byLabel,
    question: {
      question: translate(language, "commands.restore.which.question", {
        name: offered[0]?.name ?? "",
      }),
      detail: translate(language, "commands.restore.which.detail", { count: namesakes.length }),
      options: [...byLabel.keys()].map((label, index) => ({
        label,
        description: "",
        recommended: index === 0,
        preselected: false,
      })),
      multiple: true,
      other: false,
      answer: null,
    },
  };
}

/** What comes back of `items`: each one whose name something else there has, as the User chose. */
async function chosen(
  items: readonly DeletedItem[],
  deleted: readonly DeletedItem[],
  folders: ReadonlyMap<string, string>,
  asking: CommandAsking,
): Promise<DeletedItem[]> {
  const kept: DeletedItem[] = [];
  const asked = new Set<string>();
  for (const item of items) {
    if (asked.has(item.id)) continue;
    const namesakes = deleted.filter((each) => sameName(each, item));
    if (namesakes.length === 1) {
      kept.push(item);
      continue;
    }
    for (const each of namesakes) asked.add(each.id);
    if (!asking) {
      throw new InvalidInputError({
        key: "error.commands.restoreWhich",
        values: { name: item.name, count: namesakes.length },
      });
    }
    let byLabel = new Map<string, DeletedItem>();
    const answer = await asking((language) => {
      const which = whichOf(namesakes, folders, language);
      byLabel = which.byLabel;
      return which.question;
    });
    if (!answer.skipped) kept.push(...answer.chosen.flatMap((label) => byLabel.get(label) ?? []));
  }
  return kept;
}

export const restoreChecker: Checker = async (input, { core }) => {
  const deleted = await core.listDeleted();
  const items = deletedOf(deleted, input.ids);
  const shown: CommandItem[] = items.map((item) => ({
    kind: "deleted",
    id: item.id,
    name: item.name,
  }));
  return inApp("deleted.restore", shown, null, async (asking) => {
    const folders = new Map(
      (await core.getLibrary()).groups.map((group) => [group.id, group.name]),
    );
    const back = await chosen(items, deleted, folders, asking);
    if (back.length === 0) throw new InvalidInputError({ key: "error.commands.restoreNoneChosen" });
    const refs = back.map(({ kind, id }) => ({ kind, id }));
    await core.restore(refs);
    return {
      done: { items: back.map((item) => ({ kind: "deleted", id: item.id, name: item.name })) },
      step: {
        undo: async () => {
          await deleteAgain(core, back);
          return null;
        },
        redo: () => core.restore(refs),
      },
      said: `Restored ${plural(back.length, "item")} from Recently deleted, each where it was.`,
    };
  });
};
