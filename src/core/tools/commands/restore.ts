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

/** Deletes them again, as the Library's Undo of a Restore does: at the time each was deleted. */
async function deleteAgain(core: CommandsCore, items: readonly DeletedItem[]): Promise<void> {
  await core.deleteAgain(items.map(({ kind, id, deletedAt }) => ({ kind, id, deletedAt })));
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
  const descriptions = new Map<string, string>();
  for (const item of offered) {
    const base = translate(language, "commands.restore.which.option", {
      kind: translate(language, `deleted.kind.${item.kind}`),
      date: formatDateTime(item.deletedAt, language),
    });
    let label = base;
    for (let count = 2; byLabel.has(label); count++) label = `${base} (${count})`;
    byLabel.set(label, item);
    // A Folder or a Tag is in none; the others were in a Folder, or in none. A Folder this
    // question can't name, behind its wall (#1934), says nothing rather than "in no Folder".
    const folder = item.groupId ? folders.get(item.groupId) : undefined;
    descriptions.set(
      label,
      item.kind === "folder" || item.kind === "tag"
        ? ""
        : item.groupId === null
          ? translate(language, "commands.restore.which.loose")
          : folder
            ? translate(language, "commands.restore.which.in", { folder })
            : "",
    );
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
        description: descriptions.get(label) ?? "",
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

export const restoreChecker: Checker = async (input, { core }, place) => {
  // Only what is on the turn's side of a Folder wall is named or offered, namesakes too (#1934).
  const { deleted } = await place.findable();
  const items = deletedOf(deleted, input.ids);
  const shown: CommandItem[] = items.map((item) => ({
    kind: "deleted",
    id: item.id,
    name: item.name,
  }));
  return inApp("deleted.restore", shown, null, async (asking) => {
    const folders = new Map(
      (await core.getLibrary()).groups.map((group) => [group.id, group.name] as const),
    );
    // A Folder the item was in can itself be waiting in Recently deleted.
    for (const item of deleted) if (item.kind === "folder") folders.set(item.id, item.name);
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
        redo: async () => {
          await core.restore(refs);
        },
      },
      said: `Restored ${plural(back.length, "item")} from Recently deleted, each where it was.`,
    };
  });
};
