/**
 * Where a Canvas an outside agent wrote is drawn (#3406): a `<webview>` in its tab, so the app's
 * menus and cards draw over it, as a guest of its own: its own renderer process and its own session,
 * held in memory, that serves nothing but its own scheme. Every response carries a content policy
 * that sandboxes the page, with scripts but no network; the session cancels every other request,
 * sends every connection it would make (WebRTC's TURN over TCP and preconnect hints among them) to a
 * proxy on this computer that closes it unread, and turns WebRTC's UDP off; DNS prefetch is off in
 * its renderer. Permissions, downloads, navigation, redirects, new windows and webviews of its own
 * are refused; a website it tries to open is only offered to the User. A Canvas past its memory is
 * stopped. Its one way out is `CANVAS_CHANNEL`, from its preload, each message checked by its
 * sender, its frame's address and its shape before the window hears it; nothing is ever sent in.
 */
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import {
  app,
  type BrowserWindow,
  type CustomScheme,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  session,
  type WebContents,
  type WebPreferences,
} from "electron";
import type { Core, Logger } from "../core";
import { FILES_CHANNELS } from "../shared/bridge";
import {
  CANVAS_CHANNEL,
  CANVAS_PARTITION,
  CANVAS_SCHEME,
  type CanvasDrop,
  type CanvasFrameNews,
  canvasFrameUrl,
  canvasHostOf,
  offeredLink,
  readCanvasMessage,
} from "../shared/canvases";
import { KEYS_FROM_CANVASES } from "../shared/commands";
import { keysForm } from "../shared/keyForms";

/** Registered with the app's other privileged schemes, before it is ready (index.ts). */
export const CANVAS_SCHEME_PRIVILEGES: CustomScheme = {
  scheme: CANVAS_SCHEME,
  // Standard, so a page's files resolve by their names. Not secure, so the page is no secure
  // context: no clipboard, service workers or device APIs. No fetch, CORS or CSP bypass.
  privileges: { standard: true },
};

/** A page using more than this is stopped: far past what a report or a dashboard needs. */
const MEMORY_LIMIT_MB = 1024;
const MEMORY_CHECK_MS = 1000;
/** Messages a Canvas may send in a second; past it, they are dropped. */
const MESSAGES_A_SECOND = 30;
/** A drop's reason is logged once in this long for each Canvas, with how many there were. */
const DROPS_LOGGED_EVERY_MS = 10_000;

const MAC = process.platform === "darwin";

/** The window's own keys a Canvas passes on, in `keysForm`'s form. */
const WINDOW_KEYS = new Set(
  Object.values(KEYS_FROM_CANVASES).map((keys) =>
    keysForm(typeof keys === "string" ? keys : MAC ? keys.mac : keys.other, MAC),
  ),
);

const formOf = (input: Electron.Input) =>
  [
    input.meta && "meta",
    input.control && "ctrl",
    input.alt && "alt",
    input.shift && "shift",
    input.code,
  ]
    .filter(Boolean)
    .join("+");

