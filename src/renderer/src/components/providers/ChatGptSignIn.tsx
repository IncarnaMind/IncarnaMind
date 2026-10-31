import { useEffect, useState } from "react";
import type { ChatGptPlanStatus, SecretStorageStatus } from "../../../../core/api";
import { continueWithChatGpt, type SignedIn, useSignIn, useWelcome } from "../../chatGptSignIn";
import { CHATGPT_USAGE_URL } from "../../chatGptUsage";
import { core } from "../../core";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { ProblemMark } from "../ProblemLine";
import {
  buttonStyle,
  dialogActionsClass,
  dialogBodyClass,
  dialogClass,
  dialogTextClass,
  dialogTitleClass,
  noticeClass,
  primaryButtonClass,
} from "../ui";
import { useModal } from "../useModal";
import { ChatGptMark } from "./ChatGptMark";
import { PasteSignInAddress } from "./PasteSignInAddress";
import { SecretStorageNotice } from "./ProviderForm";

// The plan's service is ChatGPT, but what is sent goes to OpenAI, as Privacy says.
export const CHATGPT_RECIPIENT = "OpenAI";

/** The ChatGPT plan provider's status, kept up to date with the core's event. */
export function useChatGptPlan(): [ChatGptPlanStatus | null, (status: ChatGptPlanStatus) => void] {
  const [status, setStatus] = useState<ChatGptPlanStatus | null>(null);
  useEffect(() => {
    core.getChatGptPlan().then(setStatus, () => undefined);
    return core.on("chatGptPlan.changed", setStatus);
  }, []);
  return [status, setStatus];
}

/**
 * "Continue with ChatGPT", in the black button with the ChatGPT logo that
 * OpenAI's guidelines ask for (https://developers.openai.com/siwc/ui-ux-guidelines).
 */
export function ContinueWithChatGptButton({
  onClick,
  disabled = false,
  size = "md",
  variant = "primary",
  testId = "chatgpt-continue",
}: {
  onClick(): void;
  disabled?: boolean;
  size?: "sm" | "md" | "lg";
  variant?: "primary" | "secondary";
  testId?: string;
}) {
  const t = useT();
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={buttonStyle(variant, size)}
    >
      <ChatGptMark className="size-4" />
      {t("chatgpt.continue")}
    </button>
  );
}

/**
 * Whether this device can keep a ChatGPT sign-in, read before the User
 * signs in: "Continue with ChatGPT" waits for it, so OpenAI's page never
 * opens for a sign-in that would then have nowhere to go.
 */
export function useChatGptStorage() {
  const [status, setStatus] = useState<SecretStorageStatus | null>(null);
  useEffect(() => {
    core.getSecretStorage().then(setStatus, () => undefined);
  }, []);
  const acceptPlainText = () =>
    void core
      .acceptPlainTextSecretStorage()
      .then(setStatus, (error: unknown) => useAppStore.getState().reportError(error));
  return { status, canSave: status?.canSave === true, acceptPlainText };
}

/**
 * Why the sign-in can't be kept, said up front, beside a "Continue with
 * ChatGPT" that can't be used yet: no keychain or keyring can be reached
 * (e.g. a development run whose HOME hides the macOS keychain), or none is
 * running (Linux), until the User accepts plain-text storage as for API keys.
 */
export function ChatGptStorageNotice({
  storage,
}: {
  storage: ReturnType<typeof useChatGptStorage>;
}) {
  const t = useT();
  const { status } = storage;
  if (!status || status.canSave) return null;
  if (status.protection === "unavailable") {
    return (
      <p role="alert" data-testid="chatgpt-storage-unavailable" className={noticeClass}>
        {t("chatgpt.signIn.error.secret-storage")}
      </p>
    );
  }
  return <SecretStorageNotice status={status} onAccept={storage.acceptPlainText} />;
}

/** "Manage usage ↗": ChatGPT's own page, where the User sees and limits what apps use of the plan. */
export function ManageUsageLink({ className = "" }: { className?: string }) {
  const t = useT();
  return (
    <a
      href={CHATGPT_USAGE_URL}
      target="_blank"
      rel="noreferrer"
      data-testid="chatgpt-manage-usage"
      className={`font-semibold text-accent underline-offset-2 hover:underline ${className}`}
    >
      {t("chatgpt.manageUsage")} ↗
    </a>
  );
}

/**
 * A "Continue with ChatGPT" action's state: whether it's waiting for the
 * browser, and what went wrong, in words. `onSignedIn` gets the provider once
 * the User is signed in, whichever way they got there (Use another account too).
 */
