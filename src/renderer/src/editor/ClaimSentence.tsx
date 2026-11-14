import { useLayoutEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { cutPlaces, markedPieces, type SentenceMark } from "./claimSentenceMarks";

const QUOTED = "\u0000";

/**
 * Which sentence a check card is about (#1621), once, with the parts that need a look marked in it
 * in their verdict's colours (#2869). It is cut after two lines; a mark that would fall past them
 * moves the start on instead, after "…", so what needs a look stays in view.
 */
export function ClaimSentence({
  sentence,
  marks,
}: {
  sentence: string;
  marks: readonly SentenceMark[];
}) {
  const t = useT();
  const [open, close = ""] = t("claim.sentence", { sentence: QUOTED }).split(QUOTED);
  const line = useRef<HTMLParagraphElement>(null);
  const first = [...marks].sort((a, b) => a.start - b.start)[0] ?? null;
  const [cut, setCut] = useState(0);
  const markKey = marks.map((mark) => `${mark.start}-${mark.end}-${mark.tone}`).join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again when its words or marks change.
  useLayoutEffect(() => {
    const element = line.current;
    if (!element || !first) {
      setCut(0);
      return;
    }
    const measure = () => setCut(firstCut(element, sentence, marks, first, open ?? "", close));
    measure();
    const Observer = element.ownerDocument.defaultView?.ResizeObserver;
    if (!Observer) return;
    let width = element.clientWidth;
    const observer = new Observer(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      measure();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [sentence, markKey]);
  return (
    <p ref={line} data-testid="claim-sentence" className="claim-card-sentence">
      {open}
      {cut > 0 && "…"}
      {piecesFrom(sentence, marks, cut).map((piece) =>
        piece.mark ? (
          <mark
            key={piece.mark.key}
            data-testid="claim-sentence-mark"
            data-tone={piece.mark.tone}
            className={`claim-sentence-mark citation-card--${piece.mark.tone}`}
          >
            {piece.text}
          </mark>
        ) : (
          <span key={`plain-${piece.at}`}>{piece.text}</span>
        ),
      )}
      {close}
    </p>
  );
}

/** The sentence's stretches from `cut` on, each with where it starts. */
function piecesFrom(sentence: string, marks: readonly SentenceMark[], cut: number) {
  let at = 0;
  return markedPieces(sentence, marks).flatMap((piece) => {
    const start = at;
    at += piece.text.length;
    if (at <= cut) return [];
    return [
      { ...piece, at: start, text: start < cut ? piece.text.slice(cut - start) : piece.text },
    ];
  });
}

/**
 * Where the sentence starts so its first mark ends within two lines, measured in a copy of the
 * line laid out at its width; 0 when it already does, or when nothing can be measured.
 */
function firstCut(
  element: HTMLElement,
  sentence: string,
  marks: readonly SentenceMark[],
  first: SentenceMark,
  open: string,
  close: string,
): number {
  const view = element.ownerDocument.defaultView;
  const parent = element.parentElement;
  if (!view || !parent || !(element.offsetWidth > 0)) return 0;
  const lineHeight = Number.parseFloat(view.getComputedStyle(element).lineHeight);
  if (!(lineHeight > 0)) return 0;
  const probe = element.cloneNode(false) as HTMLElement;
  probe.removeAttribute("data-testid");
  probe.setAttribute("aria-hidden", "true");
  for (const [name, value] of [
    ["position", "absolute"],
    ["visibility", "hidden"],
    ["left", "0"],
    ["top", "0"],
    ["width", `${element.offsetWidth}px`],
    ["box-sizing", "border-box"],
    ["display", "block"],
    ["-webkit-line-clamp", "none"],
    ["overflow", "visible"],
  ] as const)
    probe.style.setProperty(name, value);
  parent.append(probe);
  const fits = (cut: number) => {
    probe.replaceChildren(open, cut > 0 ? "…" : "");
    let mark: HTMLElement | null = null;
    for (const piece of piecesFrom(sentence, marks, cut)) {
      if (piece.mark) {
        const node = element.ownerDocument.createElement("mark");
        node.className = "claim-sentence-mark";
        node.textContent = piece.text;
        if (piece.mark === first) mark = node;
        probe.append(node);
      } else probe.append(piece.text);
    }
    probe.append(close);
    const found: HTMLElement | null = mark;
    if (!found) return true;
    return found.offsetTop + found.offsetHeight <= 2 * lineHeight + 1;
  };
  try {
    if (fits(0)) return 0;
    const places = cutPlaces(sentence, first.start);
    // The latest start that keeps the most words before the mark, or right before it.
    let low = 0;
    let high = places.length - 1;
    let best = places.at(-1) ?? first.start;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const at = places[middle] ?? first.start;
      if (fits(at)) {
        best = at;
        high = middle - 1;
      } else low = middle + 1;
    }
    return best;
  } finally {
    probe.remove();
  }
}
