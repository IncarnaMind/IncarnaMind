/**
 * Folders and Tags themselves, as their menus make, rename and delete them (#1421): each a change
 * inside IncarnaMind that Undo takes back; a delete goes to Recently deleted and asks first.
 */
import type { CommandItem, LibraryGroup, Tag, TagMerge } from "../../api";
import { RECENTLY_DELETED_DAYS } from "../../api";
import { InvalidInputError, NotFoundError } from "../../errors";
import {
  type Checker,
  type CommandsCore,
  holdsAny,
  inApp,
  needs,
  onlyOne,
  plural,
  same,
} from "./run";

const folderItem = (folder: LibraryGroup, renamed?: LibraryGroup): CommandItem => ({
  kind: "folder",
  id: folder.id,
  name: folder.name,
  ...(renamed && { renamed: renamed.name }),
});

const tagItem = (tag: Tag, renamed?: Tag): CommandItem => ({
  kind: "tag",
  id: tag.id,
  name: tag.name,
  ...(renamed && { renamed: renamed.name }),
});

async function foldersOf(core: CommandsCore, ids: readonly string[]): Promise<LibraryGroup[]> {
  if (ids.length === 0) throw new InvalidInputError({ key: "error.commands.noIds" });
  const { groups } = await core.getLibrary();
  return [...new Set(ids)].map((id) => {
    const folder = groups.find((each) => each.id === id);
    if (!folder) throw new NotFoundError({ key: "error.commands.noFolderId", values: { id } });
    return folder;
  });
}

async function tagsOf(core: CommandsCore, ids: readonly string[]): Promise<Tag[]> {
  if (ids.length === 0) throw new InvalidInputError({ key: "error.commands.noIds" });
  const tags = await core.listTags();
  return [...new Set(ids)].map((id) => {
    const tag = tags.find((each) => each.id === id);
    if (!tag) throw new NotFoundError({ key: "error.commands.noTagId", values: { id } });
    return tag;
  });
}

/** Deletes each, all or none: one that fails brings back those deleted before it. */
async function deleteEach(
  refs: readonly { kind: "folder" | "tag"; id: string }[],
  remove: (id: string) => Promise<unknown>,
  restore: CommandsCore["restore"],
): Promise<void> {
  const done: { kind: "folder" | "tag"; id: string }[] = [];
  try {
    for (const ref of refs) {
      await remove(ref.id);
      done.push(ref);
    }
  } catch (error) {
    if (done.length > 0) await restore(done);
    throw error;
  }
}

const deletedSaid = (count: number, one: string) =>
  `Moved ${plural(count, one)} to Recently deleted, where the User can restore them for ${RECENTLY_DELETED_DAYS} days.`;