export function useContinueWithChatGpt(
  options: { keepDefault?: boolean; onSignedIn?(signedIn: SignedIn): void } = {},
) {
  const t = useT();
  const { waiting, failure } = useSignIn();
  const run = async (
    input: { anotherAccount?: boolean; replaceUnreadable?: boolean } = {},
  ): Promise<void> => {
    const result = await continueWithChatGpt({
      ...input,
      ...(options.keepDefault && { keepDefault: true }),
    });
    if (result && !("kind" in result)) options.onSignedIn?.(result);
  };
  return {
    run,
    waiting,
    failure,
    /** The failure as one line, in the User's language. */
    failureText: failure ? t(`chatgpt.signIn.error.${failure.kind}`) : null,
    cancel: () => void core.cancelChatGptSignIn(),
  };
}

/** How long a sign-in waits before it says it can be opened again, as a line and not an error. */
export const SIGN_IN_PATIENCE_MS = 5 * 60 * 1000;

/** True once a sign-in has waited `SIGN_IN_PATIENCE_MS`. */
function useLate(waiting: boolean): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    setLate(false);
    if (!waiting) return;
    const timer = setTimeout(() => setLate(true), SIGN_IN_PATIENCE_MS);
    return () => clearTimeout(timer);
  }, [waiting]);
  return late;
}

/**
 * What a "Continue with ChatGPT" shows while it waits or after it failed: the
 * browser hint with Cancel, or the failure in plain words with its one action
 * (`retry`: "Sign in again", where no Continue with ChatGPT button is beside
 * it), and OpenAI's own words behind "Details".
 */
export function ChatGptSignInState({
  sign,
  retry = false,
}: {
  sign: ReturnType<typeof useContinueWithChatGpt>;
  retry?: boolean;
}) {
  const t = useT();
  const late = useLate(sign.waiting);
  if (sign.waiting) {
    const link = "font-semibold text-accent underline-offset-2 hover:underline";
    return (
      <div className="flex w-full flex-col gap-1 text-[13px] leading-5 text-ink-secondary">
        <p className="flex flex-wrap items-center gap-x-2">
          {late ? (
            <span data-testid="chatgpt-late">{t("chatgpt.late")}</span>
          ) : (
            <span>{t("chatgpt.signingIn")}</span>
          )}
          <button
            type="button"
            data-testid="chatgpt-reopen"
            onClick={() => void core.reopenChatGptSignIn()}
            className={link}
          >
            {t("chatgpt.reopen")}
          </button>
          <button type="button" data-testid="chatgpt-cancel" onClick={sign.cancel} className={link}>
            {t("chatgpt.cancel")}
          </button>
        </p>
        <p className="text-ink-meta">{t("chatgpt.nothingExtra")}</p>
        <PasteSignInAddress />
      </div>
    );
  }
  const { failure, failureText } = sign;
  if (!failure || !failureText) return null;
  const action =
    failure.kind === "other-account"
      ? {
          testId: "chatgpt-another-account",
          label: t("chatgpt.anotherAccount"),
          run: { anotherAccount: true },
        }
      : failure.kind === "record-unreadable"
        ? {
            testId: "chatgpt-replace-sign-in",
            label: t("chatgpt.signInAgain"),
            run: { replaceUnreadable: true },
          }
        : retry && failure.kind !== "secret-storage" && failure.kind !== "store-unreadable"
          ? { testId: "chatgpt-retry", label: t("chatgpt.signInAgain"), run: {} }
          : null;
  return (
    <div role="alert" data-testid="chatgpt-error" className="text-[13px] leading-5 break-words">
      <p className="text-ink">
        <ProblemMark />
        {failureText}
        {action && (
          <>
            <span aria-hidden="true"> · </span>
            <button
              type="button"
              data-testid={action.testId}
              onClick={() => void sign.run(action.run)}
              className="font-semibold text-accent underline-offset-2 hover:underline"
            >
              {action.label}
            </button>
          </>
        )}
      </p>
      <details className="text-ink-meta">
        <summary className="cursor-default">{t("chatgpt.details")}</summary>
        <p data-testid="chatgpt-error-details">{failure.message}</p>
      </details>
    </div>
  );
}

/**
 * "You're using your ChatGPT plan": shown once, after the first sign-in on
 * this device, as OpenAI's guidelines ask, with "Got it".
 */
export function ChatGptWelcomeDialog() {
  const t = useT();
  const open = useWelcome((state) => state.open);
  const dialog = useModal(open);
  const close = () => useWelcome.setState({ open: false });
  return (
    <dialog
      ref={dialog}
      data-testid="chatgpt-welcome"
      aria-labelledby="chatgpt-welcome-title"
      onCancel={close}
      className={`${dialogClass} w-[26rem]`}
    >
      {open && (
        <div className={dialogBodyClass}>
          <ChatGptMark className="size-8 text-ink" />
          <h2 id="chatgpt-welcome-title" className={dialogTitleClass}>
            {t("chatgpt.welcome.title")}
          </h2>
          <p className={dialogTextClass}>
            {t("chatgpt.welcome.body")} <ManageUsageLink />
          </p>
          <div className={dialogActionsClass}>
            <button
              type="button"
              data-testid="chatgpt-welcome-ok"
              onClick={close}
              className={primaryButtonClass}
            >
              {t("chatgpt.welcome.ok")}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
