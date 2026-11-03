import { useDropArea } from "../dragDrop";
import { useT } from "../i18n";
import { linksIn } from "../webPages";

/**
 * Lets files and folders be dropped anywhere on an element, and with
 * `onLinks`, links from a browser too. `active` is true while they are
 * dragged over it, `links` while what is dragged is links, and `at` where the
 * pointer last was. `onDrop` gets every dropped item, and those of them the
 * drop says are folders; `onLinks` the web addresses dropped, unless a target
 * inside, such as a Folder, took them.
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
  return {
    active: area.over !== null,
    links: area.dragged?.kind === "links",
    at: area.at,
    handlers: area.props,
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
