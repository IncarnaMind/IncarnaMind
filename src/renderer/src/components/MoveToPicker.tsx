import type { LibraryGroup } from "../../../core/api";
import { buildFolderTree, flattenFolderTree, folderPath, isInsideFolder } from "../folders";
import { useT } from "../i18n";
import { matchName, queryWords } from "../matcher";
import { useAppStore } from "../store";
import { FolderLineIcon, FolderPlusLineIcon } from "./lineIcons";
import { type PickerOption, type PickerSection, SearchPicker } from "./SearchPicker";

type Choice = string | null | { newFolder: string };

/**
 * The Folders as an indented tree: each with the depth the picker indents it by
 * and, while a query narrows the list, its place beside its name ("Chapter 2
 * sources in Thesis: urban heat"), so two Folders of one name are told apart.
 */
function treeOptions(
  groups: readonly LibraryGroup[],
  query: string,
  t: (key: "move.inFolder", params: { path: string }) => string,
): PickerOption<Choice>[] {
  const words = queryWords(query);
  const options = flattenFolderTree(buildFolderTree(groups)).flatMap(({ folder, depth }) => {
    const parentPath = folderPath(groups, folder.parentId).join(" › ");
    return [
      {
        id: folder.id,
        label: folder.name,
        indent: depth,
        keywords: parentPath ? [parentPath] : [],
        data: { "data-folder-id": folder.id },
        icon: <FolderLineIcon className="size-4 shrink-0 text-ink-meta" />,
      },
    ];
  });
  if (words.length === 0) return options;
  return options.flatMap((option) => {
    const byName = matchName(words, option.label);
    const byPath = option.keywords?.some((each) => matchName(words, each));
    if (!byName && !byPath) return [];
    const folder = groups.find((each) => each.id === option.id);
    const path = folder?.parentId ? folderPath(groups, folder.parentId).join(" › ") : "";
    return [{ ...option, indent: 0, ...(path && { detail: t("move.inFolder", { path }) }) }];
  });
}

function taken(names: readonly string[], wanted: string): boolean {
  return names.some((name) => name.toLocaleLowerCase() === wanted);
}

/**
 * "Move to…": a Folder picker that opens beside what is moved (`anchor`),
 * with a field to find a Folder by name, or a Chinese one by its pinyin. "Not
 * in a Folder" first (or the top level, for a Folder), then every Folder as an
 * indented tree; the one it is in now is ticked. Typing filters, the arrows
 * move, Enter moves it there, Esc closes. Moving a Folder leaves out the two
 * that would put it inside itself. Shared by every Move to…: the menus, the
 * Library's selection, ⇧⌘M and ⌘K.
 */
export function MoveToPicker({
  anchor,
  name,
  current,
  forFolder,
  onChoose,
  onCreate,
  onClose,
}: {
  /** What it opens beside; it takes the focus back once closed. Null: closed. */
  anchor: HTMLElement | null;
  /** What is moved: a Mind's title, or "3 Documents". */
  name: string;
  /** Where it is now (null: Not in a Folder), or undefined for things in different places. */
  current: string | null | undefined;
  /** Set while a Folder is moved: itself, so it and the Folders inside it can't be chosen. */
  forFolder?: LibraryGroup | undefined;
  onChoose(folderId: string | null): void;
  /** Given, a name typed that no Folder has is offered as a new Folder to move into. */
  onCreate?(folderName: string): void;
  onClose(): void;
}) {
  const t = useT();
  const all = useAppStore((state) => state.library?.groups) ?? [];
  const groups = forFolder
    ? all.filter((group) => !isInsideFolder(all, group.id, forFolder.id))
    : all;
  const topLevel: PickerOption<Choice>[] = forFolder
    ? [
        {
          id: null,
          label: t("folder.topLevel"),
          data: { "data-folder-id": "" },
          icon: <FolderLineIcon className="size-4 shrink-0 text-ink-meta" />,
        },
      ]
    : [
        {
          id: null,
          label: t("library.unsorted"),
          data: { "data-folder-id": "" },
          icon: <FolderLineIcon className="size-4 shrink-0 text-ink-meta opacity-60" />,
        },
      ];
  const matching = (query: string): PickerSection<Choice>[] => {
    const words = queryWords(query);
    // "Not in a Folder" (or the top level) is found by typing its words too, as a Folder is.
    const top = topLevel.filter(
      (option) => words.length === 0 || matchName(words, option.label) !== null,
    );
    const found = treeOptions(groups, query, t);
    const wanted = query.toLocaleLowerCase();
    const names = [t("library.unsorted"), t("folder.topLevel"), ...groups.map((g) => g.name)];
    const newFolder: PickerOption<Choice>[] =
      onCreate && query && !taken(names, wanted)
        ? [
            {
              id: { newFolder: query },
              label: t("move.newFolder", { name: query }),
              data: { "data-new-folder": "true" },
              icon: <FolderPlusLineIcon className="size-4 shrink-0 text-ink-meta" />,
            },
          ]
        : [];
    return [{ options: [...top, ...found, ...newFolder] }];
  };
  return (
    <SearchPicker<Choice>
      anchor={anchor}
      title={t("move.title", { name })}
      searchLabel={t("move.search")}
      noMatch={() => t("move.none")}
      options={matching}
      current={current}
      currentLabel={forFolder ? t("folder.hereIn") : t("move.here")}
      onChoose={(choice) => {
        if (choice !== null && typeof choice === "object") onCreate?.(choice.newFolder);
        else onChoose(choice);
      }}
      onClose={onClose}
      testId="move-to"
    />
  );
}
