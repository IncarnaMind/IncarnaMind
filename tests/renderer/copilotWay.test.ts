import { describe, expect, test } from "vitest";
import type { CopilotStatus } from "../../src/core/api";
import { copilotTagged, copilotWay } from "../../src/core/providers/copilot/service";
import { translate } from "../../src/shared/i18n";

describe("The way the Copilot plan is offered", () => {
  test("is none in a build with no way to sign in, so first run and Settings show no row", () => {
    expect(copilotWay([])).toBeNull();
  });

  test("is the experimental way while it is the only one", () => {
    expect(copilotWay([{ id: "editor", experimental: true }])).toEqual({
      id: "editor",
      experimental: true,
    });
  });

  test("is IncarnaMind's own app once it has a client ID, with the experimental way behind it", () => {
    const own = { id: "own", experimental: false } as const;
    const editor = { id: "editor", experimental: true } as const;
    expect(copilotWay([own, editor])).toEqual(own);
    expect(copilotWay([editor, own])).toEqual(own);
  });
});

const OWN = { id: "own", experimental: false } as const;
const EDITOR = { id: "editor", experimental: true } as const;

function statusOf(
  account: CopilotStatus["account"],
  profiles: CopilotStatus["profiles"],
): CopilotStatus {
  return { account, signingIn: false, deviceCode: null, profiles, models: [] };
}

describe("The Experimental tag on the Copilot row", () => {
  const signedInWith = (profile: "own" | "editor") =>
    ({ state: "signed-in", profile, login: "priya-shah", plan: null }) as const;

  test("follows the way the account signed in with, not the way offered", () => {
    expect(copilotTagged(statusOf(signedInWith("editor"), [OWN, EDITOR]))).toBe(true);
    expect(copilotTagged(statusOf(signedInWith("own"), [EDITOR, OWN]))).toBe(false);
  });

  test("follows the way offered until the account has signed in", () => {
    expect(copilotTagged(statusOf({ state: "signed-out" }, [OWN, EDITOR]))).toBe(false);
    expect(copilotTagged(statusOf({ state: "expired" }, [EDITOR]))).toBe(true);
  });
});

describe("The words of the own route's signed-in row", () => {
  test("name GitHub and the account, never a plan, in English and Chinese", () => {
    expect(translate("en", "copilot.signedIn.own", { account: "priya-shah" })).toBe(
      "Signed in to GitHub as priya-shah",
    );
    expect(translate("zh-CN", "copilot.signedIn.own", { account: "priya-shah" })).toBe(
      "已登录 GitHub：priya-shah",
    );
    expect(translate("en", "copilot.signedIn.ownNoName")).toBe("Signed in to GitHub");
    expect(translate("zh-CN", "copilot.signedIn.ownNoName")).toBe("已登录 GitHub");
  });

  test("keep the plan's usage limits line", () => {
    expect(translate("en", "copilot.signedIn.usage")).toBe(
      "Answers count toward your plan’s usage limits.",
    );
    expect(translate("zh-CN", "copilot.signedIn.usage")).toBe("回答会计入订阅的用量限额。");
  });
});
