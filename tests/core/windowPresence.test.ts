import { describe, expect, test } from "vitest";
import { createWindowPresence, type WindowHeld } from "../../src/core/windowPresence";

/** Two features, as the core wires them: one a reload ends too, one only a window going ends. */
function presence() {
  const told: string[] = [];
  const held: WindowHeld[] = [
    {
      calls: ["askInConversation"],
      gone: (clientId) => told.push(`commands gone ${clientId}`),
      reloaded: (clientId) => told.push(`commands reloaded ${clientId}`),
    },
    { calls: ["watchComparisonMind"], gone: (clientId) => told.push(`tables gone ${clientId}`) },
  ];
  const windows = createWindowPresence(held, (error) => {
    throw error;
  });
  return { windows, told };
}

describe("Which window holds what (#2921)", () => {
  // protects=a window that closed or crashed has every feature let go of its id, once; fails_when=a feature isn't told, is told another id, or is told again when the host reports the same window twice; no_claim=what each feature then does.
  test("a window gone is let go by every feature, once", () => {
    const { windows, told } = presence();
    windows.called(7, "askInConversation", { clientId: "window-a" });

    windows.gone(7);
    expect(told).toEqual(["commands gone window-a", "tables gone window-a"]);

    windows.gone(7);
    expect(told).toHaveLength(2);
  });

  // protects=a page that starts again ends only what a reload ends, and its window stays known, so its going later still frees the rest; fails_when=a reload drops the window's place in tables, or the window is forgotten at the reload; no_claim=that the page keeps its id.
  test("a page that starts again ends only what a reload ends, and the window stays known", () => {
    const { windows, told } = presence();
    windows.called(7, "askInConversation", { clientId: "window-a" });

    windows.reloaded(7);
    expect(told).toEqual(["commands reloaded window-a"]);

    windows.gone(7);
    expect(told).toEqual([
      "commands reloaded window-a",
      "commands gone window-a",
      "tables gone window-a",
    ]);
  });

  // protects=only the calls a feature names make a window known: a Connector's OAuth client id, also a `clientId`, is no window; fails_when=any input carrying a clientId names the window; no_claim=which calls the core names.
  test("a call that gives a window nothing to hold names no window", () => {
    const { windows, told } = presence();
    windows.called(7, "addConnector", { clientId: "an-oauth-app" });
    windows.gone(7);
    windows.reloaded(7);
    expect(told).toEqual([]);

    windows.called(7, "watchComparisonMind", { clientId: "window-a" });
    windows.gone(7);
    expect(told).toEqual(["commands gone window-a", "tables gone window-a"]);
  });

  // protects=a call that says no window leaves its window unknown; fails_when=an empty or malformed id is kept and later let go; no_claim=what the call itself answers.
  test.each([
    ["no input", undefined],
    ["an input that is no record", "window-a"],
    ["no clientId", {}],
    ["an empty clientId", { clientId: "" }],
    ["a clientId that is no text", { clientId: 7 }],
    ["a null clientId", { clientId: null }],
  ])("a call with %s names no window", (_name, input) => {
    const { windows, told } = presence();
    windows.called(7, "askInConversation", input);
    windows.gone(7);
    expect(told).toEqual([]);
  });

  // protects=each window's holds are its own; fails_when=one window going lets go of another's id; no_claim=how many windows a host has.
  test("one window going leaves another's alone", () => {
    const { windows, told } = presence();
    windows.called(7, "askInConversation", { clientId: "window-a" });
    windows.called("panel", "watchComparisonMind", { clientId: "window-b" });

    windows.gone("panel");
    expect(told).toEqual(["commands gone window-b", "tables gone window-b"]);

    windows.gone(7);
    expect(told.slice(2)).toEqual(["commands gone window-a", "tables gone window-a"]);
  });

  // protects=a window whose page comes back under another id has the old id let go at once, and the new one when it goes; a call under the same id lets nothing go; fails_when=the old id is kept waiting for a page that can't return, or a repeated call lets go of a live page; no_claim=why a page lost its id.
  test("a page that comes back under another id has the old one let go", () => {
    const { windows, told } = presence();
    windows.called(7, "watchComparisonMind", { clientId: "window-a" });
    windows.called(7, "askInConversation", { clientId: "window-a" });
    expect(told).toEqual([]);

    windows.called(7, "askInConversation", { clientId: "window-b" });
    expect(told).toEqual(["commands gone window-a", "tables gone window-a"]);

    windows.gone(7);
    expect(told.slice(2)).toEqual(["commands gone window-b", "tables gone window-b"]);
  });

  // protects=one feature failing to let go leaves the others told, and its failure reported; fails_when=the failure stops the rest or is dropped; no_claim=what the host logs.
  test("a feature that fails to let go doesn't stop the next, and is reported", () => {
    const told: string[] = [];
    const reported: unknown[] = [];
    const stuck = new Error("stuck");
    const windows = createWindowPresence(
      [
        {
          calls: ["holdMindCheck"],
          gone: () => {
            throw stuck;
          },
        },
        {
          calls: ["watchComparisonMind"],
          gone: (clientId) => told.push(`tables gone ${clientId}`),
        },
      ],
      (error) => reported.push(error),
    );
    windows.called(7, "holdMindCheck", { clientId: "window-a" });

    windows.gone(7);

    expect(told).toEqual(["tables gone window-a"]);
    expect(reported).toEqual([stuck]);
  });
});
