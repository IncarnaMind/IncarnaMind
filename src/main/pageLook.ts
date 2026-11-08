/**
 * Keeps a web page as it looks: the core's `PageLook`. Each page is loaded
 * once, alone, in a hidden page (./hiddenPage) of a session held only in
 * memory and cleared after it, which reaches the network only through a
 * proxy that connects only to the public internet (./lookProxy). It keeps no
 * cookies or storage, and is refused permissions, pop-ups, downloads,
 * printing, WebRTC outside the proxy and navigation away from the page. Once
 * the page has loaded, or the wait for it is over, it is printed as the
 * screen shows it, and the page is destroyed: all within the time limit.
 */
import { once } from "node:events";
import { type Session, session, type WebContents } from "electron";
import type { Logger, PageLook, WebPageLookFailure } from "../core";
import type { Resolve } from "../core/tools/web/addresses";
import { onHiddenPage } from "./hiddenPage";
import { LOOK_PROXY_USER, startLookProxy } from "./lookProxy";

/** Not "persist:": the session lives in memory only. */
const PARTITION = "page-look";
const LIMIT_MS = 30_000;
const LOAD_MS = 20_000;
/** For what a page draws after it has loaded. */
const SETTLE_MS = 1_000;
const WIDTH = 1280;
const HEIGHT = 1600;
/** Inches, as printToPDF takes them: room for the date, title and address it prints. */
const MARGIN = 0.4;
const MAX_PAGES = 200;
const MAX_BYTES = 50 * 1024 * 1024;

/** Runs before the page's own scripts, in every frame: a page can't open a print dialog. */
const NO_PRINT = `Object.defineProperty(window, "print", {
  value: () => undefined,
  writable: false,
  configurable: false,
});`;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const aborted = (error: Error) => "errno" in error && error.errno === -3;

type Made = Awaited<ReturnType<PageLook["render"]>>;

const failed = (failure: WebPageLookFailure, message: string): Made => ({ failure, message });

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function prepare(): Session {
  const lookSession = session.fromPartition(PARTITION, { cache: false });
  lookSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  lookSession.setPermissionCheckHandler(() => false);
  lookSession.setDevicePermissionHandler(() => false);
  lookSession.setSpellCheckerEnabled(false);
  lookSession.on("will-download", (event) => event.preventDefault());
  return lookSession;
}

async function prepareDebugger(contents: WebContents, log: Logger): Promise<void> {
  const tools = contents.debugger;
  tools.attach("1.3");
  tools.on(
    "message",
    (_event, method, params: { sessionId?: string; targetInfo?: { type?: string } }) => {
      if (method !== "Target.attachedToTarget" || !params.sessionId) return;
      const { sessionId } = params;
      const target = params.targetInfo?.type ?? "unknown";
      // A frame of another site gets the page's script too; a worker has no window to print.
      // Each waits for the debugger, so it is let run whatever happened.
      const prepared =
        target === "iframe"
          ? Promise.all([
              tools.sendCommand("Page.enable", {}, sessionId),
              tools.sendCommand(
                "Page.addScriptToEvaluateOnNewDocument",
                { source: NO_PRINT },
                sessionId,
              ),
              tools.sendCommand(
                "Target.setAutoAttach",
                { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
                sessionId,
              ),
            ])
          : Promise.resolve();
      prepared
        .catch((error: unknown) => {
          if (!contents.isDestroyed())
            log.warn("webPages.lookFrame", { target, message: messageOf(error) });
        })
        .finally(() => {
          if (contents.isDestroyed()) return;
          tools
            .sendCommand("Runtime.runIfWaitingForDebugger", {}, sessionId)
            .catch((error: unknown) => {
              if (!contents.isDestroyed())
                log.warn("webPages.lookResume", { target, message: messageOf(error) });
            });
        });
    },
  );
  await tools.sendCommand("Page.enable");
  await tools.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: NO_PRINT });
  await tools.sendCommand("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });
  // A page is kept as it looks on paper (#1262): never in its own dark style because the app is dark.
  await tools.sendCommand("Emulation.setEmulatedMedia", {
    media: "screen",
    features: [{ name: "prefers-color-scheme", value: "light" }],
  });
}

