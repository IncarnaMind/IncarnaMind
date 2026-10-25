import { type KeyboardEvent, memo, type Ref, useId, useRef, useState } from "react";
import type { Document, ReferenceField, ReferenceRecord } from "../../../../core/api";
import { displayName, sourceOf } from "../../../../shared/documentNames";
import { missingDetails, needsCheck } from "../../../../shared/references";
import { commands } from "../../commands/registry";
import { nameWithPlace, useDocumentPlace } from "../../documentPlaces";
import { useDraggedRef, useDragSource } from "../../dragDrop";
import { useLanguage, useT } from "../../i18n";
import { FORMAT_LABELS } from "../../libraryFilters";
import { addedLabel, foundLine, type SearchMatch } from "../../libraryPage";
import { atPassage, passagePlace } from "../../palette";
import { usePeekKey } from "../../peek";
import { missingList } from "../../referenceEditing";
import { useSelectable } from "../../selection";
import { rowDrag } from "../../sidebarMoves";
import { useAppStore } from "../../store";
import { acceptSuggestions } from "../../suggestionReview";
import { isDeleteKey, isMoveToKey, isTagsKey, TREE_ROW } from "../../treeKeys";
import { typesText } from "../../undo";
import { useRename } from "../../useRename";
import { CiteAsPanel } from "../CiteAsPanel";
import { DocumentStatusLabel, NotCitedLabel } from "../DocumentsSection";
import { InlineName } from "../InlineName";
import { LibrarySelectBox } from "../LibrarySelection";
import { DocumentLineIcon, FolderLineIcon } from "../lineIcons";
import { Marked } from "../Marked";
import { ObjectMenu, useObjectMenu } from "../ObjectMenu";
import { draggedRowClass, rowActionButtonClass } from "../sidebarRows";
import { ReviewRing } from "../TagColour";
import { useTabPlace } from "../tabs/tabItems";
import { DocumentFix } from "./DocumentFix";
import { documentsToMove, useDocumentMove } from "./DocumentMoveTo";
import {
  moveFromReview,
  REVIEW_COLUMNS,
  REVIEW_ROW,
  ReviewAccept,
  ReviewFolder,
  SuggestedAccept,
} from "./ReviewCells";
import { RowTags } from "./RowTags";

/**
 * The columns past the name: as far as it takes for no name to be cut (`useFittingColumns`),
 * Added goes first, then Format, then the Tags' room shrinks, then the chips go. Narrow, only the
 * chips go: the "+" stays, so Tags… from the menu still has its place.
 */
export const COLUMN_CLASSES = {
  tags: "w-[200px] shrink-0 group-data-[hide~=narrow]/page:w-[152px] group-data-[hide~=narrower]/page:w-[112px] group-data-[hide~=narrowest]/page:w-[88px] group-data-[hide~=chips]/page:w-auto group-data-[hide~=chips]/page:[&_[data-testid^=tag-chip]]:hidden",
  format: "w-[76px] shrink-0 group-data-[hide~=format]/page:hidden",
  added: "w-24 shrink-0 group-data-[hide~=added]/page:hidden",
  more: "flex w-7 shrink-0 justify-end",
} as const;

/**
 * A row of the page: 40px folded, washed when pointed at, its focus ring
 * around the whole row, as while its Tags or its menu are open over it; one
 * a drag carries is quieter and not washed.
 */
export const pageRowClass = (selected: boolean, dragged = false) =>
  `group/row relative border-b border-rule ${
    selected ? "bg-accent-wash" : dragged ? "" : "hover:bg-frame"
  } has-[[data-row-main]:focus-visible]:shadow-[inset_0_0_0_2px_var(--color-accent)] has-[:popover-open]:shadow-[inset_0_0_0_2px_var(--color-accent)] ${
    dragged ? draggedRowClass : ""
  }`;

/** Keeps the preview showing a Document, if one does. */
function keepPreviewOf(documentId: string): void {
  const { layout, changeLayout } = useAppStore.getState();
  const preview = layout?.groups
    .flatMap((group) => group.tabs)
    .find(
      (tab) => tab.preview && tab.item.kind === "document" && tab.item.documentId === documentId,
    );
  if (preview) void changeLayout({ type: "keep", tabId: preview.id });
}

