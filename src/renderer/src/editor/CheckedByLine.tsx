import { type ReactNode, useLayoutEffect, useState } from "react";
import type { ClaimCheckAttributes } from "../../../core/api";
import { type ClaimCheckShown, checkedWith } from "../../../shared/claimChecks";
import { formatDateTime } from "../../../shared/dates";
import { andList } from "../../../shared/i18n";
import { NAME_IN_LINE_COLUMNS, shortenMiddle } from "../../../shared/naming";
import { useLanguage, useT } from "../i18n";
import { useModelNames } from "../modelNames";

/**
 * A verdict card's last line: the models whose verdicts the card shows, and when (#1667). A card
 * that needs a re-check keeps its last check's line as it was.
 *
 * It breaks only between names or before the time (DESIGN.md › Checks). A name wider than the line
 * wraps at its own spaces; one with no space to wrap at is cut in the middle, as a long file name is
 * (DESIGN.md › Long names), and keeps its whole name in its tooltip and for a screen reader.
 */
export function CheckedByLine({
  check,
  shown,
}: {
  check: ClaimCheckAttributes;
  shown: ClaimCheckShown["state"];
}) {
  const t = useT();
  const language = useLanguage();
  const nameOf = useModelNames();
  const [line, setLine] = useState<HTMLParagraphElement | null>(null);
  const room = useRoom(line);
  const by =
    shown === "supported" ||
    shown === "unsupported" ||
    shown === "contradicted" ||
    shown === "needs-recheck"
      ? checkedWith(check)
      : null;
  if (!by) return null;
  const names = by.models.map(({ modelId, providerId }) => ({
    key: `${providerId}:${modelId}`,
    name: nameOf(modelId, providerId).name,
  }));
  // Each placeholder is filled by its own marker, so a language may put the time before the names.
  const message = t("claim.checkedWith", {
    model: andList(
      language,
      names.map((_, index) => `${NAME_START}${index}${NAME_END}`),
    ),
    when: WHEN,
  });
  const pieces: ReactNode[] = [];
  let at = 0;
  for (const marker of message.matchAll(MARKERS)) {
    pieces.push(message.slice(at, marker.index));
    at = marker.index + marker[0].length;
    const named = marker[1] === undefined ? undefined : names[Number(marker[1])];
    if (!named) {
      pieces.push(
        <span key="when" className="claim-card-checked-by-when">
          {formatDateTime(by.checkedAt, language)}
        </span>,
      );
      continue;
    }
    // A name keeps the punctuation right after it, so a wrapped line never starts with "," or "、".
    const stuck = STUCK.exec(message.slice(at))?.[0] ?? "";
    at += stuck.length;
    pieces.push(<ModelName key={named.key} name={named.name} after={stuck} room={room} />);
  }
  pieces.push(message.slice(at));
  return (
    <p ref={setLine} data-testid="claim-checked-by" className="claim-card-checked-by">
      {pieces}
    </p>
  );
}

const NAME_START = "";
const NAME_END = "";
const WHEN = "";
const MARKERS = /(\d+)|/gu;
const STUCK = /^[,，、]/u;

/**
 * One model's name and the punctuation after it. A name with spaces wraps at them by itself when
 * it is wider than the line (styles.css); one with none is cut in the middle to the line's room.
 */
function ModelName({ name, after, room }: { name: string; after: string; room: Room | null }) {
  const width = room?.measure(`${name}${after}`) ?? null;
  if (!room || width === null || width <= room.width || /\s/u.test(name))
    return (
      <span className="claim-card-checked-by-name">
        {name}
        {after}
      </span>
    );
  let columns = NAME_IN_LINE_COLUMNS;
  let cut = shortenMiddle(name, columns);
  while (columns > 8 && (room.measure(`${cut}${after}`) ?? 0) > room.width) {
    columns -= 2;
    cut = shortenMiddle(name, columns);
  }
  return (
    <span className="claim-card-checked-by-name" title={name}>
      <span aria-hidden="true">{cut}</span>
      <span className="sr-only">{name}</span>
      {after}
    </span>
  );
}

interface Room {
  /** The line's width for its words, in layout pixels, which the card's opening scale doesn't change. */
  width: number;
  /** How wide `text` is in the line's font; null where nothing can measure it. */
  measure(text: string): number | null;
}

/** The room on `line` for a name, measured again whenever the line's size changes. */
function useRoom(line: HTMLParagraphElement | null): Room | null {
  const [room, setRoom] = useState<{ width: number; font: string } | null>(null);
  useLayoutEffect(() => {
    const view = line?.ownerDocument.defaultView;
    if (!line || !view) return;
    const measure = () => {
      const style = view.getComputedStyle?.(line);
      if (!style) return;
      const width =
        line.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight);
      // Before the card is laid out the line has no width; its first size comes to the observer.
      if (!(width > 0)) return;
      const font = style.font;
      setRoom((was) => (was?.width === width && was.font === font ? was : { width, font }));
    };
    measure();
    const Observer = view.ResizeObserver;
    if (!Observer) return;
    const observer = new Observer(measure);
    observer.observe(line);
    return () => observer.disconnect();
  }, [line]);
  if (!room || !line) return null;
  return {
    width: room.width,
    measure: (text) => textWidth(line.ownerDocument, room.font, text),
  };
}

let context: CanvasRenderingContext2D | null | undefined;
function textWidth(document: Document, font: string, text: string): number | null {
  context ??= document.createElement("canvas").getContext?.("2d") ?? null;
  if (!context) return null;
  context.font = font;
  return context.measureText(text).width;
}
