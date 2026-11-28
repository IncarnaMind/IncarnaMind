/**
 * Multi-window D1 coordination for `createOpenNoteEditor` (#3839):
 * verifies that when two Electron windows hold the same Note (or a second window opens it between
 * `prepareWrite` and `acceptInEditor`), `acceptInEditor` verifies every other window before letting
 * the primary window mutate the document, refusing with `"changed"` if any other window became
 * busy, edited, or newly opened the Note.
 */
import type { BrowserWindow, IpcMainEvent } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FILES_CHANNELS,
  type OpenNoteWriteReply,
  type OpenNoteWriteRequest,
} from "../../src/shared/bridge";

type IpcListener = (event: IpcMainEvent, payload: unknown) => void;
const ipcListeners = new Map<string, IpcListener[]>();
let focusedWindow: BrowserWindow | null = null;

vi.mock("electron", () => ({
  ipcMain: {
    on(channel: string, listener: IpcListener) {
      const list = ipcListeners.get(channel) ?? [];
      list.push(listener);
      ipcListeners.set(channel, list);
    },
  },
  BrowserWindow: {
    getFocusedWindow: () => focusedWindow,
  },
}));

interface FakeWindow {
  window: BrowserWindow;
  requests: OpenNoteWriteRequest[];
}

function fakeWindow(
  handler: (request: OpenNoteWriteRequest) => OpenNoteWriteReply | null,
): FakeWindow {
  const requests: OpenNoteWriteRequest[] = [];
  const webContents = {
    isDestroyed: () => false,
    once: () => undefined,
    off: () => undefined,
    send(_channel: string, request: OpenNoteWriteRequest) {
      requests.push(request);
      const reply = handler(request);
      if (!reply) return;
      queueMicrotask(() => {
        const event = { sender: webContents } as unknown as IpcMainEvent;
        for (const listener of ipcListeners.get(FILES_CHANNELS.openNoteWriteReply) ?? []) {
          listener(event, reply);
        }
      });
    },
  };
  const window = {
    isDestroyed: () => false,
    once: () => undefined,
    off: () => undefined,
    webContents,
  } as unknown as BrowserWindow;
  return { window, requests };
}

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

afterEach(() => {
  ipcListeners.clear();
  focusedWindow = null;
});

