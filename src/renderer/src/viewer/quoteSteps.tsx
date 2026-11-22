import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useState,
} from "react";
import type { TextRange } from "../../../shared/quoteMatch";
import type { ViewerTarget } from "../store";
import { quotesOf } from "./citedPlace";
import { QuoteStepper } from "./QuoteStepper";

/**
 * Stepping through the quotes a viewer was opened to mark together: those of the Citations one
 * chip stands for (#3654). Each viewer marks every quote, its highlights carrying the quote's
 * place among them (`data-quote-index`); the one it is on is washed in full and the others
 * lightly (`OTHER_QUOTE`), and the Citation's mark sits beside the current one (`CURRENT_QUOTE`).
 */

/** A quote's highlight in a text, with its place among the quotes opened together. */
export interface QuoteRange extends TextRange {
  quote?: number;
}

/** The class of another quote's highlights than the one the viewer is on. */
export const OTHER_QUOTE = "quote-highlight--other";

/** The highlights of the quote the viewer is on, or of its only quote. */
export const CURRENT_QUOTE = `[data-quote-highlight]:not(.${OTHER_QUOTE})`;

/** The quote a viewer is on, for its parts that place the Citation's mark beside it. */
export const QuoteStepContext = createContext(0);

/** Whether a quote's highlight is of the quote the viewer is on, or of its only quote. */
export const isCurrentQuote = (element: HTMLElement, step: number) =>
  element.dataset.quoteIndex === undefined || Number(element.dataset.quoteIndex) === step;

/** What a quote's highlight carries, drawn by React. */
export const quoteIndexProps = (quote: number | undefined) =>
  quote === undefined ? {} : { "data-quote-index": quote };

/** The class a quote's highlight drawn by React takes, with the quote the viewer is on (`QuoteStepContext`). */
export const quoteClass = (quote: number | undefined, step: number) =>
  quote !== undefined && quote !== step ? ` ${OTHER_QUOTE}` : "";

/** The quote the viewer opens at, among `quotesOf(target)`: the one the Citation pressed names. */
export function startOf(target: Pick<ViewerTarget, "quote" | "quotes">): number {
  const at = target.quote === undefined ? -1 : quotesOf(target).indexOf(target.quote);
  return Math.max(0, at);
}

/**
 * Marks each of the target's quotes with `mark` (`markQuote` on the viewer's text) and tags its
 * highlights with its place. Returns the highlights of the quote it opens at, else the first found.
 */
export function markEachQuote(
  target: Pick<ViewerTarget, "quote" | "quotes">,
  mark: (quote: string) => HTMLElement[] | null,
): HTMLElement[] | null {
  const start = startOf(target);
  let opening: HTMLElement[] | null = null;
  quotesOf(target).forEach((quote, index) => {
    const marked = mark(quote);
    if (!marked) return;
    for (const element of marked) element.dataset.quoteIndex = String(index);
    if (index === start || opening === null) opening = marked;
  });
  return opening;
}

/**
 * Which quote the viewer is on, and its stepper (`QuoteStepper`) when it marks more than one.
 * `drawn` changes whenever the highlights are drawn again. Call it after the effects that mark
 * the quotes and before those that read `CURRENT_QUOTE`, which run again when `step` changes.
 */
export function useQuoteSteps({
  target,
  root,
  drawn,
  found: known,
}: {
  target: ViewerTarget;
  root: RefObject<HTMLElement | null>;
  drawn: unknown;
  /**
   * The quotes found, by their place, where the viewer draws their highlights later than it
   * finds them (a PDF page's text layer); else those drawn are read from `root`.
   */
  found?: readonly number[];
}): { step: number; stepper: ReactNode } {
  const [chosen, setChosen] = useState<{ request: number; step: number } | null>(null);
  const [present, setPresent] = useState<readonly number[]>([]);
  const step = chosen && chosen.request === target.request ? chosen.step : startOf(target);
  const several = quotesOf(target).length > 1;

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again whenever the highlights are drawn
  useLayoutEffect(() => {
    const element = root.current;
    const marked =
      element && several ? [...element.querySelectorAll<HTMLElement>("[data-quote-index]")] : [];
    const found =
      known ??
      [...new Set(marked.map((each) => Number(each.dataset.quoteIndex)))].sort((a, b) => a - b);
    setPresent((was) =>
      was.length === found.length && was.every((each, at) => each === found[at]) ? was : found,
    );
    for (const each of marked) {
      each.classList.toggle(
        OTHER_QUOTE,
        found.length > 1 && Number(each.dataset.quoteIndex) !== step,
      );
    }
  }, [drawn, step, several]);

  const onStep = useCallback(
    (by: 1 | -1) => {
      const at = present.indexOf(step);
      const next = present[Math.min(Math.max(at + by, 0), present.length - 1)];
      if (next === undefined || next === step) return;
      setChosen({ request: target.request, step: next });
      root.current
        ?.querySelector(`[data-quote-index="${next}"]`)
        ?.scrollIntoView({ block: "center", inline: "nearest" });
    },
    [present, step, target.request, root],
  );

  const stepper =
    present.length > 1 ? (
      <QuoteStepper
        number={target.citation?.number ?? 0}
        at={Math.max(0, present.indexOf(step))}
        total={present.length}
        onStep={onStep}
      />
    ) : null;
  return { step, stepper };
}

/** The stepper on a line of its own above the viewer's page, so it never covers the page's first line. */
export function QuoteStepsLine({ stepper }: { stepper: ReactNode }) {
  return stepper ? <div className="quote-steps-line">{stepper}</div> : null;
}
