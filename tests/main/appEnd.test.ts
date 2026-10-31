import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import { crashReloads, logAppEnd, pageName, unexpectedEnds } from "../../src/main/appEnd";

/** Electron's quit as the log sees it: `before-quit`, then `will-quit` unless held back. */
function fakeApp() {
  const app = Object.assign(new EventEmitter(), {
    held: false,
    quits: 0,
    quit() {
      app.quits += 1;
      let prevented = false;
      app.emit("before-quit", { preventDefault: () => (prevented = true) });
      if (!prevented && !app.held) app.emit("will-quit", {});
    },
  });
  return app;
}

function start() {
  const app = fakeApp();
  const host = Object.assign(new EventEmitter(), { pid: 4242 });
  const lines: string[] = [];
  const end = logAppEnd(
    app,
    {
      info: (event, fields) =>
        lines.push(
          [event, ...Object.entries(fields ?? {}).map(([name, value]) => `${name}=${value}`)].join(
            " ",
          ),
        ),
    },
    host,
  );
  return { app, host, lines, end };
}

test("a quit the app asks for names what asked, then logs the quit and the exit code", () => {
  const { app, host, lines, end } = start();
  end.quit("menu");
  host.emit("exit", 0);
  expect(app.quits).toBe(1);
  expect(lines).toEqual(["app.quitAsked by=menu", "app.quit", "app.exited pid=4242 code=0"]);
});

test("a quit nothing in the app asked for, as the Dock's Quit, is logged as from outside", () => {
  const { app, lines, end } = start();
  app.quit();
  end.quit("shortcut");
  expect(lines).toEqual([
    "app.quitAsked by=outside",
    "app.quit",
    "app.quitAsked by=shortcut",
    "app.quit",
  ]);
});

test("what asks for a quit something else starts is named once: the next quit is from outside", () => {
  const { app, lines, end } = start();
  app.held = true;
  end.asking("os");
  app.quit();
  app.quit();
  expect(lines).toEqual(["app.quitAsked by=os", "app.quitAsked by=outside"]);
});

test("an update installing is named as what asked for the quit it starts", () => {
  const { app, lines, end } = start();
  end.asking("update");
  app.quit();
  expect(lines).toEqual(["app.quitAsked by=update", "app.quit"]);
});

/** A session end with `waiting` changes the store can't store, and a quit `held` for them or not. */
function endSession(waiting: number, held: boolean) {
  const run = start();
  const window = new EventEmitter();
  const steps: string[] = [];
  // The unsaved-changes guard, and the owner marking the run as quitting or (when held) in use.
  run.app.on("before-quit", (event: { preventDefault(): void }) => {
    if (held) event.preventDefault();
    steps.push(held ? "phase=ready" : "phase=quitting");
  });
  run.end.watchSessionEnd(window, {
    store: () => {
      steps.push("store");
      return { count: waiting, minds: waiting > 0 ? [{ mindId: "mind-1", count: waiting }] : [] };
    },
    record: ({ count, minds }) =>
      steps.push(
        count > 0
          ? `phase=quitting unsaved=${count} in=${minds.map((each) => each.mindId).join(",")}`
          : "phase=quitting",
      ),
  });
  window.emit("query-session-end");
  const beforeEnd = [...steps];
  window.emit("session-end");
  return { ...run, steps, beforeEnd };
}

test("Windows ending the session stores what waits, quits as the system's and records a clean end, all before the event returns", () => {
  const { app, lines, steps, beforeEnd } = endSession(0, false);
  expect(beforeEnd).toEqual([]);
  expect(steps).toEqual(["store", "phase=quitting", "phase=quitting"]);
  expect(app.quits).toBe(1);
  expect(lines).toEqual(["app.quitAsked by=os", "app.quit"]);
});

test("a session end with changes it couldn't store records them last, after the held quit marked the run in use", () => {
  const { app, lines, steps } = endSession(2, true);
  expect(steps).toEqual(["store", "phase=ready", "phase=quitting unsaved=2 in=mind-1"]);
  expect(app.quits).toBe(1);
  expect(lines).toEqual(["app.quitAsked by=os unsaved=2"]);
});

