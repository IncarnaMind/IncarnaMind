import { useT } from "../i18n";
import { LinkLineIcon } from "./icons";

/** The mark beside a Folder bound to a folder on disk (#3613), which says where that folder is. */
export function BoundMark({ path }: { path: string }) {
  const t = useT();
  const words = t("folder.bound.mark", { path });
  return (
    <span
      data-testid="folder-bound"
      role="img"
      aria-label={words}
      title={words}
      className="flex shrink-0"
    >
      <LinkLineIcon className="text-ink-meta" />
    </span>
  );
}
