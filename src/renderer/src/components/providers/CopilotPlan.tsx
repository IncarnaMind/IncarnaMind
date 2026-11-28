import { useEffect, useRef } from "react";
import type { CopilotPlan, CopilotStatus } from "../../../../core/api";
import { copilotTagged, copilotWay } from "../../../../core/providers/copilot/service";
import {
  COPILOT_SIGN_IN_PROBLEMS,
  type RouteProblemWords,
  type RouteWayBack,
  wayBackLabel,
} from "../../../../core/providers/signInRoutes";
import type { MessageKey } from "../../../../shared/i18n";
import { copyText } from "../../copied";
import {
  type CopilotFailure,
  cancelCopilotSignIn,
  chooseCopilotPlan,
  closeCopilotNotice,
  openCopilotNotice,
  signInWithCopilot,
  useCopilot,
  useCopilotStatus,
} from "../../copilotSignIn";
import { core } from "../../core";
import { useT } from "../../i18n";
import { useSettingsTarget } from "../../settingsTarget";
import { useAppStore } from "../../store";
import { DetailsLine } from "../DetailsLine";
import { CopyLineIcon } from "../icons";
import { ProblemMark } from "../ProblemLine";
import { SettingsRow } from "../settings/SettingsGroup";
import { buttonStyle } from "../ui";

const TARGET = ["copilot"] as const;

const PLAN_NAMES: Record<CopilotPlan, MessageKey> = {
  free: "copilot.plan.free",
  pro: "copilot.plan.pro",
  "pro-plus": "copilot.plan.pro-plus",
  business: "copilot.plan.business",
  enterprise: "copilot.plan.enterprise",
};

const NO_MODELS: RouteProblemWords = {
  line: "copilot.signIn.noModels",
  waysBack: ["try-again", "paste-api-key"],
};

const failureWords = (failure: CopilotFailure): RouteProblemWords =>
  failure.kind === "no-models" ? NO_MODELS : COPILOT_SIGN_IN_PROBLEMS[failure.kind];

export function useOfferedWay(): { status: CopilotStatus; experimental: boolean } | null {
  const status = useCopilotStatus();
  const way = status && copilotWay(status.profiles);
  return status && way ? { status, experimental: way.experimental } : null;
}

function ExperimentalTag() {
  const t = useT();
  return (
    <span className="rounded-sm bg-chip px-1.5 text-small leading-5 text-ink-secondary">
      {t("copilot.experimental")}
    </span>
  );
}

