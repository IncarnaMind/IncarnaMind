import { useEffect, useRef } from "react";
import type { AgentPairing, ClaudeCodeInstallFailureReason } from "../../../../core/api";
import {
  cancelClaudeCodeInstall,
  checkClaudeCodeAuth,
  openClaudeCodeSignIn,
  resetClaudeCodeInstall,
  startClaudeCodeInstall,
  useClaudeCodeInstallAvailability,
  useClaudeCodeInstallStarting,
  useClaudeCodeInstallState,
} from "../../claudeCodeInstall";
import { useT } from "../../i18n";
import { turnOffLocalMode } from "../../localMode";
import { ProblemMark } from "../ProblemLine";
import { buttonStyle } from "../ui";

export const ANTHROPIC_SETUP_GUIDE_URL = "https://code.claude.com/docs/en/setup";

const linkClass =
  "rounded-sm text-[13px] font-semibold text-accent-strong underline-offset-2 hover:underline focus-visible:outline-offset-0";

function failureKey(reason: ClaudeCodeInstallFailureReason) {
  switch (reason) {
    case "network":
      return "agents.install.failed.network" as const;
    case "checksum":
      return "agents.install.failed.checksum" as const;
    case "unsupported":
      return "agents.install.failed.unsupported" as const;
    case "local-mode":
      return "agents.install.failed.localMode" as const;
    case "root":
      return "agents.install.failed.root" as const;
    case "sign-in-failed":
      return "agents.install.failed.signIn" as const;
    case "failed":
      return "agents.install.failed.generic" as const;
  }
}

export interface ClaudeCodeInstallRowProps {
  /** "first-run" renders as a calm standalone card row; "settings" sits inside SettingsGroup. */
  variant: "first-run" | "settings";
  /** Connected pairings, used to name a connected desktop app (e.g. Claude) on the no-plan state. */
  pairings: readonly AgentPairing[];
  /** Called once when sign-in succeeds so the host opens the standard Connect consent card. */
  onSignedIn(): void;
  /** Called when the User chooses "Set up a model in IncarnaMind" from the no-plan fallback. */
  onSetUpModel(): void;
  /** Called when the User chooses "Keep asking through …" from the no-plan fallback. */
  onKeepDesktop?(): void;
}

/**
 * In-place offer, progress, browser sign-in handoff, installer failure, and no-plan fallback for
 * installing Anthropic's official Claude Code binary (#3638). Hidden whenever a command-line AI
 * is already detected and no install flow is active.
 */
