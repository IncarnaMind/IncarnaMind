import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import {
  consumeNoteHistoryRequest,
  moveConversation,
  noteConversationTitle,
  setColumnOpen,
  startNewConversation,
  useNoteColumns,
  useNoteConversations,
} from "../../noteConversations";
import { focusNoteAsk, isGoing, useNoteAsks } from "../../ownAiInNote";
import {
  ChevronDownLineIcon,
  CloseLineIcon,
  DockBottomLineIcon,
  DockRightLineIcon,
  HistoryLineIcon,
  type Icon,
  PlusLineIcon,
} from "../icons";
import { MenuItemParts } from "../MenuItemParts";
import { menuClass, menuItemClass, menuRuleClass } from "../ui";
import { usePopoverMenu } from "../usePopoverMenu";
import { NoteHistoryPopover } from "./NoteHistoryPopover";

/**
 * The conversation's top row (#3765, #3731): at the left, the conversation's name (first request
 * or user-renamed title, or "New conversation" before its first turn), whose menu starts a new
 * conversation, moves it between the window's column and the Note's foot where both can stand, and
 * hides it; at the right end, a clock button that opens the History popover. Each item gives the
 * keyboard back to the input, where it was before the menu took it.
 */
export function ConversationMenu({
  mindId,
  pairingId,
  conversationId,
  place,
  canMove,
  onHide,
}: {
  mindId: string;
  pairingId: string;
  conversationId: string | null;
  place: "column" | "upward";
  /** The move to the column, upward: only while the column fits beside the groups. */
  canMove: boolean;
  onHide(): void;
}) {
  const t = useT();
  const menu = usePopoverMenu({ focus: "first" });
  const historyButton = useRef<HTMLButtonElement>(null);
  const [historyOpen, setHistoryOpen] = useState<false | "pointer" | "keyboard">(false);
  const historyRequested = useNoteColumns((state) => state.historyOpenRequested);
  useEffect(() => {
    if (!historyRequested) return;
    consumeNoteHistoryRequest();
    setHistoryOpen("keyboard");
  }, [historyRequested]);

  const summary = useNoteConversations((state) =>
    conversationId ? state.list.find((each) => each.id === conversationId) : undefined,
  );
  // Not while the core holds a run of the conversation: a request working, its AI waiting on the
  // User, or one sent meanwhile still to be answered.
  const working = useNoteAsks((state) =>
    isGoing(
      conversationId !== null
        ? state.byConversation[conversationId]
        : ((pairingId ? state.pendingByPairing[pairingId] : undefined) ??
            state.pendingByPairing[mindId]),
    ),
  );
  const title =
    conversationId === null
      ? t("noteColumn.new")
      : summary
        ? noteConversationTitle(summary, t("noteColumn.title"))
        : t("noteColumn.title");
  const back = () => requestAnimationFrame(() => focusNoteAsk(mindId));
  const item = (testId: string, icon: Icon, label: string, run: () => void, disabled = false) => (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      disabled={disabled}
      onClick={() => {
        menu.close();
        run();
        back();
      }}
      className={`${menuItemClass} pl-2`}
    >
      <MenuItemParts icon={icon} label={label} />
    </button>
  );
  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        data-testid="conversation-name"
        title={title}
        className="note-conversation-name"
      >
        <span className="truncate">{title}</span>
        <ChevronDownLineIcon className="shrink-0" aria-hidden="true" />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={t("noteColumn.title")}
        data-testid="conversation-menu"
        className={menuClass}
      >
        {menu.open && (
          <>
            {item(
              "conversation-new",
              PlusLineIcon,
              t("noteColumn.new"),
              () => {
                if (pairingId) startNewConversation(pairingId);
              },
              working || !pairingId,
            )}
            <div className={menuRuleClass} />
            {place === "column" &&
              item("conversation-move-down", DockBottomLineIcon, t("noteColumn.moveDown"), () =>
                moveConversation("upward"),
              )}
            {place === "upward" &&
              canMove &&
              item("conversation-move-left", DockRightLineIcon, t("noteColumn.moveLeft"), () =>
                moveConversation("column"),
              )}
            {item(
              place === "column" ? "note-column-close" : "note-ask-fold",
              CloseLineIcon,
              t("noteColumn.close"),
              () => (place === "column" ? setColumnOpen(false) : onHide()),
            )}
          </>
        )}
      </div>
      <button
        ref={historyButton}
        type="button"
        data-testid="conversation-history-button"
        aria-expanded={historyOpen !== false}
        aria-haspopup="dialog"
        aria-label={t("noteColumn.history")}
        title={t("noteColumn.history")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) =>
          setHistoryOpen((was) => (was ? false : event.detail === 0 ? "keyboard" : "pointer"))
        }
        className="note-column-icon note-conversation-history-button"
      >
        <HistoryLineIcon />
      </button>
      {historyOpen !== false && historyButton.current && (
        <NoteHistoryPopover
          anchor={historyButton.current}
          mindId={mindId}
          pairingId={pairingId}
          activeId={conversationId}
          working={working}
          place={place}
          openedBy={historyOpen}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </>
  );
}
