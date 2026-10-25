import { beforeEach, describe, expect, test } from "vitest";
import { InvalidInputError } from "../../src/core/errors";
import { dismissNewest, registerDismissable } from "../../src/renderer/src/escapeDismiss";
import { type Clock, CONFIRMATION_SHOWN_MS, createNotices } from "../../src/renderer/src/notices";
import { errorForWindow } from "../../src/shared/errorWording";

/*
 * Notices by kind (#157): an error stays until the User dismisses it, a confirmation such as
 * "Copied" goes by itself after a few seconds, and Esc closes the newest of either. The clock is
 * the test's own, so nothing here waits.
 */

function testClock() {
  let now = 0;
  let ids = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const clock: Clock = {
    setTimeout(run, ms) {
      const id = ++ids;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimeout(timer) {
      timers.delete(timer as number);
    },
  };
  /** Moves time on, running what falls due on the way, in order. */
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= until)
        .sort(([, a], [, b]) => a.at - b.at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].run();
    }
    now = until;
  };
  return { clock, advance };
}

const failed = (message: string) =>
  new Error(`Error invoking remote method 'core:renameDocument': InvalidInputError: ${message}`);

let time: ReturnType<typeof testClock>;
let notices: ReturnType<typeof createNotices>;
beforeEach(() => {
  time = testClock();
  notices = createNotices(time.clock);
});

describe("an error", () => {
  test("says the core's sentence in plain words, with the technical text for Details", () => {
    notices.getState().showError(failed("A Document’s name can’t be empty."));
    const [notice] = notices.getState().errors;
    expect(notice?.message).toBe("A Document’s name can’t be empty.");
    expect(notice?.detail).toBe(
      "core:renameDocument\nInvalidInputError: A Document’s name can’t be empty.",
    );
    const everything = JSON.stringify(notices.getState().errors);
    expect(everything).not.toContain("Error invoking remote method");
  });

  test("keeps the core's wording, for the interface language, and its English for Details", () => {
    const error = new InvalidInputError({ key: "error.document.nameEmpty" });
    notices
      .getState()
      .showError(
        new Error(`Error invoking remote method 'core:renameDocument': ${errorForWindow(error)}`),
      );
    const [notice] = notices.getState().errors;
    expect(notice?.wording).toEqual({ key: "error.document.nameEmpty" });
    expect(notice?.message).toBe("A Document’s name can’t be empty.");
    expect(notice?.detail).toBe(
      "core:renameDocument\nInvalidInputError: A Document’s name can’t be empty.",
    );
  });

  test("stays however long it is left, whether or not anything else happens", () => {
    notices.getState().showError(failed("A Document’s name can’t be empty."));
    time.advance(CONFIRMATION_SHOWN_MS * 1000);
    notices.getState().confirm("info.copied");
    time.advance(CONFIRMATION_SHOWN_MS * 1000);
    expect(notices.getState().errors).toHaveLength(1);
    expect(notices.getState().confirmation).toBeNull();
  });

  test("goes when it is dismissed, and only that one", () => {
    notices.getState().showError(failed("One."));
    notices.getState().showError(failed("Two."));
    const [first, second] = notices.getState().errors;
    notices.getState().dismissError(first?.id ?? -1);
    expect(notices.getState().errors).toEqual([second]);
  });

  test("two at once stay together, oldest first", () => {
    notices.getState().showError(failed("One."));
    notices.getState().showError(failed("Two."));
    expect(notices.getState().errors.map((each) => each.message)).toEqual(["One.", "Two."]);
  });

  test("the same one twice is said once", () => {
    notices.getState().showError(failed("One."));
    notices.getState().showError(failed("One."));
    expect(notices.getState().errors).toHaveLength(1);
  });
});

describe("a confirmation", () => {
  test("goes by itself after a few seconds", () => {
    notices.getState().confirm("info.copied");
    expect(notices.getState().confirmation?.message).toBe("info.copied");
    time.advance(CONFIRMATION_SHOWN_MS - 1);
    expect(notices.getState().confirmation).not.toBeNull();
    time.advance(1);
    expect(notices.getState().confirmation).toBeNull();
  });

  test("a newer one starts its own few seconds", () => {
    notices.getState().confirm("info.copied");
    time.advance(CONFIRMATION_SHOWN_MS - 1000);
    notices.getState().confirm("info.copied");
    time.advance(CONFIRMATION_SHOWN_MS - 1);
    expect(notices.getState().confirmation).not.toBeNull();
    time.advance(1);
    expect(notices.getState().confirmation).toBeNull();
  });

  test("is closed by hand, and its time is not left running to close the next", () => {
    notices.getState().confirm("info.copied");
    time.advance(1000);
    notices.getState().dismissConfirmation();
    expect(notices.getState().confirmation).toBeNull();
    notices.getState().confirm("info.copied");
    time.advance(CONFIRMATION_SHOWN_MS - 1000);
    expect(notices.getState().confirmation).not.toBeNull();
  });
});

describe("Esc", () => {
  const closers: (() => void)[] = [];
  const show = (dismiss: () => void) => {
    closers.push(registerDismissable(dismiss));
  };
  beforeEach(() => {
    for (const close of closers.splice(0)) close();
  });

  test("closes the newest notice on screen, then the one before it", () => {
    const log: string[] = [];
    show(() => log.push("first"));
    show(() => log.push("second"));
    expect(dismissNewest()).toBe(true);
    expect(log).toEqual(["second"]);
    closers.pop()?.();
    expect(dismissNewest()).toBe(true);
    expect(log).toEqual(["second", "first"]);
  });

  test("closes an error and a confirmation alike, and does nothing with none on screen", () => {
    expect(dismissNewest()).toBe(false);
    notices.getState().showError(failed("One."));
    notices.getState().confirm("info.copied");
    show(() => notices.getState().dismissConfirmation());
    show(() => notices.getState().dismissError(notices.getState().errors[0]?.id ?? -1));
    dismissNewest();
    expect(notices.getState().errors).toHaveLength(0);
    // The notice that went takes itself off the list, as it does when it unmounts.
    closers.pop()?.();
    dismissNewest();
    expect(notices.getState().confirmation).toBeNull();
  });
});
