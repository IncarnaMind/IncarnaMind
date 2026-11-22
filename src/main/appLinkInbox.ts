/**
 * Where an app link the system hands IncarnaMind waits until the app can show it (#3534,
 * ADR-0033): macOS sends it as an event, also the one that starts the app; Windows and Linux start
 * the app again with it as an argument. Before the first window is up the newest link waits; then
 * its item is shown in front, or, for any other link or an item that isn't there, the app only
 * comes forward. Pure, so it is tested without Electron.
 */
export interface AppLinkInbox {
  /** A link the system handed over, as it came. */
  arrived(link: string): void;
  /** The app is up: the link waiting, if any, is shown now. */
  ready(): void;
}

export function createAppLinkInbox(options: {
  /** Shows the item a link names; false when it names none that is there. */
  show(link: string): boolean;
  /** Brings the app to the front, showing nothing new. */
  front(): void;
}): AppLinkInbox {
  let waiting: string | null = null;
  let up = false;
  const handle = (link: string) => {
    if (!options.show(link)) options.front();
  };
  return {
    arrived(link) {
      if (up) handle(link);
      else waiting = link;
    },
    ready() {
      up = true;
      const link = waiting;
      waiting = null;
      if (link !== null) handle(link);
    },
  };
}
