import { useMemo } from "react";
import type { Document, DocumentKind, LibraryGroup, Mind } from "../../../../core/api";
import { displayName } from "../../../../shared/documentNames";
import { mindName } from "../../../../shared/naming";
import { commands } from "../../commands/registry";
import { timeAgo } from "../../dates";
import { useDropTarget } from "../../dragDrop";
import { useFolderContents } from "../../folderContents";
import { folderTarget } from "../../folderDrag";
import { homeClick } from "../../home";
import { useLanguage, useT } from "../../i18n";
import { FORMAT_LABELS } from "../../libraryFilters";
import { onMiddleClick } from "../../middleClick";
import { useSelectable } from "../../selection";
import { useAppStore } from "../../store";
import { useRename } from "../../useRename";
import { InlineName } from "../InlineName";
import { DocumentLineIcon, FolderLineIcon, MindLineIcon, PlusLineIcon } from "../lineIcons";
import { ObjectMenu, useObjectMenu } from "../ObjectMenu";
import { dropIntoClass } from "../sidebarRows";

const cardClass = (selected: boolean) =>
  `group relative flex min-h-[132px] min-w-0 flex-col gap-1 rounded-[10px] px-3.5 py-3 text-left ${
    selected
      ? "bg-accent-wash shadow-[inset_0_0_0_1px_var(--color-accent)]"
      : "bg-sheet shadow-[inset_0_0_0_1px_var(--color-rule)] hover:shadow-[inset_0_0_0_1px_var(--color-rule-strong)]"
  }`;

const NO_MINDS: readonly Mind[] = [];
const NO_DOCUMENTS: readonly Document[] = [];

export function FolderCards({ now }: { now: Date }) {
  const t = useT();
  const documents = useAppStore((state) => state.documents);
  const { orderedGroups, documentsByFolder, mindsByFolder } = useFolderContents(documents);
  if (orderedGroups.length === 0) return null;
  return (
    <section data-testid="home-folders" className="mb-7">
      <h2 className="mb-1.5 text-label font-semibold text-ink-meta">{t("library.groups")}</h2>
      {/* biome-ignore lint/a11y/useSemanticElements: cards that select as the sidebar's rows do, not a table. */}
      <div
        role="grid"
        aria-multiselectable="true"
        aria-label={t("library.groups")}
        className="grid grid-cols-3 gap-3 @max-[760px]/home:grid-cols-2 @max-[480px]/home:grid-cols-1"
      >
        {orderedGroups.map((folder) => (
          <FolderCard
            key={folder.id}
            folder={folder}
            minds={mindsByFolder.get(folder.id) ?? NO_MINDS}
            documents={documentsByFolder.get(folder.id) ?? NO_DOCUMENTS}
            now={now}
          />
        ))}
        <button
          type="button"
          data-testid="home-new-folder"
          onClick={() => void commands.run("folder.new").catch(useAppStore.getState().reportError)}
          className="flex min-h-[132px] items-center justify-center gap-2 rounded-[10px] border border-dashed border-rule-strong text-ui text-ink-meta hover:bg-frame hover:text-ink"
        >
          <PlusLineIcon className="size-4" />
          {t("menu.newFolder")}
        </button>
      </div>
    </section>
  );
}

interface Item {
  id: string;
  name: string;
  at: string;
  kind: DocumentKind | null;
}

