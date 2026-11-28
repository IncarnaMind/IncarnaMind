import { useRef } from "react";
import type { NoteConversationSummary } from "../../../core/api";
import { useT } from "../i18n";
import { deleteNoteConversation, noteConversationTitle } from "../noteConversations";
import { useAppStore } from "../store";
import {
  buttonClass,
  dangerButtonClass,
  dialogActionsClass,
  dialogBodyClass,
  dialogClass,
  dialogTextClass,
  dialogTitleClass,
} from "./ui";
import { useModal } from "./useModal";

/**
 * Permanent-delete confirmation dialog for an own-AI conversation (#3731): deleting removes both
 * IncarnaMind's record and the agent's transcript and can't be undone.
 */
export function DeleteNoteConversationDialog({
  conversation,
  onClose,
}: {
  conversation: NoteConversationSummary | null;
  onClose(): void;
}) {
  const t = useT();
  const dialog = useModal(conversation !== null);
  // Kept while the dialog closes, so its text doesn't empty out first.
  const shown = useRef(conversation);
  if (conversation) shown.current = conversation;
  const current = shown.current;
  const name = current ? noteConversationTitle(current, t("noteColumn.title")) : "";
  const agent = current?.agent || "Claude Code";

  const confirm = () => {
    const doomed = conversation;
    onClose();
    if (!doomed) return;
    void deleteNoteConversation(doomed.id).catch(useAppStore.getState().reportError);
  };

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      data-testid="delete-note-conversation-dialog"
      role="alertdialog"
      aria-labelledby="delete-note-conversation-title"
      aria-describedby="delete-note-conversation-body"
      className={`${dialogClass} w-[26rem]`}
    >
      <div className={dialogBodyClass}>
        <h2 id="delete-note-conversation-title" className={`${dialogTitleClass} break-words`}>
          {t("noteColumn.delete.title", { name })}
        </h2>
        <p id="delete-note-conversation-body" className={`${dialogTextClass} break-words`}>
          {t("noteColumn.delete.body", { agent })}
        </p>
        <div className={dialogActionsClass}>
          <button
            type="button"
            data-testid="cancel-delete-note-conversation"
            onClick={onClose}
            className={buttonClass}
          >
            {t("deleted.confirm.cancel")}
          </button>
          <button
            type="button"
            data-testid="confirm-delete-note-conversation"
            onClick={confirm}
            className={dangerButtonClass}
          >
            {t("deleted.confirm.delete")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
