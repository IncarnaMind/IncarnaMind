import type { JSONContent } from "@tiptap/core";
import { create } from "zustand";
import type { MeetingSummaryContent } from "../../core/api";
import type { SummarySaveState } from "../../shared/bridge";
import { readMeetingSummaryContent } from "../../shared/meetingSummaryContent";
import { core, files } from "./core";
import { describeError } from "./errors";

type SaveProblem = "conflict" | "invalid" | "unavailable" | "failed";

interface Draft {
  base: MeetingSummaryContent | null;
  content: JSONContent;
  problem?: SaveProblem;
  saved?: boolean;
}

// A tab may switch between the Note and Transcript while a write is still in flight.
export const useMeetingSummaryDrafts = create<Record<string, Draft | undefined>>(() => ({}));
let watched = false;
function watchClose() {
  if (watched) return;
  watched = true;
  let last: SummarySaveState = "clear";
  useMeetingSummaryDrafts.subscribe((state) => {
    const remaining = Object.values(state).filter((draft) => draft && !draft.saved);
    const next = remaining.some((draft) => !draft?.problem)
      ? "saving"
      : remaining.length
        ? "problem"
        : "clear";
    if (next !== last) {
      last = next;
      files.reportSummarySaveState(next);
    }
  });
  files.onDiscardSummaryDrafts(() => useMeetingSummaryDrafts.setState({}, true));
}
const writing = new Set<string>();
const current = (id: string) => useMeetingSummaryDrafts.getState()[id];

export function discardMeetingSummaryDraft(id: string): void {
  useMeetingSummaryDrafts.setState((state) => {
    const next = { ...state };
    delete next[id];
    return next;
  }, true);
}

async function save(id: string): Promise<void> {
  if (writing.has(id)) return;
  writing.add(id);
  try {
    for (let draft = current(id); draft && !draft.saved && !draft.problem; draft = current(id)) {
      const parsed = readMeetingSummaryContent(draft.content);
      if (!parsed) {
        useMeetingSummaryDrafts.setState({ [id]: { ...draft, problem: "invalid" } });
        return;
      }
      try {
        const result = await core.updateMeetingSummaryContent(id, draft.base, parsed.content);
        const latest = current(id);
        if (!latest) return;
        useMeetingSummaryDrafts.setState({
          [id]: {
            ...latest,
            base: result.summary?.editedContent ?? parsed.content,
            saved: draft === latest,
          },
        });
      } catch (error) {
        const latest = current(id);
        if (!latest) return;
        const key = describeError(error).wording?.key;
        const problem =
          key === "error.meeting.summaryContentChanged"
            ? "conflict"
            : key === "error.meeting.summaryContentUnavailable"
              ? "unavailable"
              : key === "error.meeting.summaryContentInvalid"
                ? "invalid"
                : "failed";
        if (problem === "failed")
          console.warn("Could not save the meeting summary", describeError(error).reason);
        useMeetingSummaryDrafts.setState({ [id]: { ...latest, problem } });
        return;
      }
    }
  } finally {
    writing.delete(id);
  }
}

export function changeMeetingSummaryDraft(
  id: string,
  base: MeetingSummaryContent | null,
  content: JSONContent,
): void {
  watchClose();
  const draft = current(id);
  useMeetingSummaryDrafts.setState({
    [id]: {
      base: draft ? draft.base : base,
      content,
      ...(draft?.problem === "conflict" && { problem: "conflict" }),
    },
  });
  void save(id);
}

export function retryMeetingSummaryDraft(id: string, base: MeetingSummaryContent | null): void {
  const draft = current(id);
  if (!draft) return;
  useMeetingSummaryDrafts.setState({ [id]: { base, content: draft.content } });
  void save(id);
}
