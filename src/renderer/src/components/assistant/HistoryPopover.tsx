import { flip, offset, shift } from "@floating-ui/dom";
import { useRef } from "react";
import { formatDateTime } from "../../../../shared/dates";
import { conversationName } from "../../../../shared/naming";
import { focusComposer } from "../../commands/assistant";
import { openConversation, useConversations } from "../../conversations";
import { Popover } from "../../editor/Popover";
import { useLanguage, useT } from "../../i18n";
import { CloseLineIcon, HistoryLineIcon } from "../lineIcons";
import { iconButtonClass } from "../ui";

/**
 * The assistant's History, from its title's ▾ or "Conversation history" in ⌘K: the assistant's
 * conversations (#300), newest first, each named by its first Question and dated when it was last
 * asked in (#2310). A row opens its conversation, by click or Enter, and the composer takes the
 * cursor where the User asks next. Opening one, this Folder's first, All Folders, search and each
 * row's menu come with #258.
 */
export function HistoryPopover({ anchor, onClose }: { anchor: Element; onClose(): void }) {
  const t = useT();
  const language = useLanguage();
  const close = useRef<HTMLButtonElement>(null);
  const conversations = useConversations((state) => state.list);
  const open = async (conversationId: string): Promise<void> => {
    onClose();
    // The cursor goes where the User asks next, unless New chat or another row took over meanwhile.
    if (await openConversation(conversationId)) focusComposer();
  };
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
              const name = conversationName(conversation) || t("conversation.untitled");
              return (
                <li key={conversation.id}>
                  <button
                    type="button"
                    data-testid="assistant-history-row"
                    onClick={() => void open(conversation.id)}
                    className="assistant-history-row"
                  >
                    <span title={name} className="min-w-0 flex-1 truncate">
                      {name}
                    </span>
                    <time dateTime={conversation.updatedAt} className="shrink-0 text-ink-meta">
                      {formatDateTime(conversation.updatedAt, language)}
                    </time>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </Popover>
  );
}