/**
 * Opens the Tags of a row: its own cell's editor, or, when it is one of several
 * selected, Tags… for all of them in the selection's bar.
 */
function openTags(row: HTMLElement | null, documentId: string): void {
  const several = documentsToMove(documentId).length > 1;
  const opener = several
    ? row?.closest('[data-surface="library"]')?.querySelector<HTMLElement>("[data-selection-tags]")
    : row?.querySelector<HTMLElement>('[data-testid="document-tags-menu"]');
  opener?.click();
}

/**
 * Deletes a row's Document, or every one selected with it, to Recently
 * deleted, and moves the focus to the row after them (before them at the end),
 * as Finder does.
 */
function deleteFrom(row: HTMLElement | null, documentId: string): void {
  const ids = documentsToMove(documentId);
  const gone = new Set(ids);
  const grid = row?.closest('[role="grid"]');
  // With every row gone, Add Documents: the focus stays in the Library, where ⌘Z still works.
  const add = row
    ?.closest('[data-testid="library"]')
    ?.querySelector<HTMLElement>('[data-testid="library-add-documents"]');
  const rows = [...(grid?.querySelectorAll<HTMLElement>("[data-document-id]") ?? [])];
  const at = rows.findIndex((each) => each.dataset.documentId === documentId);
  const stays = (each: HTMLElement) => !gone.has(each.dataset.documentId ?? "");
  const next = rows.slice(at + 1).find(stays) ?? rows.slice(0, at).reverse().find(stays);
  const nextId = next?.dataset.documentId;
  commands
    .run("document.delete", {
      selection: ids.map((id) => ({ kind: "document", id })),
      focus: { kind: "document", id: documentId },
      surface: "library",
    })
    .then(() => {
      const target = nextId
        ? grid?.querySelector<HTMLElement>(
            `[data-document-id="${CSS.escape(nextId)}"] [data-row-main]`,
          )
        : add;
      target?.focus();
    })
    .catch(useAppStore.getState().reportError);
}

/** Clicks on these, inside a row, are theirs, not the row's. */
const OWN_CLICKS = "button:not([data-row-main]), input, a, [role=menu], [role=dialog]";

/** Where a modifier-click is still its own: a field, a link, a menu or the open Cite as panel. */
const KEEPS_MODIFIER_CLICKS =
  "input, textarea, select, a, [role=menu], [role=dialog], [data-cite-panel]";

/**
 * A Document's row on the Library page: its name (with the kind's icon, a
 * problem's word, and "Suggested" while Organize's Folder waits), its Tags, its
 * format and when it was added, then ⋯; the checkbox hangs in the margin. A
 * click anywhere but its Tags, checkbox and ⋯ opens it beside the list; ⌘-click
 * and Shift-click select. It drags onto a Folder or a Tag, with the rows
 * selected with it. Memoised (#156): while Organize goes through
 * thousands of Documents, only the rows whose Document changed are drawn again.
 */
