import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import type { Document } from "../../../../core/api";
import { translate } from "../../../../shared/i18n";
import {
  looksLikeLabel,
  MAX_SPEAKER_NAME,
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
import { type SpeakersStep, useAppStore } from "../../store";
import { CheckLineIcon, PlusLineIcon } from "../lineIcons";
import { ProblemMark } from "../ProblemLine";
import {
  menuFrameClass,
  menuItemClass,
  menuRuleClass,
  menuTitleClass,
  tallMenuItemClass,
} from "../ui";
import { usePopoverMenu } from "../usePopoverMenu";

const sameWords = (a: string, b: string) =>
  a.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase() ===
  b.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();

/** A Speaker there is, typed as the interface words them in English or Chinese ("Me", "我"). */
const typedSpeaker = (typed: string, labels: readonly string[]) =>
  labels.find((label) =>
    [
      label,
      speakerName(label, (key, params) => translate("en", key, params)),
      speakerName(label, (key, params) => translate("zh-CN", key, params)),
    ].some((words) => sameWords(typed, words)),
  ) ?? null;

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
  rest = null,
}: {
  document: Document;
  lines: readonly TranscriptLine[];
  line: TranscriptLine;
  /**
   * The line was just split off another (#138): the menu opens by itself to ask who speaks it,
   * and the choice completes the split's step. `done` once it closes, chosen or not.
   */
  rest?: { step: SpeakersStep; done(): void } | null;
}) {
  const t = useT();
  const menu = usePopoverMenu();
  const [all, setAll] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [refused, setRefused] = useState<string | null>(null);
  const refusedId = useId();
  const field = useRef<HTMLInputElement>(null);
  const { speakers } = document;
  const now = speakerOf(speakers, line.startMs, line.label);
  const named = (label: string) => nameOf(speakers, label) ?? speakerName(label, t);

  const asking = useRef(false);
  const wasOpen = useRef(false);
  const { show } = menu;
  useEffect(() => {
    if (!rest) return;
    asking.current = true;
    show();
  }, [rest, show]);
  useEffect(() => {
    if (menu.open) {
      wasOpen.current = true;
      return;
    }
    setAll(false);
    setNaming(false);
    setName("");
    setRefused(null);
    // Only once it has closed: it is still to open when it is first asked to.
    if (!wasOpen.current) return;
    wasOpen.current = false;
    if (asking.current) {
      asking.current = false;
      rest?.done();
    }
  }, [menu.open, rest]);
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
    if (rest && asking.current) void rest.step.amend(next);
    else void useAppStore.getState().setTranscriptSpeakers(document.id, next, said);
  };

  const onNameKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const typed = name.trim();
    if (typed === "") return;
    // A label's words pick that Speaker, "我" the User; a label nobody has isn't a name.
    const label = typedSpeaker(typed, speakersIn(speakers, lines));
    if (label) choose({ label });
    else if (looksLikeLabel(typed)) setRefused(typed);
    else choose({ name: typed });
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
        aria-label={t(rest ? "transcript.speaker.whoRest" : "transcript.speaker.who")}
        data-testid="speaker-menu"
        data-quote-skip=""
        className={`${menuFrameClass} w-[250px] max-w-[calc(100vw-16px)]`}
      >
        {menu.open && (
          <>
            <p className={menuTitleClass}>
              {t(rest ? "transcript.speaker.whoRest" : "transcript.speaker.who")}
            </p>
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
                  maxLength={MAX_SPEAKER_NAME}
                  value={name}
                  aria-invalid={refused !== null || undefined}
                  aria-describedby={refused === null ? undefined : refusedId}
                  onChange={(event) => {
                    setName(event.target.value);
                    setRefused(null);
                  }}
                  onKeyDown={onNameKey}
                  className="h-7 w-full rounded-md border border-rule bg-sheet px-2 text-ui text-ink outline-none placeholder:text-ink-placeholder focus-visible:border-accent"
                />
                {refused !== null && (
                  <p
                    id={refusedId}
                    role="alert"
                    data-testid="speaker-name-refused"
                    className="m-0 pt-1 text-[12px] leading-[18px] text-ink"
                  >
                    <ProblemMark />
                    {t("error.transcript.speakerNameIsLabel", { name: refused })}
                  </p>
                )}
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
