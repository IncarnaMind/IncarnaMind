import type { ReactNode } from "react";
import type { Document } from "../../../core/api";
import { useT } from "../i18n";
import { TagLineIcon } from "./icons";
import { pickerLabel, TagPicker, tagPopoverClass, useTagPopover } from "./TagPicker";
import { buttonStyle } from "./ui";

/**
 * "Tags…" for the Documents selected, which the Tag picker adds to or removes
 * from all at once. The selection's menus open it, too (`data-selection-tags`).
 */
export function SelectionTags({
  documents,
  testId,
  className = buttonStyle("secondary", "sm"),
  keys,
}: {
  documents: readonly Document[];
  testId: string;
  className?: string;
  /** The keys that open it, shown after its name. */
  keys?: ReactNode;
}) {
  const t = useT();
  const popover = useTagPopover();
  const label = pickerLabel(t, documents);
  return (
    <>
      <button
        {...popover.buttonProps}
        type="button"
        data-testid={testId}
        data-selection-tags=""
        className={className}
      >
        <TagLineIcon className="size-3.5" />
        {t("library.selected.tags")}
        {keys}
      </button>
      <div
        {...popover.popoverProps}
        role="dialog"
        aria-label={label}
        data-testid="selection-tags-popover"
        className={tagPopoverClass}
      >
        {popover.open && (
          <TagPicker
            documentIds={documents.map((each) => each.id)}
            label={label}
            onReposition={popover.reposition}
          />
        )}
      </div>
    </>
  );
}
