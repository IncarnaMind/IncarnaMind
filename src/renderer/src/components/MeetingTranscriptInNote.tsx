import { useLayoutEffect, useMemo, useRef } from "react";
import type { Meeting } from "../../../core/api";
import { useT } from "../i18n";
import { useAppStore, type ViewerTarget } from "../store";
import { TranscriptView } from "../viewer/TranscriptView";
import { type ViewerFrame, ViewerFrameContext, ViewerHeader } from "../viewer/ViewerHeader";
import { ViewerMessage } from "../viewer/ViewerMessage";

export function MeetingTranscriptInNote({ meeting, tabId }: { meeting: Meeting; tabId: string }) {
  const t = useT();
  const region = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    region.current?.focus();
  }, []);
  const documentId = meeting.transcript?.documentId;
  const document = useAppStore((state) => state.documents.find((each) => each.id === documentId));
  const target = useMemo<ViewerTarget>(
    () => ({ documentId: documentId ?? "", request: 0 }),
    [documentId],
  );
  const frame = useMemo<ViewerFrame>(
    () => ({ document, tabId, target, embedded: true, preview: false, keep: () => undefined }),
    [document, tabId, target],
  );
  return (
    <section
      ref={region}
      data-testid="meeting-note-transcript"
      data-document-id={documentId}
      aria-label={t("meetings.views.transcript")}
      tabIndex={-1}
      className="viewer-pane flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-sheet pt-14"
    >
      <ViewerFrameContext.Provider value={frame}>
        {document ? (
          <TranscriptView key={document.id} document={document} target={target} />
        ) : (
          <>
            <ViewerHeader />
            <ViewerMessage>{t("viewer.loading")}</ViewerMessage>
          </>
        )}
      </ViewerFrameContext.Provider>
    </section>
  );
}
