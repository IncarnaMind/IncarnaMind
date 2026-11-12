import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AnswerToolCall, CommandDone } from "../../src/core/api";
import { YOURS, yoursWordsOf } from "../../src/shared/commands";
import { translate } from "../../src/shared/i18n";

/*
 * The line under a reply that refuses what is the User's alone. For the wall of a Folder (#1934),
 * it says so, names the Folder, and its one button shows the sidebar if it is hidden and opens
 * that Folder's ⋯ menu there; with no Folder to name, it says where, with no button. For the
 * rest, its button is named after the page its click opens (#1741).
 */

let root: Root | null = null;
let container: HTMLElement;
let menuClicks: string[];
let toggled: number;
let CommandsCard: ComponentType<Record<string, unknown>>;

const callOf = (done: Partial<CommandDone>): AnswerToolCall =>
  ({
    id: "call-1",
    tool: "run_command",
    source: "commands",
    input: {},
    status: "done",
    resultCount: null,
    command: { command: "folder.keepInside", run: "run-1", items: [], yours: "wall", ...done },
  }) as AnswerToolCall;

beforeEach(async () => {
  const document = new DOMParser().parseFromString(
    `<html><head></head><body>
      <aside data-testid="sidebar">
        <button data-object-menu="folder:a"></button>
        <button data-object-menu="folder:b"></button>
      </aside>
    </body></html>`,
    "text/html",
  );
  const window = document.defaultView;
  const bridge = new Proxy(
    { on: () => () => undefined },
    { get: (each, name) => (name === "on" ? each.on : () => Promise.resolve(undefined)) },
  );
  Object.assign(window, { incarnamind: bridge, incarnamindFiles: bridge });
  menuClicks = [];
  for (const button of document.querySelectorAll("[data-object-menu]")) {
    button.addEventListener("click", () =>
      menuClicks.push(button.getAttribute("data-object-menu")),
    );
    Object.assign(button, { scrollIntoView: () => undefined });
  }
  const globals: Record<string, unknown> = {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Event: window.Event,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    CSS: { escape: (value: string) => value },
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
  const { sidebarHandle } = await import("../../src/renderer/src/commands/handles");
  toggled = 0;
  const sidebar = { hidden: true, toggle: () => undefined };
  sidebar.toggle = () => {
    toggled += 1;
    sidebar.hidden = !sidebar.hidden;
  };
  sidebarHandle.current = sidebar;
  // Loaded by path, as the other component tests are: the node typecheck reads no JSX.
  const cardPath = "../../src/renderer/src/components/assistant/CommandsCard.tsx";
  ({ CommandsCard } = await import(cardPath));
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

async function show(done: Partial<CommandDone>) {
  await act(() =>
    root?.render(
      createElement(CommandsCard, {
        answer: { id: "answer-1", text: "", toolCalls: [callOf(done)] },
        streaming: false,
      }),
    ),
  );
}

describe("the refusal to turn a Folder's wall on or off", () => {
  test("names the Folder and opens its menu, showing the hidden sidebar first", async () => {
    await show({ folder: { id: "b", name: "Client B" } });
    const line = container.querySelector('[data-testid="command-yours"]');
    expect(line?.textContent).toContain(
      "Whether “Client B” keeps its work inside it is yours to change, not mine. It’s in the Folder’s ⋯ menu.",
    );
    const open = container.querySelector('[data-testid="command-yours-open"]');
    expect(open?.textContent).toBe("Open the Folder’s menu");
    await act(() => {
      open?.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    expect(toggled).toBe(1);
    expect(menuClicks).toEqual(["folder:b"]);
  });

  test("with no Folder to name, says where, with no button", async () => {
    await show({});
    expect(container.querySelector('[data-testid="command-yours"]')?.textContent).toContain(
      "Whether a Folder keeps its work inside it is yours to change, not mine. It’s in each Folder’s ⋯ menu.",
    );
    expect(container.querySelector('[data-testid="command-yours-open"]')).toBeNull();
  });
});

describe("a refusal's button names the page its click opens (#1741)", () => {
  const BUTTONS = [
    { what: "keys", en: "Open AI settings", zh: "打开 AI 设置", page: "ai", at: null },
    { what: "privacy", en: "Open AI settings", zh: "打开 AI 设置", page: "ai", at: "local-mode" },
    {
      what: "approvals",
      en: "Open Privacy settings",
      zh: "打开隐私设置",
      page: "privacy",
      at: null,
    },
    {
      what: "spending",
      en: "Open AI settings",
      zh: "打开 AI 设置",
      page: "ai",
      at: "spending-cap",
    },
  ] as const;

  // protects=every refusal whose button opens a Settings page says that page's name, in both languages, and the click lands on it; fails_when=a label names one page and the click opens another, or a new kind with a Settings button has no row here; no_claim=the button of Recently deleted or a Folder's menu.
  test.each(["en", "zh-CN"] as const)("in %s", async (language) => {
    const withPage = YOURS.filter((what) => {
      const opens = yoursWordsOf(what).opens;
      return opens !== null && typeof opens === "object";
    });
    expect(withPage).toEqual(BUTTONS.map((each) => each.what));
    const { useAppStore } = await import("../../src/renderer/src/store");
    const { settingsPageLabels } = await import("../../src/renderer/src/settingsPages");
    for (const expected of BUTTONS) {
      useAppStore.setState({ settings: { language } } as never);
      useAppStore.getState().closeSettings();
      await show({ yours: expected.what });
      const open = container.querySelector('[data-testid="command-yours-open"]');
      expect(open?.textContent).toBe(language === "en" ? expected.en : expected.zh);
      await act(() => {
        open?.dispatchEvent(new window.Event("click", { bubbles: true }));
      });
      const state = useAppStore.getState();
      expect(state.settingsOpen).toBe(true);
      expect(state.settingsPage).toBe(expected.page);
      expect(state.settingsAt).toBe(expected.at);
      expect(open?.textContent).toContain(
        translate(language, settingsPageLabels[state.settingsPage]),
      );
    }
    useAppStore.setState({ settings: null } as never);
  });
});
