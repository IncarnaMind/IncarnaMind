import { useT } from "../i18n";
import { matchName, queryWords } from "../matcher";
import { useAppStore } from "../store";
import { FolderLineIcon, FolderPlusLineIcon } from "./lineIcons";
import { type PickerOption, type PickerSection, SearchPicker } from "./SearchPicker";

type Choice = string | null | { newFolder: string };

/**
 * "Move to…": a Folder picker that opens beside what is moved (`anchor`),
 * with a field to find a Folder by name, or a Chinese one by its pinyin.
 * "Not in a Folder" first, then every Folder by name; the one it is in now is
 * ticked. Typing filters, the arrows move, Enter moves it there, Esc closes.
 * Shared by every Move to…: the menus, the Library's selection, ⇧⌘M and ⌘K.
 */
export function MoveToPicker({
  anchor,
  name,
  current,
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
  onChoose(folderId: string | null): void;
  /** Given, a name typed that no Folder has is offered as a new Folder to move into. */
  onCreate?(folderName: string): void;
  onClose(): void;
}) {
  const t = useT();
  const groups = useAppStore((state) => state.library?.groups) ?? [];
  const options: PickerOption<Choice>[] = [
    { id: null, label: t("library.unsorted") },
    ...groups.map((group) => ({ id: group.id, label: group.name })),
  ].map((option) => ({
    ...option,
    data: { "data-folder-id": option.id ?? "" },
    icon: (
      <FolderLineIcon
        className={`size-4 shrink-0 text-ink-meta ${option.id === null ? "opacity-60" : ""}`}
      />
    ),
  }));
  const matching = (query: string): PickerSection<Choice>[] => {
    const words = queryWords(query);
    const found =
      words.length === 0
        ? options
        : options
            .flatMap((option) => {
              const match = matchName(words, option.label);
              return match ? [{ option, score: match.score }] : [];
            })
            .sort((a, b) => b.score - a.score)
            .map(({ option }) => option);
    const wanted = query.toLocaleLowerCase();
    const taken = [t("library.unsorted"), ...groups.map((group) => group.name)].some(
      (label) => label.toLocaleLowerCase() === wanted,
    );
    if (!onCreate || !query || taken) return [{ options: found }];
    const newFolder: PickerOption<Choice> = {
      id: { newFolder: query },
      label: t("move.newFolder", { name: query }),
      data: { "data-new-folder": "true" },
      icon: <FolderPlusLineIcon className="size-4 shrink-0 text-ink-meta" />,
    };
    return [{ options: [...found, newFolder] }];
  };
  return (
    <SearchPicker<Choice>
      anchor={anchor}
      title={t("move.title", { name })}
      searchLabel={t("move.search")}
      noMatch={() => t("move.none")}
      options={matching}
      current={current}
      currentLabel={t("move.here")}
      onChoose={(choice) => {
        if (choice !== null && typeof choice === "object") onCreate?.(choice.newFolder);
        else onChoose(choice);
      }}
      onClose={onClose}
      testId="move-to"
    />
  );
}
