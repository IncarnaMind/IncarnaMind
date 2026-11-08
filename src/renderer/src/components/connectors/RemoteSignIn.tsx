import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
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
import {
  SettingsGroup,
  SettingsHelp,
  SettingsRow,
  SettingsRowAction,
} from "../settings/SettingsGroup";
import { buttonStyle, errorTextClass, noticeClass, rowFieldClass } from "../ui";
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
    <SettingsHelp className="flex flex-wrap items-center gap-2">
      <span>{t("remoteConnectors.client.using", { clientId })}</span>
      <button
        type="button"
        onClick={() => void act(() => core.setConnectorClient(id, null))}
        className={linkButtonClass}
      >
        {t("remoteConnectors.client.forget")}
      </button>
    </SettingsHelp>
  );

  if (state === "needs-sign-in" && signIn.heldBack) {
    return (
      <DetailsLine
        testId="connector-sign-in-held-back"
        className={noticeClass}
        details={<p>{t("remoteConnectors.signIn.heldBack.details")}</p>}
      >
        {t("remoteConnectors.signIn.heldBack")}
      </DetailsLine>
    );
  }

  if (state === "needs-sign-in") {
    const askingForClient = needsClient || editingClient;
    return (
      <div data-testid="connector-sign-in-notice" className="flex flex-col gap-3">
        <SettingsGroup>
          <SettingsRow
            label={
              signIn.expired
                ? t("remoteConnectors.signIn.expired")
                : t("remoteConnectors.signIn.required")
            }
            control={
              askingForClient ? undefined : (
                <button
                  type="button"
                  data-testid="connector-sign-in"
                  onClick={() => void act(() => core.signInToConnector(id))}
                  disabled={!storageReady(storage, storageProblem !== null)}
                  className={buttonStyle("primary", "sm")}
                >
                  {signIn.expired
                    ? t("remoteConnectors.signInAgain")
                    : t("remoteConnectors.signIn")}
                </button>
              )
            }
          />
          {!askingForClient && !clientId && (
            <SettingsRowAction
              label={t("remoteConnectors.form.client")}
              onClick={() => setEditingClient(true)}
            />
          )}
        </SettingsGroup>
        {errorKind && (errorKind !== "secret-storage" || storage === null) && (
          <p
            role="alert"
            data-testid="connector-sign-in-error"
            className={`px-4 ${errorTextClass}`}
          >
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
        {askingForClient && (
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
        )}
        {clientLine}
      </div>
    );
  }

  if (!signIn.signedIn && !clientId) return null;
  return (
    <div className="flex flex-col">
      {signIn.signedIn && (
        <SettingsGroup>
          <SettingsRow
            label={t("remoteConnectors.signedIn")}
            control={
              <button
                type="button"
                data-testid="connector-sign-out"
                onClick={() => void act(() => core.signOutOfConnector(id))}
                className={buttonStyle("secondary", "sm")}
              >
                {t("remoteConnectors.signOut")}
              </button>
            }
          />
        </SettingsGroup>
      )}
      {clientLine}
    </div>
  );
}

/** The OAuth app's client ID and secret, as two rows of a group. */
export function ClientFields({
  clientId,
  onClientId,
  clientSecret,
  onClientSecret,
  idRequired = false,
}: {
  clientId: string;
  onClientId(value: string): void;
  clientSecret: string;
  onClientSecret(value: string): void;
  idRequired?: boolean;
}) {
  const t = useT();
  const id = useId();
  return (
    <>
      <SettingsRow
        label={t("remoteConnectors.client.id")}
        htmlFor={`${id}-id`}
        control={
          <input
            id={`${id}-id`}
            required={idRequired}
            value={clientId}
            onChange={(event) => onClientId(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            className={`${rowFieldClass} w-72 font-mono`}
          />
        }
      />
      <SettingsRow
        label={t("remoteConnectors.client.secret")}
        htmlFor={`${id}-secret`}
        detail={t("remoteConnectors.client.secretHint")}
        control={
          <input
            id={`${id}-secret`}
            type="password"
            value={clientSecret}
            onChange={(event) => onClientSecret(event.target.value)}
            autoComplete="off"
            className={`${rowFieldClass} w-72 font-mono`}
          />
        }
      />
    </>
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
      className="flex flex-col gap-3"
    >
      <div>
        <SettingsGroup>
          <ClientFields
            idRequired
            clientId={clientId}
            onClientId={setClientId}
            clientSecret={clientSecret}
            onClientSecret={setClientSecret}
          />
        </SettingsGroup>
        <SettingsHelp>
          {t("remoteConnectors.client.hint")} {t("remoteConnectors.client.redirect")}
        </SettingsHelp>
      </div>
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
        <p role="alert" className="px-4 text-[12px] leading-[18px] text-ink">
          <ProblemMark />
          {error}
        </p>
      )}
    </form>
  );
}
