import { core } from "../../core";
import { useT } from "../../i18n";
import {
  focusNoteAsk,
  isGoing,
  moveConversation,
  setColumnOpen,
  useNoteAsks,
} from "../../ownAiInNote";
import { useAppStore } from "../../store";
import { ChevronDownLineIcon } from "../lineIcons";
import { menuClass, menuItemClass, menuRuleClass } from "../ui";
import { usePopoverMenu } from "../usePopoverMenu";

/**
 * The conversation's top row: its name, whose menu starts a new conversation, moves it between the
 * window's column and the Note's foot where both can stand, and hides it (#3765). Each item gives
 * the keyboard back to the input, where it was before the menu took it.
 */
export function ConversationMenu({
  mindId,
  place,
  canMove,
  onHide,
  onNew,
}: {
  mindId: string;
  place: "column" | "upward";
  /** The move to the column, upward: only while the column fits beside the groups. */
  canMove: boolean;
  onHide(): void;
  /** After a new conversation started: the turns are read again. */
  onNew(): void;
}) {
  const t = useT();
  const menu = usePopoverMenu({ focus: "first" });
  // Not while the core holds a run of the Note: a request working, its AI waiting on the User, or
  // one sent meanwhile still to be answered.
  const working = useNoteAsks((state) => isGoing(state.byMind[mindId]));
  const back = () => requestAnimationFrame(() => focusNoteAsk(mindId));
  const item = (testId: string, label: string, run: () => void, disabled = false) => (
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
      <span className="flex-1">{label}</span>
    </button>
  );
  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        data-testid="conversation-name"
        className="note-conversation-name"
      >
        <span className="truncate">{t("noteColumn.title")}</span>
        <ChevronDownLineIcon className="size-3 shrink-0" aria-hidden="true" />
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
              t("noteColumn.new"),
              () =>
                void core
                  .startNewNoteConversation(mindId)
                  .then(onNew)
                  .catch(useAppStore.getState().reportError),
              working,
            )}
            <div className={menuRuleClass} />
            {place === "column" &&
              item("conversation-move-down", t("noteColumn.moveDown"), () =>
                moveConversation("upward"),
              )}
            {place === "upward" &&
              canMove &&
              item("conversation-move-left", t("noteColumn.moveLeft"), () =>
                moveConversation("column"),
              )}
            {item(
              place === "column" ? "note-column-close" : "note-ask-fold",
              t("noteColumn.close"),
              () => (place === "column" ? setColumnOpen(mindId, false) : onHide()),
            )}
          </>
        )}
      </div>
    </>
  );
}
