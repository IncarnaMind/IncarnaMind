---
status: accepted (2026-11-19)
---

# A Canvas is drawn in a webview of its own session, with no network

A Canvas (#3406) is a page an outside agent wrote: HTML with its own styles and scripts, which IncarnaMind shows in a tab as the agent designed it. It is the first content the app draws live that it didn't write, so where it is drawn decides what it can reach. Its page must reach no network, no file, no part of the app and no other Canvas, and a page that loops or takes memory without end must not hold the window. The app's own interface must still draw over it: menus, ⌘K, Settings, cards and notices.

## Decision

A Canvas is drawn in Electron's `<webview>` in its tab, a guest with a renderer process and a session of its own, held in memory (the partition `canvas`), served by a scheme of its own (`incarnamind-canvas://<random host>/`, privileged as standard only, so the page is no secure context).

- **An address per showing.** The core mints a random 32-hex host for each showing of a version and answers on it with that version's HTML and files alone; another Canvas's host can't be guessed, and the session's own request filter refuses a request whose frame is another showing's.
- **The guard on attach.** The main window has `webviewTag` on, and `will-attach-webview` lets a webview attach only for an address the core minted, with every web preference replaced by the Canvas's: sandboxed, context isolation, no Node in any frame or worker, the Canvas preload, the `canvas` partition, no dialogs, no webview inside it, and DNS prefetch off in its renderer (`--blink-settings=dnsPrefetchingEnabled=false`).
- **No network, three ways.** Every response carries a content policy that sandboxes the page (`sandbox allow-scripts allow-popups`) and allows scripts and styles inline and from its own files, pictures and fonts from its own files and `data:`, and nothing else (`connect-src`, `frame-src`, `worker-src`, `object-src`, `form-action`, `base-uri` all `'none'`). The session cancels every request but its own scheme's. Every connection the session would make goes to a SOCKS proxy on this computer that closes it unread, with loopback not bypassed, and WebRTC is limited to proxied UDP: so WebRTC's TURN over TCP and preconnect hints reach nothing.
- **Nothing else.** Permissions, device and display-media requests are denied; downloads, navigation, redirects and new windows are refused (a website it tries to open is offered to the User, who opens it in their browser); its storage is absent, its origin opaque.
- **One way out.** The Canvas's preload sends one message, the token of a Citation's marker the User pressed (`{ kind: "cite", token }`), and only for a trusted click or key. The main process checks its sender (a Canvas guest), its frame (the guest's main frame, at the showing's own address now) and its shape, drops anything else with a reason in the log, and the window opens the token only from that version's own Citations. Nothing is sent into a Canvas.
- **The window's own keys.** In the guest's `before-input-event`, the main process passes the window a fixed list of the app's shortcuts (`KEYS_FROM_CANVASES`: the command palette, Ask, moving between tabs and groups), and Esc, which the page also gets. Every other key is the page's.
- **Runaway pages.** A page that loops holds only its own process. One past 1 GB of memory is stopped, and its tab says so with Show Again.

## Considered options, and what decided

- **A sandboxed `<iframe>` in the main window, served from a new scheme.** It shares the main window's session. On Electron 44 (Chromium 146), a page in it reached a TURN server on this computer over TCP although WebRTC's UDP was turned off for the window, and the content policy's `webrtc 'block'` isn't implemented. The fix would be a proxy for that session, which the app's model calls and downloads use. Rejected.
- **A `WebContentsView` placed over the tab.** The strongest isolation, the same as the Analysis window's, but a native view is drawn above the page: menus, ⌘K, Settings, notices and cards would be hidden under it, and its bounds would follow the tab's by hand. Rejected for the interface.
- **The webview.** Measured in the same probe: with its own session, the closing proxy and the WebRTC limit, the stand-ins heard nothing (UDP, TCP, HTTP), the page ran in a process of its own, its `parent` and `top` were itself, and a red block of the window drew over it. DNS prefetch still looked a name up through the User's resolver until its renderer's setting was turned off.

## Consequences

- **Electron discourages `<webview>`** ("based on Chromium's webview, which is undergoing dramatic architectural changes") and may drop it. Every guard above sits on the guest's `WebContents` and its session, which a `WebContentsView` has too. If Electron deprecates the webview, or a release breaks its drawing, keyboard focus or input, the Canvas moves to a `WebContentsView` with the same session and guards, and the window gives up drawing over it: menus and cards that would cover it hide the view while they are open. The specs `e2e/canvasSandbox.spec.ts` and `e2e/canvasTab.spec.ts` are what tells us either way.
- The main window gains `webviewTag`, so `will-attach-webview` is part of the app's trust boundary: a change to it needs the escape spec run.
- A Canvas is never a secure context: no clipboard API, service worker, `crypto.subtle` or device APIs. A page that needs them doesn't work here.
- The Analysis window (ADR-0023) sets no WebRTC limit, but its code runs in Workers, where `RTCPeerConnection` doesn't exist; its spec checks that it can't be reached.