test("a quit held for unsaved changes, then answered, logs both asks and one quit", () => {
  const { app, lines, end } = start();
  app.once("before-quit", (event: { preventDefault(): void }) => event.preventDefault());
  end.quit("shortcut");
  end.quit("unsavedChoice");
  expect(lines).toEqual([
    "app.quitAsked by=shortcut",
    "app.quitAsked by=unsavedChoice",
    "app.quit",
  ]);
});

test("a signal quits as Electron's handler did, logged, and only the first is taken", () => {
  const { app, host, lines, end } = start();
  expect(host.listenerCount("SIGTERM")).toBe(0);
  end.watchSignals();
  expect(host.listenerCount("SIGTERM")).toBe(1);
  expect(host.listenerCount("SIGINT")).toBe(1);
  expect(host.listenerCount("SIGHUP")).toBe(1);
  host.emit("SIGTERM", "SIGTERM");
  expect(app.quits).toBe(1);
  expect(lines).toEqual(["app.quitAsked by=signal signal=SIGTERM", "app.quit"]);
  expect(host.listenerCount("SIGTERM")).toBe(0);
  expect(host.listenerCount("SIGINT")).toBe(1);
});

test("an unexpected end is told once: the run's to the first window that asks, a page's to its own", () => {
  const ends = unexpectedEnds({ kind: "app" });
  ends.pageEnded(7);
  expect(ends.take(7)).toEqual({ kind: "app" });
  expect(ends.take(7)).toBeNull();
  ends.pageEnded(7);
  expect(ends.take(8)).toBeNull();
  expect(ends.take(7)).toEqual({ kind: "window" });
  expect(ends.take(7)).toBeNull();

  const minds = [{ mindId: "mind-1", count: 2 }];
  const session = unexpectedEnds({ kind: "session", unsaved: 2, minds });
  expect(session.take(5)).toEqual({ kind: "session", unsaved: 2, minds });
  expect(session.take(5)).toBeNull();

  const quiet = unexpectedEnds(null);
  expect(quiet.take(3)).toBeNull();
  quiet.pageEnded(3);
  expect(quiet.take(4)).toBeNull();
  expect(quiet.take(3)).toEqual({ kind: "window" });
});

test("a crashed page loads again at its first and second crash in a minute, not its third", () => {
  let now = 0;
  const reloads = crashReloads(() => now);
  expect(reloads.crashed()).toBe(true);
  reloads.loaded();
  now = 10_000;
  expect(reloads.crashed()).toBe(true);
  reloads.loaded();
  now = 20_000;
  expect(reloads.crashed()).toBe(false);
  // A minute after the first two, only the third is still counted.
  now = 75_000;
  expect(reloads.crashed()).toBe(true);
});

test("a page that crashes again before it has loaded is left", () => {
  let now = 0;
  const reloads = crashReloads(() => now);
  expect(reloads.crashed()).toBe(true);
  now = 500;
  expect(reloads.crashed()).toBe(false);
  reloads.loaded();
  now = 90_000;
  expect(reloads.crashed()).toBe(true);
});

// protects=a crashed window's log line names only the app's own pages, never a cited website's address (#2309); fails_when=a website's path segment, or a page outside the app's folders, reaches the log; no_claim=the scrubber's own rules.
test("a crashed page is named in the log only when it is one of the app's own, else as web", () => {
  const own = [
    "file:///Applications/IncarnaMind.app/Contents/Resources/app.asar/out/renderer/",
    "incarnamind-analysis://app/",
    "http://localhost:5173/",
  ];
  expect(
    pageName(
      "file:///Applications/IncarnaMind.app/Contents/Resources/app.asar/out/renderer/index.html?window=main",
      own,
    ),
  ).toBe("index.html");
  expect(pageName("incarnamind-analysis://app/analysis.html", own)).toBe("analysis.html");
  expect(pageName("http://localhost:5173/meetingPanel.html", own)).toBe("meetingPanel.html");
  expect(pageName("http://localhost:5173/?window=main", own)).toBe("index.html");
  expect(pageName("https://example.org/reports/tide-gauges-2024", own)).toBe("web");
  expect(pageName("http://localhost:5174/secret-path", own)).toBe("web");
  expect(pageName("file:///Users/someone/Documents/lease.html", own)).toBe("web");
  expect(pageName("about:blank", own)).toBe("web");
  expect(pageName("", own)).toBe("web");
});
