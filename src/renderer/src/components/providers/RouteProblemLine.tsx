import type { ProviderErrorKind } from "../../../../core/api";
import {
  type RouteProblemWords,
  type SignInRoute,
  wayBackLabel,
} from "../../../../core/providers/signInRoutes";
import { formatResetTime } from "../../cost";
import { useLanguage, useT } from "../../i18n";
import { wayBackRun } from "../../routeSignIn";
import type { SettingsPage, SettingsTarget } from "../../settingsPages";
import { type ProblemAction, ProblemLine } from "../ProblemLine";

/**
 * Where a route signed in with the User's own account stopped: its own line, naming the
 * provider, and its ways back, the main one first (src/core/providers/signInRoutes.ts).
 */
export function RouteProblemLine({
  route,
  words,
  kind,
  resetsAt,
  details,
  onRetry,
  onOpenSettings,
}: {
  route: SignInRoute;
  words: RouteProblemWords;
  kind: ProviderErrorKind;
  resetsAt: string | null;
  details: string | null;
  onRetry?: (() => void) | undefined;
  onOpenSettings(page: SettingsPage, at?: SettingsTarget): void;
}) {
  const t = useT();
  const language = useLanguage();
  const [first, second] = words.waysBack.flatMap((wayBack, index): ProblemAction[] => {
    const onClick = wayBackRun(route, wayBack, { onRetry, onOpenSettings });
    if (!onClick) return [];
    const testId = index === 0 ? "answer-error-action" : "answer-error-also";
    return [{ label: t(wayBackLabel(route, wayBack)), onClick, testId }];
  });
  const line =
    resetsAt && words.lineUntil
      ? t(words.lineUntil, { time: formatResetTime(resetsAt, language) })
      : t(words.line);
  return (
    <div contentEditable={false} data-testid="answer-error" data-error-kind={kind}>
      <ProblemLine
        action={first}
        also={second}
        title={details ?? undefined}
        className="mt-1 select-none"
      >
        {line}
      </ProblemLine>
    </div>
  );
}
