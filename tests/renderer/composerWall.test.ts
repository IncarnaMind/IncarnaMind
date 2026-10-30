import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Conversation, LibrarySnapshot, TurnPlace } from "../../src/core/api";
import { InvalidInputError, NotFoundError } from "../../src/core/errors";
import { errorForWindow } from "../../src/shared/errorWording";

/*
 * The composer's scope chip follows the wall the core gives the turn (#2243): until the core has
 * answered for the place the composer is in now, it shows no scope, never the one it had before
 * or the outside one. A paste the core won't save says why, where it was pasted.
 */

let root: Root | null = null;
let container: HTMLElement;
let asked: {
  place: TurnPlace;
  answer(wall: string | null): void;
  fail(error: unknown): void;
}[] = [];
let reported: unknown[] = [];
/** What the scope chip said at each commit: "" while none shows. */
let frames: string[] = [];

const conversation = (id: string, folderId: string | null): Conversation => ({
  id,
  title: id,
  autoTitle: "",
  folderId,
  askedFrom: [],
  createdAt: "2026-10-30T00:00:00.000Z",
  updatedAt: "2026-10-30T00:00:00.000Z",
});

beforeEach(async () => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  const window = document.defaultView;
  asked = [];
  frames = [];
  reported = [];
  const wallOfTurn = (place: TurnPlace) =>
    new Promise<string | null>((resolve, reject) =>
      asked.push({ place, answer: resolve, fail: reject }),
    );
  // The conversation was deleted in another window just before the paste was saved.
  const saveTextAsDocument = () =>
    Promise.reject(errorForWindow(new NotFoundError({ key: "error.paste.conversationGone" })));
  // Every other call stays unanswered: the composer's other parts wait, as on a slow start.
  const bridge = new Proxy(
    { on: () => () => undefined, wallOfTurn, saveTextAsDocument },
    {
      get: (each, name) =>
        name in each ? each[name as keyof typeof each] : () => new Promise(() => undefined),
    },
  );
  // This DOM draws no animation: the menu's opening shows at once.
  Object.assign(window, {
    incarnamind: bridge,
    incarnamindFiles: bridge,
    reportError: () => undefined,
  });
  const globals: Record<string, unknown> = {
    document,
    window,
    HTMLElement: window.HTMLElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Element: window.Element,
    Event: window.Event,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    getComputedStyle: () => ({ columnGap: "0", paddingLeft: "0", paddingRight: "0" }),
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
  await import("../../src/renderer/src/commands/app");
  const { useAppStore } = await import("../../src/renderer/src/store");
  const { useConversations } = await import("../../src/renderer/src/conversations");
  useConversations.setState({
    list: [conversation("walled", "a"), conversation("outside", null)],
    openId: "walled",
    messages: [],
  });
  const at = "2026-10-30T00:00:00.000Z";
  const clientA = {
    id: "a",
    name: "Client A",
    description: "",
    countsOwnFiles: false,
    keepInside: true,
    createdAt: at,
    updatedAt: at,
  };
  const library = { groups: [clientA], assignments: [] } as Pick<
    LibrarySnapshot,
    "groups" | "assignments"
  > as LibrarySnapshot;
  useAppStore.setState({
    documents: [],
    minds: [{ id: "walled-note", folderId: "a" }],
    library,
    skills: [],
    settings: { language: "en", device: {}, user: {} },
    reportError: (error: unknown) => reported.push(error),
  } as never);
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

const chip = () =>
  (
    container.querySelector('[data-testid="composer-scope"]') ??
    container.querySelector('[data-testid="composer-scope-all"]')
  )?.textContent ?? "";

async function showComposer() {
  // Loaded by path, as the other component tests are: the node typecheck reads no JSX.
  const composerPath = "../../src/renderer/src/editor/Composer.tsx";
  const { Composer }: { Composer: ComponentType<{ mind: null }> } = await import(composerPath);
  await act(() =>
    root?.render(
      createElement(
        Profiler,
        { id: "composer", onRender: () => frames.push(chip()) },
        createElement(Composer, { mind: null }),
      ),
    ),
  );
}

async function answer(wall: string | null) {
  const last = asked.at(-1);
  if (!last) throw new Error("The composer didn't ask the core for its wall.");
  await act(async () => last.answer(wall));
}

describe("the composer's scope while the core works out the turn's wall", () => {
  test("opening a walled conversation shows no scope until the core answers, then its lock", async () => {
    await showComposer();
    expect(asked.map((each) => each.place)).toEqual([{ mindId: null, conversationId: "walled" }]);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((frame) => frame === "")).toBe(true);

    await answer("a");
    expect(chip()).toContain("Client A");
    expect(chip()).not.toContain("All Documents");
  });

  test("switching to an outside conversation shows neither the old lock nor All Documents until the core answers", async () => {
    await showComposer();
    await answer("a");
    const { useConversations } = await import("../../src/renderer/src/conversations");
    frames = [];

    await act(() => useConversations.setState({ openId: "outside" }));

    expect(asked.at(-1)?.place).toEqual({ mindId: null, conversationId: "outside" });
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((frame) => frame === "")).toBe(true);
    await answer(null);
    expect(chip()).toBe("All Documents · 1 Folder left out");
    expect(frames.filter((frame) => frame !== "")).toEqual(
      frames.filter((frame) => frame !== "").map(() => "All Documents · 1 Folder left out"),
    );
  });
});