function FolderCard({
  folder,
  minds,
  documents,
  now,
}: {
  folder: LibraryGroup;
  minds: readonly Mind[];
  documents: readonly Document[];
  now: Date;
}) {
  const t = useT();
  const language = useLanguage();
  const object = { kind: "folder", id: folder.id } as const;
  const objectMenu = useObjectMenu(object);
  const rename = useRename<HTMLButtonElement>(`home-folder:${folder.id}`);
  const drop = useDropTarget(`home-folder:${folder.id}`, folderTarget(folder.id));
  const openLibrary = useAppStore((state) => state.openLibrary);
  const open = () => openLibrary(folder.id);
  const select = useSelectable(object, "home", open);
  const untitled = t("mind.untitled");
  const items = useMemo<Item[]>(
    () =>
      [
        ...minds.map((mind) => ({
          id: mind.id,
          name: mindName(mind) || untitled,
          at: mind.updatedAt,
          kind: null,
        })),
        ...documents.map((each) => ({
          id: each.id,
          name: displayName(each),
          at: each.createdAt,
          kind: each.kind,
        })),
      ].sort((a, b) => b.at.localeCompare(a.at)),
    [minds, documents, untitled],
  );
  const kinds = useMemo(
    () => [...new Set(documents.map((each) => each.kind))].slice(0, 5),
    [documents],
  );
  const latest = items[0]?.at;

  return (
    // biome-ignore lint/a11y/useSemanticElements: a card that selects as the sidebar's rows do, not a table row.
    // biome-ignore lint/a11y/useFocusableInteractive: its name's button takes the focus.
    <div
      role="row"
      data-testid="home-folder-card"
      data-folder-id={folder.id}
      data-drop-target={drop.over ? "true" : undefined}
      {...select.rowProps}
      {...(rename.renaming ? {} : objectMenu.rowProps)}
      {...drop.props}
      title={folder.description || undefined}
      className={`${cardClass(select.selected)} ${drop.over ? dropIntoClass : ""}`}
    >
      <div className="flex min-w-0 items-center gap-2 font-semibold text-ink">
        <FolderLineIcon className="size-4 shrink-0 text-ink-meta" />
        {rename.renaming ? (
          <InlineName
            value={folder.name}
            label={t("folder.renameLabel", { name: folder.name })}
            {...rename.field((name) => useAppStore.getState().renameFolder(folder.id, name))}
          />
        ) : (
          <button
            type="button"
            ref={rename.nameProps.ref}
            data-row-main
            data-testid="home-folder-open"
            onClick={homeClick(select, open)}
            {...onMiddleClick(() => openLibrary(folder.id, { behind: true }))}
            onKeyDown={rename.nameProps.onKeyDown}
            // The whole card is what a click on it opens.
            className="min-w-0 flex-1 truncate rounded-sm text-left after:absolute after:inset-0 after:rounded-[10px]"
          >
            {folder.name}
          </button>
        )}
        {!rename.renaming && (
          <div className="relative shrink-0 opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 has-[[aria-expanded=true]]:opacity-100">
            <ObjectMenu
              target={object}
              label={t("folder.more", { name: folder.name })}
              tabIndex={-1}
              here={{ "folder.rename": rename.start }}
            />
          </div>
        )}
      </div>
      <p data-testid="home-folder-counts" className="mb-1 text-label text-ink-meta">
        {minds.length === 1 ? t("home.minds.one") : t("home.minds", { count: minds.length })}
        {" · "}
        {documents.length === 1
          ? t("library.count.one")
          : t("library.count", { count: documents.length })}
      </p>
      {items.slice(0, 2).map((item) => (
        <p
          key={item.id}
          data-testid="home-folder-item"
          className="flex min-w-0 items-center gap-1.5 text-[13px] text-ink-secondary"
        >
          {item.kind ? (
            <DocumentLineIcon kind={item.kind} className="size-3.5 shrink-0 text-ink-meta" />
          ) : (
            <MindLineIcon className="size-3.5 shrink-0 text-ink-meta" />
          )}
          <span className="truncate">{item.name}</span>
        </p>
      ))}
      <p className="mt-auto flex items-center gap-1 pt-1.5 text-label text-ink-meta">
        <span data-testid="home-folder-active" className="min-w-0 flex-1 truncate">
          {latest ? t("home.active", { time: timeAgo(new Date(latest), now, language, t) }) : ""}
        </span>
        {kinds.map((kind) => (
          <span key={kind} title={t(FORMAT_LABELS[kind])}>
            <DocumentLineIcon kind={kind} className="size-3.5" />
          </span>
        ))}
      </p>
    </div>
  );
}
