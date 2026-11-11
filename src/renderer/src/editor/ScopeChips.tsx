import { useRef, useState } from "react";
import type { SearchScope } from "../../../core/api";
import type { MessageKey } from "../../../shared/i18n";
import type { ScopeKind } from "../../../shared/searchScope";
import {
  DocumentLineIcon,
  FolderLineIcon,
  LockLineIcon,
  MindLineIcon,
  TagLineIcon,
} from "../components/lineIcons";
import { folderWallOf } from "../folders";
import { useT } from "../i18n";
import { treeCounts } from "../libraryPage";
import { DELETED_NAMES, type ScopeChip, scopeChips } from "../scope";
import { useAppStore } from "../store";
import { RemoveIcon } from "./icons";
import { ScopeCountMenu } from "./ScopeCountMenu";
import { useChipFloors } from "./useChipFloors";

const CHIP_TITLES: Record<ScopeKind, MessageKey> = {
  folder: "scope.chip.folder",
  tag: "scope.chip.tag",
  document: "scope.chip.document",
};

/** A chip's icon: the sidebar's line icon of its kind, in its muted ink. */
function ChipIcon({ chip }: { chip: ScopeChip }) {
  const className = "scope-chip-icon";
  if (chip.kind === "folder") return <FolderLineIcon className={className} />;
  if (chip.kind === "tag") return <TagLineIcon className={className} />;
  if (chip.meeting) return <MindLineIcon className={className} />;
  return <DocumentLineIcon kind={chip.documentKind ?? "text"} className={className} />;
}

/**
 * A Search scope as chips: one for each Folder, Tag and Document (its title
 * says which), with a × that takes it out. One deleted since is struck
 * through (a Folder with its name, the others as "Deleted …"): the search
 * ignores it. A long scope shows its first chips and "+N more", which shows
 * the rest. In the composer (`onChange`), each chip shows its kind's icon and
 * its name opens the "@" picker, to change the scope; the Mind's own Folder
 * (`ownFolderId`) says how many Documents it searches, and that taking it
 * out searches everything. A scope the User narrowed (`back`) goes back in one click to
 * the scope it narrowed: its one chip's ×, or, with more, a last chip that says where.
 */
