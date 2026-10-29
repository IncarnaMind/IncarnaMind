import type { Editor } from "@tiptap/core";
import { useRef, useState } from "react";
import type * as Y from "yjs";
import { mindName } from "../../../shared/naming";
import type { Verification } from "../../../shared/verification";
import { offersReview, reviewApplied } from "../appliedEdits";
import { ExampleChoices } from "../components/ExamplesMenu";
import { ChevronRightLineIcon } from "../components/lineIcons";
import { MindStyleChoices, useStyleValue } from "../components/MindStyle";
import { MoveToPicker } from "../components/MoveToPicker";
import { ObjectMenu } from "../components/ObjectMenu";
import { useTabPlace } from "../components/tabs/tabItems";
import {
  menuClass,
  menuItemClass,
  menuItemUnavailableClass,
  menuRuleClass,
  menuTitleClass,
} from "../components/ui";
import { useSubmenu } from "../components/usePopoverMenu";
import { files } from "../core";
import { showFileLabelKey } from "../fileInfo";
import { useFirstOpen } from "../firstOpen";
import { moveIntoFolder } from "../folderDrag";
import { useLanguage, useT } from "../i18n";
import { fileStatusLabel } from "../linkedFolders";
import { useMindStylePanel } from "../mindStylePanel";
import { useReviewables, useReviewPanes } from "../reviewPane";
import { allExamples, useAppStore } from "../store";
import { openDocumentBeside } from "../verify";
import { LookMenuItems } from "./LookMenu";
import { MindCounts } from "./WordCount";
import { openOriginalAtCaret, useWordFile, wordFileTooltip } from "./WordOrigin";

/**
 * The ⋯ button at a Mind's page's top right (#908; the board
 * Page-Clean-Menu): the Mind's menu in the sidebar row's order; Style ›, its
 * choices beside it; "From {file}" with Show in Finder for a Mind imported
 * from Word or made by Verify, which opens the original beside it, and
 * "Review their changes" for one with someone's changes or comments; Review
 * changes for the last AI edit applied, while it can be restored (#1795); and
 * at its foot the counts and the switch that shows the count while writing.
 */
