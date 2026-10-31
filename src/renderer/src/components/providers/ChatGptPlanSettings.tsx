import { useState } from "react";
import type { ChatGptAccount, ConnectionTestResult } from "../../../../core/api";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { ProblemMark } from "../ProblemLine";
import {
  buttonStyle,
  errorTextClass,
  noticeClass,
  rowButtonsClass,
  rowTextClass,
  rowTitleClass,
  ruledRowClass,
} from "../ui";
import {
  CHATGPT_RECIPIENT,
  ChatGptSignInState,
  ChatGptStorageNotice,
  ContinueWithChatGptButton,
  ManageUsageLink,
  useChatGptPlan,
  useChatGptStorage,
  useContinueWithChatGpt,
} from "./ChatGptSignIn";
import { TestResult } from "./ProviderForm";
import { SendsLine } from "./SendsLine";

/**
 * Settings → Models → the first plan row, ChatGPT: "Continue with ChatGPT"
 * (Sign in with ChatGPT), then the account, whether Questions use the plan, a
 * test, and Sign out. It is the one place ChatGPT signs in. The plan's model
 * is chosen in Chat model above, the one place the default model is chosen.
 * Signing in here doesn't change the default model unless there is none yet.
 */
export function ChatGptPlanRow() {
  const t = useT();
  const [status, setStatus] = useChatGptPlan();
  const readiness = useAppStore((state) => state.chatReadiness);
  const chatModel = useAppStore((state) => state.settings?.user.chatModel ?? null);
  const [busy, setBusy] = useState<"testing" | "saving" | "signing-out" | null>(null);
  const [test, setTest] = useState<ConnectionTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const sign = useContinueWithChatGpt({ keepDefault: true });
  const storage = useChatGptStorage();

  const inUse =
    readiness !== null && "provider" in readiness && readiness.provider.kind === "chatgpt";
  // The model Questions use with the plan: the one chosen in Chat model, else the plan's default.
  const planModel = (inUse && chatModel?.modelId) || (status?.models[0]?.id ?? "");
  const signedIn = status?.account.state === "signed-in";
  const waiting = sign.waiting || status?.signingIn === true;

  const run = async (action: "testing" | "saving" | "signing-out", task: () => Promise<void>) => {
    setBusy(action);
    setError(null);
    try {
      await task();
    } catch (failure) {
      setError(errorMessage(failure, t));
    } finally {
      setBusy(null);
    }
  };

  const signIn = () => {
    setTest(null);
    setUnconfirmed(false);
    // A record that can't be read is replaced only by the sign-in the User chose to make.
    void sign.run(sign.failure?.kind === "record-unreadable" ? { replaceUnreadable: true } : {});
  };

  const signOut = () =>
    run("signing-out", async () => {
      setTest(null);
      const result = await core.signOutOfChatGpt();
      setStatus(result.status);
      setUnconfirmed(!result.revoked);
    });

  const testConnection = () =>
    run("testing", async () => {
      setTest(null);
      setTest(await core.testChatConnection({ kind: "chatgpt", modelId: planModel }));
    });

  const use = () =>
    run("saving", async () => {
      await core.saveChatProvider({ kind: "chatgpt", modelId: planModel });
    });

  return (
    <li data-testid="chatgpt-settings" className={ruledRowClass}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className={rowTitleClass}>{t("plans.chatgpt.title")}</span>
        {signedIn ? (
          <p data-testid="chatgpt-account" className={rowTextClass}>
            <AccountLine account={status.account} />
          </p>
        ) : (
          <>
            <p className={rowTextClass}>{t("chatgpt.description")}</p>
            <SendsLine provider={CHATGPT_RECIPIENT} />
            {status &&
              (status.account.state === "expired" || status.account.state === "unreadable") && (
                <p data-testid="chatgpt-account" className={rowTextClass}>
                  <AccountLine account={status.account} />
                </p>
              )}
          </>
        )}
        {signedIn && inUse && (
          <p data-testid="chatgpt-in-use" className={rowTextClass}>
            {t("chatgpt.inUse")}
            <span aria-hidden="true"> · </span>
            <ManageUsageLink />
          </p>
        )}
        {!signedIn && !waiting && <ChatGptStorageNotice storage={storage} />}
        {(waiting || sign.failure) && (
          <div className="mt-2">
            <ChatGptSignInState sign={sign} />
          </div>
        )}
        {unconfirmed && !signedIn && (
          <p role="note" data-testid="chatgpt-sign-out-unconfirmed" className={noticeClass}>
            {t("chatgpt.signedOut.unconfirmed")} <ManageUsageLink />
          </p>
        )}
        {test && <TestResult result={test} />}
        {error && (
          <p role="alert" data-testid="chatgpt-settings-error" className={errorTextClass}>
            <ProblemMark />
            {error}
          </p>
        )}
      </div>
      <div className={rowButtonsClass}>
        {!signedIn ? (
          !waiting && (
            <ContinueWithChatGptButton
              onClick={signIn}
              disabled={status === null || !storage.canSave}
              size="sm"
              variant="secondary"
            />
          )
        ) : (
          <>
            {!inUse && (
              <button
                type="button"
                data-testid="chatgpt-use"
                disabled={busy !== null || planModel === ""}
                onClick={() => void use()}
                className={buttonStyle("primary", "sm")}
              >
                {t("chatgpt.use")}
              </button>
            )}
            <button
              type="button"
              data-testid="chatgpt-test"
              disabled={busy !== null || planModel === ""}
              onClick={() => void testConnection()}
              className={buttonStyle("secondary", "sm")}
            >
              {busy === "testing" ? t("providers.form.testing") : t("providers.form.test")}
            </button>
            <button
              type="button"
              data-testid="chatgpt-sign-out"
              disabled={busy !== null}
              onClick={() => void signOut()}
              className={buttonStyle("ghost", "sm")}
            >
              {t("chatgpt.signOut")}
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function AccountLine({ account }: { account: ChatGptAccount }) {
  const t = useT();
  if (account.state === "signed-out") return <>{t("chatgpt.account.signedOut")}</>;
  if (account.state === "expired") return <>{t("chatgpt.account.expired")}</>;
  if (account.state === "unreadable") return <>{t("chatgpt.account.unreadable")}</>;
  return (
    <>{t("chatgpt.account.signedIn", { account: account.email ?? t("chatgpt.account.unknown") })}</>
  );
}
