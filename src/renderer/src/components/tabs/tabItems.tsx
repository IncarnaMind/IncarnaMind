import { createContext, useContext } from "react";
import type { Meeting, TabItem } from "../../../../core/api";
import { useT } from "../../i18n";
import { isLive, useMeetingOf, useMeetingTime } from "../../meetings";
import { clockTime } from "../../meetingTime";
import { useMindStatus } from "../../mindStatus";
import { useAppStore } from "../../store";
import { tabTitle } from "../../tabs";
import { DocumentLineIcon, HomeLineIcon, LooseDocumentsLineIcon, MindLineIcon } from "../lineIcons";

/** The tab a piece of UI is in, and its group: a Citation in a Mind opens beside that group. */
export interface TabPlace {
  tabId: string;
  groupId: string;
}

export const TabPlaceContext = createContext<TabPlace | null>(null);

/** The tab this is drawn in, if it is in one. */
export const useTabPlace = () => useContext(TabPlaceContext);

export function useTabTitle(item: TabItem): string {
  const t = useT();
  return useAppStore((state) => tabTitle(state, item, t));
}

/** A tab's icon: a Mind's (or what it is busy with), the Library's, or the Document's kind. */
export function TabIcon({ item }: { item: TabItem }) {
  const kind = useAppStore((state) =>
    item.kind === "document"
      ? (state.documents.find((each) => each.id === item.documentId)?.kind ?? "pdf")
      : null,
  );
  if (item.kind === "mind") return <MindIcon mindId={item.mindId} />;
  if (item.kind === "figures") return <DocumentLineIcon kind="csv" />;
  if (item.kind === "library") return <LooseDocumentsLineIcon />;
  if (item.kind === "home") return <HomeLineIcon />;
  return <DocumentLineIcon kind={kind ?? "pdf"} />;
}

function MindIcon({ mindId }: { mindId: string }) {
  const t = useT();
  const status = useMindStatus(mindId);
  const meeting = useMeetingOf(mindId);
  // A Meeting recording: a small red dot (the owner's choice), grey while paused.
  if (isLive(meeting)) {
    return (
      <span
        role="img"
        data-testid="mind-tab-recording"
        data-status={meeting.status}
        aria-label={t(
          meeting.status === "recording" ? "meetings.bar.recording" : "meetings.bar.paused",
        )}
        className="recording-dot"
      />
    );
  }
  if (status === null) return <MindLineIcon />;
  return (
    <span
      role="img"
      data-testid="mind-tab-status"
      data-status={status}
      aria-label={status === "writing" ? t("tabs.writing") : t("approvals.answer.waiting")}
      className="tab-dot"
    />
  );
}

/** A Mind's Meeting time on its tab, ticking while it records; nothing when it has none live. */
export function MeetingTabTime({ mindId }: { mindId: string }) {
  const meeting = useMeetingOf(mindId);
  if (!isLive(meeting)) return null;
  return <LiveMeetingTime meeting={meeting} />;
}

function LiveMeetingTime({ meeting }: { meeting: Meeting }) {
  return (
    <span role="timer" data-testid="mind-tab-time" className="tab-time">
      {clockTime(useMeetingTime(meeting))}
    </span>
  );
}
