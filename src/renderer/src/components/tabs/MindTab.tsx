import { useContext, useEffect, useId, useRef, useState } from "react";
import { isWordFile, isWordType } from "../../../../shared/wordFileTypes";
import { files } from "../../core";
import { useDropTarget } from "../../dragDrop";
import {
  CompareSheetSlotContext,
  ComposerDockContext,
  PageSlotsContext,
  type ReviewShown,
} from "../../editor/mindContext";
import { useT } from "../../i18n";
import { assistantTabOf } from "../../layoutSlice";
import { useMeetingOf } from "../../meetings";
import { hasMeetingViews, useMeetingNoteView } from "../../meetingViews";
import { useWritingProperties } from "../../mindStyles";
import { useQuietAssistant } from "../../quietAssistant";
import { useReviewPanes, useRoomBeside } from "../../reviewPane";
import { useAppStore } from "../../store";
import { undoBandFor, useUndoPillBands } from "../../undoPill";
import { useGroupsMerged } from "../../useWindowWidth";
import { useWordImport } from "../../wordImport";
import { ExportResultLine } from "../ExportResultLine";
import { ExampleIntro } from "../FirstOpenSteps";
import { useIsExample } from "../GettingStarted";
import { PlusLineIcon } from "../lineIcons";
import { MakeSkillCard } from "../MakeSkillCard";
import { MeetingInMind } from "../MeetingInMind";
import { MeetingTranscriptInNote } from "../MeetingTranscriptInNote";
import { MeetingViewChip } from "../MeetingViewChip";
import { MindEditor } from "../MindEditor";
import { ChatReadinessNotice } from "../providers/ChatReadinessNotice";
import { dropIntoClass } from "../sidebarRows";
import { buttonStyle } from "../ui";
import { useTabPlace } from "./tabItems";

/**
 * A Mind's tab: its page, which holds only its text (#908), with the ⋯
 * button at its top right and the count while writing and the check badge at
 * its foot. When it is the Mind the assistant reads, its composer is drawn in
 * the assistant (#253).
 */
