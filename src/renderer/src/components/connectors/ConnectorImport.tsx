import { type ChangeEvent, useEffect, useId, useState } from "react";
import type { ConnectorImportEntry, SecretStorageStatus } from "../../../../core/api";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useLanguage, useT } from "../../i18n";
import { ProblemMark } from "../ProblemLine";
import { SecretStorageNotice } from "../providers/ProviderForm";
import { SettingsGroup, SettingsHelp, SettingsRow } from "../settings/SettingsGroup";
import { TypingTextarea } from "../TypingTextarea";
import {
  buttonClass,
  errorTextClass,
  fieldClass,
  ghostButtonClass,
  primaryButtonClass,
} from "../ui";
import { commandLine } from "./commandLine";
import { importEnvLine, importHeadersLine } from "./connectorLines";
import { importNeedsKeychain } from "./importNeeds";

/**
 * Imports Connectors from Claude Desktop's or Cursor's `mcpServers` JSON,
 * pasted or read from a file. It shows what will be added, and what won't
 * and why, before anything is added.
 */
export function ConnectorImport({ onDone }: { onDone(): void }) {
  const t = useT();
  const language = useLanguage();
  const jsonId = useId();
  const [json, setJson] = useState("");
  const [preview, setPreview] = useState<ConnectorImportEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secretStorage, setSecretStorage] = useState<SecretStorageStatus | null>(null);

  useEffect(() => {
    core.getSecretStorage().then(setSecretStorage, () => undefined);
  }, []);

  const showPreview = async (text: string) => {
    setError(null);
    setPreview(null);
    try {
      setPreview(await core.previewConnectorImport(text));
    } catch (failure) {
      setError(errorMessage(failure, t));
    }
  };

  const pickFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const text = await file.text();
    setJson(text);
    await showPreview(text);
  };

  const adding = preview?.filter((entry) => entry.action === "add") ?? [];
  const needsKeychain = importNeedsKeychain(adding);
  const blocked = needsKeychain && secretStorage !== null && !secretStorage.canSave;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await core.importConnectors(json);
      onDone();
    } catch (failure) {
      setError(errorMessage(failure, t));
    } finally {
      setBusy(false);
    }
  };

  const acceptPlainText = async () => {
    try {
      setSecretStorage(await core.acceptPlainTextSecretStorage());
    } catch (failure) {
      setError(errorMessage(failure, t));
    }
  };

  return (
    <div data-testid="connector-import-form" className="flex flex-col gap-3">
      <p className="text-[13px] leading-5 text-ink-secondary">{t("connectors.import.body")}</p>
      {!preview && (
        <SettingsGroup>
          <SettingsRow label={t("connectors.import.json")} htmlFor={jsonId}>
            <TypingTextarea
              id={jsonId}
              value={json}
              onChange={(event) => {
                setJson(event.target.value);
                setPreview(null);
              }}
              rows={6}
              spellCheck={false}
              placeholder={
                '{\n  "mcpServers": {\n    "github": { "command": "npx", "args": ["-y", "…"] }\n  }\n}'
              }
              className={`block w-full ${fieldClass} font-mono`}
            />
          </SettingsRow>
        </SettingsGroup>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label className={`${buttonClass} cursor-pointer`}>
          {t("connectors.import.file")}
          <input
            type="file"
            accept=".json,application/json"
            data-testid="connector-import-file"
            onChange={(event) => void pickFile(event)}
            className="sr-only"
          />
        </label>
        <button
          type="button"
          disabled={!json.trim()}
          onClick={() => void showPreview(json)}
          className={buttonClass}
        >
          {t("connectors.import.preview")}
        </button>
        <button type="button" onClick={onDone} className={ghostButtonClass}>
          {t("connectors.form.cancel")}
        </button>
      </div>

      {preview && (
        <>
          <button
            type="button"
            onClick={() => setPreview(null)}
            className={`${ghostButtonClass} self-start`}
          >
            {t("connectors.import.change")}
          </button>
          <SettingsGroup data-testid="connector-import-preview">
            {preview.map((entry) => (
              <SettingsRow
                key={entry.name}
                data-action={entry.action}
                label={<span className="break-words">{entry.name}</span>}
                align="start"
                detail={
                  <>
                    {entry.command && (
                      <span className="block truncate font-mono">
                        {commandLine(entry.command, entry.args)}
                      </span>
                    )}
                    {entry.url && <span className="block truncate font-mono">{entry.url}</span>}
                    {entry.env.length > 0 && (
                      <span className="block">{importEnvLine(entry.env, t, language)}</span>
                    )}
                    {entry.connection === "sse" && (
                      <span className="block">{t("remoteConnectors.connection.sse")}</span>
                    )}
                    {(entry.headers?.length ?? 0) > 0 && (
                      <span className="block">
                        {importHeadersLine(entry.headers ?? [], t, language)}
                      </span>
                    )}
                    {entry.placeholders?.map((each) => (
                      <span
                        key={`${each.header}:${each.variable}`}
                        data-testid="connector-import-placeholder"
                        className="block"
                      >
                        {t("connectors.import.placeholder", { name: each.variable })}
                      </span>
                    ))}
                  </>
                }
                control={
                  <span
                    className={`max-w-56 text-right text-[13px] leading-5 ${
                      entry.action === "add" ? "font-semibold text-ink" : "text-ink-meta"
                    }`}
                  >
                    {t(`connectors.import.action.${entry.action}`)}
                  </span>
                }
              />
            ))}
          </SettingsGroup>
          {needsKeychain && secretStorage && !secretStorage.canSave && (
            <SecretStorageNotice status={secretStorage} onAccept={() => void acceptPlainText()} />
          )}
          {adding.length === 0 ? (
            <p className="text-[13px] leading-5 text-ink-secondary">
              {t("connectors.import.nothing")}
            </p>
          ) : (
            <div className="flex flex-col items-start gap-2">
              <SettingsHelp data-testid="connector-import-sends">
                {t("connectors.import.sends")}
              </SettingsHelp>
              <button
                type="button"
                data-testid="connector-import-confirm"
                disabled={busy || blocked}
                onClick={() => void confirm()}
                className={primaryButtonClass}
              >
                {busy
                  ? t("connectors.import.adding")
                  : adding.length === 1
                    ? t("connectors.import.confirm.one")
                    : t("connectors.import.confirm", { count: adding.length })}
              </button>
            </div>
          )}
        </>
      )}
      {error && (
        <p role="alert" className={errorTextClass}>
          <ProblemMark />
          {error}
        </p>
      )}
    </div>
  );
}
