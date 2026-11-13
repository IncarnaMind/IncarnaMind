import { beforeEach, describe, expect, test, vi } from "vitest";
import { createFakeCapture } from "../../src/core/meetings/fakeCapture";
import { FILES_CHANNELS } from "../../src/shared/bridge";
import type { HelpKeys } from "../../src/shared/meetingHelp";
import { MEETING_PANEL_CHANNELS } from "../../src/shared/meetingPanel";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { recordingLog } from "../helpers/log";
import { connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";

/**
 * The call-help panel's window and the keyboard (#2925): it is made unable to take the keyboard,
 * becomes able only when its page asks for its field, and is unable again on the page's give back
 * and when the system takes the keyboard from it. ⌃⌥N and ⌘K's Quick note open it for the field.
 */
const electron = vi.hoisted(() => {
  const listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>();
  const registered = new Map<string, () => void>();
  const made: FakeWindow[] = [];

  class FakeWindow {
    focusable: boolean;
    focused = false;
    visible = false;
    destroyed = false;
    /** What was asked of the window that bears on the keyboard, in order. */
    asked: string[] = [];
    sent: unknown[][] = [];
    private readonly events = new Map<string, (() => void)[]>();
    readonly webContents = {
      send: (...args: unknown[]) => this.sent.push(args),
      focus: () => this.asked.push("webContents.focus"),
      setWindowOpenHandler: () => undefined,
      on: () => undefined,
    };

    constructor(options: { focusable?: boolean }) {
      this.focusable = options.focusable ?? true;
      made.push(this);
    }
    on(name: string, listener: () => void) {
      this.events.set(name, [...(this.events.get(name) ?? []), listener]);
    }
    once(name: string, listener: () => void) {
      const each = () => {
        this.events.set(
          name,
          (this.events.get(name) ?? []).filter((other) => other !== each),
        );
        listener();
      };
      this.on(name, each);
    }
    emit(name: string) {
      for (const listener of this.events.get(name) ?? []) listener();
    }
    showInactive() {
      this.visible = true;
      this.emit("show");
    }
    isVisible = () => this.visible;
    isDestroyed = () => this.destroyed;
    destroy() {
      this.destroyed = true;
      this.emit("closed");
    }
    isFocusable = () => this.focusable;
    setFocusable(focusable: boolean) {
      this.asked.push(`setFocusable(${focusable})`);
      this.focusable = focusable;
    }
    setSkipTaskbar(skip: boolean) {
      this.asked.push(`setSkipTaskbar(${skip})`);
    }
    isFocused = () => this.focused;
    focus() {
      this.asked.push("focus");
      this.focused = true;
    }
    blur() {
      this.asked.push("blur");
      this.focused = false;
      this.emit("blur");
    }
    setAlwaysOnTop = () => undefined;
    setVisibleOnAllWorkspaces = () => undefined;
    setContentProtection = () => undefined;
    loadFile = () => Promise.resolve();
    loadURL = () => Promise.resolve();
    getBounds = () => ({ x: 0, y: 0, width: 408, height: 320 });
    setBounds = () => undefined;
  }

  return {
    listeners,
    registered,
    made,
    module: {
      app: { on: () => undefined },
      BrowserWindow: FakeWindow,
      screen: {
        getCursorScreenPoint: () => ({ x: 0, y: 0 }),
        getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
      },
      ipcMain: {
        on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) =>
          listeners.set(channel, listener),
        handle: () => undefined,
      },
      globalShortcut: {
        register(keys: string, callback: () => void) {
          registered.set(keys, callback);
          return true;
        },
        unregister: (keys: string) => registered.delete(keys),
      },
    },
  };
});
vi.mock("electron", () => electron.module);
vi.mock("../../src/main/appearance", () => ({
  themeWindow: () => undefined,
  windowColour: () => "#ffffff",
}));

const { serveMeetingPanel } = await import("../../src/main/meetings/panel");

type Window = (typeof electron.made)[number];

beforeEach(() => {
  electron.listeners.clear();
  electron.registered.clear();
  electron.made.length = 0;
});

