import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  DEFAULT_ASSISTANT,
  type Meeting,
  type Settings,
  type WindowLayout,
} from "../../src/core/api";
import { keysLabel, keysOn } from "../../src/renderer/src/commands/keys";
import {
  type CommandContext,
  commands,
  isEnabled,
  labelOf,
  offered,
} from "../../src/renderer/src/commands/registry";
import { useRequests } from "../../src/renderer/src/requests";
import type { CommandId } from "../../src/shared/commands";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

/*
 * Recording a Meeting from the command registry (#135, #222): its commands'
 * labels in both languages, ⌘⇧P, and when each can run.
 */

const IN_MIND: CommandContext = { selection: [], focus: null, surface: "mind" };
const en = (key: MessageKey, params?: MessageParams) => translate("en", key, params);
const zh = (key: MessageKey, params?: MessageParams) => translate("zh-CN", key, params);

type Stores = typeof import("../../src/renderer/src/store") &
  typeof import("../../src/renderer/src/meetings");
let stores: Stores;

beforeAll(async () => {
  // The commands reach the stores, which read the bridge the preload exposes.
  const bridge = new Proxy({}, { get: () => () => () => undefined });
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: bridge,
  };
  await import("../../src/renderer/src/commands/app");
  stores = {
    ...(await import("../../src/renderer/src/store")),
    ...(await import("../../src/renderer/src/meetings")),
  };
});

afterEach(() => {
  stores.useMeetings.setState({ meetings: [] });
  stores.useAppStore.setState({ settings: null, layout: null });
});

const canRecord = (can = true) =>
  stores.useAppStore.setState({
    settings: { device: {}, meetingAudio: can ? "both" : "none" } as unknown as Settings,
  });

const meeting = (id: string, mindId: string, status: Meeting["status"]): Meeting =>
  ({ id, mindId, status }) as Meeting;

/** A window showing this Mind's tab. */
const showing = (mindId: string) =>
  stores.useAppStore.setState({
    layout: {
      groups: [
        {
          id: "group",
          tabs: [
            {
              id: "tab",
              item: { kind: "mind", mindId },
              preview: false,
              pinned: false,
              place: null,
              opened: 0,
            },
          ],
          activeTabId: "tab",
          width: 1,
        },
      ],
      focusedGroupId: "group",
      reopenable: 0,
      assistant: DEFAULT_ASSISTANT,
    } satisfies WindowLayout,
  });

const command = (id: CommandId) => {
  const found = commands.get(id);
  if (!found) throw new Error(`No command ${id}.`);
  return found;
};

