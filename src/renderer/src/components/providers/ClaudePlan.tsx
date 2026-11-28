import { useCallback, useEffect, useRef, useState } from "react";
import type { ClaudeAccount } from "../../../../core/api";
import {
  cancelSignInWithClaude,
  forgetClaudeSignInFailure,
  signInWithClaude,
  signOutOfClaude,
  useClaudeAccount,
  useClaudeSignIn,
} from "../../claudeSignIn";
import { CLAUDE_SIGN_IN_FAILURES } from "../../claudeSignInFailures";
import { core } from "../../core";
import { useT } from "../../i18n";
import { useSettingsTarget } from "../../settingsTarget";
import { useAppStore } from "../../store";
import { ProblemMark } from "../ProblemLine";
import { SettingsRow } from "../settings/SettingsGroup";
import { buttonStyle } from "../ui";
import { ChatGptStorageNotice, useChatGptStorage } from "./ChatGptSignIn";
import { PasteSignInAddress, type PasteWords } from "./PasteSignInAddress";
import { SendsLine } from "./SendsLine";

const PASTE: PasteWords = {
  testId: "claude-paste",
  label: "claudePlan.paste.label",
  continue: "claudePlan.paste.continue",
  problems: {
    "not-sign-in-address": "claudePlan.paste.problem.not-sign-in-address",
    "other-sign-in": "claudePlan.paste.problem.other-sign-in",
    finished: "chatgpt.paste.problem.finished",
  },
};

const TARGET = ["claude-account"] as const;

function useRowOpen(): [boolean, (open: boolean) => void] {
  const waiting = useClaudeSignIn((state) => state.waiting);
  const signedIn = useClaudeSignIn((state) => state.status?.account.state === "signed-in");
  const [open, setOpen] = useState(false);
  // A sign-in started anywhere (this row, ⌘K, a problem line) opens the row, so its wait and how
  // it ended show here. Opened by this effect, not at mount, its field takes the focus after
  // Settings has given the dialog its own.
  useEffect(() => {
    if (waiting) setOpen(true);
  }, [waiting]);
  useEffect(() => {
    if (signedIn && !waiting) setOpen(false);
  }, [signedIn, waiting]);
  return [open, setOpen];
}

export function ClaudePlanRow() {
  const t = useT();
  const status = useClaudeAccount();
  const [open, setOpen] = useRowOpen();
  const offered = status?.available === true;
  const signedIn = status?.account.state === "signed-in";
  const reached = useCallback(() => {
    if (!signedIn) setOpen(true);
  }, [signedIn, setOpen]);
  const row = useSettingsTarget<HTMLDivElement>(TARGET, offered, reached);

  // A fresh sign-in waits for its code even while the tokens kept still read signed in.
  const waiting = useClaudeSignIn((state) => state.waiting);
  if (!status || !offered) return null;
  const { account } = status;
  const steps = open && (!signedIn || waiting);
  return (
    <SettingsRow
      ref={row}
      role="listitem"
      data-testid="plans-claude-account"
      label={t("plans.claude.title")}
      detail={steps ? undefined : <AccountLines account={account} />}
      control={
        steps ? undefined : signedIn ? (
          <button
            type="button"
            data-testid="claude-plan-sign-out"
            onClick={() => void signOutOfClaude()}
            className={buttonStyle("secondary", "sm")}
          >
            {t("claudePlan.signOut")}
          </button>
        ) : (
          <button
            type="button"
            data-testid="plans-claude-sign-in"
            onClick={() =>
              account.state === "expired"
                ? void signInWithClaude({ keepDefault: true })
                : setOpen(true)
            }
            className={buttonStyle("secondary", "sm")}
          >
            {t(
              account.state === "expired" ? "signInRoute.wayBack.signInAgain" : "claudePlan.signIn",
            )}
          </button>
        )
      }
    >
      {steps && (
        <div className="flex flex-col gap-2">
          <ClaudePlanSignIn keepDefault onClose={() => setOpen(false)} />
        </div>
      )}
    </SettingsRow>
  );
}