const press = (kind: string) =>
  (
    globalThis as unknown as { incarnamindPressHelpKeys(kind: string): void }
  ).incarnamindPressHelpKeys(kind);

/** A Meeting recording on macOS or elsewhere, its panel shown or not. */
async function recording(
  mac: boolean,
  {
    shown = true,
    linux = false,
    keys = {},
  }: { shown?: boolean; linux?: boolean; keys?: HelpKeys } = {},
) {
  const core = startCore(await createTempDataFolder(), {
    audioCapture: createFakeCapture(),
    now: manualClock().now,
  });
  await core.updateSettings({
    device: {
      meetingNoticeAccepted: true,
      meetingPanel: shown,
      meetingHelpKeys: { note: "Ctrl+Alt+N", say: "Ctrl+Alt+1", ...keys },
    },
  });
  serveMeetingPanel(core, {
    rendererUrl: undefined,
    appWindows: () => [],
    trusted: () => true,
    mac,
    linux,
    log: recordingLog().log,
    testHooks: true,
  });
  const { id } = await core.createMeeting();
  await core.startMeeting({ meetingId: id });
  await vi.waitFor(() => expect([...electron.registered.keys()]).toContain("Ctrl+Alt+1"));
  return { core, meetingId: id };
}

async function shownPanel(): Promise<Window> {
  await vi.waitFor(() => expect(electron.made).toHaveLength(1));
  const [panel] = electron.made;
  if (!panel) throw new Error("No panel.");
  panel.emit("ready-to-show");
  return panel;
}

const fromPage = (panel: Window, channel: string, ...args: unknown[]) =>
  electron.listeners.get(channel)?.({ sender: panel.webContents }, ...args);
const keyboard = (panel: Window, take: boolean) =>
  fromPage(panel, MEETING_PANEL_CHANNELS.keyboard, take);
/** The page says its state, as it does once its listeners are in place. */
const ready = (panel: Window) =>
  fromPage(panel, MEETING_PANEL_CHANNELS.state, { folded: false, pinned: false });
const notesAsked = (panel: Window) =>
  panel.sent.filter(
    ([channel, command]) => channel === MEETING_PANEL_CHANNELS.command && command === "note",
  ).length;