describe("the meeting commands", () => {
  test("are named in English and Chinese, and Pause/Resume says which it will do", () => {
    canRecord();
    expect(labelOf(command("meeting.record"), IN_MIND, en)).toBe("Record a meeting");
    expect(labelOf(command("meeting.record"), IN_MIND, zh)).toBe("录制会议");
    expect(labelOf(command("meeting.stop"), IN_MIND, en)).toBe("Stop recording");
    expect(labelOf(command("meeting.stop"), IN_MIND, zh)).toBe("停止录制");

    stores.useMeetings.setState({ meetings: [meeting("m1", "mind-1", "recording")] });
    expect(labelOf(command("meeting.pauseResume"), IN_MIND, en)).toBe("Pause recording");
    expect(labelOf(command("meeting.pauseResume"), IN_MIND, zh)).toBe("暂停录制");
    stores.useMeetings.setState({ meetings: [meeting("m1", "mind-1", "paused")] });
    showing("mind-1");
    expect(labelOf(command("meeting.pauseResume"), IN_MIND, en)).toBe("Resume recording");
    expect(labelOf(command("meeting.pauseResume"), IN_MIND, zh)).toBe("继续录制");
  });

  test("Pause/Resume is ⌘⇧P on macOS and Ctrl+Shift+P elsewhere, a window-wide key", () => {
    const shortcut = command("meeting.pauseResume").shortcut;
    expect(shortcut?.list).toBeUndefined();
    expect(keysLabel(keysOn(shortcut?.keys ?? "", true), true)).toBe("⇧⌘P");
    expect(keysLabel(keysOn(shortcut?.keys ?? "", false), false)).toBe("Ctrl+Shift+P");
  });

  test("Stop can't be taken back, so it says so; the others can", () => {
    expect(command("meeting.record").reversible).toBe(true);
    expect(command("meeting.pauseResume").reversible).toBe(true);
    expect(command("meeting.stop").reversible).toEqual({
      confirm: "meetings.command.stopConfirm",
    });
  });

  test("Record is always offered, and Pause/Resume and Stop only where this copy can record and a meeting is live", () => {
    canRecord(false);
    expect(offered(command("meeting.record"), IN_MIND)).toBe(true);
    for (const id of ["meeting.pauseResume", "meeting.stop"] as const) {
      expect(offered(command(id), IN_MIND), id).toBe(false);
    }

    canRecord();
    expect(isEnabled(command("meeting.record"), IN_MIND)).toBe(true);
    for (const id of ["meeting.pauseResume", "meeting.stop"] as const) {
      expect(offered(command(id), IN_MIND), id).toBe(true);
      expect(command(id).enabled?.(IN_MIND), id).toEqual({
        reason: "meetings.command.noneLive",
      });
    }
    // A meeting that hasn't started, or has stopped, isn't live.
    stores.useMeetings.setState({
      meetings: [meeting("m1", "mind-1", "ready"), meeting("m2", "mind-2", "stopped")],
    });
    showing("mind-1");
    expect(isEnabled(command("meeting.pauseResume"), IN_MIND)).toBe(false);

    stores.useMeetings.setState({ meetings: [meeting("m1", "mind-1", "recording")] });
    expect(isEnabled(command("meeting.pauseResume"), IN_MIND)).toBe(true);
    expect(isEnabled(command("meeting.stop"), IN_MIND)).toBe(true);
  });

  test("act on the meeting in view, else on the one recording, from any Mind", async () => {
    canRecord();
    const pause = vi.fn(async () => {});
    const resume = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    stores.useMeetings.setState({
      pause,
      resume,
      stop,
      meetings: [meeting("m1", "mind-1", "recording"), meeting("m2", "mind-2", "paused")],
    });

    // In another Mind, ⌘⇧P pauses the meeting that records.
    showing("mind-3");
    await commands.run("meeting.pauseResume", IN_MIND);
    expect(pause).toHaveBeenCalledWith("m1");

    // In a paused meeting's Mind, it resumes that one.
    showing("mind-2");
    await commands.run("meeting.pauseResume", IN_MIND);
    expect(resume).toHaveBeenCalledWith("m2");
    await commands.run("meeting.stop", IN_MIND);
    expect(stop).toHaveBeenCalledWith("m2");
  });
});

describe("Pause my mic", () => {
  const micOf = (status: Meeting["status"], microphonePausedAtMs: number | null) =>
    ({ id: "m1", mindId: "mind-1", status, microphonePausedAtMs }) as Meeting;

  test("is named in English and Chinese, says which it will do, and is undone by itself", () => {
    canRecord();
    const mic = command("meeting.microphone");
    stores.useMeetings.setState({ meetings: [micOf("recording", null)] });
    expect(labelOf(mic, IN_MIND, en)).toBe("Pause my mic");
    expect(labelOf(mic, IN_MIND, zh)).toBe("暂停我的麦克风");
    stores.useMeetings.setState({ meetings: [micOf("recording", 12_000)] });
    expect(labelOf(mic, IN_MIND, en)).toBe("Resume my mic");
    expect(labelOf(mic, IN_MIND, zh)).toBe("恢复我的麦克风");
    expect(mic.reversible).toBe(true);
  });

  test("shows the global shortcut the meeting holds for it: ⌃⌥M by default on macOS, none elsewhere until one is set", () => {
    const settings = {
      device: { meetingHelpKeys: {} },
      meetingAudio: "both",
    } as unknown as Settings;
    stores.useAppStore.setState({ settings });
    expect(command("meeting.microphone").globalKeys?.()).toBe(
      process.platform === "darwin" ? "⌃⌥M" : null,
    );
    stores.useAppStore.setState({
      settings: {
        ...settings,
        device: { ...settings.device, meetingHelpKeys: { mic: "Ctrl+Alt+F8" } },
      } as Settings,
    });
    expect(command("meeting.microphone").globalKeys?.()).toMatch(/F8/);
    stores.useAppStore.setState({
      settings: {
        ...settings,
        device: { ...settings.device, meetingHelpKeys: { mic: "" } },
      } as Settings,
    });
    expect(command("meeting.microphone").globalKeys?.()).toBeNull();
  });

  test("shows no key the window binds itself, which works only over another app", () => {
    const window = process.platform === "darwin" ? "Cmd+Alt+L" : "Ctrl+Alt+L";
    stores.useAppStore.setState({
      settings: {
        device: { meetingHelpKeys: { mic: window, panel: "Ctrl+Alt+F8" } },
        meetingAudio: "both",
      } as unknown as Settings,
    });
    expect(command("meeting.microphone").globalKeys?.()).toBeNull();
    expect(command("meeting.panel").globalKeys?.()).toMatch(/F8/);
  });

  test("is offered where this copy can record, and works while a meeting records or is paused", () => {
    const mic = command("meeting.microphone");
    canRecord(false);
    expect(offered(mic, IN_MIND)).toBe(false);

    canRecord();
    expect(offered(mic, IN_MIND)).toBe(true);
    expect(mic.enabled?.(IN_MIND)).toEqual({ reason: "meetings.command.noneLive" });
    stores.useMeetings.setState({ meetings: [micOf("ready", null)] });
    showing("mind-1");
    expect(isEnabled(mic, IN_MIND)).toBe(false);
    stores.useMeetings.setState({ meetings: [micOf("recording", null)] });
    expect(isEnabled(mic, IN_MIND)).toBe(true);
    stores.useMeetings.setState({ meetings: [micOf("paused", null)] });
    expect(isEnabled(mic, IN_MIND)).toBe(true);
  });

  test("pauses the microphone of the meeting in view, or resumes it when it is paused", async () => {
    canRecord();
    const setMicrophonePaused = vi.fn(async () => {});
    stores.useMeetings.setState({ setMicrophonePaused, meetings: [micOf("recording", null)] });
    showing("mind-1");
    await commands.run("meeting.microphone", IN_MIND);
    expect(setMicrophonePaused).toHaveBeenLastCalledWith("m1", true);

    stores.useMeetings.setState({ meetings: [micOf("recording", 4000)] });
    await commands.run("meeting.microphone", IN_MIND);
    expect(setMicrophonePaused).toHaveBeenLastCalledWith("m1", false);
  });
});

