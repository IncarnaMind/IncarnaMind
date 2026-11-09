import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { Meeting, MeetingHelpKind } from "../../../core/api";
import { helpLabel } from "../../../shared/meetingHelp";
import { useT } from "../i18n";
import { useMeetingHelp } from "../meetingHelp";
import { exit } from "../motion";
import { askBarKinds } from "./askBarKinds";

/** Between the More… row and the list under it, and the room the window keeps below the list. */
const LIST_GAP = 2;
const LIST_EDGE = 8;

type Keys = Partial<Record<MeetingHelpKind, string>>;

/**
 * The prompts at the top of the floating panel: the first three as rows with their keys, and
 * More…, which opens the rest in a list over whatever is under the bar. The list pushes nothing,
 * so `onReach` tells the panel how far down it reaches, for the window to have room for it. A
 * click on a row asks and closes the list; so does a prompt asked any other way (a shortcut). A
 * click on More… again or outside it closes the list. The panel takes no keyboard, so none of
 * this is typed.
 */
export function AskBar({
  meeting,
  keys,
  onAsk,
  onReach,
}: {
  meeting: Meeting;
  keys: Keys;
  onAsk(kind: MeetingHelpKind): void;
  onReach(reach: number): void;
}) {
  const t = useT();
  const { bar, more } = askBarKinds(meeting.helpTemplate);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLFieldSetElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const asking = useMeetingHelp((state) => state.pending[meeting.id]);

  const close = useCallback(() => {
    if (list.current) exit(list.current, {});
    setOpen(false);
  }, []);

  useEffect(() => {
    if (asking) close();
  }, [asking, close]);

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close();
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open, close]);

  useLayoutEffect(() => {
    const row = anchor.current;
    const menu = list.current;
    if (!open || !row || !menu) {
      onReach(0);
      return;
    }
    const tell = () =>
      onReach(row.offsetTop + row.offsetHeight + LIST_GAP + menu.offsetHeight + LIST_EDGE);
    tell();
    const observer = new ResizeObserver(tell);
    observer.observe(menu);
    return () => observer.disconnect();
  }, [open, onReach]);

  const choose = (kind: MeetingHelpKind) => {
    close();
    onAsk(kind);
  };
  const prompt = (kind: MeetingHelpKind, role?: "menuitem") => {
    const name = t(helpLabel(kind));
    const shortcut = keys[kind];
    return (
      <button
        key={kind}
        type="button"
        role={role}
        data-testid="help-prompt"
        data-kind={kind}
        title={shortcut ? t("meetings.help.button", { name, shortcut }) : name}
        onClick={() => choose(kind)}
        className={role ? "editor-menu-item" : "ask-row"}
      >
        <span className="ask-label">{name}</span>
        {shortcut && (
          <kbd data-testid="help-prompt-keys" className="ask-key">
            {shortcut}
          </kbd>
        )}
      </button>
    );
  };

  return (
    <fieldset
      ref={root}
      aria-label={t("meetings.help.label")}
      data-testid="ask-bar"
      className="ask-bar"
    >
      {bar.map((kind) => prompt(kind))}
      <div ref={anchor} className="ask-anchor">
        <button
          type="button"
          data-testid="help-more"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onClick={() => (open ? close() : setOpen(true))}
          className="ask-row ask-more"
        >
          <span className="ask-label">{t("meetings.help.more")}</span>
        </button>
        {open && (
          <div
            ref={list}
            id={listId}
            role="menu"
            aria-label={t("meetings.help.more")}
            data-testid="help-more-list"
            className="editor-menu ask-list"
          >
            {more.map((kind) => prompt(kind, "menuitem"))}
          </div>
        )}
      </div>
    </fieldset>
  );
}