describe("The call-help panel and the keyboard (#2925)", () => {
  test.each([
    { name: "macOS", mac: true },
    { name: "Windows and Linux", mac: false },
  ])(
    "on $name it is made unable to take the keyboard, and stays so as it shows and a help key is pressed",
    async ({ mac }) => {
      await recording(mac);
      const panel = await shownPanel();
      ready(panel);
      press("say");
      expect(panel.focusable).toBe(false);
      expect(panel.asked).toEqual([]);
    },
  );

  test("its page asking for the field makes it able to and gives it the keyboard, kept off the taskbar", async () => {
    await recording(false);
    const panel = await shownPanel();
    keyboard(panel, true);
    expect(panel.asked).toEqual([
      "setFocusable(true)",
      "setSkipTaskbar(true)",
      "focus",
      "webContents.focus",
    ]);
    expect(panel.focused).toBe(true);
    // Asked again while it has it: nothing more, so nothing flickers.
    keyboard(panel, true);
    expect(panel.asked).toHaveLength(4);
  });

  test("a page that isn't the panel's can't make it take the keyboard", async () => {
    await recording(true);
    const panel = await shownPanel();
    electron.listeners.get(MEETING_PANEL_CHANNELS.keyboard)?.({ sender: {} }, true);
    electron.listeners.get(MEETING_PANEL_CHANNELS.keyboard)?.({ sender: panel.webContents }, "yes");
    expect(panel.focusable).toBe(false);
    expect(panel.asked).toEqual([]);
  });

  test("asked before it shows, it takes the keyboard once it does", async () => {
    await recording(true);
    await vi.waitFor(() => expect(electron.made).toHaveLength(1));
    const [panel] = electron.made;
    if (!panel) throw new Error("No panel.");
    keyboard(panel, true);
    expect(panel.asked).toEqual([]);
    panel.emit("ready-to-show");
    expect(panel.focused).toBe(true);
    expect(panel.focusable).toBe(true);
  });

  test.each([
    // macOS keeps the focus on a window made unfocusable: the blur hands the keys back.
    { name: "macOS", mac: true, given: ["setFocusable(false)", "blur"] },
    // There, making it unable to take the keyboard moves the foreground on by itself.
    { name: "Windows and Linux", mac: false, given: ["setFocusable(false)"] },
  ])(
    "on $name, Esc or collapsing (the page's give back) leaves it unable to take the keyboard",
    async ({ mac, given }) => {
      await recording(mac);
      const panel = await shownPanel();
      keyboard(panel, true);
      panel.asked.length = 0;
      keyboard(panel, false);
      expect(panel.asked).toEqual(given);
      expect(panel.focusable).toBe(false);
    },
  );

  test("the system taking the keyboard from it, a click in the meeting app, leaves it unable to take it again", async () => {
    await recording(true);
    const panel = await shownPanel();
    keyboard(panel, true);
    panel.focused = false;
    panel.emit("blur");
    expect(panel.focusable).toBe(false);
  });

  test("giving back a keyboard it never took asks nothing of the window", async () => {
    await recording(false);
    const panel = await shownPanel();
    keyboard(panel, false);
    expect(panel.asked).toEqual([]);
  });

  test("⌃⌥N asks a shown panel's page for the field at once", async () => {
    await recording(true);
    const panel = await shownPanel();
    ready(panel);
    press("note");
    expect(notesAsked(panel)).toBe(1);
    // Only the page's own ask makes the window able to take the keyboard.
    expect(panel.focusable).toBe(false);
  });

  test("⌃⌥N opens a closed panel and asks its page for the field once its page is ready", async () => {
    await recording(true, { shown: false });
    expect(electron.made).toHaveLength(0);
    press("note");
    const panel = await shownPanel();
    expect(notesAsked(panel)).toBe(0);
    ready(panel);
    expect(notesAsked(panel)).toBe(1);
    ready(panel);
    expect(notesAsked(panel)).toBe(1);
  });

  test("⌘K's Quick note in the app's window does what ⌃⌥N does", async () => {
    await recording(true, { shown: false });
    electron.listeners.get(FILES_CHANNELS.meetingPanelCommand)?.({}, "note");
    const panel = await shownPanel();
    ready(panel);
    expect(notesAsked(panel)).toBe(1);
  });

  test("on Linux, where the panel has no field, ⌃⌥N isn't held and a Quick note asked anyway opens nothing", async () => {
    await recording(false, { shown: false, linux: true });
    expect([...electron.registered.keys()]).toEqual(["Ctrl+Alt+1"]);
    electron.listeners.get(FILES_CHANNELS.meetingPanelCommand)?.({}, "note");
    expect(electron.made).toHaveLength(0);
  });
});

describe("A line left unsent in the panel's field when it closes (#2925)", () => {
  const ways = [
    {
      way: "its close button",
      close: (panel: Window) => fromPage(panel, MEETING_PANEL_CHANNELS.close),
    },
    {
      way: "⌘K or Call help in the app's window",
      close: () => electron.listeners.get(FILES_CHANNELS.showMeetingPanel)?.({}, false),
    },
    { way: "⌃⌥H", close: () => press("panel") },
  ];

  test.each(
    ways.flatMap((each) => [
      { ...each, language: "English", line: "Ask about the rollout" },
      { ...each, language: "Chinese", line: "问一下上线时间" },
    ]),
  )(
    "goes into the Note before the window goes, closed by $way ($language)",
    async ({ close, line }) => {
      const { core, meetingId } = await recording(true, { keys: { panel: "Ctrl+Alt+H" } });
      const panel = await shownPanel();
      const meeting = (await core.listMeetings()).find((each) => each.id === meetingId);
      if (!meeting) throw new Error("No meeting.");
      const client = await connectToMind(core, meeting.mindId);
      await core.setQuickNoteDraft({ meetingId, text: line, atMs: 1000 });

      close(panel);

      expect(panel.destroyed).toBe(true);
      await vi.waitFor(() => expect(readMind(client).textContent).toContain(line));
    },
  );
});
