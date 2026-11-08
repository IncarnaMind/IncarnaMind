/**
 * "Sign in again" for a route signed in with the User's own account (a Claude account, a Copilot
 * plan), from a problem line: the route's own sign-in, which resolves true once signed in so the
 * line can try again. A route whose sign-in isn't built here opens Settings › Models at its row.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { RouteWayBack, SignInRoute } from "../../core/providers/signInRoutes";
import { signInToClaudeAgain } from "./claudeSignIn";
import { signInToCopilotAgain } from "./copilotSignIn";
import { core } from "./core";
import { requestModelMenu } from "./modelMenu";
import type { SettingsPage } from "./settingsPages";
import { useAppStore } from "./store";

const SIGN_INS: Partial<Record<SignInRoute, () => Promise<boolean>>> = {
  "claude-account": signInToClaudeAgain,
  copilot: signInToCopilotAgain,
};

/** What a way back does on a problem line; undefined where the line can't do it. */
export function wayBackRun(
  route: SignInRoute,
  wayBack: RouteWayBack,
  line: { onRetry?: (() => void) | undefined; onOpenSettings(page: SettingsPage): void },
): (() => void) | undefined {
  switch (wayBack) {
    case "sign-in":
    case "sign-in-again":
      return () =>
        void signInToRoute(route).then((signedIn) => {
          if (signedIn) line.onRetry?.();
        });
    case "try-again":
      return line.onRetry;
    case "use-another-model":
      return requestModelMenu;
    case "paste-api-key":
      return () => line.onOpenSettings("ai");
  }
}

export function signInToRoute(route: SignInRoute): Promise<boolean> {
  const signIn = SIGN_INS[route];
  if (signIn) return signIn();
  useAppStore.getState().openSettings("ai", route);
  return Promise.resolve(false);
}

const useOffered = create<Partial<Record<SignInRoute, boolean>>>()(() => ({}));

let asked = false;
function askOffered(): void {
  asked = true;
  core.getClaudeAccount().then(
    (status) => useOffered.setState({ "claude-account": status.available }),
    (error: unknown) => console.error("Whether this build signs in to Claude is unknown.", error),
  );
  core.getCopilot().then(
    (status) => useOffered.setState({ copilot: status.profiles.length > 0 }),
    (error: unknown) => console.error("Whether this build signs in to GitHub is unknown.", error),
  );
}

/** Whether this build can sign in with `route`; true until it is known. */
export function useRouteOffered(route: SignInRoute | null): boolean {
  useEffect(() => {
    if (!asked) askOffered();
  }, []);
  return useOffered((state) => (route ? (state[route] ?? true) : false));
}
