import type { ReactNode } from "react";
import type { ClaudeCodeInstallState } from "../../../../core/api";
import {
  cancelClaudeCodeInstall,
  checkClaudeCodeAuth,
  openClaudeCodeSignIn,
  startClaudeCodeInstall,
  useClaudeCodeInstallStarting,
  useClaudeCodeInstallState,
} from "../../claudeCodeInstall";
import { useT } from "../../i18n";
import { installFailureKey } from "../agents/ClaudeCodeInstallRow";
import { buttonStyle } from "../ui";
import { AppMark, rowClass } from "./yourAiParts";

const CLAUDE_CODE = "Claude Code";

/**
 * What the Your AI step's Claude Code row says while its one-press install goes on (#3791), and its
 * one button: installing, signing in, a plan without it, or why it failed; null while idle.
 */
function installStatus(
  state: ClaudeCodeInstallState,
  t: ReturnType<typeof useT>,
): { line: string; action: ReactNode } | null {
  switch (state.kind) {
    case "idle":
    case "signed-in":
      return null;
    case "installing":
      return {
        line: t("setupPage.ai.install.installing"),
        action: (
          <button
            type="button"
            data-testid="setup-install-cancel"
            onClick={() => void cancelClaudeCodeInstall()}
            className={buttonStyle("secondary", "sm")}
          >
            {t("agents.install.progress.cancel")}
          </button>
        ),
      };
    case "awaiting-sign-in":
      return state.notYet
        ? {
            line: t("setupPage.ai.install.notYet"),
            action: (
              <button
                type="button"
                data-testid="setup-install-reopen"
                onClick={() => void openClaudeCodeSignIn()}
                className={buttonStyle("secondary", "sm")}
              >
                {t("agents.install.signIn.reopen")}
              </button>
            ),
          }
        : {
            line: t("setupPage.ai.install.signIn"),
            action: (
              <button
                type="button"
                data-testid="setup-install-signed-in"
                onClick={() => void checkClaudeCodeAuth()}
                className={buttonStyle("secondary", "sm")}
              >
                {t("agents.install.signIn.done")}
              </button>
            ),
          };
    case "no-plan":
      return {
        line: t("agents.install.noPlan.title"),
        action: (
          <button
            type="button"
            data-testid="setup-install-other-account"
            onClick={() => void openClaudeCodeSignIn()}
            className={buttonStyle("secondary", "sm")}
          >
            {t("agents.install.noPlan.tryOther")}
          </button>
        ),
      };
    case "failed":
      return {
        line: t(installFailureKey(state.reason)),
        action:
          state.reason === "local-mode" || state.reason === "root" ? null : (
            <button
              type="button"
              data-testid="setup-install-retry"
              onClick={() =>
                void (state.reason === "sign-in-failed"
                  ? openClaudeCodeSignIn()
                  : startClaudeCodeInstall())
              }
              className={buttonStyle("secondary", "sm")}
            >
              {t("agents.install.failed.retry")}
            </button>
          ),
      };
  }
}

function Row({
  testId,
  state,
  line,
  action,
}: {
  testId: string;
  state: string;
  line: string;
  action: ReactNode;
}) {
  return (
    <li data-testid={testId} data-client="claude-code" data-state={state} className={rowClass}>
      <AppMark name={CLAUDE_CODE} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-ui text-ink">{CLAUDE_CODE}</span>
        <span role="status" className="text-[12px] leading-[18px] text-ink-meta">
          {line}
        </span>
      </span>
      {action}
    </li>
  );
}

/** With no AI app found: Claude Code, installed with one press, and each step of it in this row. */
export function InstallOfferRow() {
  const t = useT();
  const state = useClaudeCodeInstallState();
  const starting = useClaudeCodeInstallStarting();
  const status = installStatus(state, t);
  return (
    <Row
      testId="setup-install-row"
      state={state.kind}
      line={status?.line ?? t("setupPage.ai.install.line")}
      action={
        status ? (
          status.action
        ) : (
          <button
            type="button"
            data-testid="setup-install-claude-code"
            disabled={starting}
            onClick={() => void startClaudeCodeInstall()}
            className={buttonStyle("primary", "sm")}
          >
            {t("setupPage.ai.install")}
          </button>
        )
      }
    />
  );
}

/** Claude Code installing in the same press that connected the Claude app, until it connects too. */
export function InstallingRow({ state }: { state: ClaudeCodeInstallState }) {
  const t = useT();
  const status = installStatus(state, t);
  return (
    <Row
      testId="setup-done-row"
      state={state.kind}
      line={status?.line ?? t("setupPage.ai.install.installing")}
      action={status?.action ?? null}
    />
  );
}
