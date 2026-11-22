/**
 * An app link the system hands IncarnaMind (#3534): handed to the core once it is there, the newest
 * if several came before; once the app is up, one naming nothing there brings the app forward.
 */
import { describe, expect, it } from "vitest";
import { createAppLinkInbox } from "../../src/main/appLinkInbox";

function inbox(there: readonly string[]) {
  const done: string[] = [];
  const box = createAppLinkInbox({
    show: (link) => {
      done.push(`show ${link}`);
      return there.includes(link);
    },
    front: () => done.push("front"),
  });
  return { box, done };
}

describe("an app link handed to IncarnaMind", () => {
  // protects=a link that starts the app reaches the core once it is there, the newest if several came, and never before (#3534); fails_when=it is handed over before the core exists, lost, or an older one wins
  it("waits for the core when it starts the app, and the newest one goes to it", () => {
    const { box, done } = inbox(["a", "b"]);
    box.arrived("a");
    box.arrived("b");
    expect(done).toEqual([]);
    box.coreUp();
    expect(done).toEqual(["show b"]);
  });

  // protects=while the first window is still coming, a link naming nothing there doesn't make another window; once it is up, it brings the app forward (#3534); fails_when=a second window opens at start, or a missing item leaves a running app behind
  it("brings the app forward for a link naming nothing there only once the app is up", () => {
    const { box, done } = inbox(["a"]);
    box.coreUp();
    box.arrived("gone");
    box.windowUp();
    box.arrived("a");
    box.arrived("gone");
    expect(done).toEqual(["show gone", "show a", "show gone", "front"]);
  });
});