export function CopilotPlanRow() {
  const t = useT();
  const offered = useOfferedWay();
  const open = useCopilot((state) => state.open);
  const failure = useCopilot((state) => state.failure);
  const providerSaved = useCopilot((state) => state.providerSaved);
  const row = useSettingsTarget<HTMLDivElement>(TARGET, offered !== null);
  const signOut = useRef<HTMLButtonElement>(null);
  const status = offered?.status;
  const signedIn = status?.account.state === "signed-in" && !status.signingIn;
  const ready = signedIn && providerSaved !== false;
  const wasSigningIn = useRef(false);
  useEffect(() => {
    if (status?.signingIn) wasSigningIn.current = true;
    else if (ready && wasSigningIn.current) {
      wasSigningIn.current = false;
      signOut.current?.focus();
    }
  }, [status?.signingIn, ready]);
  if (!offered || !status) return null;
  const { account } = status;
  const expanded = open || status.signingIn || failure !== null;
  return (
    <SettingsRow
      ref={row}
      role="listitem"
      data-testid="plans-copilot"
      label={
        <span className="flex flex-wrap items-center gap-x-2">
          {t("plans.copilot.title")}
          {copilotTagged(status) && <ExperimentalTag />}
        </span>
      }
      detail={
        account.state === "signed-in" ? (
          <>
            <p data-testid="plans-copilot-account">
              {account.profile === "own"
                ? account.login
                  ? t("copilot.signedIn.own", { account: account.login })
                  : t("copilot.signedIn.ownNoName")
                : [
                    t(account.plan ? PLAN_NAMES[account.plan] : "copilot.plan.unknown"),
                    account.login,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
            </p>
            {ready && <p>{t("copilot.signedIn.usage")}</p>}
          </>
        ) : (
          <p>
            {t(
              account.state === "expired" ? "copilot.problem.signInExpired" : "plans.copilot.line",
            )}
          </p>
        )
      }
      control={
        signedIn || !expanded ? (
          <>
            {signedIn && !ready && !expanded && (
              <button
                type="button"
                data-testid="plans-copilot-use"
                onClick={() => void chooseCopilotPlan({ keepDefault: true })}
                className={buttonStyle("primary", "sm")}
              >
                {t("copilot.use")}
              </button>
            )}
            {signedIn ? (
              <button
                ref={signOut}
                type="button"
                data-testid="plans-copilot-sign-out"
                onClick={() =>
                  void core
                    .signOutOfCopilot()
                    .then((next) => useCopilot.setState({ status: next }))
                    .catch((error: unknown) => useAppStore.getState().reportError(error))
                }
                className={buttonStyle("secondary", "sm")}
              >
                {t("copilot.signOut")}
              </button>
            ) : (
              <button
                type="button"
                data-testid="plans-copilot-sign-in"
                onClick={openCopilotNotice}
                className={buttonStyle("secondary", "sm")}
              >
                {t(
                  account.state === "expired"
                    ? "signInRoute.wayBack.signInAgain"
                    : "copilot.wayBack.signIn",
                )}
              </button>
            )}
          </>
        ) : undefined
      }
    >
      {expanded && <SignInPanel status={status} experimental={offered.experimental} />}
    </SettingsRow>
  );
}

function SignInPanel({ status, experimental }: { status: CopilotStatus; experimental: boolean }) {
  const failure = useCopilot((state) => state.failure);
  if (status.signingIn) return <Waiting status={status} />;
  if (failure) return <Failure failure={failure} />;
  return <Notice experimental={experimental} />;
}

function Notice({ experimental }: { experimental: boolean }) {
  const t = useT();
  const signIn = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  // An experimental way starts on the safe choice (ADR-0019's amendment).
  useEffect(() => {
    (experimental ? cancel : signIn).current?.focus();
  }, [experimental]);
  return (
    <div data-testid="copilot-notice" className="flex flex-col gap-2">
      <p className="text-ui leading-5 text-ink">{t("copilot.notice.title")}</p>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-ui leading-5 text-ink-secondary">
        <li data-testid="copilot-notice-usage" className="text-ink">
          {t("copilot.notice.usage")}
        </li>
        {experimental && <li>{t("copilot.notice.experimental")}</li>}
        <li>
          <DetailsLine testId="copilot-notice-sends" details={t("copilot.notice.sends.details")}>
            {t("copilot.notice.sends")}
          </DetailsLine>
        </li>
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <button
          ref={signIn}
          type="button"
          data-testid="copilot-sign-in"
          onClick={() => void signInWithCopilot({ keepDefault: true })}
          className={buttonStyle("primary", "sm")}
        >
          {t("copilot.wayBack.signIn")}
        </button>
        <button
          ref={cancel}
          type="button"
          data-testid="copilot-cancel"
          onClick={closeCopilotNotice}
          className={buttonStyle("ghost", "sm")}
        >
          {t("copilot.cancel")}
        </button>
      </div>
    </div>
  );
}

function Waiting({ status }: { status: CopilotStatus }) {
  const t = useT();
  const code = status.deviceCode;
  const copy = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const shown = code !== null;
  useEffect(() => {
    (shown ? copy : cancel).current?.focus();
  }, [shown]);
  return (
    <div data-testid="copilot-waiting" className="flex flex-col gap-2">
      {code ? (
        <>
          <p className="text-ui leading-5 text-ink">{t("copilot.code.title")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <span
              data-testid="copilot-code"
              className="rounded-sm border border-rule-strong bg-sheet px-2 font-mono text-heading leading-8 tracking-[0.04em] text-ink select-all"
            >
              {code.userCode}
            </span>
            <button
              ref={copy}
              type="button"
              data-testid="copilot-copy-code"
              onClick={() =>
                void copyText(code.userCode).catch((error: unknown) =>
                  useAppStore.getState().reportError(error),
                )
              }
              className={buttonStyle("secondary", "sm")}
            >
              <CopyLineIcon aria-hidden="true" />
              {t("copilot.code.copy")}
            </button>
          </div>
        </>
      ) : null}
      <p role="status" className="flex items-start gap-2 text-ui leading-5 text-ink-secondary">
        <span aria-hidden="true" className="flex h-5 shrink-0 items-center">
          <span className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse" />
        </span>
        {t(code ? "copilot.code.waiting" : "copilot.code.asking")}
      </p>
      <p className="text-ui leading-5 text-ink-meta">{t("copilot.notice.usage")}</p>
      <div className="flex flex-wrap items-center gap-2">
        {code && (
          <button
            type="button"
            data-testid="copilot-reopen"
            // The main process opens it in the User's browser.
            onClick={() => window.open(code.verificationUri, "_blank", "noreferrer")}
            className={buttonStyle("secondary", "sm")}
          >
            {t("copilot.code.reopen")}
          </button>
        )}
        <button
          ref={cancel}
          type="button"
          data-testid="copilot-cancel"
          onClick={() => void cancelCopilotSignIn()}
          className={buttonStyle("ghost", "sm")}
        >
          {t("copilot.cancel")}
        </button>
      </div>
    </div>
  );
}

function Failure({ failure }: { failure: CopilotFailure }) {
  const t = useT();
  const openSettings = useAppStore((state) => state.openSettings);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus();
  }, []);
  const words = failureWords(failure);
  const keepDefault = true;
  const signIn = () => void signInWithCopilot({ keepDefault });
  const anotherModel = () => {
    closeCopilotNotice();
    openSettings("ai", "chat-model");
  };
  const run: Record<RouteWayBack, (() => void) | undefined> = {
    "sign-in": signIn,
    "sign-in-again": signIn,
    // Signed in already, a plan that listed no model needs only its list read again.
    "try-again":
      failure.kind === "no-models" ? () => void chooseCopilotPlan({ keepDefault }) : signIn,
    "use-another-model": anotherModel,
    // No new model is set up in IncarnaMind (#3767).
    "paste-api-key": undefined,
  };
  const label = (wayBack: RouteWayBack) => t(wayBackLabel("copilot", wayBack));
  const actions = words.waysBack.flatMap((wayBack) => {
    const onClick = run[wayBack];
    return onClick ? [{ wayBack, onClick }] : [];
  });
  return (
    <div
      role="alert"
      data-testid="copilot-failure"
      data-failure={failure.kind}
      title={failure.message}
      className="flex flex-col gap-2"
    >
      <p className="text-ui leading-5 text-ink">
        <ProblemMark />
        {t(words.line)}
      </p>
      {failure.kind === "policy-blocked" && (
        <p className="text-ui leading-5 text-ink-secondary">{t("copilot.policyBlocked.body")}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {actions.map(({ wayBack, onClick }, index) => (
          <button
            key={wayBack}
            ref={index === 0 ? first : undefined}
            type="button"
            data-testid={`copilot-way-back-${wayBack}`}
            onClick={onClick}
            className={buttonStyle(index === 0 ? "secondary" : "ghost", "sm")}
          >
            {label(wayBack)}
          </button>
        ))}
      </div>
    </div>
  );
}
