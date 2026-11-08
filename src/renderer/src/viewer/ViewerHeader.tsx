import { isMacOS } from "@tiptap/core";
import { createContext, type ReactNode, useContext, useMemo, useRef } from "react";
import type { Document } from "../../../core/api";
import { changedSourceLines, citationState } from "../../../shared/citations";
import { displayName, sourceOf } from "../../../shared/documentNames";
import { useAnnotations } from "../annotations";
import { useCitationRecheck } from "../citationVersion";
import { CountItLine } from "../components/CountItLine";
import { YourNoteLabel } from "../components/DocumentsSection";
import { InlineName } from "../components/InlineName";
import { moveDocumentsBeside } from "../components/library/DocumentMoveTo";
import { DocumentLineIcon, NoteLineIcon, PinLineIcon } from "../components/lineIcons";
import { ObjectMenu, useObjectMenu } from "../components/ObjectMenu";
import { ProblemLine } from "../components/ProblemLine";
import { DocumentTagChips } from "../components/TagChips";
import { useLeftOutOfEvidence } from "../evidence";
import { useGap, useLanguage, useT } from "../i18n";
import { isListedDocument } from "../meetingTranscript";
import { useAppStore, type ViewerTarget } from "../store";
import { useRename } from "../useRename";
import { pageDate } from "../webPages";
import { AreaModeContext } from "./areaSelection";
import { AreaIcon, OpenExternallyIcon } from "./icons";
import { canOpenExternally, useOpenExternally } from "./openExternally";

/** What every view's toolbar needs from its tab: the Document shown, and whether it is a preview. */
export interface ViewerFrame {
  /** Undefined when its Document was deleted. */
  document: Document | undefined;
  /** The tab it is drawn in. */
  tabId: string;
  /** The tab is a preview: the toolbar offers to keep it open. */
  preview: boolean;
  embedded?: boolean;
  keep(): void;
  /** Where the tab was opened, when a Citation opened it: its version and quote. */
  target?: ViewerTarget;
}

export const ViewerFrameContext = createContext<ViewerFrame>({
  document: undefined,
  tabId: "",
  preview: false,
  keep: () => undefined,
});

/** A thin vertical rule between groups of the header's controls. */
export function HeaderDivider() {
  return <span aria-hidden="true" className="viewer-divider" />;
}

/**
 * A Document tab's 36px toolbar, under its group's tab strip: the outline
 * toggle (`leading`), the Document's kind and name, its Tags, the view's own
 * controls (`children`: where it is, page navigation and zoom for a PDF),
 * then Keep open for a preview, and "Open in default app" (for a web page,
 * when it was fetched and "Open the live page"). Under it, for a file
 * IncarnaMind wrote, that checks don't count it as evidence, with Count it (#80).
 */
