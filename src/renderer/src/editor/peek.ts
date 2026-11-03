/**
 * A Citation's card opens when its marker is hovered or focused, or when the
 * pointer is over its words in the cluster a neighbour draws. The one asking
 * lives outside the marker's node view, so it tells the marker with this
 * event, which the node view listens to.
 */
import { useCallback, useEffect, useRef, useState } from "react";

const PEEK = "citation-peek";

export function useCitationPeek() {
  const [peeking, setPeeking] = useState(false);
  const askers = useRef(new Set<string>());
  const timer = useRef<number | undefined>(undefined);
  const hold = useCallback((source: string, on: boolean) => {
    if (on) askers.current.add(source);
    else askers.current.delete(source);
    window.clearTimeout(timer.current);
    const wanted = askers.current.size > 0;
    timer.current = window.setTimeout(() => setPeeking(wanted), wanted ? 120 : 200);
  }, []);
  const clear = useCallback(() => {
    askers.current.clear();
    window.clearTimeout(timer.current);
    setPeeking(false);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { peeking, hold, clear };
}

export interface Peek {
  /** Who asks: the card stays open while anyone does. */
  source: string;
  on: boolean;
}

export const peekCitation = (marker: HTMLElement, source: string, on: boolean) =>
  marker.dispatchEvent(new CustomEvent<Peek>(PEEK, { detail: { source, on } }));

/** Listens on a marker for those asking to show or hide its card. */
export function onPeek(marker: HTMLElement, listener: (peek: Peek) => void): () => void {
  const handle = (event: Event) => {
    if (event instanceof CustomEvent) listener(event.detail as Peek);
  };
  marker.addEventListener(PEEK, handle);
  return () => marker.removeEventListener(PEEK, handle);
}
