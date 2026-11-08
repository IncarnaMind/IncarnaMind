import { useEffect, useState } from "react";
import type { Meeting } from "../../../core/api";
import { core } from "../core";
import { useT } from "../i18n";
import { useMeetingOffers } from "../meetingOffers";
import { useMeetings } from "../meetings";
import { useAppStore } from "../store";
import { ProblemLine } from "./ProblemLine";

/**
 * The call this Meeting was taken from ended (#208): "Did your meeting end? Stopping in 30
 * seconds", counting down, with Stop now and Keep recording. Left alone, the core stops it.
 */
export function CallEndingLine({ meeting }: { meeting: Meeting }) {
  const t = useT();
  const ending = useMeetingOffers((state) =>
    state.offers.ending?.meetingId === meeting.id ? state.offers.ending : null,
  );
  const stopsAt = ending ? Date.parse(ending.stopsAt) : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (stopsAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [stopsAt]);
  if (stopsAt === null) return null;
  const seconds = Math.max(0, Math.ceil((stopsAt - now) / 1000));
  return (
    <ProblemLine
      testId="meeting-line-call-ended"
      role="status"
      className="meeting-line"
      action={{
        label: t("offers.end.stopNow"),
        testId: "meeting-line-stop-now",
        onClick: () => void useMeetings.getState().stop(meeting.id),
      }}
      also={{
        label: t("offers.end.keep"),
        testId: "meeting-line-keep-recording",
        onClick: () =>
          void core.keepRecordingAfterCall(meeting.id).catch(useAppStore.getState().reportError),
      }}
    >
      {t("offers.end.line", { seconds })}
    </ProblemLine>
  );
}
