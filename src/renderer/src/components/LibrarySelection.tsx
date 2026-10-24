import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import type { Document } from "../../../core/api";
import type { CommandId } from "../../../shared/commands";
import { keysHere, menuKeysLabel } from "../commands/keymap";
import { buildMenu, type MenuItem } from "../commands/menus";
import { type CommandContext, commands, menuLabelOf } from "../commands/registry";
import { dialogOrMenuOpen } from "../escapeDismiss";
import { useLanguage, useT } from "../i18n";
import { formatCount } from "../linkedFolders";
import type { ObjectRef } from "../objects";
import { useSelectedOn, useSelection } from "../selection";
import { useAppStore } from "../store";
import { DELETE_KEYS, TAGS_KEYS } from "../treeKeys";
import { useDocumentMove } from "./library/DocumentMoveTo";
import { CloseLineIcon } from "./lineIcons";
import { ObjectMenu } from "./ObjectMenu";
import { SelectionTags } from "./SelectionTags";

const boxClass = "size-4 shrink-0 cursor-pointer accent-accent";

/** A command in the selection bar: a quiet text button, with its keys after it. */
const barCommandClass =
  "h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] whitespace-nowrap text-ink-secondary hover:bg-rule hover:text-ink aria-disabled:text-ink-placeholder aria-disabled:hover:bg-transparent";

/**
 * The commands the bar names, in its order, each from the width it shows at,
 * with the keys a Library row takes for it where the command has none of its
 * own; Tags… sits after the first. Narrower, they wait under ⋯, which holds
 * them all.
 */
const NAMED: readonly { id: CommandId; from: string; keys?: string }[] = [
  { id: "document.moveTo", from: "@[30rem]:inline-flex" },
  { id: "document.ask", from: "@[44rem]:inline-flex" },
  { id: "document.delete", from: "@[52rem]:inline-flex", keys: DELETE_KEYS },
];

const documentRef = (id: string): ObjectRef => ({ kind: "document", id });

/**
 * A Library row's checkbox, in the margin left of its name: shown when the
 * row is pointed at or focused, and on every row once two or more are
 * selected. It selects like ⌘-click, and with Shift like Shift-click.
 */
export function LibrarySelectBox({ document }: { document: Pick<Document, "id" | "name"> }) {
  const t = useT();
  const key = `document:${document.id}`;
  const checked = useSelection((state) => state.surface === "library" && state.keys.has(key));
  const selecting = useSelection((state) => state.surface === "library" && state.items.length > 1);
  return (
    <input
      type="checkbox"
      data-testid="library-select"
      aria-label={t("library.select", { name: document.name })}
      checked={checked}
      onChange={(event) => {
        const { toggle, extendTo } = useSelection.getState();
        const ref = documentRef(document.id);
        if ((event.nativeEvent as MouseEvent).shiftKey) extendTo("library", ref);
        else toggle("library", ref);
      }}
      className={`${boxClass} absolute top-3 -left-7 ${
        checked || selecting
          ? ""
          : "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
      }`}
    />
  );
}

/**
 * In the quiet bar's place while two or more are selected: select all or
 * none, how many, then Move to…, Tags…, Ask about these and Delete, each
 * saying how many it acts on, ⋯ for every command that applies to all of them
 * (the right-click menu's), and Esc to clear. Narrow, the named ones go under
 * ⋯ and the bar never wraps. Rows scroll under it, their checkboxes in the
 * margin too.
 */
