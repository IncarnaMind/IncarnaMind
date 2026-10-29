import type { Editor } from "@tiptap/core";
import { isChangeOrigin } from "@tiptap/extension-collaboration";
import type { Transaction } from "@tiptap/pm/state";
import { type FormEvent, useEffect, useState } from "react";
import type * as Y from "yjs";
import type { MessageKey } from "../../../shared/i18n";
import {
  countBasisOf,
  countShownOf,
  observeWordCountSettings,
  setCountBasis,
  setCountShown,
  setWordTarget,
  wordTargetOf,
} from "../../../shared/mindWordCount";
import {
  COUNT_BASES,
  type CountBasis,
  countedUnit,
  countFor,
  parseTarget,
} from "../../../shared/wordCount";
import { CheckLineIcon } from "../components/lineIcons";
import { ProblemMark } from "../components/ProblemLine";
import { usePopoverMenu } from "../components/usePopoverMenu";
import { useLanguage, useT } from "../i18n";
import { COUNT_IDLE_MS, createMindCounter, type MindCount } from "./wordCountText";

/**
 * The most a count holds the main thread at once (#812). Only Blocks not
 * counted yet take time, which after an edit is the Blocks it changed; a long
 * Mind's first count goes on in idle time, a slice at a time.
 */
const COUNT_SLICE_MS = 8;

/**
 * What a count may take at once for a change the User didn't type, as an
 * Accept or an Undo: they wait for their result, so it comes within 100 ms.
 */
const COUNT_AT_ONCE_MS = 50;

const BASIS_NAMES: Record<CountBasis, MessageKey> = {
  words: "wordCount.basis.words",
  characters: "wordCount.basis.characters",
  charactersNoSpaces: "wordCount.basis.charactersNoSpaces",
};

/**
 * The Mind's counts, worked out a moment after the text or the selection last
 * changed; null until the Mind's first count is done, so a long Mind never
 * shows "0 words" while it is counted.
 */
export function useCounts(editor: Editor): MindCount | null {
  const [counts, setCounts] = useState<MindCount | null>(null);

  useEffect(() => {
    setCounts(null);
    const counter = createMindCounter();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idle: number | undefined;
    let showsSelection = false;
    const count = (slice = COUNT_SLICE_MS) => {
      timer = undefined;
      idle = undefined;
      if (editor.isDestroyed) return;
      const until = performance.now() + slice;
      const { from, to } = editor.state.selection;
      const counted = counter.count(
        editor.state.doc,
        { from, to },
        () => performance.now() > until,
      );
      if (counted) {
        showsSelection = counted.selection !== null;
        setCounts(counted);
      }
      // Not starved while the renderer is busy for long, as when an Answer streams.
      else idle = requestIdleCallback(() => count(), { timeout: 1000 });
    };
    const stop = () => {
      clearTimeout(timer);
      if (idle !== undefined) cancelIdleCallback(idle);
      timer = undefined;
      idle = undefined;
    };
    const later = () => {
      stop();
      timer = setTimeout(count, COUNT_IDLE_MS);
    };
    // Typing waits for a pause; what comes through Yjs (an Accept, an Undo, the assistant's text) is waited on.
    const updated = ({ transaction }: { transaction: Transaction }) => {
      if (!isChangeOrigin(transaction)) return later();
      stop();
      count(COUNT_AT_ONCE_MS);
    };
    // A selection closed over unchanged text counts at once: a check closes it as it starts, and a later count would move the check's line (#968).
    const selected = ({ transaction }: { transaction: Transaction }) => {
      if (!showsSelection || transaction.docChanged || !editor.state.selection.empty) {
        later();
        return;
      }
      stop();
      count();
    };
    count();
    editor.on("update", updated);
    editor.on("selectionUpdate", selected);
    return () => {
      stop();
      editor.off("update", updated);
      editor.off("selectionUpdate", selected);
    };
  }, [editor]);

  return counts;
}

/** The Mind's target, what its count shows and whether it shows, kept up to date as they change here or elsewhere. */
export function useCountSettings(doc: Y.Doc) {
  const read = () => ({
    target: wordTargetOf(doc),
    basis: countBasisOf(doc),
    shown: countShownOf(doc),
  });
  const [settings, setSettings] = useState(read);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `read` only reads `doc`.
  useEffect(() => {
    setSettings(read());
    return observeWordCountSettings(doc, () => setSettings(read()));
  }, [doc]);
  return settings;
}

/**
 * The count while writing, at the page's bottom left when the User turned it
 * on: words for English and characters for Chinese (what the hover says), the
 * selection's count of the whole while text is selected, and the progress to
 * the Mind's target if it has one. Its menu chooses what is counted (words, or
 * characters with or without spaces) and sets the target. All of it is
 * remembered for the Mind (`mindWordCount`).
 */