export const FOLDER_CHECKERS = {
  "folder.new": async (input, { core }) => {
    const name = needs(input.name, "error.commands.noFolderName");
    const { groups } = await core.getLibrary();
    // It makes a Folder at the top level, where a name is free unless a top-level Folder has it (#2425).
    if (groups.some((each) => each.parentId === null && same(each.name, name))) {
      throw new InvalidInputError({ key: "error.folder.nameTaken" });
    }
    return inApp("folder.new", [], name, async () => {
      const folder = await core.createLibraryGroup({ name, description: input.about ?? "" });
      /** Whether its Undo removed it; false: kept for what the User filed in it since. */
      let removed: boolean | null = null;
      return {
        done: {
          items: [folderItem(folder)],
          into: { kind: "folder", id: folder.id, name: folder.name, made: true },
        },
        step: {
          undo: async () => {
            if (removed === false) return null;
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
          },
        },
        said: `Made the Folder “${folder.name}”.`,
      };
    });
  },

  "folder.rename": async (input, { core }) => {
    const folder = onlyOne(await foldersOf(core, input.ids));
    const name = needs(input.name, "error.commands.noName");
    return inApp("folder.rename", [folderItem(folder)], null, async () => {
      const description = folder.description;
      const renamed = await core.updateLibraryGroup(folder.id, { name, description });
      return {
        done: { items: [folderItem(folder, renamed)] },
        step: {
          undo: async () => {
            await core.updateLibraryGroup(folder.id, { name: folder.name, description });
            return null;
          },
          redo: async () => {
            await core.updateLibraryGroup(folder.id, { name: renamed.name, description });
          },
        },
        said: `Renamed the Folder “${folder.name}” to “${renamed.name}”.`,
      };
    });
  },

  "folder.delete": async (input, { core }) => {
    const folders = await foldersOf(core, input.ids);
    const refs = folders.map((each) => ({ kind: "folder" as const, id: each.id }));
    const remove = () => deleteEach(refs, (id) => core.deleteLibraryGroup(id), core.restore);
    const items = folders.map((each) => folderItem(each));
    return inApp("folder.delete", items, null, async () => {
      await remove();
      return {
        done: { items },
        step: {
          undo: async () => {
            await core.restore(refs);
            return null;
          },
          redo: remove,
        },
        said: `${deletedSaid(folders.length, "Folder")} What they held is in no Folder until then.`,
      };
    });
  },

  "tag.new": async (input, { core }) => {
    const name = needs(input.name, "error.commands.noTag");
    if ((await core.listTags()).some((each) => same(each.name, name))) {
      throw new InvalidInputError({ key: "error.commands.tagTaken", values: { name } });
    }
    return inApp("tag.new", [], name, async () => {
      const tag = await core.createTag({ name, ...(input.about && { description: input.about }) });
      let removed: boolean | null = null;
      return {
        done: {
          items: [tagItem(tag)],
          into: { kind: "tag", id: tag.id, name: tag.name, made: true },
        },
        step: {
          undo: async () => {
            if (removed === false) return null;
            const documents = await core.listDocuments();
            if (documents.some((each) => each.tags.some((one) => one.tagId === tag.id))) {
              removed = false;
              return { kind: "tag", name: tag.name };
            }
            await core.deleteTag(tag.id);
            removed = true;
            return null;
          },
          redo: async () => {
            if (removed) await core.restore([{ kind: "tag", id: tag.id }]);
            removed = null;
          },
        },
        said: `Made the Tag “${tag.name}”.`,
      };
    });
  },

  "tag.rename": async (input, { core }) => {
    const tag = onlyOne(await tagsOf(core, input.ids));
    const name = needs(input.name, "error.commands.noName");
    return inApp("tag.rename", [tagItem(tag)], null, async () => {
      const renamed = await core.updateTag(tag.id, { name });
      return {
        done: { items: [tagItem(tag, renamed)] },
        step: {
          undo: async () => {
            await core.updateTag(
              tag.id,
              { name: tag.name },
              {
                madeByUser: tag.madeByUser,
                expected: {
                  name: renamed.name,
                  description: renamed.description,
                  colour: renamed.colour,
                },
              },
            );
            return null;
          },
          redo: async () => {
            await core.updateTag(tag.id, { name: renamed.name });
          },
        },
        said: `Renamed the Tag “${tag.name}” to “${renamed.name}”, on every Document that has it.`,
      };
    });
  },

  "tag.merge": async (input, { core }) => {
    const tags = await core.listTags();
    // The model has both a Tag's id and its name, and mixes them up: either names the Tag here.
    const tagNamed = (value: string) =>
      tags.find((each) => each.id === value) ?? tags.find((each) => same(each.name, value));
    const groups = (
      input.merges.length > 0 ? input.merges : [{ ids: input.ids, tag: input.tag }]
    ).map((group) => {
      const into = tagNamed(needs(group.tag, "error.commands.noTag"));
      if (!into) throw new NotFoundError({ key: "error.tag.notFound" });
      return { ids: group.ids, into, sources: [] as Tag[] };
    });
    for (const group of groups) {
      if (group.ids.length === 0) throw new InvalidInputError({ key: "error.commands.noIds" });
      const mine = new Set<string>();
      group.sources = group.ids.flatMap((value) => {
        const tag = tagNamed(value);
        if (!tag) throw new NotFoundError({ key: "error.tag.notFound" });
        if (tag.id === group.into.id || mine.has(tag.id)) return [];
        mine.add(tag.id);
        return [tag];
      });
    }
    // A Tag merges into one Tag, and a Tag kept is never merged away: a request that names one
    // twice is the model's mistake, and the User is asked again rather than shown another merge.
    const owner = new Map<string, number>();
    groups.forEach((group, at) => {
      for (const id of [group.into.id, ...group.sources.map((tag) => tag.id)]) {
        const seen = owner.get(id);
        if (seen !== undefined && seen !== at) {
          throw new InvalidInputError({ key: "error.tag.mergeTwice" });
        }
        owner.set(id, at);
      }
    });
    const sources = groups.flatMap((group) => group.sources);
    if (sources.length === 0) throw new InvalidInputError({ key: "error.tag.mergeIntoItself" });
    const pairs = groups.flatMap((group) =>
      group.sources.map((tag) => ({ from: tag.name, into: group.into.name })),
    );
    const [only] = groups;
    return {
      ...inApp(
        "tag.merge",
        sources.map((tag) => tagItem(tag)),
        groups.length === 1 ? (only?.into.name ?? null) : null,
        async () => {
          const merges: { merged: TagMerge; into: Tag }[] = [];
          const undoMerges = async () => {
            for (const merge of [...merges].reverse()) {
              await core.restore([merge.merged.merged], {
                tagSources: [
                  {
                    tagId: merge.into.id,
                    madeByUser: merge.merged.keptMadeByUserBefore,
                    expected: {
                      name: merge.merged.tag.name,
                      description: merge.merged.tag.description,
                      colour: merge.merged.tag.colour,
                    },
                  },
                ],
              });
            }
          };
          const mergeGroups = async () => {
            for (const group of groups) {
              for (const tag of group.sources) {
                merges.push({
                  merged: await core.mergeTags(tag.id, group.into.id),
                  into: group.into,
                });
              }
            }
          };
          try {
            await mergeGroups();
          } catch (error) {
            await undoMerges();
            throw error;
          }
          const said = `${
            groups.length === 1
              ? `Merged ${plural(sources.length, "Tag")} (${pairs.map((pair) => `“${pair.from}”`).join(", ")}) into “${only?.into.name ?? ""}”, which their Documents carry now.`
              : `Merged ${plural(sources.length, "Tag")} into ${plural(groups.length, "Tag")}: ${pairs.map((pair) => `“${pair.from}” into “${pair.into}”`).join(", ")}.`
          } The User allowed it, so it is done, and the merged Tags are in Recently deleted, where the User can restore them. Name each Tag and the Tag it went into in your reply, not a list under it.`;
          return {
            done: {
              items: sources.map((tag) => tagItem(tag)),
              ...(groups.length === 1 && only
                ? {
                    into: {
                      kind: "tag" as const,
                      id: only.into.id,
                      name: only.into.name,
                      made: false,
                    },
                  }
                : {}),
              merges: pairs,
              tagCount: { before: tags.length, after: tags.length - sources.length },
            },
            step: {
              undo: async () => {
                await undoMerges();
                return null;
              },
              redo: async () => {
                merges.length = 0;
                await mergeGroups();
              },
            },
            said,
          };
        },
        "merge",
      ),
      merges: pairs,
    };
  },

  "tag.delete": async (input, { core }) => {
    const tags = await tagsOf(core, input.ids);
    const refs = tags.map((each) => ({ kind: "tag" as const, id: each.id }));
    const remove = () => deleteEach(refs, (id) => core.deleteTag(id), core.restore);
    const items = tags.map((each) => tagItem(each));
    return inApp("tag.delete", items, null, async () => {
      await remove();
      return {
        done: { items },
        step: {
          undo: async () => {
            await core.restore(refs);
            return null;
          },
          redo: remove,
        },
        said: deletedSaid(tags.length, "Tag"),
      };
    });
  },
} satisfies Record<string, Checker>;
