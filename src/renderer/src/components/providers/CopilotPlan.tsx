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
import { ChevronDownLineIcon, ChevronRightLineIcon, CopyLineIcon } from "../lineIcons";
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

const linkClass =
  "self-start text-[13px] leading-5 font-semibold text-accent underline-offset-2 hover:underline";

type Place = "setup" | "settings";

export function useOfferedWay(): { status: CopilotStatus; experimental: boolean } | null {
  const status = useCopilotStatus();
  const way = status && copilotWay(status.profiles);
  return status && way ? { status, experimental: way.experimental } : null;
}

function ExperimentalTag() {
  const t = useT();
  return (
    <span className="rounded-sm bg-chip px-1.5 text-label leading-5 font-semibold text-ink-secondary">
      {t("copilot.experimental")}
    </span>
  );
}

/** `onKey` opens the key form, the way back to an API key. */
export function CopilotSetupWay({ onKey }: { onKey(): void }) {
  const t = useT();
  const offered = useOfferedWay();
  const open = useCopilot((state) => state.open);
  const failure = useCopilot((state) => state.failure);
  if (!offered) return null;
  const expanded = open || offered.status.signingIn || failure !== null;
  const Chevron = expanded ? ChevronDownLineIcon : ChevronRightLineIcon;
  return (
    <div
      data-testid="setup-copilot"
      className={`flex flex-col rounded-md ${expanded ? "bg-frame" : ""}`}
    >
      <button
        type="button"
        data-testid="way-copilot"
        aria-expanded={expanded}
        onClick={() => (expanded ? closeCopilotNotice() : openCopilotNotice())}
        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover"
      >
        <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
          <span className="flex flex-wrap items-center gap-x-2 text-ui font-semibold text-ink">
            {t("copilot.way.title")}
            {offered.experimental && <ExperimentalTag />}
          </span>
          <span className="text-[13px] leading-5 text-ink-secondary">{t("copilot.way.line")}</span>
        </span>
        <Chevron aria-hidden="true" className="size-3.5 shrink-0 text-ink-meta" />
      </button>
      {expanded && (
        <div className="px-2 pt-1 pb-2">
          <SignInPanel
            place="setup"
            status={offered.status}
            experimental={offered.experimental}
            onKey={onKey}
          />
        </div>
      )}
    </div>
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
      {expanded && (
        <SignInPanel place="settings" status={status} experimental={offered.experimental} />
      )}
    </SettingsRow>
  );
}

function SignInPanel({
  place,
  status,
  experimental,
  onKey,
}: {
  place: Place;
  status: CopilotStatus;
  experimental: boolean;
  onKey?: () => void;
}) {
  const failure = useCopilot((state) => state.failure);
  if (status.signingIn) return <Waiting status={status} />;
  if (failure) return <Failure failure={failure} place={place} onKey={onKey} />;
  return <Notice place={place} experimental={experimental} onKey={onKey} />;
}

function Notice({
  place,
  experimental,
  onKey,
}: {
  place: Place;
  experimental: boolean;
  onKey: (() => void) | undefined;
}) {
  const t = useT();
  const signIn = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  // An experimental way starts on the safe choice (ADR-0019's amendment).
  useEffect(() => {
    (experimental ? cancel : signIn).current?.focus();
  }, [experimental]);
  return (
    <div data-testid="copilot-notice" className="flex flex-col gap-2">
      <p className="text-[13px] leading-5 font-semibold text-ink">{t("copilot.notice.title")}</p>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] leading-5 text-ink-secondary">
        <li data-testid="copilot-notice-usage" className="font-semibold text-ink">
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
          onClick={() => void signInWithCopilot({ keepDefault: place === "settings" })}
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
      {onKey && (
        <button type="button" data-testid="copilot-use-key" onClick={onKey} className={linkClass}>
          {t("signInRoute.wayBack.pasteApiKey")}
        </button>
      )}
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
          <p className="text-[13px] leading-5 font-semibold text-ink">{t("copilot.code.title")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <span
              data-testid="copilot-code"
              className="rounded-sm border border-rule-strong bg-sheet px-2 font-mono text-[20px] leading-8 font-semibold tracking-[0.04em] text-ink select-all"
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
              <CopyLineIcon aria-hidden="true" className="size-3.5" />
              {t("copilot.code.copy")}
            </button>
          </div>
        </>
      ) : null}
      <p role="status" className="flex items-start gap-2 text-[13px] leading-5 text-ink-secondary">
        <span aria-hidden="true" className="flex h-5 shrink-0 items-center">
          <span className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse" />
        </span>
        {t(code ? "copilot.code.waiting" : "copilot.code.asking")}
      </p>
      <p className="text-[13px] leading-5 text-ink-meta">{t("copilot.notice.usage")}</p>
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

function Failure({
  failure,
  place,
  onKey,
}: {
  failure: CopilotFailure;
  place: Place;
  onKey: (() => void) | undefined;
}) {
  const t = useT();
  const openSettings = useAppStore((state) => state.openSettings);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus();
  }, []);
  const words = failureWords(failure);
  const keepDefault = place === "settings";
  const signIn = () => void signInWithCopilot({ keepDefault });
  const anotherModel = () => {
    closeCopilotNotice();
    if (place === "settings") openSettings("ai", "chat-model");
  };
  const run: Record<RouteWayBack, (() => void) | undefined> = {
    "sign-in": signIn,
    "sign-in-again": signIn,
    // Signed in already, a plan that listed no model needs only its list read again.
    "try-again":
      failure.kind === "no-models" ? () => void chooseCopilotPlan({ keepDefault }) : signIn,
    "use-another-model": anotherModel,
    "paste-api-key": place === "setup" ? onKey : anotherModel,
  };
  // First run has no other model yet: there, leaving the route is choosing another way.
  const label = (wayBack: RouteWayBack) =>
    place === "setup" && wayBack === "use-another-model"
      ? t("copilot.chooseAnotherWay")
      : t(wayBackLabel("copilot", wayBack));
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
      <p className="text-[13px] leading-5 font-semibold text-ink">
        <ProblemMark />
        {t(words.line)}
      </p>
      {failure.kind === "policy-blocked" && (
        <p className="text-[13px] leading-5 text-ink-secondary">
          {t("copilot.policyBlocked.body")}
        </p>
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
