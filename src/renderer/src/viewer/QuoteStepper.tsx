import { type KeyboardEvent, useMemo } from "react";
import { quoteStepHandle, useHandle } from "../commands/handles";
import { ChevronDownLineIcon, ChevronUpLineIcon } from "../components/lineIcons";
import { useT } from "../i18n";

/**
 * The quotes of a chip that stands for several Citations of one place, one at a time: which is
 * current and how many there are, with previous and next. It sits where the find bar sits, at the
 * top right of the pane, and looks like it, so a step never moves the buttons from under the
 * pointer; the current quote carries the Citation's mark beside it. ⌘G and ⇧⌘G step too, as
 * they step through a find's matches, and Enter and Shift+Enter on its buttons.
 */
export function QuoteStepper({
  number,
  at,
  total,
  onStep,
}: {
  /** The chip's number, as the Note shows it; 0 for none. */
  number: number;
  /** The current quote, from 0. */
  at: number;
  total: number;
  onStep(by: 1 | -1): void;
}) {
  const t = useT();
  const handle = useMemo(() => ({ next: () => onStep(1), previous: () => onStep(-1) }), [onStep]);
  useHandle(quoteStepHandle, handle);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      onStep(event.key === "ArrowUp" || (event.key === "Enter" && event.shiftKey) ? -1 : 1);
    }
  };
  return (
    <div
      role="toolbar"
      data-testid="quote-steps"
      aria-label={t("citation.steps.label", { number })}
      className="find-bar quote-steps"
      onKeyDown={onKeyDown}
    >
      <div className="find-row">
        {number > 0 && <span className="quote-steps-number">{number}</span>}
        <span data-testid="quote-steps-count" aria-live="polite" className="find-count">
          {t("citation.steps.count", { at: at + 1, total })}
        </span>
        <button
          type="button"
          data-testid="quote-steps-previous"
          title={t("citation.steps.previous")}
          aria-label={t("citation.steps.previous")}
          aria-keyshortcuts="Shift+Meta+G"
          disabled={at === 0}
          onClick={() => onStep(-1)}
        >
          <ChevronUpLineIcon className="size-4" />
        </button>
        <button
          type="button"
          data-testid="quote-steps-next"
          title={t("citation.steps.next")}
          aria-label={t("citation.steps.next")}
          aria-keyshortcuts="Meta+G"
          disabled={at === total - 1}
          onClick={() => onStep(1)}
        >
          <ChevronDownLineIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}
