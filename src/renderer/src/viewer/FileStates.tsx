import type { ReactNode } from "react";
import type { Document } from "../../../core/api";
import { DocumentFix } from "../components/DocumentFix";
import { useT } from "../i18n";
import { useCitedAreaFailure } from "./citedArea";
import type { LoadedFile } from "./useDocumentFile";
import { ViewerHeader } from "./ViewerHeader";
import { FileGone, OpeningDocument, ViewerMessage } from "./ViewerMessage";

/**
 * A view while its file isn't ready to show: loading, gone (the quote is
 * still shown), or failed. `ready` draws it once it is. `lines`: what the
 * view still has to say whatever the file's state, under its header.
 */
export function FileStates<T>({
  document,
  loaded,
  quote,
  ready,
  reload,
  lines,
}: {
  document: Document;
  loaded: LoadedFile<T>;
  quote: string | undefined;
  ready(value: T): ReactNode;
  /** Reads the file again, for the fix's Retry: the bytes may not have changed. */
  reload?: () => void;
  lines?: ReactNode;
}) {
  const t = useT();
  useCitedAreaFailure(
    loaded.kind === "failed"
      ? loaded.message || loaded.kind
      : loaded.kind === "missing" || loaded.kind === "too-large"
        ? loaded.kind
        : null,
  );
  switch (loaded.kind) {
    case "loading":
      return (
        <>
          <ViewerHeader />
          {lines}
          <OpeningDocument retry={reload} />
        </>
      );
    case "missing":
      return (
        <>
          <ViewerHeader openable={false} />
          {lines}
          <FileGone quote={quote} />
        </>
      );
    case "too-large":
      return (
        <>
          <ViewerHeader />
          {lines}
          <DocumentFix
            document={document}
            view
            message=""
            reload={reload}
            fallback={
              <ViewerMessage tone="error">
                {t("documents.status.failed", { reason: t("documents.failure.tooLarge") })}
              </ViewerMessage>
            }
          />
        </>
      );
    case "failed":
      return (
        <>
          <ViewerHeader />
          {lines}
          <DocumentFix
            document={document}
            view
            message={loaded.message}
            reload={reload}
            fallback={
              <ViewerMessage tone="error">
                {loaded.message
                  ? t("viewer.failed", { message: loaded.message })
                  : t("viewer.notText")}
              </ViewerMessage>
            }
          />
        </>
      );
    case "ready":
      return <>{ready(loaded.value)}</>;
  }
}