export function createPageLook({
  log,
  resolve,
  standIn,
  limitMs = LIMIT_MS,
}: {
  log: Logger;
  /** Resolves host names for the proxy, as web search's fetcher does. */
  resolve: Resolve;
  /** Test builds: the local server standing in for the web. */
  standIn?: number;
  /** Test builds shorten it to see a page that never loads closed. */
  limitMs?: number;
}): PageLook {
  let lookSession: Session | null = null;
  let previous: Promise<unknown> = Promise.resolve();

  async function render(address: string): Promise<Made> {
    const protocol = URL.parse(address)?.protocol;
    if (protocol !== "http:" && protocol !== "https:") {
      return failed("unreachable", "Not a web address.");
    }
    lookSession ??= prepare();
    const own = lookSession;
    const proxy = await startLookProxy({ resolve, log, ...(standIn ? { standIn } : {}) });
    try {
      // Loopback too goes through the proxy, which refuses it: Chromium bypasses it there otherwise.
      await own.setProxy({ proxyRules: proxy.address, proxyBypassRules: "<-loopback>" });
      return await onHiddenPage<Made>(
        {
          session: own,
          width: WIDTH,
          height: HEIGHT,
          limitMs,
          onLimit: () => failed("timed-out", `Not printed in ${limitMs} ms.`),
        },
        async (contents) => {
          contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
          contents.on("login", (event, _details, authInfo, callback) => {
            event.preventDefault();
            if (authInfo.isProxy && authInfo.host === proxy.host && authInfo.port === proxy.port) {
              callback(LOOK_PROXY_USER, proxy.secret);
            } else callback();
          });
          // Some sites turn away a browser that names itself Electron.
          contents.setUserAgent(
            contents.getUserAgent().replace(/\s(?:incarnamind|Electron)\/\S+/gi, ""),
          );
          await contents.loadURL("about:blank");
          await prepareDebugger(contents, log);
          let committed = false;
          contents.on("did-navigate", (_event, url) => {
            if (url !== "about:blank") committed = true;
          });
          const loading = contents.loadURL(address).then(
            () => null,
            (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
          );
          const loaded = await Promise.race([loading, wait(LOAD_MS).then(() => null)]);
          // A page whose script tried to go elsewhere while it loaded is still there: the load
          // only reports the navigation refused (ERR_ABORTED).
          if (loaded && !(aborted(loaded) && committed)) {
            return failed("unreachable", loaded.message);
          }
          if (!committed) return failed("timed-out", "The page never answered.");
          if (contents.isLoading()) {
            await Promise.race([once(contents, "did-stop-loading"), wait(LOAD_MS)]);
          }
          await wait(SETTLE_MS);
          const pdf = await contents.printToPDF({
            printBackground: true,
            displayHeaderFooter: true,
            pageRanges: `1-${MAX_PAGES}`,
            pageSize: { width: WIDTH / 96 + 2 * MARGIN, height: HEIGHT / 96 + 2 * MARGIN },
            margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
          });
          if (pdf.byteLength > MAX_BYTES) {
            return failed("too-large", `${pdf.byteLength} bytes of PDF.`);
          }
          return { pdf };
        },
      );
    } catch (error) {
      return failed("failed", messageOf(error));
    } finally {
      await Promise.all([
        own.clearStorageData(),
        own.clearCache(),
        own.clearAuthCache(),
        own.clearHostResolverCache(),
        own.closeAllConnections(),
        proxy.close(),
      ]).catch((error: unknown) => log.error("webPages.lookClear", { message: messageOf(error) }));
    }
  }

  return {
    render(address) {
      // One at a time: the pages share the session, cleared between them.
      const next = previous.then(() => render(address));
      previous = next.catch(() => undefined);
      return next;
    },
  };
}
