import { type ReactNode, useState } from "react";
import type { ClaudeCodeInstallState } from "../../../../core/api";
import {
  cancelClaudeCodeInstall,
  checkClaudeCodeAuth,
  openClaudeCodeSignIn,
  useClaudeCodeInstallStarting,
  useClaudeCodeInstallState,
} from "../../claudeCodeInstall";
import { useGap, useT } from "../../i18n";
import { installFailureKey } from "../agents/ClaudeCodeInstallRow";
import { buttonStyle } from "../ui";
import { InstallDisclosure } from "./YourAiConsent";
import { AppMark, linkClass } from "./yourAiParts";

const CLAUDE_CODE = "Claude Code";

/**
 * What the Your AI step's Claude Code row says while its one-press install goes on (#3791), and its
 * one button: installing, signing in, a plan without it, or why it failed; null while idle.
 */
function installStatus(
  state: ClaudeCodeInstallState,
  t: ReturnType<typeof useT>,
  start: () => void,
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
                state.reason === "sign-in-failed" ? void openClaudeCodeSignIn() : start()
              }
              className={buttonStyle("secondary", "sm")}
            >
              {t("agents.install.failed.retry")}
            </button>
          ),
      };
  }
}

/** The row's one line, and with `more`, a Details that opens what else there is to know below it. */
function Row({
  testId,
  state,
  line,
  action,
  more,
}: {
  testId: string;
  state: string;
  line: string;
  action: ReactNode;
  more?: ReactNode;
}) {
  const t = useT();
  const gap = useGap();
  const [open, setOpen] = useState(false);
  return (
    <li
      data-testid={testId}
      data-client="claude-code"
      data-state={state}
      className="flex flex-col border-t border-rule first:border-t-0"
    >
      <div className="flex min-h-11 min-w-0 items-center gap-3 px-3 py-2">
        <AppMark name={CLAUDE_CODE} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-ui text-ink">{CLAUDE_CODE}</span>
          <span
            data-testid="setup-install-line"
            role="status"
            className="text-[12px] leading-[18px] text-ink-meta"
          >
            {line}
            {more && (
              <>
                {gap(line, t("agents.connect.details"))}
                <button
                  type="button"
                  data-testid="setup-install-details"
                  aria-expanded={open}
                  onClick={() => setOpen(!open)}
                  className={linkClass}
                >
                  {t("agents.connect.details")}
                </button>
              </>
            )}
          </span>
        </span>
        {action}
      </div>
      {more && open && <div className="px-3 pb-2 pl-[52px]">{more}</div>}
    </li>
  );
}

const installButton = (
  t: ReturnType<typeof useT>,
  testId: string,
  starting: boolean,
  start: () => void,
) => (
  <button
    type="button"
    data-testid={testId}
    disabled={starting}
    onClick={start}
    className={buttonStyle("primary", "sm")}
  >
    {t("setupPage.ai.install")}
  </button>
);

/**
 * With no AI app found: Claude Code, installed with one press, and each step of it in this row.
 * Before the press it says it downloads from Anthropic, with the rest under Details. `onStart`
 * starts the install as the step's own, which leaving the step stops.
 */
export function InstallOfferRow({ onStart }: { onStart(): void }) {
  const t = useT();
  const state = useClaudeCodeInstallState();
  const starting = useClaudeCodeInstallStarting();
  const status = installStatus(state, t, onStart);
  return (
    <Row
      testId="setup-install-row"
      state={state.kind}
      line={status?.line ?? t("setupPage.ai.install.line")}
      action={status ? status.action : installButton(t, "setup-install-claude-code", starting, onStart)}
      more={status ? undefined : <InstallDisclosure testId="setup-install-disclosure" />}
    />
  );
}

/**
 * Claude Code installing in the same press that connected the Claude app, until it connects too.
 * Stopped before it was installed (Cancel), the row says so, with Install to start it again.
 */
export function InstallingRow({
  state,
  onStart,
}: {
  state: ClaudeCodeInstallState;
  onStart(): void;
}) {
  const t = useT();
  const starting = useClaudeCodeInstallStarting();
  const status = installStatus(state, t, onStart);
  const stopped = state.kind === "idle" && !starting;
  return (
    <Row
      testId="setup-done-row"
      state={stopped ? "stopped" : state.kind}
      line={
        status?.line ??
        t(stopped ? "setupPage.ai.install.stopped" : "setupPage.ai.install.installing")
      }
      action={
        status?.action ??
        (stopped ? installButton(t, "setup-install-again", starting, onStart) : null)
      }
      more={stopped ? <InstallDisclosure testId="setup-install-disclosure" /> : undefined}
    />
  );
}
