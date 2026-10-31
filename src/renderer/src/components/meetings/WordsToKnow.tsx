import { type KeyboardEvent, useId, useRef, useState } from "react";
import {
  cleanWord,
  MAX_MEETING_WORD_LENGTH,
  MAX_MEETING_WORDS,
  wordKey,
} from "../../../../shared/meetingWords";
import { useT } from "../../i18n";
import { useSettingsTarget } from "../../settingsTarget";
import { useAppStore } from "../../store";
import { useUndo } from "../../undo";
import { useRename } from "../../useRename";
import { InlineName } from "../InlineName";
import { CloseLineIcon } from "../lineIcons";
import { rowActionButtonClass } from "../sidebarRows";
import { UndoLineAt } from "../UndoLine";
import {
  buttonClass,
  fieldClass,
  hintClass,
  rowTextClass,
  ruledListClass,
  ruledRow,
  sectionNoteClass,
  sectionTitleClass,
} from "../ui";

const TARGET = ["meeting-words"] as const;
const UNDO_PLACE = "settings:meetings:words";

const wordsNow = () => useAppStore.getState().settings?.user.meetingWords ?? [];
const saveWords = (meetingWords: string[]) =>
  useAppStore.getState().updateSettings({ user: { meetingWords } });

type Problem = { key: "meetings.words.known"; word: string } | { key: "meetings.words.full" };

function WordRow({
  word,
  rename,
  remove,
}: {
  word: string;
  rename(from: string, to: string): Promise<void>;
  remove(word: string): Promise<void>;
}) {
  const t = useT();
  const naming = useRename<HTMLButtonElement>(`meeting-word:${wordKey(word)}`);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    naming.nameProps.onKeyDown(event);
    if ((event.key === "Delete" || event.key === "Backspace") && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void remove(word);
    }
  };
  return (
    <li data-testid="meeting-word" className={`group ${ruledRow("center", true)}`}>
      {naming.renaming ? (
        <InlineName
          value={word}
          label={t("meetings.words.rename", { word })}
          maxLength={MAX_MEETING_WORD_LENGTH}
          testId="meeting-word-field"
          {...naming.field((name) => rename(word, cleanWord(name)))}
        />
      ) : (
        <button
          type="button"
          {...naming.nameProps}
          onKeyDown={onKeyDown}
          title={word}
          data-testid="meeting-word-name"
          className={`min-w-0 flex-1 truncate rounded-sm text-left ${rowTextClass} text-ink`}
        >
          {word}
        </button>
      )}
      <button
        type="button"
        aria-label={t("meetings.words.remove", { word })}
        title={t("meetings.words.remove", { word })}
        data-testid="meeting-word-remove"
        onClick={() => void remove(word)}
        className={rowActionButtonClass}
      >
        <CloseLineIcon className="size-4" />
      </button>
    </li>
  );
}

/**
 * Settings › Meetings › Words to know (#1031): names and terms the transcription on this computer
 * is told at each meeting's start, as a browser's own dictionary keeps the words it shouldn't
 * mark. A word is added at the top, renamed where it is (double-click or F2), and removed with
 * Undo.
 */
export function WordsToKnow() {
  const t = useT();
  const words = useAppStore((state) => state.settings?.user.meetingWords);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const fieldId = useId();
  const field = useRef<HTMLInputElement>(null);
  const section = useSettingsTarget<HTMLElement>(TARGET, words !== undefined, () =>
    queueMicrotask(() => field.current?.focus({ preventScroll: true })),
  );
  if (!words) return null;

  const listed = (word: string, except?: string) =>
    words.some((each) => wordKey(each) === wordKey(word) && each !== except);

  const add = async () => {
    const word = cleanWord(draft);
    if (!word) return;
    if (listed(word)) {
      setProblem({ key: "meetings.words.known", word });
      return;
    }
    if (words.length >= MAX_MEETING_WORDS) {
      setProblem({ key: "meetings.words.full" });
      return;
    }
    setProblem(null);
    setDraft("");
    await saveWords([word, ...words]);
  };

  const rename = async (from: string, to: string) => {
    if (!to || to === from) return;
    if (listed(to, from)) {
      setProblem({ key: "meetings.words.known", word: to });
      return;
    }
    setProblem(null);
    const swap = (list: readonly string[], a: string, b: string) =>
      list.map((each) => (each === a ? b : each));
    await saveWords(swap(words, from, to));
    useUndo.getState().push({
      said: (say, cut) => say("meetings.words.renamed", { from: cut(from), to: cut(to) }),
      undo: () => saveWords(swap(wordsNow(), to, from)),
      redo: () => saveWords(swap(wordsNow(), from, to)),
      shownAt: UNDO_PLACE,
    });
  };

  const remove = async (word: string) => {
    const at = words.indexOf(word);
    setProblem(null);
    await saveWords(words.filter((each) => each !== word));
    useUndo.getState().push({
      said: (say, cut) => say("meetings.words.removed", { word: cut(word) }),
      undo: async () => {
        const now = wordsNow();
        if (now.some((each) => wordKey(each) === wordKey(word))) return;
        await saveWords([...now.slice(0, at), word, ...now.slice(at)]);
      },
      redo: () => saveWords(wordsNow().filter((each) => each !== word)),
      shownAt: UNDO_PLACE,
    });
  };

  return (
    <section ref={section} data-testid="meeting-words" className="mt-6 flex flex-col">
      <h4 className={sectionTitleClass}>{t("meetings.words.title")}</h4>
      <p className={sectionNoteClass}>{t("meetings.words.body")}</p>
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <input
          ref={field}
          id={fieldId}
          type="text"
          value={draft}
          maxLength={MAX_MEETING_WORD_LENGTH}
          aria-label={t("meetings.words.field")}
          aria-describedby={problem ? `${fieldId}-problem` : undefined}
          placeholder={t("meetings.words.placeholder")}
          data-testid="meeting-words-field"
          onChange={(event) => {
            setDraft(event.target.value);
            setProblem(null);
          }}
          className={`h-8 min-w-0 flex-1 ${fieldClass}`}
        />
        <button
          type="submit"
          data-testid="meeting-words-add"
          disabled={cleanWord(draft) === ""}
          className={buttonClass}
        >
          {t("meetings.words.add")}
        </button>
      </form>
      {problem && (
        <p
          id={`${fieldId}-problem`}
          role="alert"
          data-testid="meeting-words-problem"
          className={hintClass}
        >
          {problem.key === "meetings.words.full"
            ? t(problem.key, { count: MAX_MEETING_WORDS })
            : t(problem.key, { word: problem.word })}
        </p>
      )}
      {words.length > 0 && (
        <ul data-testid="meeting-words-list" className={`mt-2 ${ruledListClass}`}>
          {words.map((word) => (
            <WordRow key={word} word={word} rename={rename} remove={remove} />
          ))}
        </ul>
      )}
      <UndoLineAt place={UNDO_PLACE} />
    </section>
  );
}
