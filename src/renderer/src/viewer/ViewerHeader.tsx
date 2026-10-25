import { createContext, type ReactNode, useContext, useMemo, useRef, useState } from "react";
import type { Document } from "../../../core/api";
import { changedSourceNote, citationState } from "../../../shared/citations";
import { displayName, sourceOf } from "../../../shared/documentNames";
import { useCitationRecheck } from "../citationVersion";
import { CountItLine } from "../components/CountItLine";
import { InlineName } from "../components/InlineName";
import { moveDocumentsBeside } from "../components/library/DocumentMoveTo";
import { DocumentLineIcon, PinLineIcon } from "../components/lineIcons";
import { ObjectMenu, useObjectMenu } from "../components/ObjectMenu";
import { ProblemLine } from "../components/ProblemLine";
import { DocumentTagChips } from "../components/TagChips";
import { files } from "../core";
import { errorMessage } from "../errors";
import { useLeftOutOfEvidence } from "../evidence";
import { useGap, useLanguage, useT } from "../i18n";
import { type Said, saidInLine } from "../lineNames";
import { useAppStore, type ViewerTarget } from "../store";
import { useRename } from "../useRename";
import { pageDate } from "../webPages";
import { OpenExternallyIcon } from "./icons";

/** What every view's toolbar needs from its tab: the Document shown, and whether it is a preview. */
export interface ViewerFrame {
  /** Undefined when its Document was deleted. */
  document: Document | undefined;
  /** The tab is a preview: the toolbar offers to keep it open. */
  preview: boolean;
  keep(): void;
  /** Where the tab was opened, when a Citation opened it: its version and quote. */
  target?: ViewerTarget;
}

export const ViewerFrameContext = createContext<ViewerFrame>({
  document: undefined,
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
}: {
  leading?: ReactNode;
  children?: ReactNode;
  /**
   * False when the Document's file couldn't be read, so there is nothing to
   * open. Nor is there while the Document says its file is missing or out of reach.
   */
  openable?: boolean;
  onRetry?: () => void;
}) {
  const t = useT();
  const language = useLanguage();
  const gap = useGap();
  const { document, preview, keep, target } = useContext(ViewerFrameContext);
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
    cited && target?.quote
      ? {
          documentId: target.documentId,
          contentHash: cited.contentHash ?? null,
          pageFrom: cited.pageFrom ?? target.pageFrom ?? null,
          pageTo: cited.pageTo ?? target.pageTo ?? null,
          quote: target.quote,
        }
      : null,
    changedState,
    document?.contentHash,
  );
  const changed = citedState
    ? changedSourceNote(
        changedState,
        {
          pageFrom: cited?.pageFrom ?? target?.pageFrom ?? null,
          pageTo: cited?.pageTo ?? target?.pageTo ?? null,
          location: cited?.location ?? null,
        },
        recheck,
        t,
      )
    : null;
  /** Why the Document's own app couldn't open it, until it is tried again. */
  const [problem, setProblem] = useState<Said | null>(null);
  const leftOut = useLeftOutOfEvidence(document);
  const objectMenu = useObjectMenu({ kind: "document", id: document?.id ?? "" });
  const rename = useRename<HTMLButtonElement>(`viewer:${document?.id}`);
  const header = useRef<HTMLElement>(null);
  const renameDocument = useAppStore((state) => state.renameDocument);

  // A copy named after the Document opens, as from the sidebar's file menu.
  const openExternally = () => {
    if (!document) return;
    setProblem(null);
    files.openDocumentExternally(document.id).catch((failure: unknown) => {
      setProblem(
        saidInLine(t, (t) =>
          t("viewer.file.openFailed", { name: document.name, reason: errorMessage(failure, t) }),
        ),
      );
    });
  };

  return (
    <>
      <header
        data-testid="viewer-header"
        {...(document ? objectMenu.rowProps : {})}
        ref={header}
        className="viewer-header"
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
              {...rename.nameProps}
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
          {document && <DocumentTagChips document={document} />}
        </div>
        {children}
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
        {document?.web && (
          <span data-testid="viewer-web-fetched" className="viewer-meta">
            {t("webPages.fetched", { date: pageDate(document.web.fetchedAt, language) })}
          </span>
        )}
        {document && (document.web || (openable && document.fileStatus === "available")) && (
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
