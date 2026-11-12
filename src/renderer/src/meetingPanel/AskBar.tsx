import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Meeting, MeetingHelpKind } from "../../../core/api";
import { helpLabel, isGeneralHelpKind } from "../../../shared/meetingHelp";
import { useT } from "../i18n";
import { useMeetingHelp } from "../meetingHelp";
import { exit } from "../motion";
import { askBarKinds } from "./askBarKinds";
import { rankHelp } from "./helpRank";
import { NoteField, type QuickNotes } from "./NoteField";

/** Between a row and the list under it, and the room the window keeps below the list. */
const LIST_GAP = 2;
const LIST_EDGE = 8;
/** The panel can't see a click in the meeting app: an open list closes once the pointer has been away this long. */
const AWAY_MS = 1000;

type Keys = Partial<Record<MeetingHelpKind, string>>;

/**
 * The prompts at the top of the floating panel and its field (#2925). The first three prompts are
 * rows with their keys; More… opens the rest in a list over whatever is under the bar, and "/" at
 * the start of the field opens all of them, narrowed as the User types. A list pushes nothing, so
 * `onReach` tells the panel how far down it reaches, for the window to have room for it. A list
 * closes on a choice, on a prompt asked any other way, on a press outside the bar, on Esc and
 * once the pointer has been off the panel for a second.
 *
 * Only a press in the field and `noteWanted` (⌃⌥N, ⌘K) take the keyboard; a press on a row or a
 * button never does, and while the field has it, keeps the cursor there. With no `notes` (Linux,
 * `helpShortcutsOn`) there is no field, and More… shows no "/".
 */
export function AskBar({
  meeting,
  keys,
  noteWanted,
  onAsk,
  onReach,
  onTakeKeyboard,
  onNoteTaken,
  notes,
}: {
  meeting: Meeting;
  keys: Keys;
  noteWanted: boolean;
  onAsk(kind: MeetingHelpKind): void;
  onReach(reach: number): void;
  onTakeKeyboard(): void;
  onNoteTaken(): void;
  notes: QuickNotes | null;
}) {
  const t = useT();
  const { bar, more } = askBarKinds(meeting.helpTemplate);
  const [moreOpen, setMoreOpen] = useState(false);
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState(0);
  const root = useRef<HTMLFieldSetElement>(null);
  const moreAnchor = useRef<HTMLDivElement>(null);
  const fieldAnchor = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const moreList = useRef<HTMLDivElement>(null);
  const slashList = useRef<HTMLDivElement>(null);
  const listId = useId();
  const asking = useMeetingHelp((state) => state.pending[meeting.id]);

  const typed = text.startsWith("/") ? text.slice(1) : null;
  const found =
    typed === null
      ? []
      : rankHelp(
          [...bar, ...more],
          typed,
          (kind) => t(helpLabel(kind)),
          (kind) => (isGeneralHelpKind(kind) ? t(`meetings.help.keywords.${kind}`) : ""),
        );
  const shownChosen = Math.min(chosen, found.length - 1);

  const closeMore = useCallback(() => {
    if (moreList.current) exit(moreList.current, {});
    setMoreOpen(false);
  }, []);
  const closeSlash = useCallback(() => {
    if (slashList.current) exit(slashList.current, {});
    setText((now) => (now.startsWith("/") ? "" : now));
  }, []);
  const closeLists = useCallback(() => {
    closeMore();
    closeSlash();
  }, [closeMore, closeSlash]);

  const changeText = (value: string) => {
    if (value.startsWith("/")) closeMore();
    if (value !== text) setChosen(0);
    setText(value);
  };

  useEffect(() => {
    if (asking) closeLists();
  }, [asking, closeLists]);

  const listOpen = moreOpen || typed !== null;
  useEffect(() => {
    if (!listOpen) return;
    const away = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) closeLists();
    };
    const page = document.documentElement;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const left = () => {
      clearTimeout(timer);
      timer = setTimeout(closeLists, AWAY_MS);
    };
    const back = () => clearTimeout(timer);
    document.addEventListener("pointerdown", away);
    page.addEventListener("pointerleave", left);
    page.addEventListener("pointerenter", back);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", away);
      page.removeEventListener("pointerleave", left);
      page.removeEventListener("pointerenter", back);
    };
  }, [listOpen, closeLists]);

  useLayoutEffect(() => {
    const row = moreOpen ? moreAnchor.current : fieldAnchor.current;
    const menu = moreOpen ? moreList.current : slashList.current;
    if (!listOpen || !row || !menu) {
      onReach(0);
      return;
    }
    const tell = () =>
      onReach(row.offsetTop + row.offsetHeight + LIST_GAP + menu.offsetHeight + LIST_EDGE);
    tell();
    const observer = new ResizeObserver(tell);
    observer.observe(menu);
    return () => observer.disconnect();
  }, [listOpen, moreOpen, onReach]);

  useEffect(() => {
    if (!noteWanted) return;
    onNoteTaken();
    const element = field.current;
    if (!element) return;
    element.focus();
    element.selectionStart = element.value.length;
    element.selectionEnd = element.value.length;
    onTakeKeyboard();
  }, [noteWanted, onNoteTaken, onTakeKeyboard]);

  const choose = (kind: MeetingHelpKind) => {
    closeLists();
    onAsk(kind);
  };

  const listKeys = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (moreOpen && event.key === "Escape") {
      closeMore();
      return true;
    }
    if (typed === null) return false;
    if (event.key === "Escape") {
      closeSlash();
      return true;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const step = event.key === "ArrowDown" ? 1 : found.length - 1;
      if (found.length > 0) setChosen((shownChosen + step) % found.length);
      return true;
    }
    if (event.key === "Enter") {
      const kind = found[shownChosen];
      if (kind) choose(kind);
      return true;
    }
    return false;
  };

  // A press on a row or button while the field is being written in leaves the cursor there.
  const keepCursor = (event: MouseEvent) => {
    const element = field.current;
    if (
      element &&
      document.activeElement === element &&
      event.target instanceof Element &&
      event.target.closest("button")
    )
      event.preventDefault();
  };

  const optionId = (index: number) => `${listId}-${index}`;
  return (
    <fieldset
      ref={root}
      aria-label={t("meetings.help.label")}
      data-testid="ask-bar"
      onMouseDown={keepCursor}
      className="ask-bar"
    >
      {bar.map((kind) => (
        <Prompt key={kind} kind={kind} shortcut={keys[kind]} onChoose={choose} />
      ))}
      <div ref={moreAnchor} className="ask-anchor">
        <button
          type="button"
          data-testid="help-more"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          aria-controls={moreOpen ? listId : undefined}
          onClick={() => {
            if (moreOpen) closeMore();
            else {
              closeLists();
              setMoreOpen(true);
            }
          }}
          className="ask-row ask-more"
        >
          <span className="ask-label">{t("meetings.help.more")}</span>
          {notes && (
            <kbd data-testid="help-more-keys" className="ask-key">
              /
            </kbd>
          )}
        </button>
        {moreOpen && (
          <div
            ref={moreList}
            id={listId}
            role="menu"
            aria-label={t("meetings.help.more")}
            data-testid="help-more-list"
            className="editor-menu ask-list"
          >
            {more.map((kind) => (
              <Prompt key={kind} kind={kind} shortcut={keys[kind]} menu onChoose={choose} />
            ))}
          </div>
        )}
      </div>
      {notes && (
        <div ref={fieldAnchor} className="ask-anchor">
          <NoteField
            meeting={meeting}
            field={field}
            text={text}
            onText={changeText}
            list={
              typed === null
                ? null
                : { id: listId, chosenId: found.length > 0 ? optionId(shownChosen) : undefined }
            }
            listKeys={listKeys}
            notes={notes}
            onTakeKeyboard={onTakeKeyboard}
          />
          {typed !== null && (
            <div
              ref={slashList}
              id={listId}
              role="listbox"
              aria-label={t("meetings.help.label")}
              data-testid="help-slash-list"
              className="editor-menu ask-list"
            >
              {found.length === 0 ? (
                <p data-testid="help-slash-none" className="editor-menu-note">
                  {t("editor.slash.empty")}
                </p>
              ) : (
                found.map((kind, index) => (
                  <Prompt
                    key={kind}
                    kind={kind}
                    shortcut={keys[kind]}
                    option={{
                      id: optionId(index),
                      selected: index === shownChosen,
                      onPoint: () => setChosen(index),
                    }}
                    onChoose={choose}
                  />
                ))
              )}
            </div>
          )}
        </div>
      )}
    </fieldset>
  );
}

