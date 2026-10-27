import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** A wait shorter than this shows nothing, so it never flashes (DESIGN.md › Feel). */
export const SHOWN_AFTER_MS = 300;

/** Once shown, a wait stays at least this long, so it doesn't flash on its way out either. */
export const SHOWN_AT_LEAST_MS = 500;

/**
 * Tracks which of the things that are there to show: `update` says what is there now, and
 * `onChange` hears when what shows changes. A thing shows once it has been there
 * `SHOWN_AFTER_MS`, unless another already shows, which it then takes the place of at once, so the
 * row is never empty between two waits; and it stays `SHOWN_AT_LEAST_MS` once shown. `drawn` says
 * what `onChange` announced is on screen: a busy page draws it later than it was announced, and
 * the time it stays counts from the drawing.
 */
export function createSettling(onChange: (shown: ReadonlySet<string>) => void) {
  let shown = new Map<string, number>();
  const undrawn = new Set<string>();
  const waiting = new Map<string, ReturnType<typeof setTimeout>>();
  const leaving = new Map<string, ReturnType<typeof setTimeout>>();
  const tell = (next: Map<string, number>) => {
    const same = next.size === shown.size && [...next.keys()].every((id) => shown.has(id));
    shown = next;
    if (!same) onChange(new Set(next.keys()));
  };
  const hide = (id: string) => {
    clearTimeout(leaving.get(id));
    leaving.delete(id);
    undrawn.delete(id);
    const next = new Map(shown);
    next.delete(id);
    tell(next);
  };
  const leave = (id: string) => {
    const left = (shown.get(id) ?? 0) + SHOWN_AT_LEAST_MS - Date.now();
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
    for (const gone of leaving.keys()) {
      next.delete(gone);
      undrawn.delete(gone);
    }
    for (const timer of leaving.values()) clearTimeout(timer);
    leaving.clear();
    next.set(id, Date.now());
    undrawn.add(id);
    tell(next);
  };
  return {
    update(ids: readonly string[]): void {
      const here = new Set(ids);
      for (const [id, timer] of waiting) {
        if (here.has(id)) continue;
        clearTimeout(timer);
        waiting.delete(id);
      }
      for (const id of shown.keys()) {
        if (here.has(id)) {
          clearTimeout(leaving.get(id));
          leaving.delete(id);
        } else if (!leaving.has(id)) leave(id);
      }
      for (const id of here) {
        if (shown.has(id) || waiting.has(id)) continue;
        if (shown.size > 0) show(id);
        else
          waiting.set(
            id,
            setTimeout(() => show(id), SHOWN_AFTER_MS),
          );
      }
    },
    drawn(): void {
      for (const id of undrawn) {
        shown.set(id, Date.now());
        const timer = leaving.get(id);
        if (timer === undefined) continue;
        clearTimeout(timer);
        leaving.delete(id);
        leave(id);
      }
      undrawn.clear();
    },
    stop(): void {
      for (const timer of [...waiting.values(), ...leaving.values()]) clearTimeout(timer);
      waiting.clear();
      leaving.clear();
      undrawn.clear();
    },
  };
}

/** The ids, of those given, that show: there for `SHOWN_AFTER_MS`, and kept `SHOWN_AT_LEAST_MS` once shown. */
export function useSettled(ids: readonly string[]): ReadonlySet<string> {
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const settling = useRef<ReturnType<typeof createSettling> | null>(null);
  settling.current ??= createSettling(setShown);
  const key = ids.join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `ids`.
  useEffect(() => settling.current?.update(ids), [key]);
  // The frame after a change of what shows is the one that draws it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a change of `shown` is when to ask.
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => settling.current?.drawn());
    return () => cancelAnimationFrame(frame);
  }, [shown]);
  useEffect(() => () => settling.current?.stop(), []);
  return shown;
}
