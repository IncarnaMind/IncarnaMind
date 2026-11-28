/**
 * Coordinates immediate outside-agent writes with any renderer window currently showing a mounted
 * editable Note editor (#3839), so in-flight typing and IME compositions are never overwritten or
 * interrupted while keeping `src/core` free of Electron imports.
 */
import { randomUUID } from "node:crypto";
import { BrowserWindow, type IpcMainEvent, ipcMain } from "electron";
import type {
  Logger,
  OpenNoteAcceptInput,
  OpenNoteAcceptResult,
  OpenNoteEditor,
  OpenNotePrepareResult,
} from "../core/adapters";
import {
  FILES_CHANNELS,
  type OpenNoteWriteReply,
  type OpenNoteWriteRequest,
} from "../shared/bridge";

const PREPARE_TIMEOUT_MS = 5_000;
const ACCEPT_TIMEOUT_MS = 10_000;
const TOKEN_TTL_MS = 60_000;

interface PendingCall {
  window: BrowserWindow;
  resolve(reply: OpenNoteWriteReply): void;
  cleanup(): void;
}

interface TokenOwner {
  window: BrowserWindow;
  timer: ReturnType<typeof setTimeout>;
}

export interface OpenNoteEditorOptions {
  windows(): BrowserWindow[];
  trusted(event: IpcMainEvent): boolean;
  log: Logger;
}

function isReply(value: unknown): value is OpenNoteWriteReply {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.callId !== "string") return false;
  if (record.kind === "prepare") {
    if (record.open === false) return true;
    if (record.open === true && record.busy === true) return true;
    return record.open === true && record.busy === false && typeof record.token === "string";
  }
  if (record.kind === "accept") {
    return (
      record.result === "applied" || record.result === "changed" || record.result === "not-open"
    );
  }
  return false;
}

export function createOpenNoteEditor({
  windows,
  trusted,
  log,
}: OpenNoteEditorOptions): OpenNoteEditor {
  const pending = new Map<string, PendingCall>();
  const tokenOwners = new Map<string, TokenOwner>();

  const releaseToken = (token: string) => {
    const owner = tokenOwners.get(token);
    if (!owner) return;
    clearTimeout(owner.timer);
    tokenOwners.delete(token);
  };

  const rememberToken = (token: string, window: BrowserWindow) => {
    releaseToken(token);
    const timer = setTimeout(() => tokenOwners.delete(token), TOKEN_TTL_MS);
    timer.unref?.();
    tokenOwners.set(token, { window, timer });
  };

  ipcMain.on(FILES_CHANNELS.openNoteWriteReply, (event, payload: unknown) => {
    if (!trusted(event)) {
      log.warn("openNoteEditor.untrustedReply");
      return;
    }
    if (!isReply(payload)) return;
    const entry = pending.get(payload.callId);
    if (!entry) return;
    if (entry.window.isDestroyed() || entry.window.webContents !== event.sender) return;
    entry.cleanup();
    entry.resolve(payload);
  });

  const askWindow = (
    window: BrowserWindow,
    request: OpenNoteWriteRequest,
    timeoutMs: number,
    fallback: OpenNoteWriteReply,
  ): Promise<OpenNoteWriteReply> => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      return Promise.resolve(fallback);
    }
    return new Promise((resolve) => {
      const { callId } = request;
      const finish = (reply: OpenNoteWriteReply) => {
        cleanup();
        resolve(reply);
      };
      const onGone = () => finish(fallback);
      const timer = setTimeout(() => finish(fallback), timeoutMs);
      timer.unref?.();
      const cleanup = () => {
        clearTimeout(timer);
        pending.delete(callId);
        if (!window.isDestroyed()) window.off("closed", onGone);
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.off("render-process-gone", onGone);
        }
      };
      pending.set(callId, { window, resolve, cleanup });
      window.once("closed", onGone);
      window.webContents.once("render-process-gone", onGone);
      try {
        window.webContents.send(FILES_CHANNELS.openNoteWriteRequest, request);
      } catch {
        finish(fallback);
      }
    });
  };

  const orderedWindows = (): BrowserWindow[] => {
    const live = windows().filter((each) => !each.isDestroyed() && !each.webContents.isDestroyed());
    const focused = BrowserWindow.getFocusedWindow();
    if (!focused) return live;
    return [...live.filter((each) => each === focused), ...live.filter((each) => each !== focused)];
  };

  return {
    async prepareWrite(mindId: string): Promise<OpenNotePrepareResult> {
      const live = orderedWindows();
      if (live.length === 0) return { open: false };
      const answers = await Promise.all(
        live.map(async (window) => {
          const callId = randomUUID();
          const reply = await askWindow(
            window,
            { kind: "prepare", callId, mindId },
            PREPARE_TIMEOUT_MS,
            { kind: "prepare", callId, open: false },
          );
          return { window, reply };
        }),
      );
      if (answers.some(({ reply }) => reply.kind === "prepare" && reply.open && reply.busy)) {
        return { open: true, busy: true };
      }
      for (const { window, reply } of answers) {
        if (reply.kind === "prepare" && reply.open && !reply.busy) {
          rememberToken(reply.token, window);
          return { open: true, busy: false, token: reply.token };
        }
      }
      return { open: false };
    },

    async acceptInEditor(input: OpenNoteAcceptInput): Promise<OpenNoteAcceptResult> {
      const owner = tokenOwners.get(input.token);
      releaseToken(input.token);
      if (!owner || owner.window.isDestroyed() || owner.window.webContents.isDestroyed()) {
        return "not-open";
      }
      const callId = randomUUID();
      const reply = await askWindow(
        owner.window,
        { kind: "accept", callId, ...input },
        ACCEPT_TIMEOUT_MS,
        { kind: "accept", callId, result: "changed" },
      );
      return reply.kind === "accept" ? reply.result : "changed";
    },
  };
}
