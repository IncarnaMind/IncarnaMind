import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Settings } from "../../src/core/api";
import { translate } from "../../src/shared/i18n";

/*
 * A joined meeting's line in the sidebar (#2579), rendered by the sidebar's own status row: its
 * Undo shows at once that it is working while Core puts the pair back, takes no second press,
 * then gives way to the line that says it worked; refused, the line and its Undo come back as
 * they were.
 */

const JOIN = { id: "join-1", mindId: "mind-1", folderId: "folder-1", noteMoved: true };
const MEETING = "Weekly tide review";

/** Core's answer to the Undo the test is waiting on. */
let settle: { resolve(): void; reject(error: Error): void } | null = null;
const undoCalls: string[] = [];

let root: Root | null = null;
let container: HTMLElement;
let SidebarStatus: ComponentType<{ problemsOnly?: boolean }>;
let useAppStore: typeof import("../../src/renderer/src/store").useAppStore;
let useJoinedMeetings: typeof import("../../src/renderer/src/joinedMeetings").useJoinedMeetings;

beforeEach(async () => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  const window = document.defaultView;
  const bridge = new Proxy(
    {
      on: () => () => undefined,
      undoMeetingJoin: (id: string) => {
        undoCalls.push(id);
        return new Promise<void>((resolve, reject) => {
          settle = { resolve, reject };
        });
      },
    },
    {
      get: (each, name) =>
        name in each
          ? (each as Record<string, unknown>)[name as string]
          : () => Promise.resolve(undefined),
    },
  );
  Object.assign(window, { incarnamind: bridge, incarnamindFiles: bridge });
  const globals: Record<string, unknown> = {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Event: window.Event,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: (run: () => void) => {
      run();
      return 0;
    },
    cancelAnimationFrame: () => undefined,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);
  const sidebarPath = "../../src/renderer/src/components/SidebarStatus.tsx";
  const sidebar: { SidebarStatus: ComponentType<{ problemsOnly?: boolean }> } = await import(
    sidebarPath
  );
  SidebarStatus = sidebar.SidebarStatus;
  ({ useAppStore } = await import("../../src/renderer/src/store"));
  ({ useJoinedMeetings } = await import("../../src/renderer/src/joinedMeetings"));
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  container.remove();
  settle = null;
  undoCalls.length = 0;
  useJoinedMeetings.setState({ joined: [], loaded: false });
  vi.unstubAllGlobals();
});

async function show(language: "en" | "zh-CN") {
  useAppStore.setState({
    settings: { language, device: {} } as unknown as Settings,
    minds: [{ id: JOIN.mindId, title: MEETING, folderId: JOIN.folderId }],
    library: {
      groups: [{ id: JOIN.folderId, name: "Harbour", parentId: null, keepInside: false }],
      deletedGroups: [],
      assignments: [],
      settings: {
        classifier: { kind: "automatic" },
        automatic: false,
        organizeWith: null,
        taggingStopped: [],
      },
      automaticDefault: false,
    },
  } as never);
  useJoinedMeetings.setState({ joined: [JOIN], loaded: true });
  await act(() => root?.render(createElement(SidebarStatus, { problemsOnly: true })));
}

const undoButton = () => container.querySelector('[data-testid="meeting-joined-undo"]');

async function press(target: Element | null) {
  if (!target) throw new Error("Missing click target");
  await act(() => {
    target.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
}

describe.each(["en", "zh-CN"] as const)("a joined meeting's Undo (%s)", (language) => {
  test("shows at once that it is working, takes no second press, then says it worked", async () => {
    await show(language);
    expect(undoButton()?.textContent).toBe(translate(language, "meetings.joined.undo"));
    expect(undoButton()?.getAttribute("aria-busy")).toBeNull();

    await press(undoButton());
    expect(undoCalls).toEqual([JOIN.id]);
    expect(undoButton()?.getAttribute("aria-busy")).toBe("true");
    expect(undoButton()?.getAttribute("aria-disabled")).toBe("true");

    await press(undoButton());
    expect(undoCalls).toEqual([JOIN.id]);

    // Core has put the pair back: the line's Undo goes, and the same line says so (the window
    // test reads its words).
    await act(async () => settle?.resolve());
    expect(undoButton()).toBeNull();
    expect(useJoinedMeetings.getState().joined).toMatchObject([
      { id: JOIN.id, undoing: false, undone: true },
    ]);
  });

  test("refused, the line and its Undo come back ready", async () => {
    await show(language);
    await press(undoButton());
    expect(undoButton()?.getAttribute("aria-busy")).toBe("true");

    await act(async () => settle?.reject(new Error("The Folder is gone.")));
    expect(undoButton()?.getAttribute("aria-busy")).toBeNull();
    expect(undoButton()?.getAttribute("aria-disabled")).toBeNull();
    expect(container.querySelector(`[data-testid="meeting-joined-${JOIN.id}"]`)).not.toBeNull();
  });
});
