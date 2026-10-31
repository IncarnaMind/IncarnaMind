import { useMemo } from "react";
import type { Tag } from "../../../core/api";
import { useDropTarget } from "../dragDrop";
import { tagTarget } from "../folderDrag";
import { useT } from "../i18n";
import { isShown } from "../layoutSlice";
import { documentsByTag } from "../libraryFilters";
import { useOwnDocuments } from "../ownDocuments";
import { useAppStore } from "../store";
import { editTag } from "../tagChanges";
import { useTreeItem } from "../treeKeys";
import { useRename } from "../useRename";
import { InlineName } from "./InlineName";
import { useFolds } from "./LibraryFolders";
import { ObjectMenu, useObjectMenu } from "./ObjectMenu";
import { SidebarSection } from "./SidebarSection";
import {
  clearsActions,
  dropIntoClass,
  rowActionsClass,
  rowButtonClass,
  rowClass,
} from "./sidebarRows";
import { TagDot } from "./TagColour";

/**
 * The sidebar's Tags section, last in the tree: the Tags at least one
 * Document carries, in name order, each with how many. A Tag shows its
 * Documents in the Library, through the Tag filter; Tags awaiting review are
 * reviewed there too. Documents dragged onto a Tag get it (`tagTarget`).
 */
export function SidebarTags() {
  const t = useT();
  const tags = useAppStore((state) => state.tags);
  const documents = useOwnDocuments();
  const byTag = useMemo(() => documentsByTag(documents), [documents]);
  const folded = useFolds((state) => state.tagsFolded);
  const used = tags.filter((tag) => byTag.has(tag.id));
  if (used.length === 0) return null;
  return (
    <SidebarSection
      testId="sidebar-tags"
      title={t("tags.title")}
      headingTestId="tags-toggle"
      fold={{ open: !folded, toggle: () => useFolds.getState().toggleTags() }}
    >
      <ul role="none">
        {used.map((tag) => (
          <TagRow key={tag.id} tag={tag} count={byTag.get(tag.id)?.length ?? 0} />
        ))}
      </ul>
    </SidebarSection>
  );
}

function TagRow({ tag, count }: { tag: Tag; count: number }) {
  const t = useT();
  const chosen = useAppStore(
    (state) => state.tagFilter.includes(tag.id) && isShown(state.layout, { kind: "library" }),
  );
  const object = { kind: "tag", id: tag.id } as const;
  const objectMenu = useObjectMenu(object);
  const show = () => {
    const store = useAppStore.getState();
    const only = store.tagFilter.length === 1 && store.tagFilter[0] === tag.id;
    if (only && isShown(store.layout, { kind: "library" })) store.setTagFilter([]);
    else {
      store.setTagFilter([tag.id]);
      store.openLibrary();
    }
  };
  // The first click of a double-click chose or cleared it: back as it was before renaming.
  const naming = useRename<HTMLButtonElement>(`sidebar-tag:${tag.id}`, show);
  const treeItem = useTreeItem({ depth: 0, selected: chosen });
  const drop = useDropTarget(`sidebar-tag:${tag.id}`, tagTarget(tag.id));
  const mark = (
    <span className="flex size-4 shrink-0 items-center justify-center">
      <TagDot colour={tag.colour} size="md" />
    </span>
  );
  return (
    <li
      role="none"
      data-testid="sidebar-tag"
      data-tag-id={tag.id}
      data-count={count}
      data-drop-target={drop.over ? "true" : undefined}
    >
      <div
        className={`${rowClass(chosen)} ${drop.over ? dropIntoClass : ""}`}
        {...(naming.renaming ? {} : objectMenu.rowProps)}
        {...drop.props}
      >
        {naming.renaming ? (
          <span className={`${rowButtonClass} pr-1`}>
            {mark}
            <InlineName
              value={tag.name}
              label={t("tag.renameLabel", { name: tag.name })}
              {...naming.field((next) => editTag(tag.id, { name: next }))}
            />
          </span>
        ) : (
          <button
            type="button"
            {...naming.nameProps}
            {...treeItem}
            className={`${rowButtonClass} ${clearsActions.menu}`}
            onClick={show}
          >
            {mark}
            <span
              data-testid="row-text"
              className="min-w-0 flex-1 truncate"
              title={tag.description || tag.name}
            >
              {tag.name}
            </span>
            <span
              data-testid="browse-count"
              className="text-[12px] tabular-nums text-ink-meta actions-shown:hidden"
            >
              {count}
            </span>
          </button>
        )}
        {!naming.renaming && (
          <div className={rowActionsClass}>
            <ObjectMenu
              target={object}
              label={t("tags.menu.of", { name: tag.name })}
              tabIndex={-1}
              here={{ "tag.rename": naming.start }}
            />
          </div>
        )}
      </div>
    </li>
  );
}
