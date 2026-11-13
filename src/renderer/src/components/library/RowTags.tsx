import { useRef } from "react";
import type { Document, DocumentTag, Tag } from "../../../../core/api";
import { useLanguage, useT } from "../../i18n";
import { useAppStore } from "../../store";
import { chipsOf, hiddenTagsLine } from "../../tagEditing";
import { DocumentTagFooter } from "../DocumentTags";
import { CloseLineIcon, PlusLineIcon, SparkLineIcon } from "../lineIcons";
import { tagChipColour } from "../TagColour";
import {
  chipClass,
  chipTitle,
  pickerLabel,
  TagPicker,
  tagPopoverClass,
  useTagPopover,
} from "../TagPicker";

/** How many chips a row shows before "+N": the row never wraps or grows. */
const VISIBLE_CHIPS = 3;

/**
 * A Library row's Tags, edited where they are, as a Notion database's cell:
 * a click anywhere in the cell (a chip, its empty space, or the faint "+"
 * shown on hover) opens the Tag picker over the cell, and T or ⌥⌘T on the
 * row do the same. Pointed at, a chip offers × to take it off in one click.
 * Each change has its own ⌘Z. Filtering by a Tag is the sidebar's, or
 * + Filter's: a chip edits.
 */
export function RowTags({ document }: { document: Document }) {
  const t = useT();
  const language = useLanguage();
  const tags = useAppStore((state) => state.tags);
  const cell = useRef<HTMLDivElement>(null);
  const popover = useTagPopover({ cover: () => cell.current });
  const chips = chipsOf(document.tags, tags);
  const shown = chips.slice(0, VISIBLE_CHIPS);
  const hidden = chips.slice(VISIBLE_CHIPS);
  const label = pickerLabel(t, [document]);
  // From a click in the cell, Esc gives the focus to "+": the cell itself takes none.
  const open = () => {
    const button = popover.buttonProps.ref.current;
    if (popover.open || !button) return;
    button.focus();
    button.click();
  };
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: the cell's "+" button opens the same editor from the keyboard, and T on the row.
    <div
      ref={cell}
      data-testid="document-tags"
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("button, [role=dialog]"))
          return;
        open();
      }}
      className="flex h-8 min-w-0 flex-1 cursor-default items-center gap-1 self-stretch"
    >
      {shown.map(({ tag, link }) => (
        <RowChip key={tag.id} document={document} tag={tag} link={link} />
      ))}
      {hidden.length > 0 && (
        <span
          data-testid="tag-chip-more"
          title={hiddenTagsLine(t, language, hidden)}
          className="shrink-0 text-[12px] text-ink-meta"
        >
          +{hidden.length}
        </span>
      )}
      <button
        {...popover.buttonProps}
        type="button"
        data-testid="document-tags-menu"
        aria-label={t("tags.edit", { name: document.name })}
        title={t("tags.edit", { name: document.name })}
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-ink-meta opacity-0 group-hover/row:opacity-60 group-has-[:focus-visible]/row:opacity-60 hover:bg-hover hover:text-ink hover:opacity-100! focus-visible:opacity-100 aria-expanded:opacity-100"
      >
        <PlusLineIcon className="size-3.5" />
      </button>
      <div
        {...popover.popoverProps}
        role="dialog"
        aria-label={label}
        data-testid="document-tags-popover"
        className={tagPopoverClass}
      >
        {popover.open && (
          <TagPicker
            documentIds={[document.id]}
            label={label}
            onReposition={popover.reposition}
            footer={<DocumentTagFooter item={document} close={popover.close} />}
          />
        )}
      </div>
    </div>
  );
}

const chipButtonClass =
  "inline-flex size-4 items-center justify-center rounded-sm hover:bg-sheet/70";

/**
 * One Tag on a row: its name, a spark when tagging gave it, and, pointed at,
 * × over its end to take it off, so nothing moves under the pointer. It is wide enough that a
 * two-character name (报告) still opens the picker where it is pointed at, not ×.
 */
function RowChip({ document, tag, link }: { document: Document; tag: Tag; link: DocumentTag }) {
  const t = useT();
  return (
    <span
      data-testid="tag-chip"
      data-tag-id={tag.id}
      data-source={link.source}
      data-colour={tag.colour}
      title={chipTitle(link, tag, t)}
      className={`group/chip relative ${chipClass} ${tagChipColour(tag.colour)} min-w-12 shrink`}
    >
      {link.source === "automatic" && (
        <SparkLineIcon aria-hidden="true" className="size-2.5 shrink-0 opacity-70" />
      )}
      <span className="min-w-0 truncate">{tag.name}</span>
      <span className="absolute inset-y-0 right-0 hidden items-center rounded-r-sm bg-inherit pr-0.5 pl-0.5 group-focus-within/chip:flex group-hover/chip:flex">
        <button
          type="button"
          data-testid="remove-document-tag"
          aria-label={t("tags.picker.remove", { tag: tag.name })}
          title={t("tags.picker.remove", { tag: tag.name })}
          onClick={() => void useAppStore.getState().removeDocumentTag(document.id, tag.id)}
          className={chipButtonClass}
        >
          <CloseLineIcon className="size-2.5" />
        </button>
      </span>
    </span>
  );
}
