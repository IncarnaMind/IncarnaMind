import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";
import type { ViewerCitation } from "../../../shared/documentViewer";
import { useT } from "../i18n";
import { ExclamationIcon, NotEqualIcon, QuestionIcon, TickIcon } from "./icons";

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
const MARK_HEIGHT = 18;

/** The space the label takes beside the number: its margin, border and padding. */
const LABEL_SPACING = 3;

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
 * The Citation's check mark (its icon and number, then where it points), in
 * the page's margin beside its quote. Given the `room` the margin has, in CSS
 * pixels, it drops the label when the label doesn't fit there, keeping it in
 * its accessible name and tooltip, so it never covers the page's text.
 */
export function CitationMark({
  mark,
  style,
  room,
  onWidth,
}: {
  mark: QuoteMark;
  style: CSSProperties;
  room?: number;
  /** Told the mark's width as shown, e.g. to keep it inside the page. */
  onWidth?: (width: number) => void;
}) {
  const t = useT();
  const own = useRef<HTMLSpanElement>(null);
  const labelElement = useRef<HTMLSpanElement>(null);
  const [fits, setFits] = useState(true);
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again as the room changes
  useLayoutEffect(() => {
    const element = own.current;
    const shown = labelElement.current;
    if (!element) return;
    const labelWidth = shown ? shown.offsetWidth + LABEL_SPACING : 0;
    const base = element.offsetWidth - (fits && shown ? labelWidth : 0);
    const next = room === undefined || !shown || base + labelWidth <= room;
    if (next !== fits) setFits(next);
    else onWidth?.(element.offsetWidth);
  }, [room, mark.label, fits]);

  const Icon =
    mark.tone === "found"
      ? TickIcon
      : mark.tone === "contradicted"
        ? NotEqualIcon
        : mark.tone === "cant-check"
          ? QuestionIcon
          : ExclamationIcon;
  return (
    <span
      ref={own}
      role="img"
      aria-label={label}
      title={label}
      data-testid="viewer-quote-mark"
      data-check={mark.tone}
      data-label-shown={mark.label ? String(fits) : undefined}
      className={`quote-mark quote-mark--${mark.tone}`}
      style={style}
    >
      <Icon className="size-[11px] shrink-0" />
      <span data-testid="viewer-quote-mark-number">{mark.number}</span>
      {mark.label && (
        <span
          ref={labelElement}
          data-testid="viewer-quote-mark-label"
          aria-hidden={!fits}
          className={`quote-mark-label ${fits ? "" : "quote-mark-label--measured"}`}
        >
          {mark.label}
        </span>
      )}
    </span>
  );
}
