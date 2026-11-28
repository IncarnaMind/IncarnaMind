import { flip, offset, shift } from "@floating-ui/dom";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { NoteConversationSummary } from "../../../../core/api";
import { formatDateTime } from "../../../../shared/dates";
import { mindName } from "../../../../shared/naming";
import { Popover } from "../../editor/Popover";
import { useLanguage, useT } from "../../i18n";
import {
  noteConversationTitle,
  refreshNoteConversations,
  renameNoteConversation,
  selectConversation,
  useNoteConversations,
} from "../../noteConversations";
import { focusNoteAsk } from "../../ownAiInNote";
import { useRequests } from "../../requests";
import { useAppStore } from "../../store";
import {
  CheckLineIcon,
  CloseLineIcon,
  HistoryLineIcon,
  MindLineIcon,
  MoreLineIcon,
  PencilLineIcon,
  TrashLineIcon,
} from "../icons";
import { MenuItemParts } from "../MenuItemParts";
import { iconButtonClass, menuClass, menuItemClass, menuRuleClass } from "../ui";
import { usePopoverMenu } from "../usePopoverMenu";

export { noteConversationTitle };

/**
 * Own-AI conversation history (#3731): opened from the clock button at the right end of the
 * conversation's top row. Reuses the assistant's History popover look: newest first, conversations
 * that touched the open Note grouped first under its name, active conversation ticked, and a row
 * menu for inline Rename and permanent Delete (asked once).
 */
