import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { Document } from "../../../../core/api";
import {
  nameOf,
  type SpeakerChoice,
  speakerName,
  speakerOf,
  speakersIn,
  type TranscriptLine,
  withSpeakerChosen,
} from "../../../../shared/speakers";
import { useT } from "../../i18n";
import type { WordsInLine } from "../../lineNames";
import { useAppStore } from "../../store";
import { CheckLineIcon, PlusLineIcon } from "../lineIcons";
import {
  menuFrameClass,
  menuItemClass,
  menuRuleClass,
  menuTitleClass,
  tallMenuItemClass,
} from "../ui";
import { usePopoverMenu } from "../usePopoverMenu";

function initialsOf(name: string): string {
  const words = name.split(/\s+/u).filter(Boolean);
  return words
    .map((word) => [...word][0] ?? "")
    .join("")
    .slice(0, 2)
    .toLocaleUpperCase();
}

/**
 * Who speaks a line of a saved Meeting's Transcript (#138), as the prototype's speaker menu has it:
 * the line's Speaker is a button, and its menu lists the User ("Me") and every Speaker its lines
 * are by now, "New speaker…" to name someone else, and "Apply to all" for every line by the line's
 * Speaker. A choice applies at once, with one Undo. F2 on the line and ⌘K open it too.
 */
export function SpeakerMenu({
  document,
  lines,
  line,
}: {
  document: Document;
  lines: readonly TranscriptLine[];
  line: TranscriptLine;
}) {
  const t = useT();
  const menu = usePopoverMenu();
  const [all, setAll] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const { speakers } = document;
  const now = speakerOf(speakers, line.startMs, line.label);
  const named = (label: string) => nameOf(speakers, label) ?? speakerName(label, t);

  useEffect(() => {
    if (menu.open) return;
    setAll(false);
    setNaming(false);
    setName("");
  }, [menu.open]);
  useEffect(() => {
    if (naming) field.current?.focus();
  }, [naming]);

  const choose = (choice: SpeakerChoice) => {
    menu.close();
    // Back on the line, so the arrow keys go on from it as before the menu opened.
    menu.buttonProps.ref.current?.closest<HTMLElement>("[data-line]")?.focus();
    const next = withSpeakerChosen(speakers, lines, line, choice, all);
    if (JSON.stringify(next) === JSON.stringify(speakers ?? { labels: {}, lines: {} })) return;
    const typed = "name" in choice ? choice.name : nameOf(next, choice.label);
    const label = "label" in choice ? choice.label : now;
    const key = all ? "transcript.speaker.allSet" : "transcript.speaker.set";
    const said: WordsInLine = (t, cut) => t(key, { name: cut(typed ?? speakerName(label, t)) });
    void useAppStore.getState().setTranscriptSpeakers(document.id, next, said);
  };

  const onNameKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const typed = name.trim();
    if (typed !== "") choose({ name: typed });
  };

  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        tabIndex={-1}
        data-testid="transcript-speaker"
        data-speaker-button=""
        data-quote-skip=""
        title={t("transcript.speaker.change")}
        className="transcript-speaker transcript-speaker-button"
      >
        {named(now)}
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={t("transcript.speaker.who")}
        data-testid="speaker-menu"
        data-quote-skip=""
        className={`${menuFrameClass} w-[250px] max-w-[calc(100vw-16px)]`}
      >
        {menu.open && (
          <>
            <p className={menuTitleClass}>{t("transcript.speaker.who")}</p>
            {speakersIn(speakers, lines).map((label) => (
              <button
                key={label}
                type="button"
                role="menuitemradio"
                aria-checked={label === now}
                data-testid="speaker-choice"
                data-speaker={label}
                title={named(label)}
                onClick={() => choose({ label })}
                className={`${menuItemClass} pl-1.5`}
              >
                <span
                  aria-hidden="true"
                  className="speaker-initials"
                  data-initials={initialsOf(named(label))}
                />
                <span className="min-w-0 flex-1 truncate">{named(label)}</span>
                {label === now && <CheckLineIcon className="size-3.5 shrink-0 text-accent" />}
              </button>
            ))}
            {naming ? (
              <div className="px-1.5 py-1">
                <input
                  ref={field}
                  data-testid="speaker-name"
                  aria-label={t("transcript.speaker.new")}
                  placeholder={t("transcript.speaker.name")}
                  spellCheck={false}
                  maxLength={200}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={onNameKey}
                  className="h-7 w-full rounded-md border border-rule bg-sheet px-2 text-ui text-ink outline-none placeholder:text-ink-placeholder focus-visible:border-accent"
                />
              </div>
            ) : (
              <button
                type="button"
                role="menuitem"
                data-testid="speaker-new"
                onClick={() => setNaming(true)}
                className={`${menuItemClass} pl-1.5`}
              >
                <span aria-hidden="true" className="speaker-initials bg-transparent">
                  <PlusLineIcon className="size-3.5" />
                </span>
                {t("transcript.speaker.new")}
              </button>
            )}
            <hr className={menuRuleClass} />
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={all}
              data-testid="speaker-all"
              onClick={() => setAll((on) => !on)}
              className={`${tallMenuItemClass} pl-2`}
            >
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{t("transcript.speaker.all")}</span>
                <span className="block text-[12px] leading-[18px] text-ink-meta">
                  {t("transcript.speaker.allHint")}
                </span>
              </span>
              <span className="switch" data-on={all || undefined} aria-hidden="true" />
            </button>
          </>
        )}
      </div>
    </>
  );
}
