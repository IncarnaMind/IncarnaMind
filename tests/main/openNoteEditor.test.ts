/**
 * Multi-window and timeout coordination for `createOpenNoteEditor` (#3839):
 * verifies that when two Electron windows hold the same Note (or a second window opens it between
 * `prepareWrite` and `acceptInEditor`), `acceptInEditor` verifies every other window before letting
 * the primary window mutate the document, refusing with `"changed"` if any other window became
 * busy, edited, or newly opened the Note; and that on accept timeout it logs, cancels the renderer
 * request, and returns `"timeout"` so core confirms against the document instead of guessing.
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
): FakeWindow & { close(): void } {
  const requests: OpenNoteWriteRequest[] = [];
  let destroyed = false;
  const closedListeners = new Set<() => void>();
  const webContents = {
    isDestroyed: () => destroyed,
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
    isDestroyed: () => destroyed,
    once(event: string, listener: () => void) {
      if (event === "closed") closedListeners.add(listener);
    },
    off(event: string, listener: () => void) {
      if (event === "closed") closedListeners.delete(listener);
    },
    webContents,
  } as unknown as BrowserWindow;
  return {
    window,
    requests,
    close() {
      destroyed = true;
      for (const listener of [...closedListeners]) {
        closedListeners.delete(listener);
        listener();
      }
    },
  };
}

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

afterEach(() => {
  ipcListeners.clear();
  focusedWindow = null;
  log.info.mockClear();
  log.warn.mockClear();
  log.error.mockClear();
});

describe("createOpenNoteEditor multi-window guard and timeout handling (#3839)", () => {
  // protects=when two windows both hold mindId, acceptInEditor verifies the second window first and refuses with "changed" without mutating Window 1 if Window 2 edited or started composing (#3839); fails_when=Window 1 receives accept despite Window 2 returning ok:false
  it("refuses with changed without mutating Window 1 when Window 2 fails verify", async () => {
    const { createOpenNoteEditor } = await import("../../src/main/openNoteEditor");
    const win1 = fakeWindow((req) => {
      if (req.kind === "prepare")
        return { kind: "prepare", callId: req.callId, open: true, busy: false, token: "tok-1" };
      if (req.kind === "verify") return { kind: "verify", callId: req.callId, ok: true };
      if (req.kind === "accept") return { kind: "accept", callId: req.callId, result: "applied" };
      return null;
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
    // Primary token is released via one-way cancel without generating spurious unexpectedReply logs.
    expect(win1.requests.some((req) => req.kind === "cancel" && req.token === "tok-1")).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
  });

  // protects=when Window 2 verifies clean (ok: true), acceptInEditor proceeds to Window 1 and returns applied (#3839); fails_when=two clean windows fail to apply
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

  // protects=if a second window opens mindId between prepareWrite and acceptInEditor, acceptInEditor detects it and refuses with changed without mutating Window 1 (#3839); fails_when=newly opened window is missed
  it("refuses with changed if a second window opens the Note between prepare and accept", async () => {
    const { createOpenNoteEditor } = await import("../../src/main/openNoteEditor");
    let win2Open = false;
    const win1 = fakeWindow((req) => {
      if (req.kind === "prepare")
        return { kind: "prepare", callId: req.callId, open: true, busy: false, token: "tok-x" };
      if (req.kind === "accept") return { kind: "accept", callId: req.callId, result: "applied" };
      if (req.kind === "verify") return { kind: "verify", callId: req.callId, ok: true };
      return null;
    });
    const win2 = fakeWindow((req) => {
      if (req.kind === "prepare") {
        return win2Open
          ? { kind: "prepare", callId: req.callId, open: true, busy: false, token: "tok-late" }
          : { kind: "prepare", callId: req.callId, open: false };
      }
      if (req.kind === "verify") return { kind: "verify", callId: req.callId, ok: true };
      return null;
    });
    focusedWindow = win1.window;
    const editor = createOpenNoteEditor({
      windows: () => [win1.window, win2.window],
      trusted: () => true,
      log,
    });

    const prep = await editor.prepareWrite("mind-3");
    expect(prep).toEqual({ open: true, busy: false, token: "tok-x" });
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
    expect(win2.requests.some((req) => req.kind === "cancel" && req.token === "tok-late")).toBe(
      true,
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  // protects=when acceptInEditor times out waiting for the renderer reply, main returns "timeout" (never guessing "changed"), logs the timeout, and sends a cancel message so a slow renderer will not apply late (#3839); fails_when=timeout assumes changed or skips cancel
  it("returns timeout, logs warning, and sends cancel to the renderer when accept times out", async () => {
    const { createOpenNoteEditor } = await import("../../src/main/openNoteEditor");
    const win1 = fakeWindow((req) => {
      if (req.kind === "prepare")
        return { kind: "prepare", callId: req.callId, open: true, busy: false, token: "tok-to" };
      // Never replies to "accept".
      return null;
    });
    focusedWindow = win1.window;
    const editor = createOpenNoteEditor({
      windows: () => [win1.window],
      trusted: () => true,
      log,
      acceptTimeoutMs: 40,
    });

    const prep = await editor.prepareWrite("mind-timeout");
    expect(prep).toEqual({ open: true, busy: false, token: "tok-to" });

    const outcome = await editor.acceptInEditor({
      mindId: "mind-timeout",
      request: "req-timeout",
      token: "tok-to",
      stateVector: new Uint8Array([0]),
      changed: 1,
      added: 0,
      tables: 0,
    });
    expect(outcome).toBe("timeout");
    expect(log.warn).toHaveBeenCalledWith(
      "openNoteEditor.timeout",
      expect.objectContaining({ kind: "accept", mindId: "mind-timeout", timeoutMs: 40 }),
    );
    expect(
      win1.requests.some(
        (req) =>
          req.kind === "cancel" &&
          req.mindId === "mind-timeout" &&
          req.request === "req-timeout" &&
          req.token === "tok-to",
      ),
    ).toBe(true);
  });

  // protects=when a live window times out on prepareWrite, main returns busy instead of open: false so a slow or composing renderer cannot look like a closed Note, while confirmed closed or not-open windows still return open: false (#3839); fails_when=prepare timeout returns open: false
  it("returns busy instead of open: false when a live window times out on prepareWrite, while keeping open: false for confirmed absence", async () => {
    const { createOpenNoteEditor } = await import("../../src/main/openNoteEditor");

    // 1. Live window never answers prepare -> must fail closed as busy, never open: false.
    const hung = fakeWindow(() => null);
    focusedWindow = hung.window;
    const editorHung = createOpenNoteEditor({
      windows: () => [hung.window],
      trusted: () => true,
      log,
      prepareTimeoutMs: 40,
    });
    expect(await editorHung.prepareWrite("mind-hung")).toEqual({ open: true, busy: true });
    expect(log.warn).toHaveBeenCalledWith(
      "openNoteEditor.timeout",
      expect.objectContaining({ kind: "prepare", mindId: "mind-hung", timeoutMs: 40 }),
    );

    // 2. One ready window + one hung window -> must return busy and release the ready window's token.
    const readyWin = fakeWindow((req) =>
      req.kind === "prepare"
        ? { kind: "prepare", callId: req.callId, open: true, busy: false, token: "tok-rel" }
        : null,
    );
    const slowWin = fakeWindow(() => null);
    const editorMixed = createOpenNoteEditor({
      windows: () => [readyWin.window, slowWin.window],
      trusted: () => true,
      log,
      prepareTimeoutMs: 40,
    });
    expect(await editorMixed.prepareWrite("mind-mixed")).toEqual({ open: true, busy: true });
    expect(readyWin.requests.some((req) => req.kind === "cancel" && req.token === "tok-rel")).toBe(
      true,
    );

    // 3. Window closes during prepare -> confirmed absence -> open: false.
    const closing = fakeWindow(() => null);
    const editorClosing = createOpenNoteEditor({
      windows: () => [closing.window],
      trusted: () => true,
      log,
      prepareTimeoutMs: 200,
    });
    const pendingClose = editorClosing.prepareWrite("mind-closed");
    queueMicrotask(() => closing.close());
    expect(await pendingClose).toEqual({ open: false });

    // 4. Live window explicitly confirms not open -> open: false.
    const confirmedClosed = fakeWindow((req) =>
      req.kind === "prepare" ? { kind: "prepare", callId: req.callId, open: false } : null,
    );
    const editorConfirmed = createOpenNoteEditor({
      windows: () => [confirmedClosed.window],
      trusted: () => true,
      log,
      prepareTimeoutMs: 40,
    });
    expect(await editorConfirmed.prepareWrite("mind-absent")).toEqual({ open: false });
  });
});
