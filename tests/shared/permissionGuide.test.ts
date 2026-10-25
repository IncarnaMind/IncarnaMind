import { describe, expect, test } from "vitest";
import {
  fitsBesideSystemSettings,
  guidePlacement,
  isGranted,
  MEDIA_ACCESS_OF,
} from "../../src/shared/permissionGuide";

describe("where the guide beside System Settings goes", () => {
  // protects=a Mac screen wide enough for System Settings in the middle and the guide at its side gets the guide beside it, and a narrow one gets the steps in the window; fails_when=the guide opens over System Settings on a small screen, or never opens beside it on a big one; no_claim=System Settings' real position, which the User may have moved.
  test("it sits beside System Settings where the screen has room, else the steps show in place", () => {
    expect(guidePlacement("darwin", 1728)).toBe("beside");
    expect(guidePlacement("darwin", 1440)).toBe("beside");
    expect(guidePlacement("darwin", 1280)).toBe("inline");
    expect(fitsBesideSystemSettings(1100)).toBe(false);
  });

  // protects=only macOS gets a guide for now: another system keeps the line and its Open Settings alone; fails_when=Windows or Linux shows macOS pane names; no_claim=the later systems.
  test("another system has none", () => {
    expect(guidePlacement("win32", 1920)).toBe("none");
    expect(guidePlacement("linux", 1920)).toBe("none");
  });
});

describe("what the system says about a permission", () => {
  // protects=the microphone is checked as the microphone and the computer's sound, a loopback screen capture, as the screen; fails_when=the sound's guide closes on the microphone's grant; no_claim=the system's own answers.
  test("the sources map to the system's media access, and only granted counts", () => {
    expect(MEDIA_ACCESS_OF).toEqual({ microphone: "microphone", system: "screen" });
    expect(isGranted("granted")).toBe(true);
    for (const answer of ["denied", "not-determined", "restricted", "unknown"]) {
      expect(isGranted(answer)).toBe(false);
    }
  });
});
