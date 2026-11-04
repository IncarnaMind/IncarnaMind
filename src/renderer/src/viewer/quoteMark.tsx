import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ViewerCitation } from "../../../shared/documentViewer";
import { useT } from "../i18n";
import { ExclamationIcon, NotEqualIcon, QuestionIcon, TickIcon } from "./icons";
import { type MarkMeasure, measureOf } from "./sheetMark";

/**
 * How a quote is washed: green, the colour of a found Citation's check, unless
 * it was opened anyway after its check said "not found" (or "unsupported"),
 * which is amber. A contradicted claim is never green: its words are outlined
 * in red, with no fill. A Citation of a scan's unsure words is quiet grey: the
 * words may not be what the page says (#535).
 */
export type QuoteTone = "found" | "not-found" | "contradicted" | "cant-check";

export const quoteTone = (citation: ViewerCitation | undefined): QuoteTone =>
  citation?.check === "cant-check"
    ? "cant-check"
    : citation?.check === "not-found" || citation?.check === "unsupported"
      ? "not-found"
      : citation?.check === "contradicted"
        ? "contradicted"
        : "found";

/**
 * The check mark to show beside a quote: only when the Citation's check and number are known. A
 * Citation that can't be checked shows one only for a scan's unsure word, which asks for a look
 * at the page (#535).
 */
export interface QuoteMark {
  tone: QuoteTone;
  number: number;
  /** Where the Citation points, e.g. "slide 4" (ADR-0011): shown after the number. */
  label?: string;
  /** Shown after the number in place of `label`, which the tooltip then holds, e.g. a row's name. */
  shown?: string;
}

export function quoteMarkOf(citation: ViewerCitation | undefined): QuoteMark | null {
  if (citation?.number === undefined) return null;
  if (citation.check === "checking") return null;
  if (citation.check === "cant-check" && citation.checkReason !== "unsure-word") return null;
  return {
    tone: quoteTone(citation),
    number: citation.number,
    ...(citation.label ? { label: citation.label } : {}),
  };
}

/** The mark's height, as in the Mind's margin. */
export const MARK_HEIGHT = 18;

/**
 * Where the mark's top goes, inside `container`, to centre it on the first line
 * of `highlight` (a quote's first highlighted part).
 */
export function markTopFor(highlight: Element, container: Element): number {
  const line = highlight.getClientRects()[0] ?? highlight.getBoundingClientRect();
  return line.top - container.getBoundingClientRect().top + line.height / 2 - MARK_HEIGHT / 2;
}

/**
 * The room for a mark set 12px past a text `column`, before the edge of the
 * page around it (its parent), in CSS pixels.
 */
export function marginRoom(column: Element): number {
  const page = column.parentElement?.getBoundingClientRect();
  return page ? page.right - column.getBoundingClientRect().right - 12 - 4 : 0;
}

/**
 * A viewer's measure of its Citation's mark, as `CitationMark` reports it through `onSize`: read
 * only for the number and label it was taken for, so the next Citation of the same row, with
 * the same label and a number a digit wider, is placed by its own width. `measured` is null until
 * the mark has been measured again.
 */
export function useMarkMeasure(mark: QuoteMark | null): {
  measured: MarkMeasure | null;
  onSize: (size: { full: number; compact: number }) => void;
} {
  const number = mark?.number;
  const label = mark?.shown ?? mark?.label;
  const [measure, setMeasure] = useState<MarkMeasure | null>(null);
  const onSize = useCallback(
    (size: { full: number; compact: number }) =>
      setMeasure((previous) =>
        previous?.full === size.full &&
        previous.compact === size.compact &&
        measureOf(previous, number, label)
          ? previous
          : { ...size, number, label },
      ),
    [number, label],
  );
  return { measured: mark ? measureOf(measure, number, label) : null, onSize };
}

/**
 * The Citation's check mark (its icon and number, then where it points), in
 * the page's margin beside its quote. Given the `room` the margin has, in CSS
 * pixels, it drops the label when the label doesn't fit there, keeping it in
 * its accessible name and tooltip, so it never covers the page's text.
 */
export function CitationMark({
  mark,
  style,
  room,
  onSize,
}: {
  mark: QuoteMark;
  style: CSSProperties;
  room?: number;
  /** Told the mark's width with its label and without it, to find it a place. */
  onSize?: (size: { full: number; compact: number }) => void;
}) {
  const t = useT();
  const fullCopy = useRef<HTMLSpanElement>(null);
  const compactCopy = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState<MarkMeasure | null>(null);
  const shown = mark.shown ?? mark.label;
  const fits = room === undefined || size === null || size.full <= room;
  const word = (
    {
      found: "found",
      "not-found": "notFound",
      contradicted: "contradicted",
      "cant-check": "cantCheck",
    } as const
  )[mark.tone];
  const label = mark.label
    ? t(`viewer.mark.${word}.at`, { number: mark.number, location: mark.label })
    : t(`viewer.mark.${word}`, { number: mark.number });

  // The widths come from copies that are never shown, so they stay the same whether the label
  // shows or not: the mark's own width changes with it, and a room just short of the full width
  // would switch the label at every render (#2459).
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again as the room changes
  useLayoutEffect(() => {
    const full = fullCopy.current?.offsetWidth ?? 0;
    const compact = compactCopy.current?.offsetWidth ?? 0;
    setSize((previous) => {
      const same = measureOf(previous, mark.number, shown);
      return same?.full === full && same.compact === compact
        ? same
        : { full, compact, number: mark.number, label: shown };
    });
  }, [room, mark.number, shown]);
  useLayoutEffect(() => {
    const taken = measureOf(size, mark.number, shown);
    if (taken) onSize?.({ full: taken.full, compact: taken.compact });
  }, [size, mark.number, shown, onSize]);

  const Icon =
    mark.tone === "found"
      ? TickIcon
      : mark.tone === "contradicted"
        ? NotEqualIcon
        : mark.tone === "cant-check"
          ? QuestionIcon
          : ExclamationIcon;
  const copy = (ref: RefObject<HTMLSpanElement | null>, withLabel: boolean) => (
    <span
      ref={ref}
      aria-hidden="true"
      data-quote-skip=""
      className={`quote-mark quote-mark--${mark.tone} quote-mark--copy`}
    >
      <Icon className="size-[11px] shrink-0" />
      <span>{mark.number}</span>
      {withLabel && mark.label && <span className="quote-mark-label">{shown}</span>}
    </span>
  );
  return (
    <>
      <span
        role="img"
        aria-label={label}
        title={label}
        data-testid="viewer-quote-mark"
        data-quote-skip=""
        data-check={mark.tone}
        data-label-shown={mark.label ? String(fits) : undefined}
        className={`quote-mark quote-mark--${mark.tone}`}
        style={style}
      >
        <Icon className="size-[11px] shrink-0" />
        <span data-testid="viewer-quote-mark-number">{mark.number}</span>
        {mark.label && (
          <span
            data-testid="viewer-quote-mark-label"
            aria-hidden={!fits}
            className={`quote-mark-label ${fits ? "" : "quote-mark-label--hidden"}`}
          >
            {shown}
          </span>
        )}
      </span>
      {copy(fullCopy, true)}
      {copy(compactCopy, false)}
    </>
  );
}