/** A row of the bar or a list. Its tooltip, the label whole and its key, shows only while the label is cut short. */
function Prompt({
  kind,
  shortcut,
  menu = false,
  option,
  onChoose,
}: {
  kind: MeetingHelpKind;
  shortcut: string | undefined;
  menu?: boolean;
  /** A row of the "/" list: the one chosen is marked, and the pointer chooses as ↑ ↓ do. */
  option?: { id: string; selected: boolean; onPoint(): void };
  onChoose(kind: MeetingHelpKind): void;
}) {
  const t = useT();
  const name = t(helpLabel(kind));
  const label = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  const measure = useCallback(() => {
    const element = label.current;
    if (element) setCut(element.scrollWidth > element.clientWidth);
  }, []);
  // After every render, as the words (another language) and the key can change what fits.
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    const element = label.current;
    if (!element) return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);
  const title = cut ? (shortcut ? t("meetings.help.button", { name, shortcut }) : name) : undefined;
  const content = (
    <>
      <span ref={label} className="ask-label">
        {name}
      </span>
      {shortcut && (
        <kbd data-testid="help-prompt-keys" className="ask-key">
          {shortcut}
        </kbd>
      )}
    </>
  );
  if (option) {
    return (
      <button
        type="button"
        id={option.id}
        role="option"
        aria-selected={option.selected}
        data-testid="help-prompt"
        data-kind={kind}
        title={title}
        onMouseMove={option.onPoint}
        onClick={() => onChoose(kind)}
        className="editor-menu-item"
      >
        {content}
      </button>
    );
  }
  return (
    <button
      type="button"
      role={menu ? "menuitem" : undefined}
      data-testid="help-prompt"
      data-kind={kind}
      title={title}
      onClick={() => onChoose(kind)}
      className={menu ? "editor-menu-item" : "ask-row"}
    >
      {content}
    </button>
  );
}