export function ClaudeCodeInstallRow({
  variant,
  pairings,
  onSignedIn,
  onSetUpModel,
  onKeepDesktop,
}: ClaudeCodeInstallRowProps) {
  const t = useT();
  const availability = useClaudeCodeInstallAvailability();
  const state = useClaudeCodeInstallState();
  const starting = useClaudeCodeInstallStarting();
  const handedOff = useRef(false);

  useEffect(() => {
    if (state.kind === "signed-in" && !handedOff.current) {
      handedOff.current = true;
      onSignedIn();
    } else if (state.kind !== "signed-in") {
      handedOff.current = false;
    }
  }, [state.kind, onSignedIn]);

  if (!availability?.supported) return null;

  const isIdle = state.kind === "idle" || state.kind === "signed-in";
  if (isIdle && availability.cliAgentPresent) return null;
  if (state.kind === "signed-in") return null;

  const wrapperClass =
    variant === "first-run"
      ? "rounded-lg bg-surface-subtle px-3.5 py-3 shadow-[inset_0_0_0_1px_var(--color-rule)]"
      : "border-b border-rule bg-surface-subtle px-4 py-3 last:border-b-0";

  if (state.kind === "installing") {
    const fillWidth = state.stage === "installing" ? "w-4/5" : "w-1/2";
    return (
      <div
        data-testid="claude-code-install-progress"
        data-stage={state.stage}
        role="status"
        className={`${wrapperClass} flex items-start justify-between gap-3.5`}
      >
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <span
            aria-hidden="true"
            className="mt-1.5 size-2 shrink-0 rounded-full bg-accent shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_16%,transparent)]"
          />
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] leading-5 font-semibold text-ink">
              {t("agents.install.progress.title")}
            </div>
            <p className="mt-0.5 text-[12.5px] leading-[18px] text-ink-meta">
              {t("agents.install.progress.detail", { directory: state.directory })}
            </p>
            <div className="mt-2 h-[3px] max-w-[340px] overflow-hidden rounded-full bg-rule">
              <div className={`h-full rounded-full bg-accent ${fillWidth}`} />
            </div>
          </div>
        </div>
        <div className="shrink-0">
          <button
            type="button"
            data-testid="claude-code-install-cancel"
            onClick={() => void cancelClaudeCodeInstall()}
            className={buttonStyle("secondary", "sm")}
          >
            {t("agents.install.progress.cancel")}
          </button>
        </div>
      </div>
    );
  }

  if (state.kind === "awaiting-sign-in") {
    return (
      <div
        data-testid="claude-code-install-signin"
        role="status"
        className={`${wrapperClass} flex items-start gap-2.5`}
      >
        <span
          aria-hidden="true"
          className="mt-1.5 size-2 shrink-0 rounded-full bg-accent shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_16%,transparent)]"
        />
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] leading-5 font-semibold text-ink">
            {t("agents.install.signIn.title")}
          </div>
          <p className="mt-0.5 text-[12.5px] leading-[18px] text-ink-meta">
            {t("agents.install.signIn.detail")}
          </p>
          {state.notYet && (
            <p
              data-testid="claude-code-install-signin-not-yet"
              className="mt-1 text-[12px] leading-[17px] text-ink-secondary"
            >
              {t("agents.install.signIn.notYet")}
            </p>
          )}
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="claude-code-install-check-auth"
              onClick={() => void checkClaudeCodeAuth()}
              className={buttonStyle("primary", "sm")}
            >
              {t("agents.install.signIn.done")}
            </button>
            <button
              type="button"
              data-testid="claude-code-install-reopen-signin"
              onClick={() => void openClaudeCodeSignIn()}
              className={buttonStyle("secondary", "sm")}
            >
              {t("agents.install.signIn.reopen")}
            </button>
            <button
              type="button"
              data-testid="claude-code-install-cancel"
              onClick={() => void cancelClaudeCodeInstall()}
              className={buttonStyle("ghost", "sm")}
            >
              {t("agents.install.progress.cancel")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (state.kind === "failed") {
    const localMode = state.reason === "local-mode";
    const signInFailed = state.reason === "sign-in-failed";
    const rootBlocked = state.reason === "root";
    return (
      <div
        data-testid="claude-code-install-failed"
        data-reason={state.reason}
        role="alert"
        className={`${wrapperClass} flex items-start gap-2.5`}
      >
        <span className="mt-0.5 shrink-0">
          <ProblemMark />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] leading-5 font-semibold text-ink">
            {t(signInFailed ? "agents.install.failed.signInTitle" : "agents.install.failed.title")}
          </div>
          <p className="mt-0.5 text-[12.5px] leading-[18px] text-ink-meta">
            {t(failureKey(state.reason))}
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
            {localMode && (
              <button
                type="button"
                data-testid="claude-code-install-local-mode-off"
                disabled={starting}
                onClick={() =>
                  void turnOffLocalMode().then(
                    () => startClaudeCodeInstall(),
                    () => undefined,
                  )
                }
                className={buttonStyle("primary", "sm")}
              >
                {t("agents.install.failed.localModeAction")}
              </button>
            )}
            {!localMode && !rootBlocked && (
              <button
                type="button"
                data-testid="claude-code-install-retry"
                disabled={starting}
                onClick={() =>
                  void (signInFailed ? openClaudeCodeSignIn() : startClaudeCodeInstall())
                }
                className={buttonStyle("primary", "sm")}
              >
                {t("agents.install.failed.retry")}
              </button>
            )}
            <a
              href={ANTHROPIC_SETUP_GUIDE_URL}
              target="_blank"
              rel="noreferrer"
              data-testid="claude-code-install-guide"
              className={linkClass}
            >
              {t("agents.install.failed.guide")}
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (state.kind === "no-plan") {
    const desktopPairing = pairings.find((each) => each.client === "claude-desktop");
    const detail = desktopPairing
      ? t("agents.install.noPlan.detail.named", { agent: desktopPairing.name })
      : t("agents.install.noPlan.detail.desktop");
    const keepLabel = desktopPairing
      ? t("agents.install.noPlan.keepAsking.named", { agent: desktopPairing.name })
      : t("agents.install.noPlan.keepAsking.desktop");
    return (
      <div
        data-testid="claude-code-install-no-plan"
        role="status"
        className={`${wrapperClass} flex items-start gap-2.5`}
      >
        <span className="mt-0.5 shrink-0">
          <ProblemMark />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] leading-5 font-semibold text-ink">
            {t("agents.install.noPlan.title")}
          </div>
          <p className="mt-0.5 text-[12.5px] leading-[18px] text-ink-meta">{detail}</p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="claude-code-no-plan-model"
              onClick={() => {
                void resetClaudeCodeInstall();
                onSetUpModel();
              }}
              className={buttonStyle("primary", "sm")}
            >
              {t("agents.install.noPlan.setUpModel")}
            </button>
            <button
              type="button"
              data-testid="claude-code-no-plan-desktop"
              onClick={() => {
                void resetClaudeCodeInstall();
                onKeepDesktop?.();
              }}
              className={buttonStyle("secondary", "sm")}
            >
              {keepLabel}
            </button>
            <button
              type="button"
              data-testid="claude-code-no-plan-try-other"
              onClick={() => void openClaudeCodeSignIn()}
              className={linkClass}
            >
              {t("agents.install.noPlan.tryOther")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const title =
    variant === "first-run"
      ? t("agents.install.firstRun.title")
      : t("agents.install.settings.title");
  const detail =
    variant === "first-run"
      ? t("agents.install.firstRun.detail")
      : t("agents.install.settings.detail");
  return (
    <div
      data-testid="claude-code-install-offer"
      className={`${wrapperClass} flex items-center justify-between gap-4`}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] leading-5 font-semibold text-ink">{title}</div>
        <p className="mt-0.5 text-[12.5px] leading-[18px] text-ink-meta">{detail}</p>
      </div>
      <div className="shrink-0">
        <button
          type="button"
          data-testid="install-claude-code"
          disabled={starting}
          aria-busy={starting || undefined}
          onClick={() => void startClaudeCodeInstall()}
          className={buttonStyle("primary", "sm")}
        >
          {starting ? t("agents.install.progress.title") : t("agents.install.action")}
        </button>
      </div>
    </div>
  );
}
