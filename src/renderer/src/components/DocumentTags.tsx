import type { ReactNode } from "react";
import type { Document, Tag } from "../../../core/api";
import { organizeHeld, organizesNewDocuments } from "../../../shared/libraryModels";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import { taggingProblem } from "../taggingProblem";
import { placeOf, resumeTagging } from "../taggingStop";
import { TagLineIcon } from "./lineIcons";
import { pickerLabel, TagPicker, tagPopoverClass, useTagPopover } from "./TagPicker";

/**
 * A Document's Tags button and the Tag picker it opens (see `TagPicker`):
 * the sidebar's row offers it when pointed at. Under the picker, "Re-tag
 * automatically" (or Organize) and "Manage Tags…".
 */
export function DocumentTagMenu({
  item,
  buttonClassName,
  tabIndex,
  children,
}: {
  item: Document;
  buttonClassName: string;
  tabIndex?: number;
  children?: ReactNode;
}) {
  const t = useT();
  const popover = useTagPopover();
  const label = pickerLabel(t, [item]);
  return (
    <>
      <button
        {...popover.buttonProps}
        type="button"
        data-testid="document-tags-menu"
        aria-label={label}
        title={label}
        tabIndex={tabIndex}
        className={buttonClassName}
      >
        {children ?? <TagLineIcon className="size-[15px]" />}
      </button>
      <div
        {...popover.popoverProps}
        role="dialog"
        aria-label={label}
        data-testid="document-tags-popover"
        className={tagPopoverClass}
      >
        {/* Only while open: every Document has this popover, and Tag names in each would read as its own text. */}
        {popover.open && (
          <TagPicker
            documentIds={[item.id]}
            label={label}
            onReposition={popover.reposition}
            footer={<DocumentTagFooter item={item} close={popover.close} />}
          />
        )}
      </div>
    </>
  );
}

type NoTagsWhy = "stopped" | "noTags" | "noFit";

const whyKeys = {
  stopped: "status.taggingStopped",
  noTags: "tags.state.noTags",
  noFit: "tags.state.noFit",
} as const;

function whyNoTags(item: Document, tags: readonly Tag[]): NoTagsWhy | null {
  if (item.status !== "ready") return null;
  if (item.tagging === "stopped") return "stopped";
  if (item.tags.length > 0 || (item.tagging !== "tagged" && item.tagging !== "no-tags"))
    return null;
  if (tags.length === 0) return "noTags";
  // Tagged before any Tag existed (before "no-tags" was kept), it was never checked against one.
  const firstTag = tags.reduce(
    (first, tag) => (tag.createdAt < first ? tag.createdAt : first),
    "~",
  );
  return item.tagging === "tagged" && item.updatedAt >= firstTag ? "noFit" : null;
}

const footerButton =
  "h-7 shrink-0 rounded-md px-2 text-[12px] font-semibold text-ink-secondary hover:bg-hover hover:text-ink";

/**
 * Under a Document's Tag picker: why it has no Tags (Tagging stopped, no Tag
 * fits, no Tags yet), where automatic tagging is (waiting, working, failed)
 * for those Organize doesn't hold, "Re-tag automatically" (Organize for those
 * it holds) and "Manage Tags…".
 */
export function DocumentTagFooter({ item, close }: { item: Document; close(): void }) {
  const t = useT();
  const library = useAppStore((state) => state.library);
  const tags = useAppStore((state) => state.tags);
  const why = whyNoTags(item, tags);
  const held = organizeHeld(library).has(item.id);
  const taggingLine =
    item.status !== "ready" || held
      ? null
      : item.tagging === "pending"
        ? t("tags.state.pending")
        : item.tagging === "tagging"
          ? t("tags.state.tagging")
          : item.tagging === "failed"
            ? t("tags.state.failed")
            : null;
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {why && (
        <div
          data-testid="document-tagging-why"
          data-why={why}
          className="flex min-h-7 min-w-0 items-center gap-1.5 px-1 text-[12px] text-ink-meta"
        >
          {why !== "noFit" && (
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-attention" />
          )}
          <span className="min-w-0 truncate">{t(whyKeys[why])}</span>
          {why === "stopped" && (
            <>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                data-testid="document-tagging-resume"
                onClick={() => {
                  close();
                  void resumeTagging([placeOf(library, item.id)]).catch((error: unknown) =>
                    useAppStore.getState().reportError(error),
                  );
                }}
                className={footerButton}
              >
                {t("tagging.resume")}
              </button>
            </>
          )}
          {why === "noTags" && (
            <>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                data-testid="document-tagging-add-tag"
                onClick={() => {
                  close();
                  useAppStore.getState().openTagsDialog();
                }}
                className={footerButton}
              >
                {t("tags.state.addTag")}
              </button>
            </>
          )}
        </div>
      )}
      <div className="flex min-h-8 min-w-0 items-center">
        {taggingLine && (
          <span
            data-testid="document-tagging"
            title={item.taggingError ? taggingProblem(item.taggingError, t) : undefined}
            className="flex max-w-28 items-center gap-1.5 px-1 text-[12px] text-ink-meta"
          >
            {item.tagging === "failed" && (
              <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-attention" />
            )}
            <span className="truncate">{taggingLine}</span>
          </span>
        )}
        {item.status === "ready" && (
          <button
            type="button"
            data-testid="retag-document"
            onClick={() => {
              close();
              void useAppStore.getState().retagDocuments([item.id]);
            }}
            className={footerButton}
          >
            {t(held && organizesNewDocuments(library) ? "library.classify" : "tags.menu.retag")}
          </button>
        )}
        <button
          type="button"
          data-testid="open-tags-dialog"
          onClick={() => {
            close();
            useAppStore.getState().openTagsDialog();
          }}
          className={footerButton}
        >
          {t("tags.menu.manage")}
        </button>
      </div>
    </div>
  );
}
