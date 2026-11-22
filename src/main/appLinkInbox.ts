/**
 * Where an app link the system hands IncarnaMind waits until the core can take it (#3534,
 * ADR-0033): macOS sends it as an event, also the one that starts the app; Windows and Linux start
 * the app again with it as an argument. The core shows what it names, or keeps it for the first
 * window, which opens it in place of Home. Once the app is up, every link also brings the app
 * forward: one that names nothing shows only the app, and where no window is open (the app started
 * at login without one) the window that opens takes what was kept. Pure, so it is tested without
 * Electron.
 */
export interface AppLinkInbox {
  /** A link the system handed over, as it came. */
  arrived(link: string): void;
  /** The core is there: the link waiting, if any, goes to it. */
  coreUp(): void;
  /** The app is up: from now on every link also brings it forward. */
  windowUp(): void;
}

export function createAppLinkInbox(options: {
  /** Hands a link to the core, which shows or keeps what it names. */
  show(link: string): void;
  /** Brings the app to the front, showing nothing new. */
  front(): void;
}): AppLinkInbox {
  let waiting: string | null = null;
  let core = false;
  let window = false;
  const handle = (link: string) => {
    options.show(link);
    if (window) options.front();
  };
  return {
    arrived(link) {
      if (core) handle(link);
      else waiting = link;
    },
    coreUp() {
      core = true;
      const link = waiting;
      waiting = null;
      if (link !== null) handle(link);
    },
    windowUp() {
      window = true;
    },
  };
}