describe("a long paste the core won't save", () => {
  for (const [language, words] of [
    ["en", "The pasted text wasn’t saved: this conversation has been deleted."],
    ["zh-CN", "粘贴的文本未保存：这个对话已删除。"],
  ] as const) {
    test(`says why above the composer, and keeps the paste (${language})`, async () => {
      const { useAppStore } = await import("../../src/renderer/src/store");
      const { useComposer } = await import("../../src/renderer/src/composer");
      useAppStore.setState({ settings: { language, device: {}, user: {} } } as never);
      useComposer
        .getState()
        .update("assistant", { pastes: [{ id: "p1", text: "x\n".repeat(40) }] });
      await showComposer();
      const click = (testId: string) =>
        container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.click();

      // The browser shows the popover; this DOM can't, so the menu hears that it opens.
      const menu = container.querySelector<HTMLElement>('[data-testid="composer-paste-menu"]');
      if (!menu) throw new Error("The paste has no menu.");
      Object.assign(menu, { hidePopover: () => undefined, matches: () => false });
      const opens = Object.assign(new Event("beforetoggle"), { newState: "open" });
      await act(async () => menu.dispatchEvent(opens));
      await act(async () => click("paste-save"));

      expect(
        container.querySelector('[data-testid="composer-paste-save-failed"]')?.textContent,
      ).toContain(words);
      expect(container.querySelectorAll('[data-testid="composer-paste"]')).toHaveLength(1);
    });
  }
});

describe("the turn's wall as the composer asks the core for it", () => {
  /** Each value the hook gave, render by render. */
  let seen: (string | null | undefined)[] = [];

  async function showPlace(place: TurnPlace) {
    const { useTurnWall } = await import("../../src/renderer/src/turnWall");
    const Probe = ({ at }: { at: TurnPlace }) => {
      seen.push(useTurnWall(at));
      return null;
    };
    await act(() => root?.render(createElement(Probe, { at: place })));
  }

  const fail = async (error: unknown) => {
    const last = asked.at(-1);
    if (!last) throw new Error("Nothing asked the core.");
    await act(async () => last.fail(error));
  };

  test("from a walled Note to a conversation and back, no render gives the wall of the place before", async () => {
    seen = [];
    const note = { mindId: "walled-note", conversationId: "outside" };
    const chat = { mindId: null, conversationId: "outside" };
    await showPlace(note);
    expect(seen.every((each) => each === undefined)).toBe(true);
    await answer("a");
    expect(seen.at(-1)).toBe("a");

    seen = [];
    await showPlace(chat);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((each) => each === undefined)).toBe(true);
    await answer(null);
    expect(seen.at(-1)).toBeNull();

    seen = [];
    await showPlace(note);
    expect(seen.every((each) => each === undefined)).toBe(true);
    await answer("a");
    expect(seen.at(-1)).toBe("a");
    expect(asked.map((each) => each.place)).toEqual([note, chat, note]);
  });

  test("a conversation deleted meanwhile leaves the wall unknown, with no notice", async () => {
    seen = [];
    await showPlace({ mindId: null, conversationId: "walled" });
    await fail(errorForWindow(new NotFoundError({ key: "error.conversation.notFound" })));
    expect(seen.every((each) => each === undefined)).toBe(true);
    expect(reported).toEqual([]);
  });

  test("any other failure is reported, and the wall stays unknown", async () => {
    seen = [];
    await showPlace({ mindId: null, conversationId: "walled" });
    await fail(errorForWindow(new InvalidInputError({ key: "error.turnPlace" })));
    expect(seen.every((each) => each === undefined)).toBe(true);
    expect(reported).toHaveLength(1);
  });
});