describe("Mark (#139)", () => {
  test("is ⌘D on macOS and Ctrl+D elsewhere, a window-wide key, named in both languages", () => {
    const mark = command("meeting.mark");
    expect(mark.shortcut?.list).toBeUndefined();
    expect(keysLabel(keysOn(mark.shortcut?.keys ?? "", true), true)).toBe("⌘D");
    expect(keysLabel(keysOn(mark.shortcut?.keys ?? "", false), false)).toBe("Ctrl+D");
    expect(labelOf(mark, IN_MIND, en)).toBe("Mark this moment");
    expect(labelOf(mark, IN_MIND, zh)).toBe("标记此刻");
    expect(mark.reversible).toBe(true);
  });

  test("is offered where this copy can record, and works only while audio is recorded", () => {
    const mark = command("meeting.mark");
    canRecord(false);
    expect(offered(mark, IN_MIND)).toBe(false);

    canRecord();
    expect(offered(mark, IN_MIND)).toBe(true);
    expect(mark.enabled?.(IN_MIND)).toEqual({ reason: "meetings.command.noneLive" });

    stores.useMeetings.setState({ meetings: [meeting("m1", "mind-1", "paused")] });
    showing("mind-1");
    expect(mark.enabled?.(IN_MIND)).toEqual({ reason: "meetings.command.markPaused" });

    stores.useMeetings.setState({ meetings: [meeting("m1", "mind-1", "recording")] });
    expect(isEnabled(mark, IN_MIND)).toBe(true);
  });
});

describe("Recording details (#161)", () => {
  test("show and hide the details of the meeting in view once it has started, named in both languages", async () => {
    canRecord();
    const details = command("meeting.details");
    expect(details.reversible).toBe(true);
    expect(details.enabled?.(IN_MIND)).toEqual({ reason: "meetings.health.none" });
    stores.useMeetings.setState({ meetings: [meeting("m1", "mind-1", "ready")] });
    showing("mind-1");
    expect(isEnabled(details, IN_MIND)).toBe(false);

    stores.useMeetings.setState({
      meetings: [meeting("m1", "mind-1", "stopped")],
      detailsShown: {},
    });
    expect(isEnabled(details, IN_MIND)).toBe(true);
    expect(labelOf(details, IN_MIND, en)).toBe("Show recording details");
    expect(labelOf(details, IN_MIND, zh)).toBe("显示录制详情");
    await commands.run("meeting.details", IN_MIND);
    expect(stores.useMeetings.getState().detailsShown).toEqual({ m1: true });
    expect(labelOf(details, IN_MIND, en)).toBe("Hide recording details");
    expect(labelOf(details, IN_MIND, zh)).toBe("隐藏录制详情");
    await commands.run("meeting.details", IN_MIND);
    expect(stores.useMeetings.getState().detailsShown).toEqual({ m1: false });
  });

  test("are offered in a meeting's Mind even where this copy can't record", () => {
    const details = command("meeting.details");
    canRecord(false);
    expect(offered(details, IN_MIND)).toBe(false);
    stores.useMeetings.setState({ meetings: [meeting("m1", "mind-1", "stopped")] });
    showing("mind-1");
    expect(offered(details, IN_MIND)).toBe(true);
  });
});

