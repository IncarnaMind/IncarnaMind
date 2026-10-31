import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import { crashReloads, logAppEnd, unexpectedEnds } from "../../src/main/appEnd";

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

test("Windows ending the session quits at once, logged as the system's, before the process ends", () => {
  const { app, lines, end } = start();
  const window = new EventEmitter();
  let markedQuitting = false;
  app.on("before-quit", () => {
    markedQuitting = true;
  });
  end.watchSessionEnd(window);
  expect(app.quits).toBe(0);
  window.emit("query-session-end");
  expect(app.quits).toBe(0);
  window.emit("session-end");
  // Synchronously: Windows ends the process as soon as the event returns.
  expect(markedQuitting).toBe(true);
  expect(app.quits).toBe(1);
  expect(lines).toEqual(["app.quitAsked by=os", "app.quit"]);
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

test("an unexpected end is told once: the app's to the first window that asks, a page's to its own", () => {
  const ends = unexpectedEnds(true);
  ends.pageEnded(7);
  expect(ends.take(7)).toBe("app");
  expect(ends.take(7)).toBeNull();
  ends.pageEnded(7);
  expect(ends.take(8)).toBeNull();
  expect(ends.take(7)).toBe("window");
  expect(ends.take(7)).toBeNull();

  const quiet = unexpectedEnds(false);
  expect(quiet.take(3)).toBeNull();
  quiet.pageEnded(3);
  expect(quiet.take(4)).toBeNull();
  expect(quiet.take(3)).toBe("window");
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
