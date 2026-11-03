import { create } from "zustand";
import { type DropProps, type Point, useDropArea } from "../dragDrop";
import { useT } from "../i18n";
import { linksIn } from "../webPages";

/** What a file or link drag from outside is over: the card, or anywhere else (the sidebar, the
 * assistant's composer, which is never in the card). */
export type WindowDropZone = "card" | "other";

interface WindowDrop {
  /** Where the pointer last was, for the label that follows it. */
  at: Point | null;
  zone: WindowDropZone | null;
}

/**
 * Where the window's own drop is: the pointer in `at`, and the zone under it
 * in `zone`, which the shell subscribes to alone, so a move redraws the label
 * and not the window.
 */
export const useWindowDrop = create<WindowDrop>(() => ({ at: null, zone: null }));

function zoneAt(at: Point): WindowDropZone {
  return document.elementFromPoint(at.x, at.y)?.closest('[data-testid="card"]') ? "card" : "other";
}

function note(event: { clientX: number; clientY: number }): void {
  const at = { x: event.clientX, y: event.clientY };
  const zone = zoneAt(at);
  const current = useWindowDrop.getState();
  if (current.at?.x !== at.x || current.at?.y !== at.y || current.zone !== zone) {
    useWindowDrop.setState({ at, zone });
  }
}

const forget = (): void => useWindowDrop.setState({ at: null, zone: null });

/**
 * Lets files and folders be dropped anywhere on an element, and with
 * `onLinks`, links from a browser too. `active` is true while they are
 * dragged over it, and `links` while what is dragged is links; the pointer and
 * the zone are in `useWindowDrop`. `onDrop` gets every dropped item, and those
 * of them the drop says are folders; `onLinks` the web addresses dropped,
 * unless a target inside, such as a Folder, took them.
 */
export function useFileDrop(
  onDrop: (files: File[], folders: File[]) => void,
  onLinks?: (addresses: string[]) => void,
) {
  const area = useDropArea({
    accepts: (dragged) =>
      dragged.kind === "files" || (dragged.kind === "links" && onLinks !== undefined)
        ? { kind: "import" }
        : null,
    drop(dropped) {
      if (dropped.kind === "files") {
        if (dropped.files.length > 0) onDrop(dropped.files, dropped.folders);
      } else if (dropped.kind === "links" && onLinks) {
        const addresses = linksIn(dropped.data);
        if (addresses.length > 0) onLinks(addresses);
      }
    },
  });
  const handlers: DropProps = {
    onDragEnter(event) {
      area.props.onDragEnter(event);
      if (event.defaultPrevented) note(event);
    },
    onDragLeave(event) {
      area.props.onDragLeave(event);
      if (!event.relatedTarget) forget();
    },
    onDragOver(event) {
      area.props.onDragOver(event);
      if (event.defaultPrevented) note(event);
    },
    onDrop(event) {
      area.props.onDrop(event);
      forget();
    },
  };
  return {
    active: area.over !== null,
    links: area.dragged?.kind === "links",
    handlers,
  };
}

/**
 * Shown while files or links are dragged over the card: blue, as something to
 * act on. The caller shows it only over the card, never over a target inside
 * or the composer, so the sidebar's Folders stay in sight and one target
 * lights at a time; opaque, so nothing under it (an empty Mind's words) shows
 * through its own.
 */
export function DropOverlay({ links = false }: { links?: boolean }) {
  const t = useT();
  return (
    <div
      data-testid="drop-overlay"
      className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-accent-wash"
    >
      <p className="text-ui font-semibold text-accent">
        {t(links ? "webPages.drop" : "documents.drop")}
      </p>
    </div>
  );
}
