import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CoreApi, Meeting, MeetingSummary } from "../../src/core/api";
import { createFakeCapture } from "../../src/core/meetings/fakeCapture";
import { nextToRedo, useUndo } from "../../src/renderer/src/undo";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";
import { createTempDataFolder, startCore } from "../helpers/core";

const api = vi.hoisted(() => ({
  eligible: vi.fn<CoreApi["canReviewMeetingSummaryCandidates"]>(),
  read: vi.fn<CoreApi["getMeetingSummaryCandidates"]>(),
  review: vi.fn<CoreApi["reviewMeetingSummaryCandidates"]>(),
  add: vi.fn<CoreApi["addMeetingSummaryCandidate"]>(),
  undo: vi.fn<CoreApi["undoAddMeetingSummaryCandidate"]>(),
  listeners: new Map<string, (payload?: { mindId: string }) => void>(),
  store: { documents: [{ id: "transcript", contentHash: "first" }], minds: [], library: null },
}));
vi.mock("../../src/renderer/src/core", () => ({
  core: {
    canReviewMeetingSummaryCandidates: api.eligible,
    getMeetingSummaryCandidates: api.read,
    reviewMeetingSummaryCandidates: api.review,
    addMeetingSummaryCandidate: api.add,
    undoAddMeetingSummaryCandidate: api.undo,
    on: (event: string, callback: (payload?: { mindId: string }) => void) => {
      api.listeners.set(event, callback);
      return () => api.listeners.delete(event);
    },
  },
}));
vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: (read: (state: typeof api.store) => unknown) => read(api.store),
}));
vi.mock("../../src/renderer/src/transcripts", () => ({ openTranscriptOfNote: vi.fn() }));
vi.mock("../../src/renderer/src/i18n", () => ({
  useT: () => (key: MessageKey, params?: MessageParams) => translate("en", key, params),
}));

let meeting: Meeting;
let root: Root;
let container: HTMLElement;
let Candidates: ComponentType<{ meeting: Meeting; count: number; focusSummary(): void }>;
const candidate = {
  id: 9,
  sources: [{ startMs: 1000, endMs: 2100, text: "Could we measure that?" }],
};
const cached: MeetingSummary = {
  state: "ready",
  throughMs: 2100,
  text: "Meeting ended.",
  candidatesReviewed: true,
  candidateCount: 1,
};
const fresh: MeetingSummary = { state: "ready", throughMs: 2100, text: "Meeting ended." };

beforeEach(async () => {
  const core = startCore(await createTempDataFolder(), { audioCapture: createFakeCapture() });
  try {
    meeting = {
      ...(await core.createMeeting()),
      status: "stopped",
      transcript: {
        documentId: "transcript",
        state: "saved",
        lines: 1,
        partials: [],
        model: null,
        cloud: null,
        fellBack: null,
        savedPath: null,
        separating: false,
        problem: null,
      },
    };
  } finally {
    core.close();
  }
  vi.resetAllMocks();
  const doc = new DOMParser().parseFromString("<html><body></body></html>", "text/html");
  const window = doc.defaultView;
  for (const [name, value] of Object.entries({
    window,
    document: doc,
    Node: window.Node,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    vi.stubGlobal(name, value);
  }
  api.store.documents[0] = { id: "transcript", contentHash: "first" };
  api.eligible.mockResolvedValue(true);
  api.read.mockResolvedValue([candidate]);
  api.review.mockResolvedValue([candidate]);
  api.add.mockResolvedValue({ ...meeting, summary: { ...cached, candidateCount: 0 } });
  api.undo.mockResolvedValue({ ...meeting, summary: cached });
  useUndo.setState({ done: [], undone: [], running: null, aside: [], line: null });
  container = doc.createElement("div", {});
  doc.body.append(container);
  root = createRoot(container);
  const path = "../../src/renderer/src/components/meetings/MeetingSummaryCandidates.tsx";
  ({ MeetingSummaryCandidates: Candidates } = await import(path));
});
afterEach(async () => {
  await act(() => root.unmount());
  api.listeners.clear();
  vi.unstubAllGlobals();
});
const disclosure = () => container.querySelector<HTMLButtonElement>("button[aria-expanded]");
async function show(summary: MeetingSummary) {
  await act(() =>
    root.render(
      createElement(Candidates, {
        meeting: { ...meeting, summary },
        count: summary.candidateCount ?? 0,
        focusSummary: () => {},
      }),
    ),
  );
}
async function click(selector: string) {
  const button = container.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`Expected button: ${selector}`);
  await act(() => button.click());
}

test("the newest access answer controls first-open; cached quotes stay local after a route is revoked", async () => {
  const initial = Promise.withResolvers<boolean>();
  api.eligible.mockReturnValueOnce(initial.promise).mockResolvedValueOnce(false);
  await show(fresh);
  expect(disclosure()).toBeNull();
  await act(() => api.listeners.get("mind.update")?.({ mindId: "other-note" }));
  expect(api.eligible).toHaveBeenCalledTimes(1);
  await act(() => api.listeners.get("mind.update")?.({ mindId: meeting.mindId }));
  await act(() => initial.resolve(true));
  expect(disclosure()).toBeNull();
  expect(api.review).not.toHaveBeenCalled();
  await show(cached);
  await click("button[aria-expanded]");
  expect(container.textContent).toContain(candidate.sources[0]?.text);
  expect(api.read).toHaveBeenCalledExactlyOnceWith(meeting.id);
  expect(api.review).not.toHaveBeenCalled();
});

test("finishing a first review holds the panel open, and changing the transcript closes it until another click", async () => {
  await show(fresh);
  await click("button[aria-expanded]");
  expect(api.review).toHaveBeenCalledTimes(1);
  await show(cached);
  expect(disclosure()?.getAttribute("aria-expanded")).toBe("true");
  api.store.documents[0] = { id: "transcript", contentHash: "edited" };
  await show(fresh);
  expect(disclosure()?.getAttribute("aria-expanded")).toBe("false");
  expect(container.textContent).not.toContain(candidate.sources[0]?.text);
  expect(api.review).toHaveBeenCalledTimes(1);
  await click("button[aria-expanded]");
  expect(api.review).toHaveBeenCalledTimes(2);
});

test.each([true, false])(
  "Redo after taking a quote out of Actions requires that exact quote to be restorable (%s)",
  async (restorable) => {
    await show(cached);
    await click("button[aria-expanded]");
    await click('[data-testid="meeting-summary-add-candidate"]');
    api.read.mockResolvedValue(restorable ? [candidate] : [{ ...candidate, id: 17 }]);
    await act(() => useUndo.getState().undo());
    const redo = nextToRedo(useUndo.getState());
    expect(!!redo).toBe(restorable);
    await act(() => useUndo.getState().redo());
    expect(api.add).toHaveBeenCalledTimes(restorable ? 2 : 1);
    expect(api.review).not.toHaveBeenCalled();
  },
);
