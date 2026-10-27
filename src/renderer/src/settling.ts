import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** A wait shorter than this shows nothing, so it never flashes (DESIGN.md › Feel). */
export const SHOWN_AFTER_MS = 300;

/** Once shown, a wait stays at least this long, so it doesn't flash on its way out either. */
export const SHOWN_AT_LEAST_MS = 500;

type Timer = ReturnType<typeof setTimeout>;

/**
 * Tracks which of the things that are there to show: `update` says what is there now, and
 * `onChange` hears when what shows changes. A thing shows once it has been there
 * `SHOWN_AFTER_MS`, unless another already shows, which it then takes the place of at once, so the
 * row is never empty between two waits; and it stays `SHOWN_AT_LEAST_MS` once shown.
 *
 * Shown is counted from the announcement, unless `drawnIsTold`: then from the `drawn` call that
 * follows it, since a busy page draws what `onChange` announced later, and a thing whose work ends
 * before that goes `SHOWN_AT_LEAST_MS` after the drawing, however late it comes.
 */
export function createSettling(
  onChange: (shown: ReadonlySet<string>) => void,
  { drawnIsTold = false }: { drawnIsTold?: boolean } = {},
) {
  /** What shows, and when it began to stay: null until `drawn`, for a thing not yet drawn. */
  let shown = new Map<string, number | null>();
  let present = new Set<string>();
  const waiting = new Map<string, Timer>();
  const leaving = new Map<string, Timer>();
  const tell = (next: Map<string, number | null>) => {
    const same = next.size === shown.size && [...next.keys()].every((id) => shown.has(id));
    shown = next;
    if (!same) onChange(new Set(next.keys()));
  };
  const hide = (id: string) => {
    clearTimeout(leaving.get(id));
    leaving.delete(id);
    const next = new Map(shown);
    next.delete(id);
    tell(next);
  };
  /** Its work is over: it goes once it has stayed its minimum. One not yet drawn goes after `drawn`. */
  const leave = (id: string) => {
    const since = shown.get(id);
    if (since === null || since === undefined || leaving.has(id)) return;
    const left = since + SHOWN_AT_LEAST_MS - Date.now();
    if (left <= 0) hide(id);
    else
      leaving.set(
        id,
        setTimeout(() => hide(id), left),
      );
  };
  const show = (id: string) => {
    clearTimeout(waiting.get(id));
    waiting.delete(id);
    const next = new Map(shown);
    // What was only being kept on screen gives way to what takes its place.
    for (const kept of [...next.keys()]) {
      if (present.has(kept)) continue;
      next.delete(kept);
      clearTimeout(leaving.get(kept));
      leaving.delete(kept);
    }
    next.set(id, drawnIsTold ? null : Date.now());
    tell(next);
  };
  return {
    update(ids: readonly string[]): void {
      present = new Set(ids);
      for (const [id, timer] of waiting) {
        if (present.has(id)) continue;
        clearTimeout(timer);
        waiting.delete(id);
      }
      for (const id of shown.keys()) {
        if (present.has(id)) {
          clearTimeout(leaving.get(id));
          leaving.delete(id);
        } else leave(id);
      }
      for (const id of present) {
        if (shown.has(id) || waiting.has(id)) continue;
        if (shown.size > 0) show(id);
        else
          waiting.set(
            id,
            setTimeout(() => show(id), SHOWN_AFTER_MS),
          );
      }
    },
    /** What `onChange` announced is on screen: what was waiting to be drawn starts to stay now. */
    drawn(): void {
      const now = Date.now();
      for (const [id, since] of shown) {
        if (since !== null) continue;
        shown.set(id, now);
        if (!present.has(id)) leave(id);
      }
    },
    stop(): void {
      for (const timer of [...waiting.values(), ...leaving.values()]) clearTimeout(timer);
      waiting.clear();
      leaving.clear();
      shown = new Map();
      present = new Set();
    },
  };
}

/**
 * Calls `done` in the second frame from now: the frame before it has drawn what was committed
 * before this call. Returns what cancels it, in whichever frame it stands.
 */
export function afterPaint(done: () => void): () => void {
  let second = 0;
  const first = requestAnimationFrame(() => {
    second = requestAnimationFrame(done);
  });
  return () => {
    cancelAnimationFrame(first);
    cancelAnimationFrame(second);
  };
}

/** The ids, of those given, that show: there for `SHOWN_AFTER_MS`, and kept `SHOWN_AT_LEAST_MS` once shown. */
export function useSettled(ids: readonly string[]): ReadonlySet<string> {
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const settling = useRef<ReturnType<typeof createSettling> | null>(null);
  settling.current ??= createSettling(setShown, { drawnIsTold: true });
  const key = ids.join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `ids`.
  useEffect(() => settling.current?.update(ids), [key]);
  // Two frames after a change of what shows, the change has been drawn.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a change of `shown` is when to ask.
  useLayoutEffect(() => afterPaint(() => settling.current?.drawn()), [shown]);
  useEffect(() => () => settling.current?.stop(), []);
  return shown;
}
