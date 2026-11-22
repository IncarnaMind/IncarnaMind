import { act, type ComponentType, createElement } from "react";
import { expect, test, vi } from "vitest";
import type { Meeting, MeetingSummaryItem } from "../../src/core/api";
import { stubEditorDom } from "../helpers/editorDom";

const startedAt = "2026-11-20T12:00:00Z";
const stoppedAt = "2026-11-20T12:01:00Z";
const meeting: Meeting = {
  id: "meeting",
  mindId: "note",
  kind: "meeting",
  status: "stopped",
  pausedBy: null,
  systemAudio: false,
  sources: { system: "off", microphone: "off" },
  recordedMs: 60_000,
  recordingSince: null,
  gaps: [],
  startedAt,
  stoppedAt,
  audio: { kept: false, expiresAt: null, deletedAt: null, keptUntilDeleted: false },
  saveError: null,
  transcript: null,
  health: { realTimeFactor: null, measuredMs: 0, keepsUp: null, events: [] },
  microphonePausedAtMs: null,
  help: null,
  helps: [],
  helpTemplate: null,
  fill: null,
  createdAt: startedAt,
  updatedAt: stoppedAt,
};

test("an item disappearing during refresh keeps the draft available to copy or cancel", async () => {
  const save = vi.fn();
  stubEditorDom();
  Object.assign(document, { oninput: null });
  Object.assign(window, {
    incarnamind: {
      on: () => () => undefined,
      listApprovalRequests: async () => [],
      listUserQuestions: async () => [],
      correctMeetingSummaryItem: save,
    },
    incarnamindFiles: {},
  });
  vi.stubGlobal("localStorage", { getItem: () => null });
  vi.stubGlobal("navigator", { platform: "Linux", languages: ["en"], userAgent: "node" });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const path = "../../src/renderer/src/components/meetings/MeetingSummary.tsx";
  const { MeetingSummary } = (await import(path)) as {
    MeetingSummary: ComponentType<{ meeting: Meeting }>;
  };
  const row: MeetingSummaryItem = {
    id: 1,
    kind: "action",
    status: "active",
    text: "Dana will call the supplier.",
  };
  const draftText = "I’ll call the supplier on Tuesday.";
  const show = (items: MeetingSummaryItem[]) =>
    act(() =>
      root.render(
        createElement(MeetingSummary, {
          meeting: {
            ...meeting,
            summary: {
              text: "We discussed the supplier.",
              throughMs: 60_000,
              state: "ready",
              items,
            },
          },
        }),
      ),
    );
  const find = <ElementType extends HTMLElement>(id: string) =>
    container.querySelector<ElementType>(`[data-testid="meeting-summary-item-${id}"]`);

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await show([row]);
    container.querySelector("details")?.setAttribute("open", "");
    await act(() => find("edit")?.click());
    const text = container.querySelector("textarea");
    expect(text?.value).toBe(row.text);
    await act(() => {
      if (!text) throw new Error("Expected the draft editor.");
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set?.call(
        text,
        draftText,
      );
      text.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    expect(find<HTMLButtonElement>("save")?.disabled).toBe(false);

    await show([]);
    expect(find("problem")?.textContent).toContain("This item is no longer in the summary.");
    expect(container.querySelector("details")?.hasAttribute("open")).toBe(true);
    expect(container.querySelector("textarea")?.value).toBe(draftText);
    expect(container.querySelector("textarea")?.hasAttribute("readonly")).toBe(false);
    expect(find<HTMLButtonElement>("save")?.disabled).toBe(true);

    await show([{ ...row, kind: "decision", text: "Wait for the supplier’s quote." }]);
    expect(container.querySelector("textarea")?.value).toBe(draftText);
    expect(find("problem")?.textContent).toContain("This item changed while you were editing.");
    expect(find<HTMLButtonElement>("save")?.disabled).toBe(true);

    await show([]);
    await act(() => find("cancel")?.click());
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("details")).toBeNull();
    expect(save).not.toHaveBeenCalled();
  } finally {
    try {
      await act(() => root.unmount());
      // Tiptap destroys the unmounted editor on the next timer, while its DOM still exists.
      await vi.runOnlyPendingTimersAsync();
    } finally {
      vi.useRealTimers();
      container.remove();
      vi.unstubAllGlobals();
    }
  }
});
