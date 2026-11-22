/**
 * An app link the system hands IncarnaMind (#3534): handed to the core once it is there, the newest
 * if several came before; once the app is up, every link also brings the app forward.
 */
import { describe, expect, it } from "vitest";
import { createAppLinkInbox } from "../../src/main/appLinkInbox";

function inbox() {
  const done: string[] = [];
  const box = createAppLinkInbox({
    show: (link) => void done.push(`show ${link}`),
    front: () => void done.push("front"),
  });
  return { box, done };
}

describe("an app link handed to IncarnaMind", () => {
  // protects=a link that starts the app reaches the core once it is there, the newest if several came, and never before (#3534); fails_when=it is handed over before the core exists, lost, or an older one wins
  it("waits for the core when it starts the app, and the newest one goes to it", () => {
    const { box, done } = inbox();
    box.arrived("a");
    box.arrived("b");
    expect(done).toEqual([]);
    box.coreUp();
    expect(done).toEqual(["show b"]);
  });

  // protects=while the first window is still coming, a link doesn't open another; once the app is up, every link brings it forward, so one handed to an app started at login without a window opens one, which takes the link (#3534); fails_when=a second window opens at start, or a link while the app runs without a window shows nothing
  it("brings the app forward with every link once the app is up, and not before", () => {
    const { box, done } = inbox();
    box.coreUp();
    box.arrived("a");
    box.windowUp();
    box.arrived("b");
    box.arrived("gone");
    expect(done).toEqual(["show a", "show b", "front", "show gone", "front"]);
  });
});
