import { useLayoutEffect, useRef } from "react";
import { useAgentsToAskRead, useNoModel, useReadAgentsToAsk } from "../../askYourAi";
import { useExports } from "../../exports";
import { useHomeView, useMindNoteStates, useOwnMinds } from "../../home";
import { useMinuteClock } from "../../minuteClock";
import { rowsIn, useSelectionOrder } from "../../selection";
import { useAppStore } from "../../store";
import { useHomeNextStep } from "../../useHomeNextStep";
import { CallOffersTip } from "./CallOffersTip";
import { ComingUp } from "./ComingUp";
import { FolderCards } from "./FolderCards";
import { HomeAsk, HomeFootConnect } from "./HomeAsk";
import { HomeHeader } from "./HomeHeader";
import { HomeNextStep } from "./HomeNextStep";
import { MeetingOfferLine } from "./MeetingOfferLine";
import { RecentMinds } from "./RecentMinds";

export function HomePane() {
  const now = useMinuteClock();
  const minds = useOwnMinds();
  const notes = useMindNoteStates(minds);
  const exported = useAppStore((state) => state.settings?.device.gettingStarted.exported ?? false);
  const result = useExports((state) => state.result);
  const saved =
    result?.state === "saved" &&
    result.format === "docx" &&
    minds.some((mind) => mind.id === result.mindId)
      ? { mindId: result.mindId, path: result.path, at: result.at }
      : null;
  const next = useHomeNextStep(minds, notes, exported, saved);
  useReadAgentsToAsk(null);
  const agents = useAgentsToAskRead(null);
  const noModel = useNoModel();
  const asksHere = (agents?.length ?? 0) > 0 || noModel;
  // Nothing of their own yet: Home's next step is adding files, or asking about them (#3767).
  const starting = next?.kind === "add" || next?.kind === "ask";
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = useHomeView.getState().scrollTop;
  }, []);
  // ⌘A takes the list the focus is in: Recent or the Folders.
  useSelectionOrder("home", () => {
    const list = document.activeElement?.closest("[aria-multiselectable]");
    return rowsIn(list && scroller.current?.contains(list) ? list : scroller.current);
  });
  return (
    <section
      data-testid="home"
      data-surface="home"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-sheet text-ui text-ink"
    >
      <div
        ref={scroller}
        data-testid="home-scroller"
        onScroll={(event) => useHomeView.setState({ scrollTop: event.currentTarget.scrollTop })}
        className="@container/home min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto w-full max-w-[760px] px-6 pt-10 pb-24 @max-[760px]/home:px-4 @max-[760px]/home:pt-8">
          <HomeHeader now={now} />
          <HomeAsk starting={starting} empty={next?.kind === "add"} />
          {/* Adding files is the buttons above, and asking is their input or its line, unless a
              model in IncarnaMind is the way to ask (#3791). */}
          {next && next.kind !== "add" && !(next.kind === "ask" && asksHere) && (
            <div className="mb-6 text-ui leading-5">
              <HomeNextStep step={next} />
            </div>
          )}
          <MeetingOfferLine />
          <CallOffersTip />
          <ComingUp now={now} />
          <RecentMinds now={now} states={notes} />
          <FolderCards now={now} />
        </div>
      </div>
      {!starting && <HomeFootConnect />}
    </section>
  );
}