export function PageMenu({
  editor,
  doc,
  mindId,
  verification,
  readOnly,
}: {
  editor: Editor;
  doc: Y.Doc;
  mindId: string;
  verification: Verification | null;
  readOnly: boolean;
}) {
  const t = useT();
  const language = useLanguage();
  const mind = useAppStore((state) => state.minds.find((each) => each.id === mindId));
  const name = (mind && mindName(mind)) || t("mind.untitled");
  const tabId = useTabPlace()?.tabId;
  // The quiet first open shows no tab strip, so there is no tab to rename in.
  const firstOpen = useFirstOpen();
  const holder = useRef<HTMLSpanElement>(null);
  const [moving, setMoving] = useState<HTMLElement | null>(null);
  const button = () =>
    holder.current?.querySelector<HTMLButtonElement>("[data-object-menu]") ?? null;
  const style = useSubmenu();
  const styleValue = useStyleValue(mindId);
  const { file, report } = useWordFile(doc);
  const origin = verification
    ? { name: verification.documentName, documentId: verification.documentId, word: false }
    : file
      ? { name: file.name, documentId: file.documentId ?? null, word: true }
      : null;
  const original = useAppStore((state) =>
    origin?.documentId ? state.documents.find((each) => each.id === origin.documentId) : undefined,
  );
  const away = original ? fileStatusLabel(original.fileStatus) : null;
  const otherExamples = useAppStore(
    (state) => allExamples(state).find((each) => each.mindId === mindId)?.more,
  );
  return (
    <span ref={holder} className="contents">
      <ObjectMenu
        target={{ kind: "mind", id: mindId }}
        label={t("mind.more", { title: name })}
        testId="page"
        align="end"
        className="page-menu-button"
        here={{
          // Once the menu has closed and given the focus back, so the field or the picker keeps it.
          ...(tabId &&
            !firstOpen && {
              "mind.rename": () =>
                requestAnimationFrame(() => useAppStore.getState().renameTab(tabId)),
            }),
          "mind.moveTo": () => requestAnimationFrame(() => setMoving(button())),
        }}
        // The Mind is open on this page: nothing to open, and Style is below.
        without={["mind.style", "mind.open", "mind.openTab"]}
        more={
          readOnly && !origin && !otherExamples
            ? undefined
            : (close) => (
                <>
                  {!readOnly && (
                    <button
                      {...style.itemProps}
                      type="button"
                      data-testid="page-style"
                      className={`${menuItemClass} pl-2 aria-expanded:bg-hover`}
                    >
                      <span className="flex-1">{t("mindStyle.title")}</span>
                      <span className="max-w-32 truncate pl-4 text-[13px] text-ink-meta">
                        {styleValue}
                      </span>
                      <ChevronRightLineIcon className="size-3.5 shrink-0 text-ink-meta" />
                    </button>
                  )}
                  {!readOnly && origin?.word && <LookMenuItems mindId={mindId} close={close} />}
                  {!readOnly && offersReview(editor) && (
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="page-review-changes"
                      onClick={() => {
                        close();
                        requestAnimationFrame(() => reviewApplied(editor, { focus: true }));
                      }}
                      className={`${menuItemClass} pl-2`}
                    >
                      <span className="min-w-0 flex-1 truncate">{t("edit.applied.review")}</span>
                    </button>
                  )}
                  {origin && (
                    <>
                      {!readOnly && <div className={menuRuleClass} />}
                      {!readOnly && origin.word && useReviewables.getState()[mindId]?.has() && (
                        <button
                          type="button"
                          role="menuitem"
                          data-testid="page-review"
                          onClick={() => {
                            close();
                            useReviewPanes.getState().open(mindId);
                          }}
                          className={`${menuItemClass} pl-2`}
                        >
                          <span className="min-w-0 flex-1 truncate">{t("review.menuItem")}</span>
                        </button>
                      )}
                      {/* Not in the Library, the original can't be opened: what it says of the file is still true. */}
                      <button
                        type="button"
                        role="menuitem"
                        data-testid="page-from"
                        aria-disabled={original ? undefined : true}
                        title={
                          origin.word
                            ? wordFileTooltip(report, t, language)
                            : t("verify.from.title", { name: origin.name })
                        }
                        onClick={() => {
                          if (!original) return;
                          close();
                          if (origin.word) openOriginalAtCaret(original.id, editor, doc);
                          else openDocumentBeside(original.id);
                        }}
                        className={`${menuItemClass} ${menuItemUnavailableClass} pl-2`}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {t(origin.word ? "wordImport.from" : "verify.from", {
                            name: origin.name,
                          })}
                        </span>
                      </button>
                      {original && (
                        <button
                          type="button"
                          role="menuitem"
                          data-testid="page-show-original"
                          aria-disabled={away ? true : undefined}
                          title={away ? t(away.reason) : undefined}
                          onClick={() => {
                            if (away) return;
                            close();
                            files
                              .showDocumentInFolder(original.id)
                              .catch((error) => useAppStore.getState().reportError(error));
                          }}
                          className={`${menuItemClass} ${menuItemUnavailableClass} pl-2`}
                        >
                          {t(showFileLabelKey(navigator.platform))}
                        </button>
                      )}
                    </>
                  )}
                  {otherExamples && (
                    <>
                      {(!readOnly || origin) && <div className={menuRuleClass} />}
                      <p className={menuTitleClass}>{t("examples.banner.more")}</p>
                      <ExampleChoices more={otherExamples} close={close} />
                    </>
                  )}
                </>
              )
        }
        aside={
          readOnly
            ? undefined
            : (close) => (
                <div
                  {...style.menuProps}
                  role="menu"
                  aria-label={t("mindStyle.title")}
                  data-testid="page-style-menu"
                  className={`${menuClass} w-[280px] max-w-[280px]`}
                >
                  <MindStyleChoices
                    mindId={mindId}
                    close={close}
                    onOtherFonts={() => {
                      const anchor = button();
                      close();
                      if (anchor)
                        requestAnimationFrame(() =>
                          useMindStylePanel.getState().pickFont(mindId, anchor),
                        );
                    }}
                    onCustomLineSpacing={() => {
                      const anchor = button();
                      close();
                      if (anchor)
                        requestAnimationFrame(() =>
                          useMindStylePanel.getState().typeSpacing(mindId, anchor),
                        );
                    }}
                  />
                </div>
              )
        }
        foot={<MindCounts editor={editor} doc={doc} switchable={!readOnly} />}
      />
      {/* Mounted only while open: closed, it would sit in the page beside the sidebar row's. */}
      {moving && (
        <MoveToPicker
          anchor={moving}
          name={name}
          current={mind?.folderId ?? null}
          onChoose={(folderId) => {
            if (folderId !== mind?.folderId) {
              void moveIntoFolder({ mindIds: [mindId] }, folderId);
            }
          }}
          onCreate={(folderName) =>
            void useAppStore.getState().createFolder({ mindIds: [mindId] }, folderName)
          }
          onClose={() => setMoving(null)}
        />
      )}
    </span>
  );
}