const policy = (host: string) => {
  const own = `${CANVAS_SCHEME}://${host}`;
  return [
    // Scripts, and new windows only so that their addresses reach the handler that refuses them.
    "sandbox allow-scripts allow-popups",
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${own}`,
    `style-src 'unsafe-inline' ${own}`,
    `img-src ${own} data: blob:`,
    `font-src ${own} data:`,
    `media-src ${own} data: blob:`,
    "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
};

const FEATURES_OFF = [
  "camera",
  "microphone",
  "geolocation",
  "display-capture",
  "clipboard-read",
  "clipboard-write",
  "fullscreen",
  "payment",
  "usb",
  "serial",
  "hid",
  "bluetooth",
  "midi",
  "publickey-credentials-get",
  "screen-wake-lock",
  "web-share",
  "xr-spatial-tracking",
  "idle-detection",
  "local-fonts",
  "window-management",
]
  .map((feature) => `${feature}=()`)
  .join(", ");

const headers = (host: string, type: string) => ({
  "Content-Type": type,
  "Content-Security-Policy": policy(host),
  "Permissions-Policy": FEATURES_OFF,
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
});

/** What a Canvas's guest is, while it is drawn. */
interface Guest {
  contents: WebContents;
  /** It was stopped for its memory: its end says so. */
  stoppedForMemory: boolean;
  sent: number[];
  drops: Map<CanvasDrop, { count: number; loggedAt: number }>;
}

export interface CanvasOptions {
  log: Logger;
  /** Whether a call comes from the app's own page. */
  trusted(event: IpcMainInvokeEvent): boolean;
  /** Test builds lower it, so a test sees a Canvas stopped without using a gigabyte. */
  memoryLimitMb?: number;
}

/** A proxy on this computer that closes each connection it takes, reading nothing from it. */
async function startRefusingProxy(): Promise<Server> {
  const server = createServer((socket) => socket.destroy());
  server.on("error", () => undefined);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  server.unref();
  return server;
}

/**
 * Serves Canvases to the app's windows: their session and scheme, the guard on every guest, and the
 * one channel out of them. Called once the core has started, before a window can show one.
 */
export async function serveCanvases(core: Core, options: CanvasOptions): Promise<void> {
  const { log } = options;
  const limitKb = (options.memoryLimitMb ?? MEMORY_LIMIT_MB) * 1024;
  const guests = new Map<number, Guest>();
  const canvasSession = session.fromPartition(CANVAS_PARTITION, { cache: false });

  const notFound = (host: string) =>
    new Response("Not found", { status: 404, headers: headers(host, "text/plain") });
  canvasSession.protocol.handle(CANVAS_SCHEME, async (request) => {
    const host = canvasHostOf(request.url) ?? "invalid";
    if (request.method !== "GET" || host === "invalid") return notFound(host);
    const served = await core.serveCanvas(host, new URL(request.url).pathname).catch((error) => {
      log.error("canvas.serveFailed", { message: error instanceof Error ? error.name : "unknown" });
      return null;
    });
    return served
      ? new Response(Buffer.from(served.bytes), { headers: headers(host, served.type) })
      : notFound(host);
  });
  canvasSession.webRequest.onBeforeRequest((details, callback) => {
    const host = canvasHostOf(details.url);
    // A page asks only for its own showing's address, never another Canvas's.
    const from =
      details.resourceType === "mainFrame" ? host : canvasHostOf(details.frame?.url ?? "");
    const allowed = host !== null && host === from && core.canvasShowing(host) !== null;
    if (!allowed) log.info("canvas.requestCancelled", { kind: details.resourceType });
    callback({ cancel: !allowed });
  });
  canvasSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  canvasSession.setPermissionCheckHandler(() => false);
  canvasSession.setDevicePermissionHandler(() => false);
  canvasSession.setDisplayMediaRequestHandler((_request, callback) => callback(null));
  canvasSession.on("will-download", (event) => event.preventDefault());
  canvasSession.setSpellCheckerEnabled(false);
  const proxy = await startRefusingProxy();
  const address = proxy.address();
  const port = typeof address === "object" && address ? address.port : 0;
  // Loopback too goes through it: Chromium would reach this computer directly otherwise.
  await canvasSession.setProxy({
    proxyRules: `socks5://127.0.0.1:${port}`,
    proxyBypassRules: "<-loopback>",
  });
  app.once("will-quit", () => proxy.close());

  const tell = (contents: WebContents, news: CanvasFrameNews) => {
    const window = contents.hostWebContents;
    if (window && !window.isDestroyed()) window.send(FILES_CHANNELS.canvasFrame, news);
  };
  const hostOf = (contents: WebContents) =>
    contents.isDestroyed() ? null : canvasHostOf(contents.getURL());

  /** A website the Canvas tried to open: the User is offered it, and the Canvas stays. */
  const offer = (contents: WebContents, url: string) => {
    const host = hostOf(contents);
    const link = offeredLink(url);
    if (host && link) tell(contents, { host, kind: "link", url: link });
  };

  const guard = (contents: WebContents) => {
    const guest: Guest = { contents, stoppedForMemory: false, sent: [], drops: new Map() };
    guests.set(contents.id, guest);
    contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    contents.setWindowOpenHandler(({ url }) => {
      offer(contents, url);
      return { action: "deny" };
    });
    contents.on("will-frame-navigate", (event) => {
      // A link to a place on the page stays on it.
      if (event.isSameDocument) return;
      event.preventDefault();
      if (event.isMainFrame) offer(contents, event.url);
    });
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("will-redirect", (event) => event.preventDefault());
    contents.on("will-attach-webview", (event) => event.preventDefault());
    // The window's own shortcuts still work here; every other key is the page's. Esc is both: it
    // closes what the page has open, and what the window has.
    contents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.isAutoRepeat) return;
      const esc =
        input.key === "Escape" && !input.meta && !input.control && !input.alt && !input.shift;
      if (!esc && !WINDOW_KEYS.has(formOf(input))) return;
      const host = hostOf(contents);
      if (!host) return;
      if (!esc) event.preventDefault();
      tell(contents, {
        host,
        kind: "key",
        key: input.key,
        code: input.code,
        meta: input.meta,
        ctrl: input.control,
        alt: input.alt,
        shift: input.shift,
      });
    });
    contents.on("render-process-gone", (_event, details) => {
      const host = hostOf(contents);
      if (details.reason === "clean-exit" || !host) return;
      log.warn("canvas.stopped", { reason: guest.stoppedForMemory ? "memory" : details.reason });
      tell(contents, {
        host,
        kind: "stopped",
        reason: guest.stoppedForMemory ? "memory" : "crashed",
      });
    });
    contents.once("destroyed", () => guests.delete(contents.id));
    watchMemory();
  };

  let watching: ReturnType<typeof setInterval> | undefined;
  const watchMemory = () => {
    if (watching) return;
    watching = setInterval(() => {
      if (guests.size === 0) {
        clearInterval(watching);
        watching = undefined;
        return;
      }
      const metrics = app.getAppMetrics();
      for (const guest of guests.values()) {
        if (guest.contents.isDestroyed() || guest.stoppedForMemory) continue;
        const pid = guest.contents.getOSProcessId();
        const memory = metrics.find((each) => each.pid === pid)?.memory.workingSetSize ?? 0;
        if (memory > limitKb) {
          guest.stoppedForMemory = true;
          guest.contents.forcefullyCrashRenderer();
        }
      }
    }, MEMORY_CHECK_MS);
    watching.unref();
  };

  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() === "webview") guard(contents);
  });

  const unknownDrops: Guest["drops"] = new Map();
  const dropped = (guest: Guest | null, reason: CanvasDrop) => {
    const now = Date.now();
    const drops = guest?.drops ?? unknownDrops;
    const seen = drops.get(reason) ?? { count: 0, loggedAt: 0 };
    seen.count += 1;
    if (now - seen.loggedAt >= DROPS_LOGGED_EVERY_MS) {
      log.warn("canvas.messageDropped", { reason, count: seen.count });
      seen.count = 0;
      seen.loggedAt = now;
    }
    drops.set(reason, seen);
  };

  ipcMain.on(CANVAS_CHANNEL, (event: IpcMainEvent, value: unknown) => {
    const guest = guests.get(event.sender.id) ?? null;
    // From the page at its own showing's address alone, never a frame inside it or a page it
    // went to: the guest's frame and address, not only its process, are what is trusted.
    const host =
      guest && event.senderFrame && event.senderFrame === event.sender.mainFrame
        ? canvasHostOf(event.senderFrame.url)
        : null;
    if (!guest || !host || host !== hostOf(event.sender) || core.canvasShowing(host) === null) {
      dropped(guest, "unknown-sender");
      return;
    }
    const now = Date.now();
    guest.sent = guest.sent.filter((at) => now - at < 1000);
    if (guest.sent.length >= MESSAGES_A_SECOND) {
      dropped(guest, "too-many");
      return;
    }
    guest.sent.push(now);
    const read = readCanvasMessage(value);
    if ("dropped" in read) {
      dropped(guest, read.dropped);
      return;
    }
    log.info("canvas.citationAsked");
    tell(event.sender, { host, ...read.message });
  });
}

/** Lets the app's window draw Canvases in `<webview>`, each with these preferences and no other. */
export function allowCanvases(
  window: BrowserWindow,
  core: () => Core | undefined,
  log: Logger,
): void {
  window.webContents.on("will-attach-webview", (event, preferences, params) => {
    const src = params.src ?? "";
    const host = canvasHostOf(src);
    const showing = host === null ? null : (core()?.canvasShowing(host) ?? null);
    if (!host || src !== canvasFrameUrl(host) || showing === null) {
      log.warn("canvas.viewRefused");
      event.preventDefault();
      return;
    }
    for (const key of Object.keys(preferences) as (keyof WebPreferences)[]) delete preferences[key];
    Object.assign(preferences, {
      preload: join(__dirname, "../preload/canvas.js"),
      partition: CANVAS_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      plugins: false,
      javascript: true,
      disableDialogs: true,
      navigateOnDragDrop: false,
      spellcheck: false,
      devTools: !app.isPackaged,
      autoplayPolicy: "document-user-activation-required",
      // A DNS prefetch hint would look a name up through the User's resolver, past every proxy.
      additionalArguments: ["--blink-settings=dnsPrefetchingEnabled=false"],
    } satisfies WebPreferences);
  });
}
