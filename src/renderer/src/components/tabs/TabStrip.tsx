import {
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import type { LayoutGroup, LayoutTab } from "../../../../core/api";
import { shortcutLabel } from "../../commands/keymap";
import { useFirstOpen } from "../../firstOpen";
import { useT } from "../../i18n";
import { focusedGroupOf, groupOfTab } from "../../layoutSlice";
import { onMiddleClick } from "../../middleClick";
import { useAppStore } from "../../store";
import { focusTab } from "../../tabFocus";
import { tabLabelEm } from "../../tabLabel";
import { InlineName } from "../InlineName";
import { CloseLineIcon, PinLineIcon, PlusLineIcon, SplitLineIcon } from "../lineIcons";
import { ObjectMenu, useObjectMenu } from "../ObjectMenu";
import { SidebarToggle } from "../SidebarToggle";
import { TasksChip } from "../TasksChip";
import { ExportMenu } from "./ExportMenu";
import { ShowAllTabs } from "./ShowAllTabs";
import { GroupMenu, StripButton } from "./TabMenus";
import { splitToTheRight } from "./tabActions";
import { MeetingTabTime, TabIcon, useTabTitle } from "./tabItems";
import { type TabDrag, useTabSource } from "./useTabDrag";
import { useTabStripFit } from "./useTabStripFit";

/*
 * A group's tab strip (DESIGN.md, Components: Mind tabs, which now hold
 * everything that opens): the tabs, then "+" for a new Mind in this group,
 * then the Tasks chip (in the last group's strip), Export (for a Mind), Split
 * and ⋯. This file is their behaviour and
 * structure; their whole look is the `.tab-strip` block in styles.css.
 */

/** The tabs of a group, or, merged, of every group in order, with the one shown. */
export function TabStrip({
  group,
  index,
  merged,
  drag,
}: {
  group: LayoutGroup;
  index: number;
  merged: boolean;
  drag: TabDrag;
}) {
  const t = useT();
  const layout = useAppStore((state) => state.layout);
  const createMind = useAppStore((state) => state.createMind);
  const strip = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const tabs = merged && layout ? layout.groups.flatMap((each) => each.tabs) : group.tabs;
  const shownId = group.activeTabId;
  const tabIds = tabs.map((tab) => tab.id).join();
  const overflow = useOverflow(list, tabIds);
  const shown = group.tabs.find((tab) => tab.id === shownId);
  const last = merged || index === (layout?.groups.length ?? 1) - 1;

  const spacer = useRef<HTMLSpanElement>(null);
  const hidden = useTabStripFit(strip, list, spacer, shownId ?? null, tabIds);

  /** Arrow keys, Home and End move to another tab of the strip and show it, as in any tab list. */
  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (fromInside(event)) return;
    const current = tabs.findIndex((tab) => tab.id === shownId);
    const next =
      event.key === "ArrowRight"
        ? tabs[(current + 1) % tabs.length]
        : event.key === "ArrowLeft"
          ? tabs[(current - 1 + tabs.length) % tabs.length]
          : event.key === "Home"
            ? tabs[0]
            : event.key === "End"
              ? tabs.at(-1)
              : undefined;
    if (!next) return;
    event.preventDefault();
    void useAppStore.getState().changeLayout({ type: "show", tabId: next.id });
    focusTab(next.id);
  };

  const quiet = useFirstOpen() && layout?.groups.flatMap((each) => each.tabs).length === 1;
  if (quiet) {
    return (
      <header
        data-testid="tab-strip"
        data-group-id={group.id}
        data-first-group={index === 0 || undefined}
        data-quiet=""
        className="tab-strip title-bar"
      >
        {index === 0 && <SidebarToggle place="band" />}
        <span className="tab-strip-spacer" />
        {/* Its slot in the band: "Show Tasks" is in ⌘K here too, and it needs somewhere to open from. */}
        {last && <TasksChip />}
      </header>
    );
  }

  return (
    <header
      ref={strip}
      data-testid="tab-strip"
      data-group-id={group.id}
      data-first-group={index === 0 || undefined}
      className="tab-strip title-bar"
    >
      {index === 0 && <SidebarToggle place="band" />}
      <div
        ref={list}
        role="tablist"
        aria-label={t("tabs.group", { n: index + 1 })}
        data-testid="tab-list"
        data-hidden-before={overflow.before || undefined}
        data-hidden-after={overflow.after || undefined}
        className="tab-list"
        onKeyDown={moveFocus}
      >
        {tabs.map((tab, position) => {
          const owner = merged ? groupOfTab(layout, tab.id)?.group : group;
          const selected = tab.id === shownId;
          const next = tabs[position + 1];
          return (
            <Tab
              key={tab.id}
              tab={tab}
              groupId={owner?.id ?? group.id}
              selected={selected}
              // A divider on a tab's right edge: not on the last, nor next to the shown one.
              divider={!selected && next !== undefined && next.id !== shownId}
              dragged={drag.draggedTabId === tab.id}
            />
          );
        })}
      </div>
      <button
        type="button"
        data-testid="new-tab"
        aria-label={t("tabs.new", { shortcut: shortcutLabel("mind.new") })}
        title={t("tabs.new.about", { shortcut: shortcutLabel("mind.new") })}
        onClick={() => void createMind({ titled: true, groupId: group.id })}
        className="tab-new"
      >
        <PlusLineIcon />
      </button>
      {/* Shown only while a tab is hidden (styles.css), so the fit counts its room when it is (#2244). */}
      <ShowAllTabs tabs={tabs} shownId={shownId} hidden={hidden} />
      <span ref={spacer} className="tab-strip-spacer" />
      {last && <TasksChip />}
      {shown?.item.kind === "mind" && <ExportMenu mindId={shown.item.mindId} />}
      {!merged && (
        <span className="tab-split">
          <StripButton
            testId="split-group"
            label={t("tabs.split", { shortcut: shortcutLabel("tab.split") })}
            onClick={() => void splitToTheRight(shown?.id)}
          >
            <SplitLineIcon />
          </StripButton>
        </span>
      )}
      <GroupMenu groupId={group.id} merged={merged} />
    </header>
  );
}

