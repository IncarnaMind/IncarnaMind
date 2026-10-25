import { type FormEvent, useEffect, useRef, useState } from "react";
import type { RemoteConnector, SecretStorageStatus } from "../../../../core/api";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useT } from "../../i18n";
import { ProblemMark } from "../ProblemLine";
import { SecretStorageNotice } from "../providers/ProviderForm";
import {
  errorTextClass,
  fieldLabelClass,
  ghostButtonClass,
  hintClass,
  inputClass,
  primaryButtonClass,
} from "../ui";

export const keyHeader = (name: string, value: string) => ({
  [name.trim()]:
    name.trim().toLowerCase() === "authorization" && !/^(Bearer|Basic)\s/i.test(value)
      ? `Bearer ${value}`
      : value,
});

export function ConnectorKeyFields({
  value,
  onChange,
}: {
  value: string;
  onChange(value: string): void;
}) {
  const t = useT();
  return (
    <label className={fieldLabelClass}>
      {t("remoteConnectors.key.label")}
      <input
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        spellCheck={false}
        className={inputClass}
      />
      <span className={hintClass}>{t("remoteConnectors.key.hint")}</span>
    </label>
  );
}

export function HeaderNameField({
  value,
  onChange,
}: {
  value: string;
  onChange(value: string): void;
}) {
  const t = useT();
  return (
    <label className={fieldLabelClass}>
      {t("remoteConnectors.key.header")}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        spellCheck={false}
        className={`${inputClass} font-mono`}
      />
      <span className={hintClass}>{t("remoteConnectors.key.bearer")}</span>
    </label>
  );
}

export function RemoteKeyForm({
  connector,
  onDone,
}: {
  connector: RemoteConnector;
  onDone(): void;
}) {
  const t = useT();
  const names = connector.headers?.length ? connector.headers : ["Authorization"];
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storage, setStorage] = useState<SecretStorageStatus | null>(null);
  const firstField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    firstField.current?.focus();
    core.getSecretStorage().then(setStorage, (failure) => setError(errorMessage(failure, t)));
  }, [t]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const headers = Object.fromEntries(
        names.flatMap((name) => Object.entries(keyHeader(name, values[name] ?? ""))),
      );
      await core.setConnectorHeaders(connector.id, headers);
      onDone();
    } catch (failure) {
      setError(errorMessage(failure, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="mt-2 flex flex-col gap-3">
      {names.map((name) => (
        <label key={name} className={fieldLabelClass}>
          {t("remoteConnectors.key.label")}
          {names.length > 1 ? ` · ${name}` : ""}
          <input
            ref={name === names[0] ? firstField : undefined}
            required
            type="password"
            autoComplete="off"
            value={values[name] ?? ""}
            onChange={(event) => setValues({ ...values, [name]: event.target.value })}
            className={inputClass}
          />
        </label>
      ))}
      {storage && !storage.canSave && (
        <SecretStorageNotice
          status={storage}
          onAccept={() => {
            void core
              .acceptPlainTextSecretStorage()
              .then(setStorage, (failure) => setError(errorMessage(failure, t)));
          }}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={busy || storage?.canSave === false}
          className={primaryButtonClass}
        >
          {t(busy ? "connectors.form.saving" : "connectors.form.save")}
        </button>
        <button type="button" onClick={onDone} className={ghostButtonClass}>
          {t("connectors.form.cancel")}
        </button>
      </div>
      {error && (
        <p role="alert" className={errorTextClass}>
          <ProblemMark />
          {error}
        </p>
      )}
    </form>
  );
}
