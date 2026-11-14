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
  /** Shown only because of the keyboard's focus: no pointer, no pin asks for it. */
  const [byKeyboard, setByKeyboard] = useState(false);
  const askers = useRef(new Set<string>());
  const timer = useRef<number | undefined>(undefined);
  const settle = useCallback(() => {
    const asked = [...askers.current];
    setPeeking(asked.length > 0);
    setByKeyboard(
      asked.length > 0 && asked.every((each) => each === "focus" || each === "card-focus"),
    );
  }, []);
  /** `now`: the keyboard's focus shows or hides the card at once; the pointer waits (#3102). */
  const hold = useCallback(
    (source: string, on: boolean, now = false) => {
      if (on) askers.current.add(source);
      else askers.current.delete(source);
      window.clearTimeout(timer.current);
      if (now) settle();
      else timer.current = window.setTimeout(settle, askers.current.size > 0 ? 120 : 200);
    },
    [settle],
  );
  /** Lets go of what the pointer holds, as another control's keyboard focus takes over (#3102). */
  const dropPointer = useCallback(() => {
    for (const source of [...askers.current]) {
      if (source !== "focus" && source !== "card-focus") askers.current.delete(source);
    }
    window.clearTimeout(timer.current);
    settle();
  }, [settle]);
  const clear = useCallback(() => {
    askers.current.clear();
    window.clearTimeout(timer.current);
    setPeeking(false);
    setByKeyboard(false);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { peeking, byKeyboard, hold, dropPointer, clear };
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