export const LibraryRow = memo(function LibraryRow({
  doc,
  suggestedIn,
  review = false,
  notSorted,
  sortFailed,
  match,
  path,
}: {
  doc: Document;
  /** The Suggested Folder it waits in, if Organize suggested one. */
  suggestedIn: string | null;
  review?: boolean;
  /** Why Organize couldn't sort it, if it couldn't. */
  notSorted: string | null;
  /** Why a Suggested Folder's latest run failed, if it did. */
  sortFailed: string | null;
  /** How it matches the search, while there is one. */
  match: SearchMatch | null;
  /** Its Folder, shown under it while searching. */
  path: string | null;
}) {
  const t = useT();
  const language = useLanguage();
  const place = useTabPlace();
  const name = displayName(doc);
  const where = useDocumentPlace(doc.id);
  const source = sourceOf(doc);
  const format = t(FORMAT_LABELS[doc.kind]);
  const added = addedLabel(doc.createdAt, new Date(), language);
  const [citing, setCiting] = useState<{ focus: ReferenceField | null } | null>(null);
  const citeToggle = useRef<HTMLButtonElement>(null);
  const citePanelId = useId();
  const objectMenu = useObjectMenu({ kind: "document", id: doc.id });
  const inside = match?.text ?? null;
  const foundAt = inside ? passagePlace(doc.kind, inside, t) : "";
  const line = inside ? foundLine(inside) : null;
  const select = useSelectable({ kind: "document", id: doc.id }, "library", () =>
    useAppStore
      .getState()
      .openDocument(
        { documentId: doc.id, ...(inside && atPassage(inside)) },
        { as: "library", ...(place && { from: place.groupId }) },
      ),
  );
  const peek = usePeekKey(doc.id, "library");
  // A double-click keeps the preview it opened, then renames.
  const rename = useRename<HTMLButtonElement>(
    `${review ? "library-review" : "library-document"}:${doc.id}`,
    () => keepPreviewOf(doc.id),
  );
  const renameDocument = useAppStore((state) => state.renameDocument);
  const row = useRef<HTMLDivElement>(null);
  const moveTo = (anchor: HTMLElement | null) => {
    if (!anchor) return;
    if (review) moveFromReview(doc.id, anchor);
    else useDocumentMove.getState().show({ anchor, documentIds: documentsToMove(doc.id) });
  };
  const menuButton = () => row.current?.querySelector<HTMLElement>("[data-object-menu]") ?? null;
  const dragSource = useDragSource(() => rowDrag({ kind: "document", id: doc.id }, "library"));
  const dragged = useDraggedRef({ kind: "document", id: doc.id });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    objectMenu.rowProps.onKeyDown(event);
    if (event.defaultPrevented || typesText(event.target)) return;
    // Enter accepts a Folder To review suggested (#241); elsewhere, and on a Document it couldn't
    // sort, it opens, as it does on every other row.
    if (
      review &&
      suggestedIn !== null &&
      event.key === "Enter" &&
      !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) &&
      event.target instanceof Element &&
      event.target.matches("[data-row-main]")
    ) {
      event.preventDefault();
      // A held key accepts one row, not the whole list.
      if (!event.repeat) {
        void acceptSuggestions(documentsToMove(doc.id)).catch(useAppStore.getState().reportError);
      }
    } else if (isMoveToKey(event)) {
      event.preventDefault();
      moveTo(menuButton());
    } else if (isTagsKey(event)) {
      event.preventDefault();
      openTags(row.current, doc.id);
    } else if (isDeleteKey(event)) {
      event.preventDefault();
      if (!event.repeat) deleteFrom(row.current, doc.id);
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a row of columns in a grid of sections, not a table row.
    // biome-ignore lint/a11y/useFocusableInteractive: the name's button takes the focus, and the arrow keys move between them.
    <div
      ref={row}
      data-testid={review ? "library-review-document" : "library-document"}
      data-document-id={doc.id}
      data-suggested={suggestedIn !== null ? "" : undefined}
      data-dragging={dragged || undefined}
      role="row"
      {...select.rowProps}
      {...peek.rowProps}
      {...objectMenu.rowProps}
      onKeyDown={onKeyDown}
      // ⌘-, Ctrl- and Shift-click only change the selection, wherever in the row they land, a chip
      // or the Tags included: nothing else opens (interaction rule 6, #1509).
      onClickCapture={(event) => {
        if (!(event.metaKey || event.ctrlKey || event.shiftKey)) return;
        const target = event.target instanceof Element ? event.target : null;
        if (!target || target.closest(KEEPS_MODIFIER_CLICKS)) return;
        event.stopPropagation();
        select.onClick(event);
      }}
      onClick={(event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest(OWN_CLICKS) || target?.closest("[data-row-cell=tags]")) return;
        select.onClick(event);
      }}
      className={`${pageRowClass(select.selected, dragged)} cursor-default`}
    >
      <LibrarySelectBox document={doc} />
      <div
        {...(rename.renaming ? {} : dragSource)}
        className={
          review
            ? REVIEW_ROW
            : "flex min-h-[39px] items-center gap-4 pr-1.5 pl-3 group-data-[hide~=narrowest]/page:gap-2"
        }
      >
        <div className={`flex min-w-0 flex-1 items-center ${review ? REVIEW_COLUMNS.name : ""}`}>
          <span aria-hidden="true" className="w-5 shrink-0" />
          <div className={`min-w-0 flex-1 ${match ? "py-1.5" : ""}`}>
            <div className="flex min-w-0 items-center gap-2">
              {rename.renaming ? (
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <DocumentLineIcon kind={doc.kind} className="size-4 shrink-0 text-ink-meta" />
                  <InlineName
                    value={doc.name}
                    label={t("documents.renameLabel", { name: doc.name })}
                    {...rename.field((next) => renameDocument(doc.id, next))}
                  />
                </span>
              ) : (
                <button
                  {...rename.nameProps}
                  type="button"
                  {...TREE_ROW}
                  data-row-main=""
                  title={[
                    nameWithPlace(name, where),
                    ...(name === source ? [] : [source]),
                    `${format} · ${added}`,
                  ].join("\n")}
                  className="flex min-w-0 items-center gap-2 text-left focus-visible:outline-0"
                >
                  <DocumentLineIcon kind={doc.kind} className="size-4 shrink-0 text-ink-meta" />
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      data-testid="library-document-name"
                      data-fit-name=""
                      className="max-w-full shrink-0 truncate text-ui text-ink"
                    >
                      {match ? <Marked text={name} ranges={match.ranges} /> : name}
                    </span>
                    {where && (
                      <span
                        data-testid="library-document-place"
                        data-fit-name=""
                        className="min-w-0 truncate text-[12px] text-ink-meta"
                      >
                        {where}
                      </span>
                    )}
                  </span>
                </button>
              )}
              {foundAt && (
                <span
                  data-testid="library-found-place"
                  className="shrink-0 text-[12px] text-ink-meta"
                >
                  {foundAt}
                </span>
              )}
              <span className="contents">
                <NotCitedLabel item={doc} />
                <DocumentStatusLabel item={doc} />
                {notSorted !== null && (
                  <span
                    data-testid="library-not-sorted"
                    title={t("library.notSorted.title", { reason: notSorted })}
                    className="min-w-0 max-w-60 shrink truncate text-label font-semibold text-ink-meta"
                  >
                    {t("library.notSorted.reason", { reason: notSorted })}
                  </span>
                )}
                {sortFailed !== null && (
                  <span
                    data-testid="library-sort-failed"
                    title={t("library.sortAgain.title", { reason: sortFailed })}
                    className="min-w-0 max-w-60 shrink truncate text-label font-semibold text-ink-meta"
                  >
                    {t("library.sortAgain.reason", { reason: sortFailed })}
                  </span>
                )}
                {suggestedIn !== null && !review && (
                  <>
                    <span
                      data-testid="library-suggested"
                      title={t("library.suggested.title", { folder: suggestedIn })}
                      className="inline-flex shrink-0 items-center gap-1 text-label font-semibold text-review"
                    >
                      <ReviewRing />
                      {t("library.suggested")}
                    </span>
                    <SuggestedAccept doc={doc} folder={suggestedIn} />
                  </>
                )}
              </span>
              {doc.reference && !rename.renaming && (
                <CiteAsToggle
                  ref={citeToggle}
                  document={doc}
                  record={doc.reference}
                  panelId={citePanelId}
                  open={citing !== null}
                  onToggle={(focus) => setCiting(citing === null ? { focus } : null)}
                />
              )}
            </div>
            <DocumentFix doc={doc} />
            {line && (
              <p
                data-testid="library-found-text"
                className="truncate pl-6 text-[13px] leading-5 text-ink-secondary"
              >
                <Marked text={line.text} ranges={line.ranges} />
              </p>
            )}
            {path !== null && (
              <p
                data-testid="library-path"
                className="flex min-w-0 items-center gap-1 pl-6 text-[12px] leading-4 text-ink-meta"
              >
                <FolderLineIcon className="size-3 shrink-0" />
                <span className="truncate">{path}</span>
              </p>
            )}
          </div>
        </div>
        <div
          data-row-cell="tags"
          className={`${review ? REVIEW_COLUMNS.tags : COLUMN_CLASSES.tags} flex min-w-0 items-center overflow-hidden`}
        >
          <RowTags document={doc} />
        </div>
        {review && suggestedIn !== null ? (
          <>
            <span className={REVIEW_COLUMNS.folder}>
              <ReviewFolder doc={doc} folder={suggestedIn} onChange={moveTo} />
            </span>
            <span className={REVIEW_COLUMNS.accept}>
              <ReviewAccept doc={doc} folder={suggestedIn} />
            </span>
          </>
        ) : (
          <>
            <span
              data-testid="library-document-format"
              className={`${COLUMN_CLASSES.format} truncate text-[13px] text-ink-secondary`}
            >
              {format}
            </span>
            <span
              data-testid="library-document-added"
              className={`${COLUMN_CLASSES.added} truncate text-[13px] whitespace-nowrap text-ink-secondary`}
            >
              {added}
            </span>
          </>
        )}
        <span className={COLUMN_CLASSES.more}>
          <ObjectMenu
            target={{ kind: "document", id: doc.id }}
            label={t("documents.more", { name: doc.name })}
            here={{
              "document.rename": rename.start,
              // Once the menu has closed and given the focus back, so the picker opens beside ⋯.
              "document.moveTo": () => requestAnimationFrame(() => moveTo(menuButton())),
            }}
            className={`${rowActionButtonClass} opacity-0 group-hover/row:opacity-100 group-has-[:focus-visible]/row:opacity-100 aria-expanded:opacity-100`}
          />
        </span>
      </div>
      {citing && doc.reference && (
        <div id={citePanelId} data-cite-panel="" className="min-w-0 pr-1.5 pb-3 pl-14">
          <CiteAsPanel
            document={doc}
            record={doc.reference}
            focusField={citing.focus}
            onClose={() => {
              setCiting(null);
              citeToggle.current?.focus();
            }}
          />
        </div>
      )}
    </div>
  );
});

