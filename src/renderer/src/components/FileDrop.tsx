import { useDropArea } from "../dragDrop";
import { useT } from "../i18n";
import { linksIn } from "../webPages";

/**
 * Lets files and folders be dropped anywhere on an element, and with
 * `onLinks`, links from a browser too. `active` is true while they are
 * dragged over it, and `links` while what is dragged is links. `onDrop` gets
 * every dropped item, and those of them the drop says are folders; `onLinks`
 * the web addresses dropped, unless a target inside, such as a Folder, took
 * them.
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
    handlers: area.props,
  };
}

/**
 * Shown while files are dragged over the window: blue, as something to act
 * on. Opaque, so nothing under it (an empty Mind's words) shows through its
 * own. For links it covers only the card, so the sidebar's Folders, which
 * take a link too, stay in sight.
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
