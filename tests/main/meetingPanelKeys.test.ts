import { beforeEach, describe, expect, test, vi } from "vitest";
import { createFakeCapture } from "../../src/core/meetings/fakeCapture";
import { FILES_CHANNELS } from "../../src/shared/bridge";
import { keysForm } from "../../src/shared/keyForms";
import type { HelpKeys } from "../../src/shared/meetingHelp";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { recordingLog } from "../helpers/log";

const electron = vi.hoisted(() => {
  const taken = new Set<string>();
  const registered = new Map<string, () => void>();
  const attempts: string[] = [];
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>();
  return {
    taken,
    registered,
    attempts,
    handlers,
    listeners,
    module: {
      app: { on: () => undefined },
      BrowserWindow: class {},
      screen: {},
      ipcMain: {
        on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) =>
          listeners.set(channel, listener),
        handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) =>
          handlers.set(channel, listener),
      },
      globalShortcut: {
        register(keys: string, callback: () => void) {
          attempts.push(keys);
          if (taken.has(keys)) return false;
          registered.set(keys, callback);
          return true;
        },
        unregister: (keys: string) => registered.delete(keys),
      },
    },
  };
});
vi.mock("electron", () => electron.module);

const { serveMeetingPanel } = await import("../../src/main/meetings/panel");

beforeEach(() => {
  electron.taken.clear();
  electron.registered.clear();
  electron.attempts.length = 0;
  electron.handlers.clear();
  electron.listeners.clear();
});

const held = () => [...electron.registered.keys()].sort();

// The hook a test build adds to the main process (src/main/meetings/panel.ts).
const mainInFront = (front: boolean) =>
  (
    globalThis as unknown as { incarnamindMainFocused(front: boolean): void }
  ).incarnamindMainFocused(front);

async function serve(mac: boolean, meetingHelpKeys: HelpKeys = {}) {
  const core = startCore(await createTempDataFolder(), {
    audioCapture: createFakeCapture(),
    now: manualClock().now,
  });
  await core.updateSettings({
    device: { meetingNoticeAccepted: true, meetingPanel: false, meetingHelpKeys },
  });
  serveMeetingPanel(core, {
    rendererUrl: undefined,
    appWindows: () => [],
    trusted: () => true,
    mac,
    log: recordingLog().log,
    testHooks: true,
  });
  const { id } = await core.createMeeting();
  return {
    core,
    id,
    record: () => core.startMeeting({ meetingId: id }),
    setKeys: (keys: HelpKeys) => core.updateSettings({ device: { meetingHelpKeys: keys } }),
  };
}

const windowBinds = (mac: boolean, ...keys: string[]) =>
  electron.listeners.get(FILES_CHANNELS.windowKeys)?.(
    {},
    keys.map((each) => keysForm(each, mac)),
  );

const keysFree = async (keys: string) =>
  electron.handlers.get(FILES_CHANNELS.globalKeysFree)?.({}, keys);

describe("The shortcuts held over the meeting app while a meeting records", () => {
  test("macOS holds its ⌃⌥ defaults: the seven buttons, Call help and Pause my mic", async () => {
    const { record } = await serve(true);
    await record();
    await vi.waitFor(() =>
      expect(held()).toEqual([
        "Ctrl+Alt+1",
        "Ctrl+Alt+2",
        "Ctrl+Alt+3",
        "Ctrl+Alt+4",
        "Ctrl+Alt+5",
        "Ctrl+Alt+6",
        "Ctrl+Alt+7",
        "Ctrl+Alt+H",
        "Ctrl+Alt+M",
      ]),
    );
  });

  test("Windows and Linux hold nothing until the User sets a key, then only that key", async () => {
    const { core, id, record, setKeys } = await serve(false);
    await record();
    await vi.waitFor(async () =>
      expect((await core.listMeetings()).map((meeting) => meeting.status)).toEqual(["recording"]),
    );
    mainInFront(false);
    expect(electron.attempts).toEqual([]);

    await setKeys({ say: "Ctrl+Shift+9" });
    await vi.waitFor(() => expect(held()).toEqual(["Ctrl+Shift+9"]));
    expect(electron.attempts).toEqual(["Ctrl+Shift+9"]);

    await setKeys({ say: "" });
    await vi.waitFor(() => expect(held()).toEqual([]));
    await setKeys({ mic: "Ctrl+Alt+F8" });
    await vi.waitFor(() => expect(held()).toEqual(["Ctrl+Alt+F8"]));

    await core.pauseMeeting(id);
    await vi.waitFor(() => expect(held()).toEqual([]));
    await core.resumeMeeting(id);
    await vi.waitFor(() => expect(held()).toEqual(["Ctrl+Alt+F8"]));
    await core.stopMeeting(id);
    await vi.waitFor(() => expect(held()).toEqual([]));
  });

  test("macOS keeps holding its defaults with a main window in front, as Pause my mic is wanted while taking notes", async () => {
    const { record } = await serve(true);
    windowBinds(true, "CmdOrCtrl+B", "Cmd+Shift+9");
    await record();
    await vi.waitFor(() => expect(held()).toHaveLength(9));
    mainInFront(true);
    expect(held()).toHaveLength(9);
    expect(held()).toContain("Ctrl+Alt+M");
    mainInFront(false);
    expect(held()).toHaveLength(9);
  });

  test.each([
    { name: "macOS", mac: true },
    { name: "Windows and Linux", mac: false },
  ])(
    "a key the User sets that is one of the window's own is held only while another app is in front, and the rest stay held, on $name",
    async ({ mac }) => {
      const { record } = await serve(mac, {
        panel: "Ctrl+Alt+F8",
        say: "Ctrl+Shift+9",
        mic: "Ctrl+Alt+F9",
      });
      const set = ["Ctrl+Alt+F8", "Ctrl+Alt+F9", "Ctrl+Shift+9"];
      const mine = () => held().filter((keys) => set.includes(keys));
      await record();
      await vi.waitFor(() => expect(mine()).toEqual(set));
      windowBinds(mac, "Ctrl+Shift+9");
      expect(mine()).toEqual(set);
      mainInFront(true);
      expect(mine()).toEqual(["Ctrl+Alt+F8", "Ctrl+Alt+F9"]);
      mainInFront(false);
      expect(mine()).toEqual(set);
    },
  );

  test("a key another app holds is refused, so the button works without it, and Settings is told it is in use", async () => {
    electron.taken.add("Ctrl+Alt+F8");
    const { record } = await serve(false, { mic: "Ctrl+Alt+F8", say: "Ctrl+Alt+F9" });
    await record();
    await vi.waitFor(() => expect(held()).toEqual(["Ctrl+Alt+F9"]));
    expect(electron.attempts.filter((keys) => keys === "Ctrl+Alt+F8")).toHaveLength(1);

    expect(await keysFree("Ctrl+Alt+F8")).toBe(false);
    expect(await keysFree("Ctrl+Alt+F10")).toBe(true);
    expect(held()).toEqual(["Ctrl+Alt+F9"]);
    expect(await keysFree("Ctrl+Alt+F9")).toBe(true);
  });
});