/**
 * A row's way into "Cite as" (#286), after its name: "Needs details", with the
 * waiting dot, while the record is too thin to cite, which opens it at the
 * first missing field; "Needs checking", with the review ring, while what was
 * read from the file waits for the User to check it; otherwise "Cite as",
 * shown while the row is pointed at or focused.
 */
function CiteAsToggle({
  ref,
  document,
  record,
  panelId,
  open,
  onToggle,
}: {
  ref: Ref<HTMLButtonElement>;
  document: Document;
  record: ReferenceRecord;
  panelId: string;
  open: boolean;
  onToggle(focus: ReferenceField | null): void;
}) {
  const t = useT();
  const language = useLanguage();
  const missing = missingDetails(record);
  const list = missingList(language, record);
  const unchecked = missing.length === 0 && needsCheck(record);
  const label = t("reference.citeAs.label", { name: displayName(document) });
  const said = list
    ? t("reference.needsDetails.title", { missing: list })
    : unchecked
      ? t("reference.toCheck.title")
      : null;
  return (
    <button
      ref={ref}
      type="button"
      data-testid="cite-as-toggle"
      data-needs-details={missing.length > 0 ? "" : undefined}
      data-needs-check={unchecked ? "" : undefined}
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      aria-label={said ? `${label}. ${said}` : label}
      title={said ?? undefined}
      onClick={() => onToggle(missing[0] ?? null)}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-sm text-[12px] leading-5 whitespace-nowrap text-ink-meta hover:text-ink hover:underline ${
        missing.length > 0 || unchecked || open
          ? ""
          : "opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100"
      }`}
    >
      {missing.length > 0 && (
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-attention" />
      )}
      {unchecked && <ReviewRing />}
      {t(
        missing.length > 0
          ? "reference.needsDetails"
          : unchecked
            ? "reference.toCheck"
            : "reference.citeAs",
      )}
    </button>
  );
}
