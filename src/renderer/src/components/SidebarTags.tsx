import { useEffect, useMemo, useState } from "react";
import type { Tag } from "../../../core/api";
import { nextTagColour, type TagColour } from "../../../shared/tagColours";
import { useDropTarget } from "../dragDrop";
import { tagTarget } from "../folderDrag";
import { useT } from "../i18n";
import { isShown } from "../layoutSlice";
import { documentsByTag } from "../libraryFilters";
import { useOwnDocuments } from "../ownDocuments";
import { useAppStore } from "../store";
import { createTagNamed, editTag } from "../tagChanges";
import { useTreeItem } from "../treeKeys";
import { useRename } from "../useRename";
import { InlineName } from "./InlineName";
import { useFolds } from "./LibraryFolders";
import { MoreLineIcon, PlusLineIcon, TagLineIcon } from "./lineIcons";
import { ObjectMenu, useObjectMenu } from "./ObjectMenu";
import { SidebarSection } from "./SidebarSection";
import {
  clearsActions,
  dropIntoClass,
  rowActionButtonClass,
  rowActionsClass,
  rowButtonClass,
  rowClass,
  rowIconClass,
} from "./sidebarRows";
import { TagColourChoices, TagDot } from "./TagColour";
import { menuClass, menuFrameClass, menuItemClass } from "./ui";
import { usePopoverMenu } from "./usePopoverMenu";

/**
 * The sidebar's Tags section, last in the tree: every Tag the User made, and
 * each preset Tag a Document carries, in name order, each with how many. A Tag
 * shows its Documents in the Library, through the Tag filter; Tags awaiting
 * review are reviewed there too. Documents dragged onto a Tag get it
 * (`tagTarget`). The heading's + makes one in place (#205), the dot opens its
 * eight colours, and the heading's menu and Manage Tags… at the end open the
 * full list. A Tag's menu carries Colour, Edit description, Merge into…,
 * Rename and Delete, through the one menu every object has (#223).
 */
export function SidebarTags() {
  const t = useT();
  const tags = useAppStore((state) => state.tags);
  const documents = useOwnDocuments();
  const byTag = useMemo(() => documentsByTag(documents), [documents]);
  const folded = useFolds((state) => state.tagsFolded);
  const [naming, setNaming] = useState(false);
  // The Tag just named, put where a keyboard expects after its field goes: on its new row.
  const [focusing, setFocusing] = useState<string | null>(null);
  // Every Tag the User made is listed, with 0 until a Document carries it, so one made with the +
  // doesn't vanish at a restart. The presets, which exist before the User makes anything, show
  // once a Document carries one (DESIGN.md, Sidebar; flagged for the owner in #205's pull request).
  const listed = tags.filter((tag) => !tag.preset || byTag.has(tag.id));
  useEffect(() => {
    if (focusing === null) return;
    const row = document.querySelector<HTMLElement>(
      `[data-testid="sidebar-tag"][data-tag-id="${CSS.escape(focusing)}"]`,
    );
    row?.querySelector<HTMLElement>("[data-tree-row]")?.focus();
    setFocusing(null);
  }, [focusing]);
  if (listed.length === 0) return null;

  const startNew = () => {
    if (useFolds.getState().tagsFolded) useFolds.getState().toggleTags();
    setNaming(true);
  };
  const doneNaming = () => {
    setNaming(false);
    // Back on the +, where the keyboard came from, unless the User moved on.
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) {
        document.querySelector<HTMLElement>('[data-testid="tags-add"]')?.focus();
      }
    });
  };
  const madeOne = (tag: Tag) => setFocusing(tag.id);

  return (
    <SidebarSection
      testId="sidebar-tags"
      title={t("tags.title")}
      headingTestId="tags-toggle"
      fold={{ open: !folded, toggle: () => useFolds.getState().toggleTags() }}
      actions={
        <>
          <button
            type="button"
            data-testid="tags-add"
            aria-label={t("tags.new")}
            title={t("tags.new")}
            onClick={startNew}
            className={rowActionButtonClass}
          >
            <PlusLineIcon className="size-4" />
          </button>
          <SectionMenu />
        </>
      }
      foot={
        <div className={rowClass(false)}>
          <button
            type="button"
            data-testid="manage-tags-link"
            onClick={() => useAppStore.getState().openTagsDialog()}
            className={rowButtonClass}
          >
            <TagLineIcon className={rowIconClass(false)} />
            <span className="truncate">{t("tags.menu.manage")}</span>
          </button>
        </div>
      }
    >
      <ul role="none">
        {listed.map((tag) => (
          <TagRow key={tag.id} tag={tag} count={byTag.get(tag.id)?.length ?? 0} />
        ))}
        {naming && <NewTagRow onMade={madeOne} onDone={doneNaming} />}
      </ul>
    </SidebarSection>
  );
}