export function ViewerHeader({
  leading,
  children,
  openable = true,
  onRetry,
  showingCited = false,
}: {
  leading?: ReactNode;
  children?: ReactNode;
  /**
   * False when the Document's file couldn't be read, so there is nothing to
   * open. Nor is there while the Document says its file is missing or out of reach.
   */
  openable?: boolean;
  onRetry?: () => void;
  /**
   * The view shows the version a Citation was made from (#2159): the header
   * says nothing of the Document's newer version, which that view's own bar
   * does, and a saved page's date is the cited version's.
   */
  showingCited?: boolean;
}) {
  const t = useT();
  const language = useLanguage();
  const gap = useGap();
  const { document, tabId, preview, keep, target, embedded } = useContext(ViewerFrameContext);
  const documents = useAppStore((state) =>
    state.status.kind === "ready" ? state.documents : null,
  );
  const cited = target?.citation ?? null;
  const citedState = useMemo(
    () =>
      cited && target
        ? citationState(
            {
              documentId: target.documentId,
              contentHash: cited.contentHash ?? null,
              check: cited.check,
              pageFrom: cited.pageFrom ?? target.pageFrom ?? null,
              pageTo: cited.pageTo ?? target.pageTo ?? null,
            },
            documents,
          )
        : null,
    [cited, target, documents],
  );
  const changedState = citedState?.changedAfterCited ?? false;
  const recheck = useCitationRecheck(
    // The cited version's own view says how it stands, not the newer one's.
    !showingCited && cited && target?.quote
      ? {
          documentId: target.documentId,
          contentHash: cited.contentHash ?? null,
          pageFrom: cited.pageFrom ?? target.pageFrom ?? null,
          pageTo: cited.pageTo ?? target.pageTo ?? null,
          quote: target.quote,
          location: cited.location,
        }
      : null,
    changedState,
    document?.contentHash,
    // The Document's own viewer is browsing, which a Folder wall leaves open (#1934).
    null,
  );
  const changed =
    !showingCited && citedState
      ? changedSourceLines(
          changedState,
          {
            pageFrom: cited?.pageFrom ?? target?.pageFrom ?? null,
            pageTo: cited?.pageTo ?? target?.pageTo ?? null,
            location: cited?.location ?? null,
          },
          recheck,
          document,
          language,
          t,
        ).note
      : null;
  // A saved page's date is the shown version's: the cited one while it is shown (#2159).
  const fetchedAt =
    showingCited && document?.web
      ? (document.web.versions.find((each) => each.contentHash === cited?.contentHash)?.fetchedAt ??
        document.web.fetchedAt)
      : (document?.web?.fetchedAt ?? null);
  const { open: openExternally, problem } = useOpenExternally(document);
  const leftOut = useLeftOutOfEvidence(document);
  const objectMenu = useObjectMenu({ kind: "document", id: document?.id ?? "" });
  const panelOpen = useAnnotations((state) => state.panelOpen[tabId] === true);
  const room = useAnnotations((state) => state.room[tabId] ?? true);
  const listInPlace = useAnnotations((state) => state.listInPlace[tabId] === true);
  const togglePanel = useAnnotations((state) => state.togglePanel);
  const areaMode = useContext(AreaModeContext);
  const rename = useRename<HTMLButtonElement>(`viewer:${document?.id}`);
  const header = useRef<HTMLElement>(null);
  const renameDocument = useAppStore((state) => state.renameDocument);

  if (embedded) {
    return children ? (
      <header
        data-testid="viewer-embedded-header"
        className="flex min-h-7 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1 text-[12px] leading-5 text-ink-meta [&_.viewer-meta]:not-sr-only"
      >
        {children}
      </header>
    ) : null;
  }

  return (
    <>
      <header
        data-testid="viewer-header"
        {...(document ? objectMenu.rowProps : {})}
        ref={header}
        className={`viewer-header${areaMode ? " viewer-header--area" : ""}${
          listInPlace ? " viewer-header--list-only" : ""
        }`}
      >
        {leading}
        {document && (
          <DocumentLineIcon
            kind={document.kind}
            className={`viewer-kind ${leading ? "ml-1" : "ml-1.5"}`}
          />
        )}
        <div className="viewer-name-area">
          {document && rename.renaming ? (
            <span className="ml-1 min-w-16 max-w-md flex-1">
              <InlineName
                value={document.name}
                label={t("documents.renameLabel", { name: document.name })}
                testId="viewer-title-rename"
                {...rename.field((name) => renameDocument(document.id, name))}
              />
            </span>
          ) : document ? (
            <button
              {...(isListedDocument(document) && rename.nameProps)}
              type="button"
              // Out of the toolbar's tab order: a click focuses it for F2, and its menu has Rename.
              tabIndex={-1}
              data-testid="viewer-title"
              title={
                displayName(document) === sourceOf(document)
                  ? displayName(document)
                  : `${displayName(document)}
${sourceOf(document)}`
              }
              className="viewer-title cursor-default text-left"
            >
              {displayName(document)}
            </button>
          ) : null}
          {document && <YourNoteLabel item={document} />}
          {document && isListedDocument(document) && <DocumentTagChips document={document} />}
        </div>
        <div className="contents" inert={listInPlace}>
          {children}
        </div>
        {areaMode && (
          <button
            type="button"
            data-testid="viewer-area-select"
            aria-pressed={areaMode.active}
            aria-label={areaMode.active ? t("viewer.area.selected") : t("viewer.area.select")}
            title={
              areaMode.active
                ? areaMode.purpose === "highlight"
                  ? t("viewer.area.highlightTip")
                  : t("viewer.area.activeTip")
                : t("viewer.area.selectTip", { key: isMacOS() ? "⌥" : "Alt" })
            }
            onClick={() => areaMode.setActive(!areaMode.active)}
            className="viewer-icon-button"
          >
            <AreaIcon className="size-4" />
          </button>
        )}
        {preview && (
          <button
            type="button"
            data-testid="viewer-keep"
            title={t("viewer.keepTip")}
            onClick={keep}
            className="viewer-keep"
          >
            <PinLineIcon className="size-[13px]" />
            <span>{t("viewer.keep")}</span>
          </button>
        )}
        {fetchedAt && (
          <span data-testid="viewer-web-fetched" className="viewer-meta">
            {t("webPages.fetched", { date: pageDate(fetchedAt, language) })}
          </span>
        )}
        {document && canOpenExternally(document, openable) && (
          <button
            type="button"
            data-testid="viewer-open-externally"
            aria-label={t(document.web ? "webPages.openLive" : "documents.copy.open")}
            title={document.web ? document.web.address : t("documents.copy.open")}
            onClick={openExternally}
            className="viewer-icon-button"
          >
            <OpenExternallyIcon className="size-4" />
          </button>
        )}
        {document && (
          <button
            type="button"
            data-testid="viewer-annotations-toggle"
            aria-pressed={panelOpen}
            aria-label={t("annotations.open")}
            title={
              !room && !panelOpen
                ? t("annotations.needsRoom")
                : t(panelOpen ? "annotations.close" : "annotations.open")
            }
            disabled={!room && !panelOpen}
            onClick={() => togglePanel(!panelOpen, tabId)}
            className="viewer-icon-button viewer-annotations-toggle"
          >
            <NoteLineIcon className="size-4" />
          </button>
        )}
        {document && (
          <ObjectMenu
            target={{ kind: "document", id: document.id }}
            label={t("documents.more", { name: displayName(document) })}
            here={{
              ...(onRetry && { "document.retry": onRetry }),
              "document.rename": rename.start,
              "document.moveTo": () => moveDocumentsBeside(header.current, [document.id]),
            }}
            className="viewer-icon-button"
          />
        )}
      </header>
      {problem && (
        <ProblemLine
          testId="viewer-open-problem"
          title={problem.fullMessage}
          className="shrink-0 px-4 py-2"
        >
          {problem.message}
        </ProblemLine>
      )}
      {changed && (
        <ProblemLine role="status" testId="viewer-citation-changed" className="shrink-0 px-4 py-2">
          {changed.notice}
          {changed.quote && `${gap(changed.notice, changed.quote)}${changed.quote}`}
        </ProblemLine>
      )}
      {document && leftOut && (
        <CountItLine document={document} testId="viewer-own-file" className="shrink-0 px-4 py-2">
          {t("evidence.ownFile")}
        </CountItLine>
      )}
    </>
  );
}
