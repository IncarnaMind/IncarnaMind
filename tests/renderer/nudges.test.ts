import { describe, expect, test } from "vitest";
import { chooseNudge } from "../../src/renderer/src/nudges";

const OPEN = {
  started: true,
  hidden: false,
  citationChecked: false,
  mistakeSeen: false,
  indexed: false,
  askedOwn: false,
  askedReady: false,
};
const DONE = { ...OPEN, citationChecked: true, mistakeSeen: true, indexed: true, askedOwn: true };
const CLOSED = { ...OPEN, hidden: true };

const state = (
  over: {
    steps?: object;
    usage?: object;
    notice?: string;
    ownAnswerArrived?: boolean;
    askedOwnAtLaunch?: boolean;
  } = {},
) =>
  ({
    settings: { device: { gettingStarted: over.steps ?? OPEN } },
    privacy: {
      usageData: {
        available: true,
        enabled: false,
        testerBuild: false,
        asked: false,
        localMode: false,
        ...over.usage,
      },
    },
    ownAnswerArrived: over.ownAnswerArrived ?? false,
    askedOwnAtLaunch: over.askedOwnAtLaunch ?? false,
    usageNotice: over.notice ?? "auto",
  }) as unknown as Parameters<typeof chooseNudge>[0];

describe("the sidebar's one nudge (#123)", () => {
  test("a release waits for the first own Answer and for the steps to be done", () => {
    expect(chooseNudge(state({ steps: DONE }))).toBeNull();
    expect(chooseNudge(state({ steps: DONE, ownAnswerArrived: true }))).toBe("usage-data");
  });

  test("a release asks once the steps are closed, after the first own Answer", () => {
    expect(chooseNudge(state({ steps: CLOSED }))).toBeNull();
    expect(chooseNudge(state({ steps: CLOSED, ownAnswerArrived: true }))).toBe("usage-data");
  });

  test("steps done with the ready Question still wait for an Answer of the User's own", () => {
    const done = {
      ...OPEN,
      citationChecked: true,
      mistakeSeen: true,
      indexed: true,
      askedReady: true,
    };
    expect(chooseNudge(state({ steps: done }))).toBeNull();
    expect(chooseNudge(state({ steps: done, ownAnswerArrived: true }))).toBe("usage-data");
  });

  test("with the steps still open it waits, until the next launch", () => {
    expect(chooseNudge(state({ steps: OPEN, ownAnswerArrived: true }))).toBeNull();
    expect(chooseNudge(state({ steps: OPEN, askedOwnAtLaunch: true }))).toBe("usage-data");
  });

  test("it goes once answered, and never returns after a choice", () => {
    const ready = { steps: DONE, ownAnswerArrived: true };
    expect(chooseNudge(state({ ...ready, notice: "answered" }))).toBeNull();
    expect(chooseNudge(state({ ...ready, usage: { asked: true } }))).toBeNull();
  });

  test("a test build says so from the first run, and keeps it once the switch is used", () => {
    const tester = { testerBuild: true };
    expect(chooseNudge(state({ usage: tester }))).toBe("usage-data");
    expect(chooseNudge(state({ usage: { ...tester, asked: true }, notice: "kept" }))).toBe(
      "usage-data",
    );
    expect(
      chooseNudge(state({ usage: { ...tester, asked: true }, notice: "answered" })),
    ).toBeNull();
  });

  test("nothing shows without a sender, or in local mode", () => {
    const ready = { steps: DONE, ownAnswerArrived: true };
    expect(chooseNudge(state({ ...ready, usage: { available: false } }))).toBeNull();
    expect(chooseNudge(state({ ...ready, usage: { localMode: true } }))).toBeNull();
  });
});