export function ScopeChips({
  scope,
  ownFolderId = null,
  onRemove,
  back,
  hideBackChip = false,
  hints = true,
  inRow = false,
  onChange,
  shown: most,
  className,
  testId,
}: {
  scope: SearchScope;
  /** The Folder of the Mind the composer is in: its chip is the Mind's own. */
  ownFolderId?: string | null;
  onRemove(kind: ScopeKind, id: string): void;
  /** `label` names the scope it goes back to. */
  back?: { label: string; onBack(): void };
  /** The last chip that says where `back` goes is left out, for a row with no room: each chip's × still goes back. */
  hideBackChip?: boolean;
  /** The "· empty" a Folder's chip carries is shown, whole, or left out for a row with no room for it. */
  hints?: boolean;
  /** The chips sit in the composer's row: each keeps its first characters (see `useChipFloors`). */
  inRow?: boolean;
  /** Opens the picker from a chip's name, as "@" does. */
  onChange?(): void;
  /** Beyond this many chips (the Documents a Library filter showed, say), the rest fold behind "+N more". */
  shown: number;
  className: string;
  testId: string;
}) {
  const t = useT();
  const folders = useAppStore((state) => state.folders);
  const groups = useAppStore((state) => state.library?.groups);
  const deletedGroups = useAppStore((state) => state.library?.deletedGroups);
  const tags = useAppStore((state) => state.tags);
  const documents = useAppStore((state) => state.documents);
  // How many Documents the Mind's own Folder holds now, those in its sub-Folders too, for its chip's tooltip.
  const ownCount = useAppStore((state) => {
    if (ownFolderId === null) return 0;
    const counted = treeCounts(
      state.library?.groups ?? [],
      (state.library?.assignments ?? []).flatMap((each) =>
        each.groupId === null ? [] : [{ folderId: each.groupId }],
      ),
    );
    return counted.get(ownFolderId) ?? 0;
  });
  const assignments = useAppStore((state) => state.library?.assignments);
  const minds = useAppStore((state) => state.minds);
  const chips = scopeChips(
    { folders, groups, deletedGroups, tags, documents, assignments, minds, t },
    scope,
  );
  /** What a chip says and is: its name, whether it keeps its Question inside it, and its tooltip. */
  const describe = (chip: ScopeChip) => {
    const { deleted } = chip;
    const name = chip.name ?? t(DELETED_NAMES[chip.kind]);
    const path = chip.path.length > 1 ? chip.path.join(" › ") : name;
    const own = !deleted && chip.kind === "folder" && chip.id === ownFolderId;
    const walled =
      !deleted && chip.kind === "folder" && folderWallOf(groups ?? [], chip.id) !== null;
    const title = deleted
      ? t("scope.chip.deleted")
      : walled
        ? t("scope.chip.wall", { name: path })
        : own
          ? t(
              chip.path.length > 1
                ? ownCount === 1
                  ? "scope.chip.own.named.one"
                  : "scope.chip.own.named"
                : ownCount === 1
                  ? "scope.chip.own.one"
                  : "scope.chip.own",
              chip.path.length > 1 ? { path, count: ownCount } : { name, count: ownCount },
            )
          : t(CHIP_TITLES[chip.kind], { name: path });
    return { name, own, walled, title };
  };
  /** What a chip's × does: a lone chip of a narrowed scope goes back to the scope it narrowed. */
  const removal = (chip: ScopeChip, name: string) => {
    const goesBack = back !== undefined && chips.length === 1;
    return {
      label: goesBack ? back.label : t("scope.chip.remove", { name }),
      run: () => (goesBack ? back.onBack() : onRemove(chip.kind, chip.id)),
    };
  };
  const [expanded, setExpanded] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  useChipFloors(list, inRow);
  const long = chips.length > most;
  const shown = long && !expanded ? chips.slice(0, Math.max(0, most - 1)) : chips;
  const more = chips.length - shown.length;
  // With every chip folded away the count says what they were, not what is "more".
  const allFiles = chips.every((chip) => chip.kind === "document");
  const one = chips.length === 1;
  const counted =
    long && shown.length === 0 && !expanded
      ? t(
          allFiles
            ? one
              ? "scope.chip.count.files.one"
              : "scope.chip.count.files"
            : one
              ? "scope.chip.count.items.one"
              : "scope.chip.count.items",
          { count: chips.length },
        )
      : null;
  return (
    <ul
      ref={list}
      contentEditable={false}
      data-testid={testId}
      data-chips={
        inRow
          ? chips.map((chip) => `${chip.name ?? ""}${chip.count === 0 ? " empty" : ""}`).join("\n")
          : undefined
      }
      aria-label={t("scope.picker.label")}
      className={className}
    >
      {shown.map((chip) => {
        const { deleted } = chip;
        const { name, own, walled, title } = describe(chip);
        const remove = removal(chip, name);
        const label = deleted ? (
          <>
            <s className="truncate">{name}</s>
            <span className="sr-only">{t("scope.chip.deleted")}</span>
          </>
        ) : (
          <span className="truncate">{name}</span>
        );
        const emptyHint =
          hints && !deleted && chip.count === 0 ? (
            <span data-testid="scope-chip-empty" className="scope-chip-empty">
              {t("scope.chip.empty")}
            </span>
          ) : null;
        return (
          <li
            key={`${chip.kind}:${chip.id}`}
            data-testid="scope-chip"
            data-kind={chip.kind}
            data-id={chip.id}
            data-deleted={deleted ? "true" : undefined}
            data-own={own ? "true" : undefined}
            data-walled={walled ? "true" : undefined}
            title={title}
            className={`scope-chip ${deleted ? "scope-chip--deleted" : ""}`}
          >
            {onChange && !walled ? (
              <button
                type="button"
                data-testid="scope-chip-change"
                aria-label={t("composer.scope.change", { name: title })}
                onClick={onChange}
                className="scope-chip-name"
              >
                <ChipIcon chip={chip} />
                {label}
                {emptyHint}
              </button>
            ) : (
              <>
                {walled && <LockLineIcon className="scope-chip-icon" />}
                {label}
                {walled && <span className="sr-only">{title}</span>}
                {emptyHint}
              </>
            )}
            {!walled && (
              <button
                type="button"
                data-testid="scope-chip-remove"
                aria-label={remove.label}
                title={remove.label}
                // Keep the cursor where it is.
                onMouseDown={(event) => event.preventDefault()}
                onClick={remove.run}
                className="scope-chip-remove"
              >
                <RemoveIcon className="size-2.5" />
              </button>
            )}
          </li>
        );
      })}
      {counted !== null ? (
        <li className="scope-chips-more">
          <ScopeCountMenu
            label={counted}
            // A count of one keeps what its chip's tooltip said, so the name is still one hover away.
            title={chips.length === 1 && chips[0] ? describe(chips[0]).title : undefined}
            menuLabel={t("scope.picker.label")}
            rows={chips.map((chip) => {
              const { name, walled, title } = describe(chip);
              return {
                key: `${chip.kind}:${chip.id}`,
                icon: walled ? (
                  <LockLineIcon className="scope-chip-icon" data-testid="scope-chips-menu-lock" />
                ) : (
                  <ChipIcon chip={chip} />
                ),
                name,
                struck: chip.deleted,
                title,
                walled,
                remove: walled ? null : removal(chip, name),
              };
            })}
          />
        </li>
      ) : (
        long && (
          <li className="scope-chips-more">
            <button
              type="button"
              data-testid="scope-chips-more"
              aria-expanded={expanded}
              aria-label={expanded ? undefined : t("scope.chip.moreLabel", { count: more })}
              // Keep the cursor where it is.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setExpanded(!expanded)}
              className="scope-chip scope-chip-more"
            >
              {expanded ? t("scope.chip.fewer") : t("scope.chip.more", { count: more })}
            </button>
          </li>
        )
      )}
      {back && chips.length > 1 && !hideBackChip && (
        <li className="scope-chips-back">
          <button
            type="button"
            data-testid="scope-chips-back"
            title={back.label}
            // Keep the cursor where it is.
            onMouseDown={(event) => event.preventDefault()}
            onClick={back.onBack}
            className="scope-chip scope-chip-more"
          >
            <span className="truncate">{back.label}</span>
          </button>
        </li>
      )}
    </ul>
  );
}