describe("createOpenNoteEditor multi-window guard (#3839)", () => {
  // protects=SHOULD-FIX 3: when two windows both hold mindId, acceptInEditor verifies the second window first and refuses with "changed" without mutating Window 1 if Window 2 edited or started composing; fails_when=Window 1 receives accept despite Window 2 returning ok:false
  it("refuses with changed without mutating Window 1 when Window 2 fails verify", async () => {
    const { createOpenNoteEditor } = await import("../../src/main/openNoteEditor");
    const win1 = fakeWindow((req) => {
      if (req.kind === "prepare")
        return { kind: "prepare", callId: req.callId, open: true, busy: false, token: "tok-1" };
      if (req.kind === "verify") return { kind: "verify", callId: req.callId, ok: true };
      return { kind: "accept", callId: req.callId, result: "applied" };
    });
    const win2 = fakeWindow((req) => {
      if (req.kind === "prepare")
        return { kind: "prepare", callId: req.callId, open: true, busy: false, token: "tok-2" };
      if (req.kind === "verify") return { kind: "verify", callId: req.callId, ok: false };
      return null;
    });
    focusedWindow = win1.window;
    const editor = createOpenNoteEditor({
      windows: () => [win1.window, win2.window],
      trusted: () => true,
      log,
    });

    const prep = await editor.prepareWrite("mind-1");
    expect(prep).toEqual({ open: true, busy: false, token: "tok-1" });

    const outcome = await editor.acceptInEditor({
      mindId: "mind-1",
      request: "req-1",
      token: "tok-1",
      stateVector: new Uint8Array([0]),
      changed: 1,
      added: 0,
      tables: 0,
    });
    expect(outcome).toBe("changed");
    expect(win2.requests.some((req) => req.kind === "verify" && req.token === "tok-2")).toBe(true);
    expect(win1.requests.some((req) => req.kind === "accept")).toBe(false);
    // Primary token is released on refusal.
    expect(win1.requests.some((req) => req.kind === "verify" && req.token === "tok-1")).toBe(true);
  });

  // protects=SHOULD-FIX 3: when Window 2 verifies clean (ok: true), acceptInEditor proceeds to Window 1 and returns applied; fails_when=two clean windows fail to apply
  it("applies in Window 1 once Window 2 verifies clean", async () => {
    const { createOpenNoteEditor } = await import("../../src/main/openNoteEditor");
    const win1 = fakeWindow((req) => {
      if (req.kind === "prepare")
        return { kind: "prepare", callId: req.callId, open: true, busy: false, token: "tok-a" };
      if (req.kind === "accept") return { kind: "accept", callId: req.callId, result: "applied" };
      return { kind: "verify", callId: req.callId, ok: true };
    });
    const win2 = fakeWindow((req) => {
      if (req.kind === "prepare")
        return { kind: "prepare", callId: req.callId, open: true, busy: false, token: "tok-b" };
      if (req.kind === "verify") return { kind: "verify", callId: req.callId, ok: true };
      return null;
    });
    focusedWindow = win1.window;
    const editor = createOpenNoteEditor({
      windows: () => [win1.window, win2.window],
      trusted: () => true,
      log,
    });

    const prep = await editor.prepareWrite("mind-2");
    expect(prep).toEqual({ open: true, busy: false, token: "tok-a" });
    const outcome = await editor.acceptInEditor({
      mindId: "mind-2",
      request: "req-2",
      token: "tok-a",
      stateVector: new Uint8Array([0]),
      changed: 1,
      added: 0,
      tables: 0,
    });
    expect(outcome).toBe("applied");
    expect(win2.requests.some((req) => req.kind === "verify" && req.token === "tok-b")).toBe(true);
    expect(win1.requests.some((req) => req.kind === "accept")).toBe(true);
  });

  // protects=SHOULD-FIX 3: if a second window opens mindId between prepareWrite and acceptInEditor, acceptInEditor detects it and refuses with changed without mutating Window 1; fails_when=newly opened window is missed
  it("refuses with changed if a second window opens the Note between prepare and accept", async () => {
    const { createOpenNoteEditor } = await import("../../src/main/openNoteEditor");
    let win2Open = false;
    const win1 = fakeWindow((req) => {
      if (req.kind === "prepare")
        return { kind: "prepare", callId: req.callId, open: true, busy: false, token: "tok-x" };
      if (req.kind === "accept") return { kind: "accept", callId: req.callId, result: "applied" };
      return { kind: "verify", callId: req.callId, ok: true };
    });
    const win2 = fakeWindow((req) => {
      if (req.kind === "prepare") {
        return win2Open
          ? { kind: "prepare", callId: req.callId, open: true, busy: false, token: "tok-late" }
          : { kind: "prepare", callId: req.callId, open: false };
      }
      return { kind: "verify", callId: req.callId, ok: true };
    });
    focusedWindow = win1.window;
    const editor = createOpenNoteEditor({
      windows: () => [win1.window, win2.window],
      trusted: () => true,
      log,
    });

    const prep = await editor.prepareWrite("mind-3");
    expect(prep).toEqual({ open: true, busy: false, token: "tok-x" });
    // Window 2 opens mind-3 before acceptInEditor runs.
    win2Open = true;
    const outcome = await editor.acceptInEditor({
      mindId: "mind-3",
      request: "req-3",
      token: "tok-x",
      stateVector: new Uint8Array([0]),
      changed: 1,
      added: 0,
      tables: 0,
    });
    expect(outcome).toBe("changed");
    expect(win1.requests.some((req) => req.kind === "accept")).toBe(false);
    expect(win2.requests.some((req) => req.kind === "verify" && req.token === "tok-late")).toBe(
      true,
    );
  });
});
