/**
 * An app link the system hands IncarnaMind (#3534): shown once the app is up, whether it started
 * the app or came while it ran; any other link, or an item that isn't there, only brings it forward.
 */
import { describe, expect, it } from "vitest";
import { createAppLinkInbox } from "../../src/main/appLinkInbox";

function inbox(there: readonly string[]) {
  const done: string[] = [];
  const box = createAppLinkInbox({
    show: (link) => {
      if (!there.includes(link)) return false;
      done.push(`show ${link}`);
      return true;
    },
    front: () => done.push("front"),
  });
  return { box, done };
}

describe("an app link handed to IncarnaMind", () => {
  // protects=a link that starts the app is shown once the app is up, the newest if several came, and never before (#3534); fails_when=it is shown before the window can open it, lost, or an older one wins
  it("waits until the app is up when it starts the app, and the newest one is shown", () => {
    const { box, done } = inbox(["a", "b"]);
    box.arrived("a");
    box.arrived("b");
    expect(done).toEqual([]);
    box.ready();
    expect(done).toEqual(["show b"]);
  });

  // protects=a link that comes while the app runs is shown at once; one naming nothing that is there only brings the app forward (#3534); fails_when=it waits, or a missing item leaves the app behind
  it("is shown at once while the app runs, and one naming nothing there only brings the app forward", () => {
    const { box, done } = inbox(["a"]);
    box.ready();
    box.arrived("a");
    box.arrived("gone");
    expect(done).toEqual(["show a", "front"]);
  });

  // protects=readying twice shows the waiting link once (#3534); fails_when=a link is shown twice
  it("shows a waiting link only once", () => {
    const { box, done } = inbox(["a"]);
    box.arrived("a");
    box.ready();
    box.ready();
    expect(done).toEqual(["show a"]);
  });
});
