import type { ChatReadiness } from "../../../../core/api";
import {
  isSignInRoute,
  SIGN_IN_ROUTES,
  wayBackLabel,
} from "../../../../core/providers/signInRoutes";
import { signInAgain } from "../../chatGptSignIn";
import { useLanguage, useT } from "../../i18n";
import { turnOffLocalMode } from "../../localMode";
import { useSettingUp } from "../../modelSetup";
import { useRequests } from "../../requests";
import { wayBackRun } from "../../routeSignIn";
import type { SettingsPage } from "../../settingsPages";
import { useAppStore } from "../../store";
import { ProblemLine } from "../ProblemLine";
import { readinessKey, serviceName } from "./shared";

/** Where to fix it: a declined data flow is allowed again on the Privacy page, the rest under Models. */
export const settingsPageFor = (
  readiness: Extract<ChatReadiness, { ready: false }>,
): SettingsPage => (readiness.reason === "consent-declined" ? "privacy" : "models");

/** A sign-in route's way back from being signed out: the `index`th, first the main one. */
function routeWayBack(
  readiness: Extract<ChatReadiness, { ready: false }>,
  index: number,
  t: ReturnType<typeof useT>,
  openSettings: (page: SettingsPage) => void,
  before?: () => void,
): { label: string; onClick(): void } | undefined {
  if (readiness.reason !== "sign-in-required") return undefined;
  const { kind } = readiness.provider;
  if (!isSignInRoute(kind)) return undefined;
  const wayBack = SIGN_IN_ROUTES[kind].problems["signed-out"].waysBack[index];
  const run = wayBack && wayBackRun(kind, wayBack, { onOpenSettings: openSettings });
  if (!wayBack || !run) return undefined;
  return {
    label: t(wayBackLabel(kind, wayBack)),
    onClick: () => {
      before?.();
      run();
    },
  };
}

/**
 * The one action that fixes `readiness`, labelled `label` (its Settings page
 * by default): for an ended sign-in, signing in again with its own provider;
 * else opening the Settings page that fixes it. `before` runs first, e.g. to
 * dismiss the problem.
 */
export function readinessAction(
  readiness: Extract<ChatReadiness, { ready: false }>,
  t: ReturnType<typeof useT>,
  openSettings: (page: SettingsPage) => void,
  label: string,
  before?: () => void,
): { label: string; onClick(): void } {
  const route = routeWayBack(readiness, 0, t, openSettings, before);
  if (route) return route;
  if (readiness.reason === "sign-in-required") {
    return {
      label: t("chatgpt.signInAgain"),
      onClick: () => {
        before?.();
        void signInAgain(openSettings);
      },
    };
  }
  return {
    label,
    onClick: () => {
      before?.();
      openSettings(settingsPageFor(readiness));
    },
  };
}

/** A sign-in route's second way back from being signed out, beside `readinessAction`. */
export const readinessAlso = (
  readiness: Extract<ChatReadiness, { ready: false }>,
  t: ReturnType<typeof useT>,
  openSettings: (page: SettingsPage) => void,
  before?: () => void,
) => routeWayBack(readiness, 1, t, openSettings, before);

/**
 * What to configure before Questions can be asked. `inLine`: ahead of an
 * action on the same line, so without the full stop that ends it otherwise.
 */
export function ReadinessExplanation({
  readiness,
  inLine = false,
}: {
  readiness: Extract<ChatReadiness, { ready: false }>;
  inLine?: boolean;
}) {
  const t = useT();
  const language = useLanguage();
  const service = "provider" in readiness ? serviceName(readiness.provider, t, language) : "";
  const words = t(readinessKey(readiness), { service });
  if (inLine) return <>{words.replace(/[.。]$/, "")}</>;
  return <>{/[.。]$/.test(words) ? words : `${words}${language === "zh-CN" ? "。" : "."}`}</>;
}

/**
 * Why Questions can't be asked, as one line with the one thing that fixes it.
 * Local mode refusing a cloud model has two ways out, so it offers both: a
 * local model, or turning local mode off (which can be undone).
 */
export function ReadinessLine({
  readiness,
  testId,
  className,
  setUpLabel,
}: {
  readiness: Extract<ChatReadiness, { ready: false }>;
  testId: string;
  className?: string;
  setUpLabel: string;
}) {
  const t = useT();
  const openSettings = useAppStore((state) => state.openSettings);
  if (readiness.reason === "local-mode") {
    return (
      <ProblemLine
        role="status"
        testId={testId}
        {...(className && { className })}
        action={{
          label: t("localMode.useLocal"),
          testId: "local-mode-use-local",
          onClick: () => useRequests.getState().ask({ chooseLocalModel: true }),
        }}
        also={{
          label: t("localMode.turnOff"),
          testId: "local-mode-turn-off",
          onClick: () =>
            turnOffLocalMode().catch((error: unknown) => useAppStore.getState().reportError(error)),
        }}
      >
        <ReadinessExplanation readiness={readiness} inLine />
      </ProblemLine>
    );
  }
  return (
    <ProblemLine
      role="status"
      testId={testId}
      {...(className && { className })}
      action={readinessAction(readiness, t, openSettings, setUpLabel)}
      also={readinessAlso(readiness, t, openSettings)}
    >
      <ReadinessExplanation readiness={readiness} inLine />
    </ProblemLine>
  );
}

/**
 * Shown in a Mind while Questions can't be asked, with a way to fix it.
 * Answers (#29) disable asking with the same explanation.
 */
export function ChatReadinessNotice() {
  const t = useT();
  const readiness = useAppStore((state) => state.chatReadiness);
  // The setup card already says it.
  const settingUp = useSettingUp();
  if (!readiness || readiness.ready || settingUp) return null;
  // Local mode's refusal is said once, in the composer where the Question was asked (#1511): a
  // second line above the page would move the page.
  if (readiness.reason === "local-mode") return null;
  return (
    <ReadinessLine
      readiness={readiness}
      testId="chat-readiness"
      className="mb-3"
      setUpLabel={t("providers.readiness.setUp")}
    />
  );
}
