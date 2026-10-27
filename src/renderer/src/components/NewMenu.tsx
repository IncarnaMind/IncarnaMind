import type { ComponentType } from "react";
import type { CommandId } from "../../../shared/commands";
import type { MessageKey } from "../../../shared/i18n";
import { menuKeysLabel } from "../commands/keymap";
import { type CommandContext, commands, labelOf, offered } from "../commands/registry";
import { TableIcon } from "../editor/icons";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import {
  ChevronDownLineIcon,
  ChevronRightLineIcon,
  DocumentLineIcon,
  FindSourcesLineIcon,
  FolderLineIcon,
  MicLineIcon,
  MindLineIcon,
  MoreLineIcon,
  PlusLineIcon,
  RecordingLineIcon,
  VerifyLineIcon,
} from "./lineIcons";
import { iconButtonClass, menuClass, menuItemClass, primaryButtonClass } from "./ui";
import { usePopoverMenu, useSubmenu } from "./usePopoverMenu";

interface NewItem {
  id: CommandId;
  testId: string;
  icon: ComponentType<{ className?: string }>;
  /** The menu's own words, where the command's ⌘K label says more than the menu needs. */
  label?: MessageKey;
}

const WordIcon = ({ className }: { className?: string }) => (
  <DocumentLineIcon kind="docx" className={className} />
);
const WebPageIcon = ({ className }: { className?: string }) => (
  <DocumentLineIcon kind="web" className={className} />
);

const ADD_DOCUMENTS: NewItem = {
  id: "documents.addFilesOrFolder",
  testId: "plus-add-documents",
  icon: PlusLineIcon,
};

const NEW_ITEMS: readonly NewItem[] = [
  { id: "mind.new", testId: "plus-new-mind", icon: MindLineIcon },
  ADD_DOCUMENTS,
  { id: "folder.new", testId: "plus-new-folder", icon: FolderLineIcon },
  { id: "meeting.record", testId: "plus-record-meeting", icon: RecordingLineIcon },
];

const MORE_ITEMS: readonly NewItem[] = [
  { id: "word.import", testId: "plus-import-word", icon: WordIcon },
  { id: "memo.record", testId: "plus-record-memo", icon: MicLineIcon, label: "memos.record.menu" },
  { id: "comparison.start", testId: "plus-compare-documents", icon: TableIcon },
  { id: "verify.document", testId: "plus-verify-document", icon: VerifyLineIcon },
  {
    id: "folder.starters",
    testId: "plus-starter-folders",
    icon: FolderLineIcon,
    label: "folder.fromStarters",
  },
  { id: "webPage.add", testId: "plus-add-web-page", icon: WebPageIcon },
  {
    id: "sources.find",
    testId: "plus-find-sources",
    icon: FindSourcesLineIcon,
    label: "sidebar.plus.findSources",
  },
];

const WINDOW: CommandContext = { selection: [], focus: null, surface: "sidebar" };

/**
 * The one New menu, opened by the sidebar header's + or by the ▾ beside Home's New Mind
 * (`place`). Each item runs the command ⌘K lists, with its keys, so the two can't drift apart.
 */
export function NewMenu({ place = "sidebar" }: { place?: "sidebar" | "home" }) {
  const t = useT();
  const menu = usePopoverMenu(place === "home" ? { align: "end" } : {});
  const more = useSubmenu();
  // Both can be in the window at once: Home's carry their own names for tests.
  const testId = (name: string) => (place === "home" ? `home-${name}` : name);
  const picking = useAppStore((state) => state.pickingDocuments);

  const entryOf = (each: NewItem) => {
    const command = commands.get(each.id);
    if (!command || !offered(command, WINDOW)) return null;
    return {
      label: each.label ? t(each.label) : labelOf(command, WINDOW, t),
      keys: menuKeysLabel(command),
      run: () => void commands.run(each.id, WINDOW).catch(useAppStore.getState().reportError),
    };
  };

  const item = (each: NewItem) => {
    const entry = entryOf(each);
    if (!entry) return null;
    const { icon: Icon } = each;
    return (
      <button
        key={each.testId}
        type="button"
        role="menuitem"
        data-testid={testId(each.testId)}
        disabled={each === ADD_DOCUMENTS && picking}
        onClick={() => {
          menu.close();
          entry.run();
        }}
        className={`${menuItemClass} pl-2`}
      >
        <Icon className="size-4 shrink-0 text-ink-meta" />
        <span className="flex-1">{entry.label}</span>
        {entry.keys && <span className="pl-4 text-[13px] text-ink-meta">{entry.keys}</span>}
      </button>
    );
  };

  return (
    <>
      {place === "home" ? (
        <button
          {...menu.buttonProps}
          type="button"
          data-testid="home-new-menu"
          aria-label={t("home.newMind.more")}
          title={t("home.newMind.more")}
          className={`${primaryButtonClass} w-8 rounded-l-none px-0`}
        >
          <ChevronDownLineIcon className="size-3.5" />
        </button>
      ) : (
        <button
          {...menu.buttonProps}
          type="button"
          data-testid="plus-menu"
          aria-label={t("sidebar.plus")}
          title={t("sidebar.plus")}
          className={`${iconButtonClass} text-ink-secondary`}
        >
          <PlusLineIcon className="size-4" />
        </button>
      )}
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={t("sidebar.plus")}
        data-testid={testId("plus-menu-items")}
        className={menuClass}
      >
        {/* Made as it opens: what each command offers is read then. */}
        {menu.open && (
          <>
            {NEW_ITEMS.map(item)}
            <button
              {...more.itemProps}
              type="button"
              data-testid={testId("plus-more")}
              className={`${menuItemClass} pl-2 aria-expanded:bg-hover`}
            >
              <MoreLineIcon className="size-4 shrink-0 text-ink-meta" />
              <span className="flex-1">{t("sidebar.plus.more")}</span>
              <ChevronRightLineIcon className="size-3.5 text-ink-meta" />
            </button>
          </>
        )}
      </div>
      <div
        {...more.menuProps}
        role="menu"
        aria-label={t("sidebar.plus.more")}
        data-testid={testId("plus-more-menu")}
        className={menuClass}
      >
        {menu.open && MORE_ITEMS.map(item)}
      </div>
    </>
  );
}
