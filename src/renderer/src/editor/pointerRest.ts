/**
 * Who holds a card, the keyboard or the pointer: the latest input wins (#3102). A pointer that is
 * moving or pressed keeps the card it holds. One at rest loses it when the keyboard's focus goes to
 * a control, and the browser's re-sending of events to a pointer that hasn't moved (when a card
 * lands under it or leaves from under it) doesn't give it back: only a move does.
 */

/** A move this recent is a pointer in use; the keyboard doesn't take its card. */
const MOVING_MS = 40;

interface PointerLike {
  type: string;
  clientX: number;
  clientY: number;
  buttons: number;
  timeStamp: number;
}

let at = { x: Number.NaN, y: Number.NaN };
let movedAt = Number.NEGATIVE_INFINITY;
let pressed = false;
let heldBack = false;
const droppers = new Set<(taker: unknown) => void>();
let listening = false;

/** Notes where the pointer is: a changed place, or a press, is the User using it. */
export function trackPointer(event: PointerLike): void {
  pressed = event.buttons !== 0;
  if (event.type !== "pointerdown" && event.clientX === at.x && event.clientY === at.y) return;
  at = { x: event.clientX, y: event.clientY };
  movedAt = event.timeStamp;
  heldBack = false;
}

/** Whether a pointer event may ask for a card: false for a pointer at rest the keyboard took over from. */
export const pointerMayAsk = (): boolean => !heldBack;

/**
 * The keyboard's focus went to `taker`, a control that shows its card: the cards the pointer only
 * rests over go, and the pointer asks for none again until it moves.
 */
export function keyboardTakesOver(taker: unknown, now = performance.now()): void {
  if (pressed || now - movedAt < MOVING_MS) return;
  heldBack = true;
  for (const drop of droppers) drop(taker);
}

/** Registers a card's owner, which lets go of what the pointer holds when another control takes over. */
export function onKeyboardTakesOver(drop: (taker: unknown) => void): () => void {
  if (!listening && typeof document !== "undefined") {
    listening = true;
    for (const type of ["pointermove", "pointerdown", "pointerup", "pointerover"]) {
      document.addEventListener(type, (event) => trackPointer(event as PointerEvent), true);
    }
  }
  droppers.add(drop);
  return () => {
    droppers.delete(drop);
  };
}

/** For tests: a pointer never seen, nothing held back. */
export function resetPointer(): void {
  at = { x: Number.NaN, y: Number.NaN };
  movedAt = Number.NEGATIVE_INFINITY;
  pressed = false;
  heldBack = false;
}