export function MindTab({ mindId }: { mindId: string }) {
  const mind = useAppStore((state) => state.minds.find((each) => each.id === mindId));
  const isExample = useIsExample(mindId);
  const [top, setTop] = useState<HTMLElement | null>(null);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [count, setCount] = useState<HTMLElement | null>(null);
  const [badge, setBadge] = useState<HTMLElement | null>(null);
  const [sheetSlot, setSheetSlot] = useState<HTMLElement | null>(null);
  const assistantSlot = useContext(ComposerDockContext);
  const place = useTabPlace();
  const tabId = place?.tabId;
  const meeting = useMeetingOf(mindId);
  const view = useMeetingNoteView(tabId, mindId);
  const hasViews = hasMeetingViews(meeting);
  const transcriptShown = hasViews && !!tabId && view === "transcript";
  const band = useUndoPillBands((state) => undoBandFor(state.bands, place?.groupId));
  const merged = useGroupsMerged();
  const read = useAppStore((state) => assistantTabOf(state.layout, merged)?.id === tabId);
  const wordDrop = useWordFileDrop();
  const writing = useWritingProperties(mindId);
  const pill = useQuietAssistant();
  // The Ask pill stands at the middle of all the groups, where a group's foot may be (#2527 walk).
  const besidePill = useAppStore(
    (state) => pill && !merged && (state.layout?.groups.length ?? 0) > 1,
  );
  const review = useReviewShown(mindId);
  const reviewShown = transcriptShown ? "closed" : review.shown;
  if (!mind) return null;

  return (
    <div className="relative flex min-h-0 flex-grow flex-col">
      <div
        ref={review.setRow}
        data-review={reviewShown}
        className="mind-tab-row relative flex min-h-0 flex-grow"
      >
        <div className="mind-tab-page relative flex min-h-0 min-w-0 flex-grow flex-col">
          {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target, in the capture phase because the note's own handlers accept every drag over the text; "Import a Word file…" does it without dragging. */}
          <div
            data-testid="mind-scroller"
            data-drop-target={wordDrop.over ? "true" : undefined}
            onDragEnterCapture={wordDrop.props.onDragEnter}
            onDragOverCapture={wordDrop.props.onDragOver}
            onDragLeave={wordDrop.props.onDragLeave}
            onDropCapture={wordDrop.props.onDrop}
            style={{
              ...(band > 0 && { marginBottom: band }),
              // Hidden in place, not taken out of the layout: the notes keep their scroll and
              // their cursor for when the User comes back to them (#138).
              ...(transcriptShown && { visibility: "hidden", position: "absolute", inset: 0 }),
            }}
            className={`mind-scroller min-h-0 flex-grow overflow-auto ${wordDrop.over ? `rounded-lg ${dropIntoClass}` : ""}`}
          >
            {/* Every text in it starts at one edge (styles.css, `.mind-column`). */}
            <article
              data-testid="mind-pane"
              data-mind-id={mind.id}
              className="mind-column"
              style={writing}
            >
              <div className="mind-measure">
                {isExample && <ExampleIntro mindId={mindId} />}
                <div ref={setTop} data-testid="mind-top-slot" />
                <MeetingInMind mindId={mind.id} />
                {/* The example works without a chat model: it says so in its Answer instead. */}
                {!isExample && <ChatReadinessNotice />}
                <ComposerDockContext.Provider value={read ? assistantSlot : null}>
                  <PageSlotsContext.Provider
                    value={{
                      top,
                      menu,
                      count,
                      badge,
                      review: review.slot,
                      reviewShown,
                    }}
                  >
                    <CompareSheetSlotContext.Provider value={sheetSlot}>
                      <MindEditor mindId={mind.id} />
                    </CompareSheetSlotContext.Provider>
                  </PageSlotsContext.Provider>
                </ComposerDockContext.Provider>
                <MakeSkillCard mindId={mind.id} />
              </div>
            </article>
            {pill && (
              <div aria-hidden="true" data-testid="ask-pill-fade" className="ask-pill-fade" />
            )}
          </div>
          {transcriptShown && <MeetingTranscriptInNote meeting={meeting} tabId={tabId} />}
          <div className="mind-menu-slot">
            {hasViews && tabId && meeting.status === "stopped" && (
              <MeetingViewChip meeting={meeting} tabId={tabId} />
            )}
            <div ref={setMenu} className="flex items-center gap-1" />
          </div>
          <div
            className={`mind-foot-slot ${besidePill ? "mind-foot-slot--over-pill" : ""}`}
            style={transcriptShown ? { display: "none" } : undefined}
          >
            <div ref={setCount} className="mind-foot-count" />
            <div ref={setBadge} className="mind-foot-badge" />
          </div>
        </div>
        <div ref={review.setSlot} data-shown={reviewShown} className="review-slot" />
      </div>
      {/* The Compare Documents sheet docks here, in the column's measure, below the note. */}
      <div
        ref={setSheetSlot}
        className="compare-sheet-dock"
        style={transcriptShown ? { display: "none" } : undefined}
      />
      <div className="contents" style={transcriptShown ? { display: "none" } : undefined}>
        <ExportResultLine mindId={mind.id} />
      </div>
    </div>
  );
}

function useReviewShown(mindId: string) {
  const [row, setRow] = useState<HTMLElement | null>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const beside = useRoomBeside(row);
  const pane = useReviewPanes((state) => state.panes[mindId]);
  const wasBeside = useRef(beside);
  useEffect(() => {
    if (wasBeside.current && !beside) useReviewPanes.getState().update(mindId, { over: false });
    wasBeside.current = beside;
  }, [beside, mindId]);
  const shown: ReviewShown = !pane ? "closed" : beside ? "beside" : pane.over ? "over" : "folded";
  return { setRow, setSlot, slot, shown };
}

// A Word file dropped on a Mind, alone, opens the import screen (#104), which also offers to add it
// as a Document. Only its type is known before the drop, and a file with no path on this computer
// is added as the window would.
function useWordFileDrop() {
  return useDropTarget(`mind-word:${useId()}`, {
    accepts(dragged) {
      if (dragged.kind !== "files") return null;
      const count = dragged.names?.length ?? dragged.types.length;
      const [name] = dragged.names ?? [];
      const word = name !== undefined ? isWordFile(name) : isWordType(dragged.types[0] ?? "");
      return count === 1 && word ? { kind: "import", said: (t) => t("drop.importWord") } : null;
    },
    drop(dropped) {
      const [file] = dropped.kind === "files" ? dropped.files : [];
      if (!file) return;
      const path = files.pathForFile(file);
      if (path) void useWordImport.getState().open(path, true);
      else void useAppStore.getState().addDropped([file], []);
    },
  });
}

/** A window with no tab open: a way to start a Mind. */
export function NoTabOpen() {
  const t = useT();
  const createMind = useAppStore((state) => state.createMind);
  return (
    <div
      data-testid="mind-none-open"
      className="flex h-full flex-col items-center justify-center gap-2 px-10 pb-11 text-center"
    >
      <h1 className="font-sans text-heading font-semibold text-ink">{t("mind.noneOpen.title")}</h1>
      <p className="max-w-sm text-ui text-ink-secondary">{t("mind.noneOpen.body")}</p>
      <button
        type="button"
        onClick={() => void createMind({ titled: true })}
        className={`mt-3 ${buttonStyle("primary")}`}
      >
        <PlusLineIcon className="size-4" />
        {t("sidebar.newMind")}
      </button>
    </div>
  );
}
