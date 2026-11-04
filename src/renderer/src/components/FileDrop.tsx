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
  /** Whether a link, not files, is dragged. */
  links: boolean;
}

/**
 * Where the window's own drop is: the pointer in `at`, and the zone under it
 * in `zone`; a drag is over the window while the zone is set. The shell
 * subscribes to the zone and the kind alone, so a move redraws the label and
 * not the window.
 */
export const useWindowDrop = create<WindowDrop>(() => ({ at: null, zone: null, links: false }));

function zoneAt(at: Point): WindowDropZone {
  return document.elementFromPoint(at.x, at.y)?.closest('[data-testid="card"]') ? "card" : "other";
}

function note(event: { clientX: number; clientY: number }, links: boolean): void {
  const at = { x: event.clientX, y: event.clientY };
  const zone = zoneAt(at);
  const current = useWindowDrop.getState();
  if (
    current.at?.x !== at.x ||
    current.at?.y !== at.y ||
    current.zone !== zone ||
    current.links !== links
  ) {
    useWindowDrop.setState({ at, zone, links });
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
    useWindowDrop.setState({ at: null, zone: null, links: false });
  }, []);
  // A cancelled drag sends the page nothing, so the first pointer move after it ends the window's
  // drop.
  const watchCancel = useCallback(() => {
    if (cancelWatch.current || typeof window === "undefined") return;
    cancelWatch.current = () => {
      cancelWatch.current = null;
      forget();
    };
    window.addEventListener("pointermove", cancelWatch.current, { capture: true, once: true });
  }, [forget]);
  /** "files", "links" or null: whether the window's drop takes what is dragged, unlike an app drag. */
  const windowTakes = (event: { dataTransfer: DataTransfer | null }) => {
    const dragged = event.dataTransfer ? draggedIn(event.dataTransfer) : null;
    if (dragged?.kind === "files") return "files";
    if (dragged?.kind === "links" && onLinks !== undefined) return "links";
    return null;
  };
  const handlers: DropProps = {
    onDragEnter(event) {
      area.props.onDragEnter(event);
      const takes = windowTakes(event);
      if (takes) {
        note(event, takes === "links");
        watchCancel();
      }
    },
    onDragLeave(event) {
      if (!event.relatedTarget) forget();
    },
    onDragOver(event) {
      area.props.onDragOver(event);
      const takes = windowTakes(event);
      if (takes) {
        note(event, takes === "links");
        watchCancel();
      }
    },
    onDrop(event) {
      area.props.onDrop(event);
      forget();
    },
  };
  const zone = useWindowDrop((state) => state.zone);
  const links = useWindowDrop((state) => state.links);
  return { active: zone !== null, links, handlers };
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
