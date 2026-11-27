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
 * What the Your AI step's Claude Code row says while its one-press install goes on (#3791, #3819),
 * its progress bar while downloading/installing, and its actions: installing, signing in (with a
 * way to reopen the sign-in page), a plan without it, or why it failed; null while idle.
 */
function installStatus(
  state: ClaudeCodeInstallState,
  starting: boolean,
  t: ReturnType<typeof useT>,
  start: () => void,
): { line: string; action: ReactNode; progress?: string } | null {
  if (state.kind === "idle" && starting) {
    return {
      line: t("setupPage.ai.install.starting"),
      progress: "w-1/4",
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
  }
  switch (state.kind) {
    case "idle":
    case "signed-in":
      return null;
    case "installing":
      return {
        line: t(
          state.stage === "installing"
            ? "setupPage.ai.install.installing"
            : "setupPage.ai.install.downloading",
        ),
        progress: state.stage === "installing" ? "w-4/5" : "w-1/2",
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
      return {
        line: t(state.notYet ? "setupPage.ai.install.notYet" : "setupPage.ai.install.signIn"),
        action: (
          <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            <button
              type="button"
              data-testid="setup-install-reopen"
              onClick={() => void openClaudeCodeSignIn()}
              className={buttonStyle(state.notYet ? "secondary" : "ghost", "sm")}
            >
              {t("agents.install.signIn.reopen")}
            </button>
            <button
              type="button"
              data-testid="setup-install-signed-in"
              onClick={() => void checkClaudeCodeAuth()}
              className={buttonStyle(state.notYet ? "ghost" : "secondary", "sm")}
            >
              {t("agents.install.signIn.done")}
            </button>
          </span>
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

/** The row's one line, optional progress bar, and with `more`, a Details below it. */
function Row({
  testId,
  state,
  line,
  progress,
  action,
  more,
}: {
  testId: string;
  state: string;
  line: string;
  progress?: string;
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
      <div className="relative flex min-h-11 min-w-0 items-center gap-3 px-3 py-2">
        <AppMark name={CLAUDE_CODE} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-ui text-ink">{CLAUDE_CODE}</span>
          <span
            data-testid="setup-install-line"
            role="status"
            className="text-small leading-[18px] text-ink-meta"
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
        {progress && (
          <span
            data-testid="setup-install-progress"
            aria-hidden="true"
            className="pointer-events-none absolute bottom-[2px] left-[52px] block h-[3px] w-[220px] max-w-[calc(100%-140px)] overflow-hidden rounded-full bg-rule"
          >
            <span className={`block h-full rounded-full bg-accent ${progress}`} />
          </span>
        )}
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
  const status = installStatus(state, starting, t, onStart);
  return (
    <Row
      testId="setup-install-row"
      state={state.kind === "idle" && starting ? "installing" : state.kind}
      line={status?.line ?? t("setupPage.ai.install.line")}
      progress={status?.progress}
      action={
        status ? status.action : installButton(t, "setup-install-claude-code", starting, onStart)
      }
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
  const status = installStatus(state, starting, t, onStart);
  const stopped = state.kind === "idle" && !starting;
  return (
    <Row
      testId="setup-done-row"
      state={stopped ? "stopped" : state.kind === "idle" && starting ? "installing" : state.kind}
      line={
        status?.line ??
        t(stopped ? "setupPage.ai.install.stopped" : "setupPage.ai.install.starting")
      }
      progress={status?.progress}
      action={
        status?.action ??
        (stopped ? installButton(t, "setup-install-again", starting, onStart) : null)
      }
      more={stopped ? <InstallDisclosure testId="setup-install-disclosure" /> : undefined}
    />
  );
}
