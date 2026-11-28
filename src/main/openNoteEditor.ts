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
  mindId: string;
  window: BrowserWindow;
  others: { window: BrowserWindow; token: string }[];
  timer: ReturnType<typeof setTimeout>;
}

export interface OpenNoteEditorOptions {
  windows(): BrowserWindow[];
  trusted(event: IpcMainEvent): boolean;
  log: Logger;
  prepareTimeoutMs?: number;
  acceptTimeoutMs?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  if (record.kind === "verify") {
    return typeof record.ok === "boolean";
  }
  if (record.kind === "accept") {
    return (
      record.result === "applied" ||
      record.result === "changed" ||
      record.result === "held" ||
      record.result === "failed" ||
      record.result === "not-open"
    );
  }
  return false;
}

export function createOpenNoteEditor({
  windows,
  trusted,
  log,
  prepareTimeoutMs = PREPARE_TIMEOUT_MS,
  acceptTimeoutMs = ACCEPT_TIMEOUT_MS,
}: OpenNoteEditorOptions): OpenNoteEditor {
  const pending = new Map<string, PendingCall>();
  const tokenOwners = new Map<string, TokenOwner>();

  const releaseToken = (token: string) => {
    const owner = tokenOwners.get(token);
    if (!owner) return;
    clearTimeout(owner.timer);
    tokenOwners.delete(token);
  };

  const rememberToken = (
    token: string,
    mindId: string,
    window: BrowserWindow,
    others: { window: BrowserWindow; token: string }[],
  ) => {
    releaseToken(token);
    const timer = setTimeout(() => tokenOwners.delete(token), TOKEN_TTL_MS);
    timer.unref?.();
    tokenOwners.set(token, { mindId, window, others, timer });
  };

  ipcMain.on(FILES_CHANNELS.openNoteWriteReply, (event, payload: unknown) => {
    if (!trusted(event)) {
      log.warn("openNoteEditor.untrustedReply");
      return;
    }
    if (!isReply(payload)) {
      log.warn("openNoteEditor.invalidReply");
      return;
    }
    const entry = pending.get(payload.callId);
    if (!entry) {
      log.warn("openNoteEditor.unexpectedReply", {
        callId: payload.callId,
        kind: payload.kind,
      });
      return;
    }
    if (entry.window.isDestroyed() || entry.window.webContents !== event.sender) {
      log.warn("openNoteEditor.senderMismatch", {
        callId: payload.callId,
        kind: payload.kind,
      });
      return;
    }
    entry.cleanup();
    entry.resolve(payload);
  });

  const askWindow = (
    window: BrowserWindow,
    request: OpenNoteWriteRequest,
    timeoutMs: number,
    fallback: OpenNoteWriteReply,
    goneFallback: OpenNoteWriteReply = fallback,
  ): Promise<OpenNoteWriteReply> => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      log.warn("openNoteEditor.windowDestroyed", {
        kind: request.kind,
        mindId: request.mindId,
        callId: request.callId,
      });
      return Promise.resolve(goneFallback);
    }
    return new Promise((resolve) => {
      const { callId } = request;
      const finish = (reply: OpenNoteWriteReply) => {
        cleanup();
        resolve(reply);
      };
      const onGone = () => {
        log.warn("openNoteEditor.windowGone", {
          kind: request.kind,
          mindId: request.mindId,
          callId,
        });
        finish(goneFallback);
      };
      const timer = setTimeout(() => {
        log.warn("openNoteEditor.timeout", {
          kind: request.kind,
          mindId: request.mindId,
          callId,
          timeoutMs,
        });
        finish(fallback);
      }, timeoutMs);
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
      } catch (error) {
        log.warn("openNoteEditor.sendFailed", {
          kind: request.kind,
          mindId: request.mindId,
          callId,
          error: errorMessage(error),
        });
        finish(window.isDestroyed() || window.webContents.isDestroyed() ? goneFallback : fallback);
      }
    });
  };

  const orderedWindows = (): BrowserWindow[] => {
    const live = windows().filter((each) => !each.isDestroyed() && !each.webContents.isDestroyed());
    const focused = BrowserWindow.getFocusedWindow();
    if (!focused) return live;
    return [...live.filter((each) => each === focused), ...live.filter((each) => each !== focused)];
  };

  const releaseRemote = (window: BrowserWindow, mindId: string, token: string) => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    try {
      window.webContents.send(FILES_CHANNELS.openNoteWriteRequest, {
        kind: "cancel",
        callId: randomUUID(),
        mindId,
        request: "",
        token,
      } satisfies OpenNoteWriteRequest);
    } catch (error) {
      log.warn("openNoteEditor.releaseFailed", {
        mindId,
        error: errorMessage(error),
      });
    }
  };

  const cancelRemote = (window: BrowserWindow, mindId: string, request: string, token: string) => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    try {
      window.webContents.send(FILES_CHANNELS.openNoteWriteRequest, {
        kind: "cancel",
        callId: randomUUID(),
        mindId,
        request,
        token,
      } satisfies OpenNoteWriteRequest);
    } catch (error) {
      log.warn("openNoteEditor.cancelFailed", {
        mindId,
        request,
        error: errorMessage(error),
      });
    }
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
            prepareTimeoutMs,
            { kind: "prepare", callId, open: true, busy: true },
            { kind: "prepare", callId, open: false },
          );
          return { window, reply };
        }),
      );
      const ready: { window: BrowserWindow; token: string }[] = [];
      let busy = false;
      for (const { window, reply } of answers) {
        if (reply.kind !== "prepare" || !reply.open) continue;
        if (reply.busy) busy = true;
        else ready.push({ window, token: reply.token });
      }
      if (busy) {
        for (const item of ready) releaseRemote(item.window, mindId, item.token);
        return { open: true, busy: true };
      }
      const [primary, ...others] = ready;
      if (!primary) return { open: false };
      rememberToken(primary.token, mindId, primary.window, others);
      return { open: true, busy: false, token: primary.token };
    },

    async acceptInEditor(input: OpenNoteAcceptInput): Promise<OpenNoteAcceptResult> {
      const owner = tokenOwners.get(input.token);
      releaseToken(input.token);
      if (!owner || owner.mindId !== input.mindId) return "not-open";
      const releaseAllOthers = () => {
        for (const other of owner.others) releaseRemote(other.window, input.mindId, other.token);
      };
      if (owner.window.isDestroyed() || owner.window.webContents.isDestroyed()) {
        releaseAllOthers();
        return "not-open";
      }
      const otherTokens = new Map(owner.others.map((each) => [each.window, each.token]));
      const otherLive = orderedWindows().filter((window) => window !== owner.window);
      const checks = await Promise.all(
        otherLive.map(async (window) => {
          const otherToken = otherTokens.get(window);
          if (otherToken !== undefined) {
            const callId = randomUUID();
            const reply = await askWindow(
              window,
              { kind: "verify", callId, mindId: input.mindId, token: otherToken },
              prepareTimeoutMs,
              { kind: "verify", callId, ok: false },
            );
            return reply.kind === "verify" && reply.ok;
          }
          // Window didn't hold `mindId` at prepareWrite (or opened since): refuse if it now holds it.
          const callId = randomUUID();
          const reply = await askWindow(
            window,
            { kind: "prepare", callId, mindId: input.mindId },
            prepareTimeoutMs,
            { kind: "prepare", callId, open: true, busy: true },
          );
          if (reply.kind === "prepare" && reply.open) {
            if (!reply.busy) releaseRemote(window, input.mindId, reply.token);
            return false;
          }
          return true;
        }),
      );
      if (checks.some((ok) => !ok)) {
        releaseRemote(owner.window, input.mindId, input.token);
        return "changed";
      }
      const callId = randomUUID();
      const reply = await askWindow(
        owner.window,
        { kind: "accept", callId, ...input },
        acceptTimeoutMs,
        { kind: "accept", callId, result: "timeout" },
      );
      if (reply.kind !== "accept") {
        cancelRemote(owner.window, input.mindId, input.request, input.token);
        return "timeout";
      }
      if (reply.result === "timeout") {
        cancelRemote(owner.window, input.mindId, input.request, input.token);
      }
      return reply.result;
    },
  };
}
