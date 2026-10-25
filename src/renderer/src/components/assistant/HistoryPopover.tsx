import { flip, offset, shift } from "@floating-ui/dom";
import { useMemo, useRef } from "react";
import { allOrigins, conversationOrigin } from "../../../../shared/blockOrigins";
import { formatDateTime } from "../../../../shared/dates";
import { conversationName, mindName } from "../../../../shared/naming";
import { useConversations } from "../../conversations";
import { Popover } from "../../editor/Popover";
import { useLanguage, useT } from "../../i18n";
import { noteRememberedFor } from "../../noteChats";
import { useShownPages } from "../../shownPages";
import { useAppStore } from "../../store";
import { CloseLineIcon, HistoryLineIcon } from "../lineIcons";
import { iconButtonClass } from "../ui";

/**
 * The assistant's History, from its title's ▾ or "Conversation history" in ⌘K: the assistant's
 * conversations (#300), newest first, each with its name and when it was last asked in. A chat
 * a note was made from (#1940) is listed under the note's title, its own name being the first
 * Question it came from. Opening one, this Folder's first, All Folders, search and each row's
 * menu come with #258.
 */
export function HistoryPopover({ anchor, onClose }: { anchor: Element; onClose(): void }) {
  const t = useT();
  const language = useLanguage();
  const close = useRef<HTMLButtonElement>(null);
  const conversations = useConversations((state) => state.list);
  const pages = useShownPages((state) => state);
  const minds = useAppStore((state) => state.minds);
  /** The note each chat made, for the notes open in this window: their links back are in their copies. */
  const noteOf = useMemo(() => {
    const notes = new Map<string, string>();
    for (const [mindId, doc] of Object.entries(pages)) {
      const origin = conversationOrigin(allOrigins(doc));
      const chat =
        origin?.from.artifactKind === "conversation" ? origin.from.artifactId : undefined;
      if (chat && !notes.has(chat)) notes.set(chat, mindId);
    }
    return notes;
  }, [pages]);
  return (
    <Popover
      anchor={anchor}
      placement="bottom-start"
      // Without crossAxis: false, flip() hangs a popover that is too wide for the room under the title from its right edge, over the page.
      middleware={() => [offset(4), flip({ crossAxis: false }), shift({ padding: 8 })]}
      onDismiss={onClose}
      initialFocus={close}
      returnFocus
      aria-label={t("assistant.history")}
      data-testid="assistant-history-popover"
    >
      <section className="assistant-history">
        <header className="assistant-history-head">
          <HistoryLineIcon className="size-4 shrink-0 text-ink-meta" />
          <h2 className="min-w-0 flex-1 truncate">{t("assistant.history")}</h2>
          <button
            ref={close}
            type="button"
            aria-label={t("assistant.history.close")}
            title={t("assistant.history.close")}
            onClick={onClose}
            className={iconButtonClass}
          >
            <CloseLineIcon className="size-4" />
          </button>
        </header>
        {conversations.length === 0 ? (
          <p data-testid="assistant-history-empty" className="assistant-history-empty">
            {t("assistant.history.empty")}
          </p>
        ) : (
          <ul aria-label={t("assistant.history")} className="assistant-history-list">
            {conversations.map((conversation) => {
              // The open note's own link first: it is what the note says now.
              const noteId = noteOf.get(conversation.id) ?? noteRememberedFor(conversation.id);
              const note = noteId ? minds.find((each) => each.id === noteId) : undefined;
              const name =
                (note && mindName(note)) ||
                conversationName(conversation) ||
                t("conversation.untitled");
              return (
                <li
                  key={conversation.id}
                  data-testid="assistant-history-row"
                  className="assistant-history-row"
                >
                  <span title={name} className="min-w-0 flex-1 truncate">
                    {name}
                  </span>
                  <time dateTime={conversation.updatedAt} className="shrink-0 text-ink-meta">
                    {formatDateTime(conversation.updatedAt, language)}
                  </time>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </Popover>
  );
}
