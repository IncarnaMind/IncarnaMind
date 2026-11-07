import { useEffect, useMemo, useRef } from "react";
import type { Meeting } from "../../../core/api";
import { useT } from "../i18n";
import { isLive } from "../meetings";
import { focusTaken, useMeetingViewFocus } from "../meetingViews";
import { useAppStore, type ViewerTarget } from "../store";
import { openTranscriptBeside } from "../transcripts";
import { MeetingTranscriptView } from "../viewer/TranscriptView";
import { type ViewerFrame, ViewerFrameContext } from "../viewer/ViewerHeader";
import { OpenBesideLineIcon } from "./lineIcons";
import { LiveMeetingBar } from "./MeetingInMind";
import { useTabPlace } from "./tabs/tabItems";

/**
 * The meeting's Transcript in its Note's page (#138): while the call records, under the
 * recording bar, from the first word said; after it, the saved Transcript. "Open beside" opens it
 * as a tab in the next group instead.
 */
export function MeetingTranscriptInNote({ meeting, tabId }: { meeting: Meeting; tabId: string }) {
  const t = useT();
  const region = useRef<HTMLElement>(null);
  const focusAsked = useMeetingViewFocus(tabId, "transcript");
  useEffect(() => {
    if (focusAsked === null) return;
    region.current?.focus();
    focusTaken(focusAsked);
  }, [focusAsked]);
  const groupId = useTabPlace()?.groupId;
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
  const live = isLive(meeting);
  const beside = (
    <button
      type="button"
      data-testid="meeting-transcript-beside"
      disabled={!documentId}
      title={t(documentId ? "meetings.views.besideCommand" : "meetings.bar.transcriptSoon")}
      onClick={() => openTranscriptBeside({ meeting, tabId, groupId })}
      className="meeting-beside"
    >
      <OpenBesideLineIcon className="size-3.5" />
      {t("command.openBeside")}
    </button>
  );
  return (
    <section
      ref={region}
      data-testid="meeting-note-transcript"
      data-document-id={documentId ?? undefined}
      aria-label={t("meetings.views.transcript")}
      tabIndex={-1}
      className={`viewer-pane meeting-note-transcript flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-sheet ${live ? "" : "pt-14"}`}
    >
      {live && (
        <div className="mind-column meeting-note-transcript-top">
          <div className="mind-measure">
            <LiveMeetingBar meeting={meeting} />
          </div>
        </div>
      )}
      <ViewerFrameContext.Provider value={frame}>
        <MeetingTranscriptView
          key={meeting.id}
          meeting={meeting}
          document={document}
          target={target}
          aside={beside}
        />
      </ViewerFrameContext.Provider>
    </section>
  );
}
