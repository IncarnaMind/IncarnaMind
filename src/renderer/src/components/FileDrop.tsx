import { useCallback, useRef } from "react";
import { create } from "zustand";
import { type DropProps, draggedIn, type Point, useDropArea } from "../dragDrop";
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
  const cancelWatch = useRef<(() => void) | null>(null);
  const forget = useCallback(() => {
    const watching = cancelWatch.current;
    if (watching) {
      window.removeEventListener("pointermove", watching, { capture: true });
      cancelWatch.current = null;
    }
    useWindowDrop.setState({ at: null, zone: null });
  }, []);
  // A cancelled drag sends the page nothing, so the first pointer move after it ends the area and
  // the label.
  const watchCancel = useCallback(() => {
    if (cancelWatch.current || typeof window === "undefined") return;
    cancelWatch.current = () => {
      cancelWatch.current = null;
      area.reset();
      forget();
    };
    window.addEventListener("pointermove", cancelWatch.current, { capture: true, once: true });
  }, [area, forget]);
  /** Whether the window's own drop takes what is dragged, not an app drag its targets may take. */
  const windowTakes = (event: { dataTransfer: DataTransfer | null }) => {
    const dragged = event.dataTransfer ? draggedIn(event.dataTransfer) : null;
    return dragged?.kind === "files" || (dragged?.kind === "links" && onLinks !== undefined);
  };
  const handlers: DropProps = {
    onDragEnter(event) {
      area.props.onDragEnter(event);
      if (windowTakes(event)) {
        note(event);
        watchCancel();
      }
    },
    onDragLeave(event) {
      area.props.onDragLeave(event);
      if (!event.relatedTarget) {
        area.reset();
        forget();
      }
    },
    onDragOver(event) {
      area.props.onDragOver(event);
      if (windowTakes(event)) {
        note(event);
        watchCancel();
      }
    },
    onDrop(event) {
      area.props.onDrop(event);
      area.reset();
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