/**
 * The section's own menu, so Manage Tags… stays reachable when the section is
 * folded and its rows are out of sight. It opens from the button beside the +.
 */
function SectionMenu() {
  const t = useT();
  const menu = usePopoverMenu({ focus: "first" });
  const label = t("tags.menu.of", { name: t("tags.title") });
  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        data-testid="tags-menu"
        aria-label={label}
        title={label}
        className={rowActionButtonClass}
      >
        <MoreLineIcon className="size-4" />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={label}
        data-testid="tags-menu-items"
        className={menuClass}
      >
        {menu.open && (
          <button
            type="button"
            role="menuitem"
            data-testid="tags.manage"
            onClick={() => {
              menu.close();
              useAppStore.getState().openTagsDialog();
            }}
            className={`${menuItemClass} pl-2`}
          >
            <span className="flex-1">{t("tags.menu.manage")}</span>
          </button>
        )}
      </div>
    </>
  );
}

/**
 * A new Tag named where its row will be: the heading's + opens it, Enter keeps
 * it (with Undo), and Esc or a blank name leaves no Tag. Its dot is the colour
 * the core gives it.
 */
function NewTagRow({ onMade, onDone }: { onMade(tag: Tag): void; onDone(): void }) {
  const t = useT();
  const tags = useAppStore((state) => state.tags);
  const colour = nextTagColour(tags.map((tag) => tag.colour));
  const commit = async (name: string) => {
    try {
      const tag = await createTagNamed(name);
      onMade(tag);
      onDone();
    } catch (failure) {
      onDone();
      throw failure;
    }
  };
  return (
    <li role="none" data-testid="sidebar-tag-new">
      <div className={rowClass(false)}>
        <span className="ml-2 flex size-4 shrink-0 items-center justify-center">
          <TagDot colour={colour} size="md" />
        </span>
        <span className="min-w-0 flex-1 pr-2 pl-2">
          <InlineName
            value=""
            label={t("tags.newLabel")}
            placeholder={t("tags.new")}
            maxLength={100}
            testId="sidebar-tag-new-name"
            onCommit={commit}
            onCancel={onDone}
          />
        </span>
      </div>
    </li>
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
  const colours = usePopoverMenu({ focus: "checked" });
  const colourLabel = t("tags.colour.of", { name: tag.name });
  const reportError = useAppStore((state) => state.reportError);
  const openColours = () => colours.buttonProps.ref.current?.click();
  const recolour = (colour: TagColour) => {
    colours.close();
    void editTag(tag.id, { colour }).catch(reportError);
  };
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
          <>
            <span className="ml-2 flex size-4 shrink-0 items-center justify-center">
              <TagDot colour={tag.colour} size="md" />
            </span>
            <span className="min-w-0 flex-1 pr-2 pl-2">
              <InlineName
                value={tag.name}
                label={t("tag.renameLabel", { name: tag.name })}
                maxLength={100}
                {...naming.field((next) => editTag(tag.id, { name: next }))}
              />
            </span>
          </>
        ) : (
          <>
            <button
              {...colours.buttonProps}
              type="button"
              tabIndex={-1}
              data-testid="tag-dot-button"
              aria-label={colourLabel}
              title={colourLabel}
              className="ml-2 flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-rule focus-visible:outline-offset-0"
            >
              <TagDot colour={tag.colour} size="md" />
            </button>
            <button
              type="button"
              {...naming.nameProps}
              {...treeItem}
              className={`${rowButtonClass} flex-1 ${clearsActions.menu}`}
              onClick={show}
            >
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
          </>
        )}
        {!naming.renaming && (
          <div className={rowActionsClass}>
            <ObjectMenu
              target={object}
              label={t("tags.menu.of", { name: tag.name })}
              tabIndex={-1}
              here={{ "tag.rename": naming.start, "tag.colour": openColours }}
              controls={{
                "tag.colour": (close) => (
                  // biome-ignore lint/a11y/useSemanticElements: a menu's group of one choice each, not a form fieldset.
                  <div
                    role="group"
                    aria-label={t("tag.color")}
                    data-testid="tag.colour"
                    className="flex h-8 items-center gap-1 pr-1 pl-2 text-ui text-ink"
                  >
                    <span className="flex-1">{t("tag.color")}</span>
                    <TagColourChoices
                      value={tag.colour}
                      onPick={(colour) => {
                        close();
                        recolour(colour);
                      }}
                    />
                  </div>
                ),
              }}
            />
          </div>
        )}
        <div
          {...colours.menuProps}
          role="menu"
          aria-label={colourLabel}
          data-testid="tag-colour-menu"
          className={`${menuFrameClass} w-max`}
        >
          {colours.open && (
            <div className="p-2">
              <TagColourChoices value={tag.colour} onPick={recolour} />
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
