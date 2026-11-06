import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type {
  ConnectorClientInput,
  RemoteConnector,
  SecretStorageStatus,
} from "../../../../core/api";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { DetailsLine } from "../DetailsLine";
import { ProblemMark } from "../ProblemLine";
import { SecretStorageNotice } from "../providers/ProviderForm";
import { buttonStyle, fieldLabelClass, hintClass, inputClass, noticeClass } from "../ui";
import { storageReady } from "./signInStorage";

/** A text button inside a line, e.g. "Sign out". */
const linkButtonClass =
  "rounded-sm text-accent underline-offset-2 hover:text-accent-strong hover:underline";

/** Runs an action; a failure shows in the app's error banner. */
async function act(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (failure) {
    useAppStore.getState().reportError(failure);
  }
}

/**
 * A remote Connector's sign-in, under its row: signing in (in the browser)
 * when the server requires it, waiting for the browser, signing out, and the
 * OAuth app it signs in with when the service can't register IncarnaMind.
 */
export function RemoteSignIn({ connector }: { connector: RemoteConnector }) {
  const t = useT();
  const { id, state, signIn, clientId } = connector;
  const [editingClient, setEditingClient] = useState(false);
  const [storage, setStorage] = useState<SecretStorageStatus | null>(null);
  const [storageProblem, setStorageProblem] = useState<string | null>(null);
  const needsClient = signIn.error?.kind === "client-id-required";
  const errorKind = storageProblem !== null ? "secret-storage" : signIn.error?.kind;
  const storageRead = useRef(0);
  const readStorage = useCallback(() => {
    const read = ++storageRead.current;
    setStorageProblem(null);
    core.getSecretStorage().then(
      (next) => {
        if (read !== storageRead.current) return;
        setStorage(next);
        setStorageProblem(null);
      },
      (failure) => {
        if (read !== storageRead.current) return;
        // The old status can't stand for a failed read: the button waits on the next answer.
        setStorage(null);
        setStorageProblem(errorMessage(failure, t));
      },
    );
  }, [t]);
  useEffect(() => {
    if (state !== "needs-sign-in") return;
    readStorage();
  }, [state, readStorage]);

  // The page's head shows the wait, with Cancel.
  if (state === "signing-in") return null;

  const clientLine = clientId && (
    <p className="mt-1 flex flex-wrap items-center gap-2 text-[12px] leading-[18px] text-ink-meta">
      <span>{t("remoteConnectors.client.using", { clientId })}</span>
      <button
        type="button"
        onClick={() => void act(() => core.setConnectorClient(id, null))}
        className={linkButtonClass}
      >
        {t("remoteConnectors.client.forget")}
      </button>
    </p>
  );

  if (state === "needs-sign-in" && signIn.heldBack) {
    return (
      <DetailsLine
        testId="connector-sign-in-held-back"
        className={`mt-1 ${noticeClass}`}
        details={<p>{t("remoteConnectors.signIn.heldBack.details")}</p>}
      >
        {t("remoteConnectors.signIn.heldBack")}
      </DetailsLine>
    );
  }

  if (state === "needs-sign-in") {
    return (
      <div data-testid="connector-sign-in-notice" className={`mt-1 ${noticeClass}`}>
        <p>
          {signIn.expired
            ? t("remoteConnectors.signIn.expired")
            : t("remoteConnectors.signIn.required")}
        </p>
        {errorKind && (errorKind !== "secret-storage" || storage === null) && (
          <p role="alert" data-testid="connector-sign-in-error" className="mt-1 text-ink">
            <ProblemMark />
            {storageProblem ?? t(`remoteConnectors.signIn.error.${errorKind}`)}
            {storageProblem !== null && (
              <>
                {" "}
                <button type="button" onClick={readStorage} className={linkButtonClass}>
                  {t("remoteConnectors.storage.tryAgain")}
                </button>
              </>
            )}
          </p>
        )}
        {storage && !storage.canSave && (
          <SecretStorageNotice
            status={storage}
            onAccept={() =>
              void act(async () => setStorage(await core.acceptPlainTextSecretStorage()))
            }
          />
        )}
        {needsClient || editingClient ? (
          <ClientForm
            initialClientId={connector.clientId ?? ""}
            submitLabel={t("remoteConnectors.client.save")}
            canSubmit={storageReady(storage, storageProblem !== null)}
            onSubmit={async (client) => {
              await core.setConnectorClient(id, client);
              setEditingClient(false);
              await core.signInToConnector(id);
            }}
            onCancel={needsClient ? undefined : () => setEditingClient(false)}
          />
        ) : (
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              data-testid="connector-sign-in"
              onClick={() => void act(() => core.signInToConnector(id))}
              disabled={!storageReady(storage, storageProblem !== null)}
              className={buttonStyle("primary", "sm")}
            >
              {signIn.expired ? t("remoteConnectors.signInAgain") : t("remoteConnectors.signIn")}
            </button>
            {!clientId && (
              <button
                type="button"
                onClick={() => setEditingClient(true)}
                className={`text-[12px] ${linkButtonClass}`}
              >
                {t("remoteConnectors.form.client")}
              </button>
            )}
          </div>
        )}
        {clientLine}
      </div>
    );
  }

  if (!signIn.signedIn && !clientId) return null;
  return (
    <div className="text-[12px] leading-[18px] text-ink-meta">
      {signIn.signedIn && (
        <p className="flex flex-wrap items-center gap-2">
          <span>{t("remoteConnectors.signedIn")}</span>
          <button
            type="button"
            data-testid="connector-sign-out"
            onClick={() => void act(() => core.signOutOfConnector(id))}
            className={linkButtonClass}
          >
            {t("remoteConnectors.signOut")}
          </button>
        </p>
      )}
      {clientLine}
    </div>
  );
}