function AccountLines({ account }: { account: ClaudeAccount }) {
  const t = useT();
  if (account.state === "signed-in") {
    const name = account.email ?? account.organization ?? t("claudePlan.account.unknown");
    return (
      <>
        <p data-testid="claude-plan-account">{t("claudePlan.signedIn", { account: name })}</p>
        <p data-testid="claude-plan-usage">{t("claudePlan.usage")}</p>
      </>
    );
  }
  if (account.state === "expired") {
    return <p data-testid="claude-plan-account">{t("claudeAccount.problem.signInExpired")}</p>;
  }
  return <p data-testid="claude-plan-account">{t("claudePlan.usage")}</p>;
}

export function ClaudePlanSignIn({
  keepDefault = false,
  onClose,
}: {
  keepDefault?: boolean;
  onClose(): void;
}) {
  const t = useT();
  const waiting = useClaudeSignIn((state) => state.waiting);
  const failure = useClaudeSignIn((state) => state.failure);
  const storage = useChatGptStorage();
  const cancel = useRef<HTMLButtonElement>(null);

  // Opened, the focus is on the safe choice (ADR-0019).
  useEffect(() => {
    if (!useClaudeSignIn.getState().waiting) cancel.current?.focus();
  }, []);

  if (waiting) {
    return (
      <div data-testid="claude-plan-waiting" className="flex flex-col gap-2">
        <p role="status" className="flex items-start gap-2 text-ui text-ink">
          <span aria-hidden="true" className="mt-[7px] size-1.5 shrink-0 rounded-full bg-accent" />
          {t("claudePlan.waiting")}
        </p>
        <p data-testid="claude-plan-usage" className="text-ui leading-5 text-ink-secondary">
          {t("claudePlan.usage")}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="claude-plan-reopen"
            onClick={() =>
              void core
                .reopenClaudeSignIn()
                .catch((error: unknown) => useAppStore.getState().reportError(error))
            }
            className={buttonStyle("secondary", "sm")}
          >
            {t("claudePlan.reopen")}
          </button>
          <button
            type="button"
            data-testid="claude-plan-cancel"
            onClick={() => {
              cancelSignInWithClaude();
              onClose();
            }}
            className={buttonStyle("ghost", "sm")}
          >
            {t("claudePlan.cancel")}
          </button>
        </div>
        <PasteSignInAddress
          paste={(address) => core.pasteClaudeSignInAddress(address)}
          words={PASTE}
        />
      </div>
    );
  }

  return (
    <div data-testid="claude-plan-notice" className="flex flex-col gap-2">
      <p data-testid="claude-plan-usage" className="text-ui leading-5 text-ink">
        {t("claudePlan.usage")}
      </p>
      <SendsLine provider="Anthropic" testId="claude-plan-sends" />
      <ChatGptStorageNotice storage={storage} />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="claude-plan-sign-in"
          disabled={!storage.canSave}
          onClick={() => void signInWithClaude({ keepDefault })}
          className={buttonStyle("primary", "sm")}
        >
          {t("claudePlan.signIn")}
        </button>
        <button
          ref={cancel}
          type="button"
          data-testid="claude-plan-cancel"
          onClick={() => {
            forgetClaudeSignInFailure();
            onClose();
          }}
          className={buttonStyle("ghost", "sm")}
        >
          {t("claudePlan.cancel")}
        </button>
      </div>
      {failure && (
        <div role="alert" data-testid="claude-plan-error" className="text-ui leading-5 break-words">
          <p className="text-ink">
            <ProblemMark />
            {t(CLAUDE_SIGN_IN_FAILURES[failure.kind])}
          </p>
          <details className="text-ink-meta">
            <summary className="cursor-default">{t("claudePlan.details")}</summary>
            <p data-testid="claude-plan-error-details">{failure.message}</p>
          </details>
        </div>
      )}
    </div>
  );
}
