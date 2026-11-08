import type { LibraryGroup } from "../../../core/api";
import { folderTreeOptions, sharedFolderNames } from "../folderPicker";
import { isInsideFolder } from "../folders";
import { useT } from "../i18n";
import { matchName, queryWords } from "../matcher";
import { useAppStore } from "../store";
import { FolderLineIcon, FolderPlusLineIcon } from "./lineIcons";
import { type PickerOption, type PickerSection, SearchPicker } from "./SearchPicker";

type Choice = string | null | { newFolder: string };

/** The tree's pure part in ../folderPicker; here each Folder with its icon. */
function treeOptions(
  groups: readonly LibraryGroup[],
  query: string,
  t: (key: "move.inFolder", params: { path: string }) => string,
): PickerOption<Choice>[] {
  return folderTreeOptions(groups, query, t).map((option) => ({
    id: option.folder.id,
    label: option.label,
    indent: option.indent,
    keywords: option.keywords,
    ...(option.detail && { detail: option.detail }),
    data: { "data-folder-id": option.folder.id },
    icon: <FolderLineIcon className="size-4 shrink-0 text-ink-meta" />,
  }));
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
    if (words.length === 0) return [{ options: [...topLevel, ...treeOptions(groups, "", t)] }];
    // "Not in a Folder" (or the top level) is found by typing its words too, and ranked with
    // the Folders: an exact Folder named "Folder" comes before "Not in a Folder".
    const scoreOf = (option: PickerOption<Choice>) =>
      Math.max(
        matchName(words, option.label)?.score ?? 0,
        ...(option.keywords ?? []).map((text) => matchName(words, text)?.score ?? 0),
      );
    const found = [...topLevel, ...treeOptions(groups, query, t)]
      .map((option) => ({ option, score: scoreOf(option) }))
      .filter((each) => each.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ option }) => option);
    const wanted = query.toLocaleLowerCase();
    const names = [t("library.unsorted"), t("folder.topLevel"), ...all.map((g) => g.name)];
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
    return [{ options: [...found, ...newFolder] }];
  };
  // Two Folders with one name are told apart by their place, which needs the room (#2425).
  const shared = sharedFolderNames(groups).size > 0;
  return (
    <SearchPicker<Choice>
      anchor={anchor}
      {...(shared && { widthClass: "w-[320px] max-w-[calc(100vw-16px)]" })}
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
