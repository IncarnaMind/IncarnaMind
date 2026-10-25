import type { ObjectRef } from "../objects";
import type { CommandContext } from "./registry";

type Here = NonNullable<CommandContext["here"]>;

interface Place {
  button: HTMLElement;
  here(): Here;
}

const places: Place[] = [];

/**
 * An object's ⋯ button on the page, and what only that place can do for the
 * object (`CommandContext.here`): renaming in its row, or opening a picker
 * beside it. Gone when the place is.
 */
export function showPlace(button: HTMLElement, here: () => Here): () => void {
  const place: Place = { button, here };
  places.push(place);
  return () => {
    const at = places.indexOf(place);
    if (at >= 0) places.splice(at, 1);
  };
}

const ROW = "[data-object-row]";

/**
 * What the place that shows `target` can do for it, for ⌘K, which has none of
 * its own: the row the focus was in, else the Mind's or Document's page rather
 * than a row for it, a row remounted later (virtualised) not being the one
 * ⌘K was opened from.
 */
export function placeHere(target: ObjectRef, focus: Element | null): CommandContext["here"] {
  const named = `${target.kind}:${target.id}`;
  const shown = places.filter(
    ({ button }) =>
      button.dataset.objectMenu === named &&
      button.isConnected &&
      button.getClientRects().length > 0,
  );
  const own = focus ? shown.find(({ button }) => button.closest(ROW)?.contains(focus)) : undefined;
  const onPage = shown.filter(({ button }) => !button.closest(ROW)).at(-1);
  return (own ?? onPage ?? shown.at(-1))?.here();
}