/**
 * Whether an event comes from inside a tab's menu or its name being typed,
 * which sit in the tab but aren't the tab: they keep their keys and clicks.
 */
const fromInside = (event: { target: EventTarget }) =>
  (event.target as Element).closest('[role="menu"], input') !== null;

interface TabProps {
  tab: LayoutTab;
  /** The group it is in. */
  groupId: string;
  selected: boolean;
  divider: boolean;
  dragged: boolean;
}

/** One tab: its icon, its title (italic while a preview), and ✕, or a pin for a pinned one. */
function Tab({ tab, groupId, selected, divider, dragged }: TabProps) {
  const t = useT();
  const title = useTabTitle(tab.item);
  const renaming = useAppStore((state) => state.renamingTabId === tab.id);
  const source = useTabSource(tab.id, title);
  const { changeLayout, closeTab, renameTab } = useAppStore.getState();
  const isMind = tab.item.kind === "mind";
  const objectMenu = useObjectMenu({ kind: "tab", id: tab.id });

  const show = () => {
    const { layout } = useAppStore.getState();
    const current = layout ? focusedGroupOf(layout) : null;
    if (selected && current?.id === groupId) return;
    void changeLayout({ type: "show", tabId: tab.id });
  };
  const rename = () => {
    if (isMind) renameTab(tab.id);
  };
  const tooltip = tab.preview
    ? t("tabs.preview", { title })
    : tab.pinned
      ? t("tabs.pinned", { title })
      : title;

  return (
    <div
      role="tab"
      id={`tab-${tab.id}`}
      aria-selected={selected}
      aria-controls={selected ? `tabpanel-${groupId}` : undefined}
      tabIndex={selected ? 0 : -1}
      title={tooltip}
      // Its name is its title, not its buttons' too; a preview or a pin is said after it.
      aria-label={title}
      aria-description={tooltip === title ? undefined : tooltip}
      data-testid={`${tab.item.kind}-tab`}
      data-tab-id={tab.id}
      data-group-id={groupId}
      data-kind={tab.item.kind}
      data-mind-id={tab.item.kind === "mind" ? tab.item.mindId : undefined}
      data-document-id={tab.item.kind === "document" ? tab.item.documentId : undefined}
      data-preview={tab.preview || undefined}
      data-pinned={tab.pinned || undefined}
      data-divider={divider || undefined}
      data-dragging={dragged || undefined}
      style={{ "--tab-label-min": `${tabLabelEm(title)}em` } as CSSProperties}
      className="tab"
      {...(renaming ? {} : source)}
      onClick={(event) => {
        if (!renaming && !fromInside(event)) show();
      }}
      onDoubleClick={(event) => {
        if (fromInside(event) || (event.target as Element).closest("button")) return;
        // A preview is kept; a Mind's tab is renamed in place.
        if (tab.preview) void changeLayout({ type: "keep", tabId: tab.id });
        else rename();
      }}
      {...objectMenu.rowProps}
      onKeyDown={(event) => {
        if (fromInside(event)) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (tab.preview) void changeLayout({ type: "keep", tabId: tab.id });
          show();
        } else objectMenu.rowProps.onKeyDown(event);
      }}
      // A middle click closes it, as in a browser; a pinned tab stays, as with ⌘W.
      {...onMiddleClick((event) => {
        if (!tab.pinned && !fromInside(event)) closeTab(tab.id);
      })}
    >
      {/* The shown tab's feet, flaring into the page below; the others hide them. */}
      <span aria-hidden="true" data-side="left" className="tab-foot" />
      <span className="tab-inner">
        <span className="tab-icon">
          <TabIcon item={tab.item} />
        </span>
        {renaming && tab.item.kind === "mind" ? (
          <RenameTab
            mindId={tab.item.mindId}
            title={title}
            onDone={() => {
              renameTab(null);
              focusTab(tab.id, { onlyIfLost: true });
            }}
          />
        ) : (
          <span data-testid="tab-title" className="tab-title">
            {title}
          </span>
        )}
        {tab.item.kind === "mind" && <MeetingTabTime mindId={tab.item.mindId} />}
        {tab.pinned ? (
          <button
            type="button"
            tabIndex={-1}
            data-testid="tab-unpin"
            aria-label={t("tabs.unpin", { title })}
            title={t("tabs.unpin", { title })}
            onClick={(event) => {
              event.stopPropagation();
              void changeLayout({ type: "pin", tabId: tab.id, pinned: false });
            }}
            className="tab-close"
          >
            <PinLineIcon className="size-[13px] [stroke-width:1.75]" />
          </button>
        ) : (
          <button
            type="button"
            // The tab is the keyboard stop; ⌘W closes it from there.
            tabIndex={-1}
            data-testid="tab-close"
            aria-label={t("tabs.close", { title })}
            title={`${t("tabs.close", { title })} (${shortcutLabel("tab.close")})`}
            onClick={(event) => {
              event.stopPropagation();
              closeTab(tab.id);
            }}
            className="tab-close"
          >
            <CloseLineIcon />
          </button>
        )}
      </span>
      <span aria-hidden="true" data-side="right" className="tab-foot" />
      <ObjectMenu
        target={{ kind: "tab", id: tab.id }}
        label={t("tabs.tabMenu", { title })}
        className="tab-menu-anchor"
        tabIndex={-1}
      />
    </div>
  );
}