export function WordCount({ editor, doc }: { editor: Editor; doc: Y.Doc }) {
  const t = useT();
  const language = useLanguage();
  const counts = useCounts(editor);
  const { target, basis } = useCountSettings(doc);
  const menu = usePopoverMenu();
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);

  if (!counts) return null;

  const format = (value: number) => new Intl.NumberFormat(language).format(value);
  const counted = countedUnit(counts.total, basis, language === "zh-CN");
  const unit = (value: number) =>
    t(value === 1 ? `wordCount.unit.${counted}.one` : `wordCount.unit.${counted}`);

  const total = countFor(counts.total, basis);
  const selected = counts.selection ? countFor(counts.selection, basis) : null;
  const text =
    selected !== null
      ? t("wordCount.selected", {
          selected: format(selected),
          total: format(total),
          unit: unit(total),
        })
      : target !== null
        ? t("wordCount.target", {
            count: format(total),
            target: format(target),
            unit: unit(target),
          })
        : t("wordCount.total", { count: format(total), unit: unit(total) });
  const percent = target === null ? 0 : Math.min(100, Math.round((total / target) * 100));

  const setTarget = (event: FormEvent) => {
    event.preventDefault();
    const value = parseTarget(draft);
    if (value === null) {
      setInvalid(true);
      return;
    }
    setWordTarget(doc, value);
    menu.close();
  };

  return (
    <div className="mind-count" data-testid="mind-count">
      <button
        type="button"
        {...menu.buttonProps}
        data-testid="mind-count-button"
        data-total={total}
        data-selected={selected ?? undefined}
        title={t("wordCount.rule")}
        onClick={() => {
          setDraft(target === null ? "" : format(target));
          setInvalid(false);
        }}
        className="mind-count-button"
      >
        {text}
      </button>
      {target !== null && (
        <span
          role="progressbar"
          aria-label={t("wordCount.progress", { percent })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          data-testid="mind-count-progress"
          className="mind-count-progress"
        >
          <span className="mind-count-fill" style={{ width: `${percent}%` }} />
        </span>
      )}
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={t("wordCount.menu")}
        data-testid="mind-count-menu"
        className="model-menu count-menu"
      >
        {menu.open && (
          <>
            <div className="model-menu-list">
              <p className="model-menu-intro">{t("wordCount.scope")}</p>
              {COUNT_BASES.map((each) => (
                <button
                  key={each}
                  type="button"
                  role="menuitemradio"
                  aria-checked={each === basis}
                  data-testid="mind-count-basis"
                  data-basis={each}
                  onClick={() => {
                    setCountBasis(doc, each);
                    menu.close();
                  }}
                  className="model-menu-item"
                >
                  <CheckLineIcon
                    className="model-menu-check"
                    style={{ visibility: each === basis ? "visible" : "hidden" }}
                  />
                  <span className="model-menu-name">{t(BASIS_NAMES[each])}</span>
                </button>
              ))}
            </div>
            <form onSubmit={setTarget} className="count-target">
              <label htmlFor={`${menu.menuProps.id}-target`}>{t("wordCount.target.label")}</label>
              <input
                id={`${menu.menuProps.id}-target`}
                type="text"
                className="count-target-field"
                inputMode="numeric"
                data-testid="mind-count-target"
                value={draft}
                placeholder={t("wordCount.target.placeholder")}
                aria-invalid={invalid}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setInvalid(false);
                }}
                // Keys that move through the menu's items belong to the field while it has the focus.
                onKeyDown={(event) => {
                  if (event.key !== "Escape") event.stopPropagation();
                }}
              />
              <button
                type="submit"
                role="menuitem"
                data-testid="mind-count-set"
                className="count-target-set"
              >
                {t("wordCount.target.set")}
              </button>
              {invalid && (
                <p role="alert" className="count-target-problem">
                  <ProblemMark />
                  {t("wordCount.target.invalid")}
                </p>
              )}
            </form>
            {target !== null && (
              <div className="model-menu-foot">
                <button
                  type="button"
                  role="menuitem"
                  data-testid="mind-count-remove"
                  className="model-menu-link"
                  onClick={() => {
                    setWordTarget(doc, null);
                    menu.close();
                  }}
                >
                  {t("wordCount.target.remove")}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The counts at the foot of a Mind's ⋯ menu: "812 words · 8,071 characters"
 * (字数 812 · 字符数 8,071), of the whole while text is selected, and the
 * switch that shows the count while writing.
 */
export function MindCounts({
  editor,
  doc,
  switchable,
}: {
  editor: Editor;
  doc: Y.Doc;
  /** False for a read-only Mind, which can't remember the switch. */
  switchable: boolean;
}) {
  const t = useT();
  const language = useLanguage();
  const counts = useCounts(editor);
  const { shown } = useCountSettings(doc);
  const format = (value: number) => new Intl.NumberFormat(language).format(value);
  const part = (basis: "words" | "characters") => {
    if (!counts) return "";
    const count = countFor(counts.total, basis);
    if (counts.selection) {
      return t(`page.count.selected.${basis}`, {
        selected: format(countFor(counts.selection, basis)),
        count: format(count),
      });
    }
    return t(count === 1 ? `page.count.${basis}.one` : `page.count.${basis}`, {
      count: format(count),
    });
  };
  return (
    <div className="page-menu-foot">
      {counts && (
        <p className="page-menu-counts tabular-nums" data-testid="page-counts">
          {`${part("words")} · ${part("characters")}`}
        </p>
      )}
      {switchable && (
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={shown}
          data-testid="page-count-shown"
          className="page-menu-switch"
          onClick={() => setCountShown(doc, !shown)}
        >
          <span className="flex-1">{t("page.countShown")}</span>
          <span className="switch" data-on={shown || undefined} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
