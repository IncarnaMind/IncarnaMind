import { describe, expect, test } from "vitest";
import type { Meeting } from "../../src/core/api";
import { type TrayActions, type TrayState, trayMenu } from "../../src/main/trayMenu";

const did: string[] = [];
const actions: TrayActions = {
  open: () => did.push("open"),
  openRecording: (id) => did.push(`openRecording ${id}`),
  stopRecording: (id) => did.push(`stop ${id}`),
  takeOffer: (id) => did.push(`take ${id}`),
  declineOffer: (id, always) => did.push(`decline ${id} ${always}`),
  keepRecording: (id) => did.push(`keep ${id}`),
  settings: () => did.push("settings"),
  quit: () => did.push("quit"),
};

const NOW = Date.parse("2026-11-08T10:04:12.000Z");
const meeting = {
  id: "m1",
  mindId: "n1",
  status: "recording",
  recordedMs: 0,
  recordingSince: "2026-11-08T10:00:00.000Z",
} as Meeting;

const labels = (state: TrayState, platform: NodeJS.Platform = "darwin") =>
  trayMenu(state, actions, NOW, platform).map((item) =>
    item.type === "separator" ? "—" : `${item.label}${item.enabled === false ? " (off)" : ""}`,
  );

/** Clicks the menu's item `id`, as the menu would. */
function click(state: TrayState, id: string): void {
  const item = trayMenu(state, actions, NOW, "darwin").find((each) => each.id === id);
  if (!item?.click) throw new Error(`No item ${id}.`);
  (item.click as () => void)();
}

const idle: TrayState = { language: "en", recording: null, offer: null, ending: null };

describe("The menu bar icon's menu", () => {
  test("opens IncarnaMind, its Settings, and quits", () => {
    expect(labels(idle)).toEqual([
      "IncarnaMind (off)",
      "—",
      "Open IncarnaMind",
      "Settings…",
      "—",
      "Quit IncarnaMind",
    ]);
    click(idle, "tray.quit");
    expect(did.at(-1)).toBe("quit");
  });

  test("shows the recording with its time, and stops it", () => {
    const state = { ...idle, recording: { meeting, note: "Monday stand-up" } };
    expect(labels(state).slice(0, 3)).toEqual([
      "IncarnaMind (off)",
      "Recording · Monday stand-up  4:12",
      "Stop Recording",
    ]);
    click(state, "tray.stopRecording");
    expect(did.at(-1)).toBe("stop m1");
  });

  test("holds the offer for a call, with Take notes and Don't ask, in Chinese too", () => {
    const offer = { id: "o1", app: "slack", at: "2026-11-08T10:04:00.000Z" };
    expect(labels({ ...idle, offer }, "win32").slice(0, 3)).toEqual([
      "Huddle detected · Slack (off)",
      "Take notes",
      "Don’t ask for Slack",
    ]);
    expect(labels({ ...idle, language: "zh-CN", offer: { ...offer, app: "feishu" } })).toContain(
      "不再因 飞书 询问",
    );
    click({ ...idle, offer }, "tray.takeNotes");
    expect(did.at(-1)).toBe("take o1");
  });

  test("counts down a call's end, and keeps recording", () => {
    const state = {
      ...idle,
      recording: { meeting, note: "Call" },
      ending: { meetingId: "m1", app: "zoom", stopsAt: "2026-11-08T10:04:30.000Z" },
    };
    expect(labels(state)).toContain("Did your meeting end? Stopping in 18 seconds (off)");
    click(state, "tray.keepRecording");
    expect(did.at(-1)).toBe("keep m1");
  });
});
