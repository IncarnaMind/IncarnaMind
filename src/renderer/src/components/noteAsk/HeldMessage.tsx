import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { NoteTurn } from "../../../../core/api";
import { keysHere } from "../../commands/keymap";
import { useT } from "../../i18n";
import { discardInNote, editHeldInNote, keepInInput, sendNowInNote } from "../../ownAiInNote";
import { useAppStore } from "../../store";
import { PencilLineIcon, TrashLineIcon } from "../icons";
import { TypingTextarea } from "../TypingTextarea";
import { CopyRequest } from "./CopyRequest";

/**
 * A message sent while another request ran, held until that reply ends (#3765): Edit opens it in
 * place, and it isn't sent while the editor is open; Copy; Discard, and it is never sent; Send now
 * gives it to the AI at once; on the oldest, ⌘↵ in the input does too.
 */
export function HeldMessage({
  mindId,
  turn,
  oldest,
}: {
  mindId: string;
  turn: NoteTurn;
  oldest: boolean;
}) {
  const t = useT();
  const report = useAppStore.getState().reportError;
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  });
  const shown = useRef({
    draft: null as string | null,
    request: turn.request,
    closing: false,
    gone: false,
  });
  shown.current.draft = draft;
  shown.current.request = turn.request;
  // An editor that goes without Cancel or Save, as the conversation folds, lets the message go. If
  // the message went first, never sent, the words changed in it are kept in the input.
  useEffect(() => {
    const now = shown.current;
    now.gone = false;
    return () => {
      now.gone = true;
      const left = now.draft;
      if (left === null || now.closing) return;
      void editHeldInNote(mindId, turn.id, { kind: "cancel" })
        .then((held) => {
          if (!held && left !== now.request) keepInInput(mindId, left);
        })
        .catch(report);
    };
  }, [mindId, turn.id, report]);
  // The editor stays open, its words fixed, until the core has them.
  const close = async (edit: { kind: "cancel" } | { kind: "save"; words: string }) => {
    shown.current.closing = true;
    setSaving(true);
    try {
      const held = await editHeldInNote(mindId, turn.id, edit);
      // It went meanwhile, never sent as its run failed: the new words are kept in the input.
      if (!held && edit.kind === "save") keepInInput(mindId, edit.words);
      setDraft(null);
    } catch (error) {
      if (shown.current.gone && edit.kind === "save") keepInInput(mindId, edit.words);
      report(error);
    } finally {
      shown.current.closing = false;
      setSaving(false);
    }
  };
  const openEditor = async () => {
    // Only a message still held opens: one gone meanwhile reads again as sent.
    if (!(await editHeldInNote(mindId, turn.id, { kind: "open" }))) return;
    // Folded away before the core answered: no editor shows, so the message waits for none.
    if (shown.current.gone) {
      await editHeldInNote(mindId, turn.id, { kind: "cancel" });
      return;
    }
    // Drawn at once, out of the press's own event, so its field can take the focus.
    flushSync(() => setDraft(turn.request));
    const field = area.current;
    field?.focus();
    field?.setSelectionRange(field.value.length, field.value.length);
  };
  if (draft !== null) {
    return (
      <div data-testid="note-column-editor" className="note-column-editor">
        <TypingTextarea
          ref={area}
          aria-label={t("noteColumn.edit.message")}
          value={draft}
          readOnly={saving}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || saving) return;
            event.preventDefault();
            void close({ kind: "cancel" });
          }}
          rows={1}
          className="note-column-editor-text"
        />
        <div className="note-column-editor-foot">
          <button
            type="button"
            data-testid="note-column-edit-cancel"
            disabled={saving}
            onClick={() => void close({ kind: "cancel" })}
            className="approval-button approval-button--ghost note-column-editor-button"
          >
            {t("noteColumn.edit.cancel")}
          </button>
          <button
            type="button"
            data-testid="note-column-edit-save"
            disabled={saving || draft.trim() === "" || draft === turn.request}
            onClick={() => void close({ kind: "save", words: draft })}
            className="approval-button approval-button--primary note-column-editor-button"
          >
            {t("noteColumn.edit.save")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="note-column-sent">
      <div className="note-column-bubble">
        <p>{turn.request}</p>
      </div>
      <div data-testid="note-column-held" className="note-column-sent-state" data-waiting="">
        <button
          type="button"
          data-testid="note-column-edit"
          aria-label={t("noteColumn.edit")}
          title={t("noteColumn.edit")}
          onClick={() => void openEditor().catch(report)}
          className="note-column-icon"
        >
          <PencilLineIcon />
        </button>
        <CopyRequest words={turn.request} />
        <button
          type="button"
          data-testid="note-column-discard"
          aria-label={t("noteColumn.discard")}
          title={t("noteColumn.discard")}
          onClick={() => void discardInNote(mindId, turn.id).catch(report)}
          className="note-column-icon"
        >
          <TrashLineIcon />
        </button>
        <span role="status" className="note-column-sent-word">
          {t("noteColumn.waiting")}
        </span>
        <button
          type="button"
          data-testid="note-column-send-now"
          title={oldest ? `${t("noteColumn.sendNow")} ${keysHere("CmdOrCtrl+Enter")}` : undefined}
          onClick={() => void sendNowInNote(mindId, turn.id).catch(report)}
          className="note-column-send-now"
        >
          {t("noteColumn.sendNow")}
          {oldest && <kbd className="note-column-send-now-keys">{keysHere("CmdOrCtrl+Enter")}</kbd>}
        </button>
      </div>
    </div>
  );
}