export function LibrarySelectionBar({ shownIds }: { shownIds: readonly string[] }) {
  const t = useT();
  const language = useLanguage();
  const items = useSelectedOn("library");
  const documents = useAppStore(
    useShallow((state) => {
      const ids = new Set(items.map((each) => each.id));
      return ids.size > 1 ? state.documents.filter((each) => ids.has(each.id)) : [];
    }),
  );
  const all = useRef<HTMLInputElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const every = items.length > 0 && items.length === shownIds.length;
  useEffect(() => {
    if (all.current) all.current.indeterminate = items.length > 0 && !every;
  });
  if (items.length < 2) return null;
  const last = items.at(-1) as ObjectRef;
  const moveBeside = (selector: string) => {
    const anchor = bar.current?.querySelector<HTMLElement>(selector);
    if (!anchor) return;
    useDocumentMove.getState().show({
      anchor,
      documentIds: items.flatMap((ref) => (ref.kind === "document" ? [ref.id] : [])),
    });
  };
  const ctx: CommandContext = {
    selection: items,
    focus: last,
    surface: "library",
    here: { "document.moveTo": () => moveBeside('[data-command="document.moveTo"]') },
  };
  const offered = buildMenu("document", ctx).filter((entry): entry is MenuItem => entry !== "rule");
  const named = NAMED.flatMap(({ id, from, keys }) => {
    const item = offered.find((entry) => entry.command.id === id);
    return item ? [{ item, from, keys: keys && keysHere(keys) }] : [];
  });
  const run = (item: MenuItem) => {
    if (item.enabled !== true) return;
    commands.run(item.command.id, ctx).catch(useAppStore.getState().reportError);
  };
  const button = ({ item, from, keys: rowKeys }: (typeof named)[number]) => {
    const keys = menuKeysLabel(item.command) ?? rowKeys;
    return (
      <button
        key={item.command.id}
        type="button"
        data-testid="library-selection-action"
        data-command={item.command.id}
        aria-disabled={item.enabled === true ? undefined : true}
        onClick={() => run(item)}
        className={`${barCommandClass} hidden ${from}`}
      >
        {menuLabelOf(item.command, ctx, t)}
        {keys && <span className="text-[12px] text-ink-meta">{keys}</span>}
      </button>
    );
  };
  const [move, ...rest] = named;
  const count = formatCount(items.length, language);
  return (
    <div
      ref={bar}
      role="toolbar"
      aria-label={t("library.selected", { count })}
      data-testid="library-selection"
      onKeyDown={(event) => {
        // A picker or menu that is open, such as the bar's Tags picker, closes first.
        if (event.key !== "Escape" || event.defaultPrevented || dialogOrMenuOpen()) return;
        event.preventDefault();
        useSelection.getState().clear("library");
      }}
      className="@container sticky top-0 z-10 mt-2 flex h-9 min-w-0 items-center gap-1 rounded-md bg-frame pr-1 pl-2.5 text-[13px] before:absolute before:inset-y-0 before:right-full before:w-10 before:bg-sheet"
    >
      <input
        ref={all}
        type="checkbox"
        data-testid="library-select-all"
        aria-label={t("library.selectAll", { count: formatCount(shownIds.length, language) })}
        checked={every}
        onChange={() =>
          every ? useSelection.getState().clear("library") : useSelection.getState().all("library")
        }
        className={boxClass}
      />
      <span role="status" className="mr-2 ml-1 shrink-0 font-semibold whitespace-nowrap text-ink">
        {t("library.selected", { count })}
      </span>
      {move && button(move)}
      <SelectionTags
        documents={documents}
        testId="library-selection-tags"
        className={`${barCommandClass} inline-flex`}
        keys={
          <span className="hidden text-[12px] text-ink-meta @[44rem]:inline">
            {keysHere(TAGS_KEYS)}
          </span>
        }
      />
      {rest.map(button)}
      <ObjectMenu
        target={last}
        selection={items}
        here={{
          // Once the menu has closed and given the focus back, so the picker opens beside ⋯.
          "document.moveTo": () => requestAnimationFrame(() => moveBeside("[data-object-menu]")),
        }}
        label={t("library.selected.more", { count })}
      />
      <span className="flex-1" />
      <button
        type="button"
        data-testid="library-selection-clear"
        aria-label={t("library.selected.clear")}
        title={t("library.selected.clear")}
        onClick={() => useSelection.getState().clear("library")}
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-ink-meta hover:bg-rule hover:text-ink"
      >
        <CloseLineIcon className="size-3.5" />
        <span className="text-[12px]">Esc</span>
      </button>
    </div>
  );
}