export function NoteHistoryPopover({
  anchor,
  mindId,
  pairingId,
  activeId,
  working,
  place,
  openedBy = "keyboard",
  onClose,
}: {
  anchor: Element;
  mindId: string;
  pairingId: string;
  activeId: string | null;
  working: boolean;
  place: "column" | "upward";
  openedBy?: "pointer" | "keyboard";
  onClose(): void;
}) {
  const t = useT();
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const all = useNoteConversations((state) => state.list);
  const minds = useAppStore((state) => state.minds);
  const currentMind = minds.find((each) => each.id === mindId);
  const currentTitle = (currentMind && mindName(currentMind)) || t("mind.untitled");
  const [renamingId, setRenamingId] = useState<string | null>(null);

  useEffect(() => {
    void refreshNoteConversations().catch(useAppStore.getState().reportError);
  }, []);

  // Show this connected AI's conversations (one conversation stream per connected AI).
  const conversations = pairingId ? all.filter((each) => each.pairingId === pairingId) : all;
  const thisNote = conversations.filter((each) => each.notes.some((n) => n.mindId === mindId));
  const others = conversations.filter((each) => !each.notes.some((n) => n.mindId === mindId));

  const pick = (conversation: NoteConversationSummary) => {
    if (working && conversation.id !== activeId) return;
    if (conversation.id !== activeId) selectConversation(conversation.pairingId, conversation.id);
    onClose();
    requestAnimationFrame(() => focusNoteAsk(mindId));
  };

  const askDelete = (conversation: NoteConversationSummary) => {
    useRequests.getState().ask({ deleteNoteConversation: conversation });
  };

  return (
    <Popover
      anchor={anchor}
      placement={place === "upward" ? "top-end" : "bottom-end"}
      middleware={() => [offset(6), flip({ crossAxis: false }), shift({ padding: 8 })]}
      onDismiss={() => {
        if (useRequests.getState().deleteNoteConversation === null) onClose();
      }}
      initialFocus={openedBy === "keyboard" ? close : panel}
      returnFocus
      aria-label={t("noteColumn.history")}
      data-testid="note-history-popover"
    >
      <section
        ref={panel}
        tabIndex={-1}
        className="assistant-history note-history focus:outline-none"
      >
        <header className="assistant-history-head">
          <HistoryLineIcon className="shrink-0 text-ink-meta" />
          <h2 className="min-w-0 flex-1 truncate">{t("noteColumn.history")}</h2>
          <button
            ref={close}
            type="button"
            data-testid="note-history-close"
            aria-label={t("noteColumn.historyClose")}
            title={t("noteColumn.historyClose")}
            onClick={onClose}
            className={iconButtonClass}
          >
            <CloseLineIcon />
          </button>
        </header>
        {conversations.length === 0 ? (
          <p data-testid="note-history-empty" className="assistant-history-empty">
            {t("noteColumn.historyEmpty")}
          </p>
        ) : (
          <div className="assistant-history-list note-history-list">
            {thisNote.length > 0 && (
              <div data-testid="note-history-group-current" className="note-history-group">
                <div data-testid="note-history-group-heading" className="note-history-group-head">
                  <MindLineIcon className="note-history-group-icon" aria-hidden="true" />
                  <span className="truncate">{currentTitle}</span>
                </div>
                <ul aria-label={currentTitle} className="note-history-rows">
                  {thisNote.map((conversation) => (
                    <HistoryRow
                      key={conversation.id}
                      conversation={conversation}
                      active={conversation.id === activeId}
                      disabled={working && conversation.id !== activeId}
                      renaming={renamingId === conversation.id}
                      omitMindId={mindId}
                      onPick={() => pick(conversation)}
                      onStartRename={() => setRenamingId(conversation.id)}
                      onDoneRename={() => setRenamingId(null)}
                      onAskDelete={() => askDelete(conversation)}
                    />
                  ))}
                </ul>
              </div>
            )}
            {others.length > 0 && (
              <div data-testid="note-history-group-other" className="note-history-group">
                {thisNote.length > 0 && (
                  <div
                    data-testid="note-history-group-heading"
                    className="note-history-group-head note-history-group-head--other"
                  >
                    <span className="truncate">{t("noteColumn.historyOther")}</span>
                  </div>
                )}
                <ul aria-label={t("noteColumn.historyOther")} className="note-history-rows">
                  {others.map((conversation) => (
                    <HistoryRow
                      key={conversation.id}
                      conversation={conversation}
                      active={conversation.id === activeId}
                      disabled={working && conversation.id !== activeId}
                      renaming={renamingId === conversation.id}
                      onPick={() => pick(conversation)}
                      onStartRename={() => setRenamingId(conversation.id)}
                      onDoneRename={() => setRenamingId(null)}
                      onAskDelete={() => askDelete(conversation)}
                    />
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>
    </Popover>
  );
}

function HistoryRow({
  conversation,
  active,
  disabled,
  renaming,
  omitMindId,
  onPick,
  onStartRename,
  onDoneRename,
  onAskDelete,
}: {
  conversation: NoteConversationSummary;
  active: boolean;
  disabled: boolean;
  renaming: boolean;
  /** In the open Note's group, omit the open Note's own name so only other touched Notes show. */
  omitMindId?: string;
  onPick(): void;
  onStartRename(): void;
  onDoneRename(): void;
  onAskDelete(): void;
}) {
  const t = useT();
  const language = useLanguage();
  const minds = useAppStore((state) => state.minds);
  const menu = usePopoverMenu({ align: "end", focus: "first" });
  const name = noteConversationTitle(conversation, t("noteColumn.title"));
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!renaming) return;
    setDraft(name);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [renaming, name]);

  const commitRename = () => {
    const cleaned = draft.trim();
    onDoneRename();
    if (cleaned === "" || cleaned === name) return;
    void renameNoteConversation(conversation.id, cleaned).catch(useAppStore.getState().reportError);
  };

  const onRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      commitRename();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onDoneRename();
    }
  };

  const separator = language === "zh-CN" ? "、" : ", ";
  const noteTitles = conversation.notes
    .filter((each) => each.mindId !== omitMindId)
    .map((each) => {
      const live = minds.find((m) => m.id === each.mindId);
      return (live && mindName(live)) || each.title;
    })
    .filter((each) => each !== "");
  const dateText = formatDateTime(conversation.updatedAt, language);
  const metaLine = noteTitles.length > 0 ? `${noteTitles.join(separator)} · ${dateText}` : dateText;

  return (
    <li
      data-testid="note-history-row"
      data-conversation-id={conversation.id}
      data-active={active || undefined}
      data-menu-open={menu.open || undefined}
      className="note-history-row"
    >
      {renaming ? (
        <div className="note-history-rename-wrap">
          <input
            ref={inputRef}
            type="text"
            data-testid="note-history-rename-input"
            aria-label={t("noteColumn.rename")}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onRenameKeyDown}
            onBlur={commitRename}
            className="note-history-rename-input"
          />
          <span className="note-history-row-meta">{metaLine}</span>
        </div>
      ) : (
        <button
          type="button"
          data-testid="note-history-row-pick"
          disabled={disabled}
          onClick={onPick}
          onDoubleClick={(event) => {
            event.preventDefault();
            onStartRename();
          }}
          onKeyDown={(event) => {
            if (event.key === "F2") {
              event.preventDefault();
              onStartRename();
            }
          }}
          className="note-history-row-main"
        >
          <span title={name} className="note-history-row-title">
            {name}
          </span>
          <span title={metaLine} className="note-history-row-meta">
            {noteTitles.length > 0 && `${noteTitles.join(separator)} · `}
            <time dateTime={conversation.updatedAt}>{dateText}</time>
          </span>
        </button>
      )}
      {!renaming && (
        <div className="note-history-row-end">
          {active && (
            <span
              data-testid="note-history-active-mark"
              aria-hidden="true"
              className="note-history-row-check"
            >
              <CheckLineIcon />
            </span>
          )}
          <button
            {...menu.buttonProps}
            type="button"
            data-testid="note-history-row-menu"
            aria-label={t("noteColumn.historyMore")}
            title={t("noteColumn.historyMore")}
            className="note-history-row-more"
          >
            <MoreLineIcon />
          </button>
          <div
            {...menu.menuProps}
            role="menu"
            aria-label={name}
            data-testid="note-history-item-menu"
            className={menuClass}
          >
            {menu.open && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="note-history-rename"
                  onClick={() => {
                    menu.close();
                    onStartRename();
                  }}
                  className={`${menuItemClass} pl-2`}
                >
                  <MenuItemParts icon={PencilLineIcon} label={t("noteColumn.rename")} />
                </button>
                <div className={menuRuleClass} />
                <button
                  type="button"
                  role="menuitem"
                  data-testid="note-history-delete"
                  onClick={() => {
                    menu.close();
                    onAskDelete();
                  }}
                  className={`${menuItemClass} pl-2`}
                >
                  <MenuItemParts icon={TrashLineIcon} label={t("noteColumn.delete")} />
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </li>
  );
}
