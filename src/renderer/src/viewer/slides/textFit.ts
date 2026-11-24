/**
 * How a text box follows its text while it is typed in, as PowerPoint's autofit kinds do: one that
 * grows to fit its text takes the height the text needs; one that shrinks its text on overflow
 * takes the largest of PowerPoint's steps that fits, shown by zooming its paragraphs, which
 * changes no node an input method is composing in; one that does neither says when its text runs
 * past it, and which step would fit.
 */
import type { Autofit } from "../../../../core/documents/formats/pptxDrawing";

/** A text box's fit, measured as the person left it. */
export type MeasuredFit =
  | { kind: "grow"; height: number }
  | { kind: "shrink"; fontScale: number; lineReduction: number }
  | { kind: "overflow"; fontScale: number; lineReduction: number };

/** PowerPoint's steps of shrinking text on overflow: a font scale and the line spacing reduction it takes. */
const STEPS: readonly { fontScale: number; lineReduction: number }[] = [
  { fontScale: 1, lineReduction: 0 },
  { fontScale: 0.925, lineReduction: 0 },
  { fontScale: 0.85, lineReduction: 0.1 },
  { fontScale: 0.775, lineReduction: 0.1 },
  { fontScale: 0.7, lineReduction: 0.2 },
  { fontScale: 0.625, lineReduction: 0.2 },
  { fontScale: 0.55, lineReduction: 0.2 },
  { fontScale: 0.475, lineReduction: 0.2 },
  { fontScale: 0.4, lineReduction: 0.2 },
  { fontScale: 0.325, lineReduction: 0.2 },
  { fontScale: 0.25, lineReduction: 0.2 },
];

const SLACK = 0.5;

/** The box's own CSS pixels per screen pixel: the slide is drawn scaled. */
const ratioOf = (box: HTMLElement) => {
  const drawn = box.getBoundingClientRect().height;
  return box.offsetHeight > 0 && drawn > 0 ? drawn / box.offsetHeight : 1;
};

function room(box: HTMLElement): number {
  const style = getComputedStyle(box);
  return (
    box.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom)
  );
}

/** The height the paragraphs take now, in the box's own pixels. */
const needs = (box: HTMLElement, paragraphs: HTMLElement) =>
  paragraphs.getBoundingClientRect().height / ratioOf(box);

/** The step that fits: the largest whose scale, relative to what the drawing applied, fits the room. */
function fittingStep(box: HTMLElement, paragraphs: HTMLElement, autofit: Autofit) {
  const available = room(box);
  for (const step of STEPS) {
    paragraphs.style.zoom = String(step.fontScale / autofit.fontScale);
    if (needs(box, paragraphs) <= available + SLACK) return step;
  }
  return STEPS.at(-1) ?? { fontScale: 0.25, lineReduction: 0.2 };
}

/** Shows a shrinking box's text at the step it fits at now; nothing for the other kinds. */
export function followText(box: HTMLElement, paragraphs: HTMLElement, autofit: Autofit): void {
  if (autofit.kind === "shrink") fittingStep(box, paragraphs, autofit);
}

/** How the box follows its text as left; null when it needs nothing written. */
export function measuredFit(
  box: HTMLElement,
  paragraphs: HTMLElement,
  autofit: Autofit,
): MeasuredFit | null {
  if (autofit.kind === "grow") {
    const style = getComputedStyle(box);
    const height =
      needs(box, paragraphs) +
      Number.parseFloat(style.paddingTop) +
      Number.parseFloat(style.paddingBottom);
    return { kind: "grow", height };
  }
  const was = paragraphs.style.zoom;
  const step = fittingStep(box, paragraphs, autofit);
  if (autofit.kind === "none") {
    paragraphs.style.zoom = "1";
    const overflows = needs(box, paragraphs) > room(box) + SLACK;
    paragraphs.style.zoom = was;
    return overflows ? { kind: "overflow", ...step } : null;
  }
  const same =
    Math.abs(step.fontScale - autofit.fontScale) < 0.001 &&
    Math.abs(step.lineReduction - autofit.lineReduction) < 0.001;
  return same ? null : { kind: "shrink", ...step };
}
