import type { Document, DocumentTag, Tag } from "../../../core/api";
import { useLanguage, useT } from "../i18n";
import { useAppStore } from "../store";
import { chipsOf, hiddenTagsLine } from "../tagEditing";
import { DocumentTagFooter } from "./DocumentTags";
import { SparkLineIcon, TagLineIcon } from "./lineIcons";
import { tagChipColour } from "./TagColour";
import {
  chipClass,
  chipTitle,
  pickerLabel,
  TagPicker,
  tagPopoverClass,
  useTagPopover,
} from "./TagPicker";
import { useFittingChips } from "./useFittingChips";

/** How many chips the viewer's header shows before "+N": they stay one line. */
const MOST_CHIPS = 2;

/**
 * A Document's Tags in the viewer's header, on one line: the chips its room
 * holds (a spark marks one tagging applied automatically), then "+N", then the
 * button that opens the Tag picker. A narrow viewer keeps only the button.
 * In a peek (`variant="peek"`) every chip shows, wrapping, and the button says "+ Add tags".
 * The Library's rows have their own (`RowTags`).
 */
export function DocumentTagChips({
  document,
  variant = "header",
}: {
  document: Document;
  variant?: "header" | "peek";
}) {
  const peek = variant === "peek";
  const t = useT();
  const language = useLanguage();
  const tags = useAppStore((state) => state.tags);
  const popover = useTagPopover({
    // A folded row's button has no box: the ⋯ that opened the picker is where it should show.
    cover: (button) =>
      button && button.getBoundingClientRect().width > 0
        ? null
        : (button
            ?.closest<HTMLElement>('[data-testid="viewer-header"]')
            ?.querySelector<HTMLElement>('[data-testid="document-file-menu"]') ?? null),
  });
  const chips = chipsOf(document.tags, tags);
  const fitting = useFittingChips(chips.length, MOST_CHIPS);
  const listed = peek ? chips : chips.slice(0, MOST_CHIPS);
  const hidden = peek ? [] : chips.slice(fitting.shown);
  const label = pickerLabel(t, [document]);
  const more = hiddenTagsLine(t, language, hidden);
  return (
    <div
      ref={fitting.row}
      data-testid="document-tags"
      className={`flex items-center gap-1 ${peek ? "min-w-0 flex-wrap" : "viewer-tags"}`}
    >
      {listed.map(({ tag, link }) => (
        <TagChip key={tag.id} tag={tag} link={link} />
      ))}
      {!peek && chips.length > 0 && (
        <button
          type="button"
          data-tag-more=""
          data-testid="tag-chip-more"
          title={more}
          aria-label={more}
          onClick={() => popover.buttonProps.ref.current?.click()}
          className="h-5 shrink-0 rounded-sm px-1 text-[12px] text-ink-meta hover:bg-hover hover:text-ink"
        >
          +{hidden.length}
        </button>
      )}
      <button
        {...popover.buttonProps}
        type="button"
        data-testid="document-tags-menu"
        aria-label={t("tags.edit", { name: document.name })}
        title={t("tags.edit", { name: document.name })}
        className={
          peek
            ? `h-6 shrink-0 rounded-sm px-1.5 text-[12px] text-ink-meta hover:bg-hover hover:text-ink ${
                chips.length === 0 ? "-ml-1.5" : ""
              }`
            : "viewer-icon-button"
        }
      >
        {peek ? t("peek.addTags") : <TagLineIcon className="size-4" />}
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

/** One Tag in the header: its name, a spark when tagging applied it automatically. */
function TagChip({ tag, link }: { tag: Tag; link: DocumentTag }) {
  const t = useT();
  return (
    <span
      data-tag-chip=""
      data-testid="tag-chip"
      data-tag-id={tag.id}
      data-source={link.source}
      data-colour={tag.colour}
      title={chipTitle(link, tag, t)}
      className={`group/chip ${chipClass} ${tagChipColour(tag.colour)} min-w-0 shrink`}
    >
      {link.source === "automatic" && (
        <SparkLineIcon aria-hidden="true" className="size-2.5 shrink-0 opacity-70" />
      )}
      <span className="min-w-0 truncate">{tag.name}</span>
    </span>
  );
}