/** A Mind's name typed in its tab; blank, it is named by its first line again. */
function RenameTab({ mindId, title, onDone }: { mindId: string; title: string; onDone(): void }) {
  const t = useT();
  const renameMind = useAppStore((state) => state.renameMind);
  const typed = useAppStore((state) => state.minds.find((each) => each.id === mindId)?.title ?? "");
  return (
    <InlineName
      value={typed}
      label={t("mind.renameLabel", { title })}
      placeholder={title}
      testId="tab-rename"
      className="tab-rename"
      clearable
      onCommit={(name) => {
        onDone();
        return renameMind(mindId, name);
      }}
      onCancel={onDone}
    />
  );
}

/**
 * Whether a tab reaches past the strip's visible part on either side: the strip fades out there
 * (see `.tab-list`), which says there is more. The tabs' own edges decide it, not the strip's
 * `scrollWidth`, which the shown tab's feet and the end padding would read as overflow too.
 * `useTabStripFit` keeps the shown tab clear of the fade.
 */
function useOverflow(list: RefObject<HTMLDivElement | null>, tabIds: string) {
  const [overflow, setOverflow] = useState({ before: false, after: false });
  // biome-ignore lint/correctness/useExhaustiveDependencies: tabIds stands for the tabs in the strip, which mounts with the second.
  useEffect(() => {
    const element = list.current;
    if (!element) return;
    const measure = () => {
      const view = element.getBoundingClientRect();
      let before = false;
      let after = false;
      for (const tab of element.querySelectorAll<HTMLElement>(':scope > [role="tab"]')) {
        const box = tab.getBoundingClientRect();
        if (box.left < view.left - 1) before = true;
        if (box.right > view.right + 1) after = true;
      }
      setOverflow((current) =>
        current.before === before && current.after === after ? current : { before, after },
      );
    };
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    // The strip's size changes with the window; its width of tabs, as tabs open and close.
    const resized = new ResizeObserver(measure);
    resized.observe(element);
    const changed = new MutationObserver(measure);
    changed.observe(element, { childList: true });
    return () => {
      element.removeEventListener("scroll", measure);
      resized.disconnect();
      changed.disconnect();
    };
  }, [list, tabIds]);
  return overflow;
}
