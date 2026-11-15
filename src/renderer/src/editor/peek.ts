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

export const peekCitation = (marker: EventTarget, source: string, on: boolean) =>
  marker.dispatchEvent(new CustomEvent<Peek>(PEEK, { detail: { source, on } }));

/** Listens on a marker for those asking to show or hide its card. */
export function onPeek(marker: EventTarget, listener: (peek: Peek) => void): () => void {
  const handle = (event: Event) => {
    if (event instanceof CustomEvent) listener(event.detail as Peek);
  };
  marker.addEventListener(PEEK, handle);
  return () => marker.removeEventListener(PEEK, handle);
}

/**
 * The card the pointer over a Citation's marker asks for: the marker's own, which it holds with
 * `hold`, or, over a neighbour's words in the cluster the marker draws, that neighbour's.
 */
export function pointedCard(
  own: () => EventTarget | null,
  hold: (source: string, on: boolean) => void,
) {
  let pointed: EventTarget | null = null;
  const ask = (target: EventTarget, on: boolean) => {
    if (target === own()) hold("pointer", on);
    else peekCitation(target, "cluster", on);
  };
  return {
    /** The pointer is over `target`'s words, or no one's: that card shows and the one it left goes. */
    pointAt(target: EventTarget | null) {
      if (target === pointed) return;
      const before = pointed;
      pointed = target;
      if (before) ask(before, false);
      if (target) ask(target, true);
    },
    /**
     * The keyboard's focus took over (#3102): a neighbour's card the pointer asked for goes, so the
     * next move over its words asks for it again. The marker's own hold goes only when the focus
     * went to another control (`ownToo`); the caller drops it.
     */
    keyboardTookOver(ownToo: boolean) {
      if (pointed !== null && pointed !== own()) {
        peekCitation(pointed, "cluster", false);
        pointed = null;
      } else if (ownToo) pointed = null;
    },
  };
}
