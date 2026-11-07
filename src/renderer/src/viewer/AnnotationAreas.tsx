/**
 * The regions of a Document's area highlights (#327, #118): each one a wash of
 * its colour over the Unit it was drawn on, measured where the viewer draws
 * that Unit, as a Citation's region is outlined.
 */
import { useLayoutEffect, useState } from "react";
import type { Annotation, AnnotationColour } from "../../../core/api";
import { areasOf } from "../annotations";

interface Wash {
  id: string;
  colour: AnnotationColour;
  left: number;
  top: number;
  width: number;
  height: number;
}

const sameWashes = (a: readonly Wash[], b: readonly Wash[]): boolean =>
  a.length === b.length &&
  a.every((each, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      each.id === other.id &&
      each.colour === other.colour &&
      each.left === other.left &&
      each.top === other.top &&
      each.width === other.width &&
      each.height === other.height
    );
  });

export function AnnotationAreas({
  section,
  annotations,
}: {
  section: HTMLElement | null;
  annotations: readonly Annotation[] | undefined;
}) {
  const areas = areasOf(annotations);
  const key = areas
    .map(
      (annotation) =>
        `${annotation.id}:${annotation.colour}:${annotation.pageFrom}:${JSON.stringify(annotation.location?.area)}`,
    )
    .join("|");
  const [washes, setWashes] = useState<Wash[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` names the areas measured and their colours
  useLayoutEffect(() => {
    if (!section) {
      setWashes([]);
      return;
    }
    let frame = 0;
    const measure = () => {
      const origin = section.getBoundingClientRect();
      const next: Wash[] = [];
      for (const annotation of areas) {
        const area = annotation.location?.area;
        if (!area || annotation.pageFrom === null) continue;
        const element = section.querySelector<HTMLElement>(
          `[data-area-unit="${annotation.pageFrom}"]`,
        );
        if (!element) continue;
        const rect = element.getBoundingClientRect();
        next.push({
          id: annotation.id,
          colour: annotation.colour,
          left: rect.left - origin.left + rect.width * area.x,
          top: rect.top - origin.top + rect.height * area.y,
          width: rect.width * area.width,
          height: rect.height * area.height,
        });
      }
      setWashes((before) => (sameWashes(before, next) ? before : next));
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    schedule();
    const resize = new ResizeObserver(schedule);
    resize.observe(section);
    // Pages are drawn after the file is read, and zooming redraws them.
    const mutations = new MutationObserver(schedule);
    mutations.observe(section, { childList: true, subtree: true });
    section.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      section.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [section, key]);
  return (
    <>
      {washes.map((wash) => (
        <div
          key={wash.id}
          aria-hidden="true"
          data-testid="annotation-area"
          data-annotation-area-id={wash.id}
          className={`annotation-area annotation-area--${wash.colour}`}
          style={{
            left: wash.left,
            top: wash.top,
            width: wash.width,
            height: wash.height,
          }}
        />
      ))}
    </>
  );
}
