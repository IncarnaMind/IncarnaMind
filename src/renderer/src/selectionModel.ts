import type { ObjectRef } from "./objects";

/*
 * What is selected, and how each gesture changes it (docs/agents/interaction.md,
 * rule 6). Pure, so the unit tests import it: no store and no page.
 */

/** The places that keep a selection each (Recently deleted at the Library's foot is one): moving to another clears it, as Finder does per window. */
export type SelectSurface = "sidebar" | "library" | "deleted" | "home";

export const refKey = (ref: ObjectRef): string => `${ref.kind}:${ref.id}`;

export function refOfKey(key: string): ObjectRef | null {
  const at = key.indexOf(":");
  return at > 0 ? ({ kind: key.slice(0, at), id: key.slice(at + 1) } as ObjectRef) : null;
}

export interface SelectionState {
  surface: SelectSurface | null;
  /** In the order they were chosen. */
  items: readonly ObjectRef[];
  keys: ReadonlySet<string>;
  /** Where a Shift-click or Shift+arrow extends from: the last one chosen. */
  anchor: ObjectRef | null;
}

export const NOTHING_SELECTED: SelectionState = {
  surface: null,
  items: [],
  keys: new Set(),
  anchor: null,
};

const of = (
  surface: SelectSurface,
  items: readonly ObjectRef[],
  anchor: ObjectRef | null,
): SelectionState =>
  items.length === 0
    ? NOTHING_SELECTED
    : { surface, items, keys: new Set(items.map(refKey)), anchor };

/** What another surface held is gone: a gesture here starts from nothing. */
const here = (state: SelectionState, surface: SelectSurface) =>
  state.surface === surface ? state : NOTHING_SELECTED;

/** A click: just this one, which is also where a range starts. */
export const choose = (
  state: SelectionState,
  surface: SelectSurface,
  ref: ObjectRef,
): SelectionState =>
  state.surface === surface &&
  state.items.length === 1 &&
  state.anchor !== null &&
  refKey(state.anchor) === refKey(ref)
    ? state
    : of(surface, [ref], ref);

/** ⌘-click or Ctrl-click: adds it, or removes it if it was in. */
export function toggle(
  state: SelectionState,
  surface: SelectSurface,
  ref: ObjectRef,
): SelectionState {
  const base = here(state, surface);
  const key = refKey(ref);
  const items = base.keys.has(key)
    ? base.items.filter((each) => refKey(each) !== key)
    : [...base.items, ref];
  return of(surface, items, ref);
}

/** The refs from one to the other, both included, in the order given. */
function between(order: readonly ObjectRef[], from: ObjectRef, to: ObjectRef): ObjectRef[] | null {
  const keys = order.map(refKey);
  const start = keys.indexOf(refKey(from));
  const end = keys.indexOf(refKey(to));
  if (start === -1 || end === -1) return null;
  return order.slice(Math.min(start, end), Math.max(start, end) + 1);
}

/**
 * Shift-click, Shift+↑ or Shift+↓: everything from the anchor to this one. The
 * anchor stays, so the range shrinks again when it goes back. Without an
 * anchor in view, it is a click.
 */
export function extend(
  state: SelectionState,
  surface: SelectSurface,
  ref: ObjectRef,
  order: readonly ObjectRef[],
): SelectionState {
  const base = here(state, surface);
  const range = base.anchor ? between(order, base.anchor, ref) : null;
  return range ? of(surface, range, base.anchor) : of(surface, [ref], ref);
}

/** ⌘A: everything in view. The anchor stays if it is in view. */
export function selectAll(
  state: SelectionState,
  surface: SelectSurface,
  order: readonly ObjectRef[],
): SelectionState {
  const base = here(state, surface);
  const anchor =
    base.anchor && order.some((each) => refKey(each) === refKey(base.anchor as ObjectRef))
      ? base.anchor
      : (order[0] ?? null);
  return of(surface, order, anchor);
}

/** Esc, or going to the other surface. */
export const clear = (state: SelectionState, surface?: SelectSurface): SelectionState =>
  surface === undefined || state.surface === surface ? NOTHING_SELECTED : state;

/** Keeps what still exists: a deleted Document or Mind leaves the selection. */
export function keepOnly(
  state: SelectionState,
  exists: (ref: ObjectRef) => boolean,
): SelectionState {
  if (state.items.every(exists)) return state;
  const surface = state.surface;
  if (surface === null) return state;
  const items = state.items.filter(exists);
  return of(surface, items, state.anchor && exists(state.anchor) ? state.anchor : null);
}