/**
 * The OAuth app the User registered with a service that registers only the
 * apps it knows: its client ID, and secret if it has one.
 */
export function ClientForm({
  initialClientId = "",
  submitLabel,
  onSubmit,
  onCancel,
  canSubmit = true,
}: {
  initialClientId?: string;
  submitLabel: string;
  onSubmit(client: ConnectorClientInput): Promise<void>;
  /** Absent when the service can't be signed in to without one. */
  onCancel?: () => void;
  /** Whether the keychain can keep what signing in will save; held until that is known. */
  canSubmit?: boolean;
}) {
  const t = useT();
  const [clientId, setClientId] = useState(initialClientId);
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ clientId, ...(clientSecret.trim() ? { clientSecret } : {}) });
    } catch (failure) {
      setError(errorMessage(failure, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      data-testid="connector-client-form"
      onSubmit={(event) => void submit(event)}
      className="mt-2 flex flex-col gap-2"
    >
      <p className={hintClass}>
        {t("remoteConnectors.client.hint")} {t("remoteConnectors.client.redirect")}
      </p>
      <label className={fieldLabelClass}>
        {t("remoteConnectors.client.id")}
        <input
          required
          value={clientId}
          onChange={(event) => setClientId(event.target.value)}
          spellCheck={false}
          autoComplete="off"
          className={`${inputClass} font-mono`}
        />
      </label>
      <label className={fieldLabelClass}>
        {t("remoteConnectors.client.secret")}
        <input
          type="password"
          value={clientSecret}
          onChange={(event) => setClientSecret(event.target.value)}
          autoComplete="off"
          className={`${inputClass} font-mono`}
        />
        <span className={hintClass}>{t("remoteConnectors.client.secretHint")}</span>
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          data-testid="connector-client-submit"
          disabled={busy || !clientId.trim() || !canSubmit}
          className={buttonStyle("primary", "sm")}
        >
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className={buttonStyle("ghost", "sm")}>
            {t("remoteConnectors.cancel")}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-[12px] leading-[18px] text-ink">
          <ProblemMark />
          {error}
        </p>
      )}
    </form>
  );
}