describe("Delete audio (#609)", () => {
  const withAudio = (
    id: string,
    mindId: string,
    status: Meeting["status"],
    audio: Partial<Meeting["audio"]> = {},
  ): Meeting =>
    ({
      id,
      mindId,
      status,
      audio: { kept: true, expiresAt: null, deletedAt: null, ...audio },
    }) as Meeting;
  const deleteAudio = () => command("meeting.deleteAudio");
  const asked = () => useRequests.getState().deleteAudio;

  afterEach(() => useRequests.setState({ deleteAudio: null }));

  test("is named in both languages, and asks first with the question on the Meeting's line", () => {
    expect(labelOf(deleteAudio(), IN_MIND, en)).toBe("Delete audio");
    expect(labelOf(deleteAudio(), IN_MIND, zh)).toBe("删除音频");
    expect(deleteAudio().reversible).toEqual({ confirm: "meetings.audio.confirm" });
    expect(en("meetings.audio.confirm")).toContain("for good");
    expect(zh("meetings.audio.confirm")).toContain("永久删除");
  });

  test("is offered where this copy can record, or in a Meeting's Mind where it can't", () => {
    canRecord(false);
    expect(offered(deleteAudio(), IN_MIND)).toBe(false);
    stores.useMeetings.setState({ meetings: [withAudio("m1", "mind-1", "stopped")] });
    showing("mind-1");
    expect(offered(deleteAudio(), IN_MIND)).toBe(true);
    canRecord();
    stores.useMeetings.setState({ meetings: [] });
    expect(offered(deleteAudio(), IN_MIND)).toBe(true);
  });

  test("says why it can't run: no Meeting in view, a recording, or audio that is already gone", () => {
    canRecord();
    expect(deleteAudio().enabled?.(IN_MIND)).toEqual({
      reason: "meetings.command.noMeetingInView",
    });
    stores.useMeetings.setState({ meetings: [withAudio("m1", "mind-1", "ready")] });
    showing("mind-1");
    expect(deleteAudio().enabled?.(IN_MIND)).toEqual({
      reason: "meetings.command.noMeetingInView",
    });

    stores.useMeetings.setState({ meetings: [withAudio("m1", "mind-1", "recording")] });
    expect(deleteAudio().enabled?.(IN_MIND)).toEqual({
      reason: "meetings.command.audioWhileRecording",
    });

    stores.useMeetings.setState({
      meetings: [withAudio("m1", "mind-1", "stopped", { kept: false, deletedAt: "2026-10-13" })],
    });
    expect(deleteAudio().enabled?.(IN_MIND)).toEqual({ reason: "meetings.audio.deleted" });
    stores.useMeetings.setState({
      meetings: [withAudio("m1", "mind-1", "stopped", { kept: false })],
    });
    expect(deleteAudio().enabled?.(IN_MIND)).toEqual({ reason: "meetings.audio.none" });

    for (const status of ["paused", "stopped"] as const) {
      stores.useMeetings.setState({ meetings: [withAudio("m1", "mind-1", status)] });
      expect(isEnabled(deleteAudio(), IN_MIND), status).toBe(true);
    }
  });

  test("asks about the Meeting in view, or the Mind it is aimed at, and deletes nothing itself", async () => {
    canRecord();
    const deleteMeetingAudio = vi.fn(async () => {});
    stores.useMeetings.setState({
      deleteAudio: deleteMeetingAudio,
      meetings: [withAudio("m1", "mind-1", "stopped"), withAudio("m2", "mind-2", "paused")],
    });
    showing("mind-1");
    await commands.run("meeting.deleteAudio", IN_MIND);
    expect(asked()).toEqual({ meetingId: "m1" });

    // A line's own button is for its Meeting, whichever group has the focus.
    await commands.run("meeting.deleteAudio", {
      ...IN_MIND,
      focus: { kind: "mind", id: "mind-2" },
    });
    expect(asked()).toEqual({ meetingId: "m2" });
    expect(deleteMeetingAudio).not.toHaveBeenCalled();
  });

  test("asks nothing where it can't run", async () => {
    canRecord();
    stores.useMeetings.setState({
      meetings: [withAudio("m1", "mind-1", "stopped", { kept: false })],
    });
    showing("mind-1");
    await commands.run("meeting.deleteAudio", IN_MIND);
    expect(asked()).toBeNull();
  });
});
