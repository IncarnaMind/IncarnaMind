import { type FormEvent, useEffect, useId, useState } from "react";
import {
  type EmbeddingConnectionTestResult,
  type EmbeddingProviderKind,
  type EmbeddingSettings,
  type SaveEmbeddingProviderInput,
  type SecretStorageStatus,
  SUGGESTED_EMBEDDING_MODELS,
} from "../../../../core/api";
import type { MessageKey, MessageParams } from "../../../../shared/i18n";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { KeyCharacterLine } from "../KeyCharacterLine";
import { ProblemMark } from "../ProblemLine";
import { PopUpSelect } from "../settings/PopUpButton";
import { SettingsGroup, SettingsHelp, SettingsRow } from "../settings/SettingsGroup";
import {
  buttonClass,
  buttonStyle,
  dialogActionsClass,
  dialogBodyClass,
  dialogClass,
  dialogTextClass,
  dialogTitleClass,
  errorTextClass,
  hintClass,
  primaryButtonClass,
  rowFieldClass,
  successTextClass,
} from "../ui";
import { useModal } from "../useModal";
import { SecretStorageNotice, TestResult } from "./ProviderForm";
import { useProviderKey } from "./shared";

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** Ollama's default local address, shown as the URL's placeholder. */
const OLLAMA_URL = "http://127.0.0.1:11434";

/** A server of the User's own: the only kinds whose address, and key, the form asks for. */
export type ServerEmbeddingKind = Extract<EmbeddingProviderKind, "ollama" | "openai-compatible">;
const SERVER_KINDS: readonly ServerEmbeddingKind[] = ["ollama", "openai-compatible"];

/** Providers whose requests always leave this computer. */
const CLOUD_KINDS: ReadonlySet<EmbeddingProviderKind> = new Set(["openai", "google"]);

/** Loopback addresses: a server there runs on this computer. */
function isOnThisComputer(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "::1" ||
      host === "0.0.0.0" ||
      /^127(\.\d{1,3}){3}$/.test(host)
    );
  } catch {
    return false;
  }
}

/** Kinds that take no server, key or model name: embeddings off, and the built-in model. */
const isPlainKind = (kind: EmbeddingProviderKind) => kind === "off" || kind === "built-in";

/** Where a provider would send Document text, or null when it stays here. */
export function cloudServiceOf(kind: EmbeddingProviderKind, baseUrl: string, t: Translate) {
  if (CLOUD_KINDS.has(kind)) return t(`embeddingProviders.kind.${kind}`);
  if (isPlainKind(kind)) return null;
  const url = baseUrl.trim() || (kind === "ollama" ? OLLAMA_URL : "");
  if (!url || isOnThisComputer(url)) return null;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * A search model on a server of the User's own: Ollama at another address, or an
 * OpenAI-compatible server, with its optional key and the model's name; tested, then switched to
 * after the warning. A company's own API takes its key from Accounts and keys instead.
 */
export function EmbeddingServerForm({
  current,
  onDone,
}: {
  current: EmbeddingSettings;
  onDone(): void;
}) {
  const t = useT();
  const id = useId();
  const savedKind = SERVER_KINDS.find((each) => each === current.provider.kind);
  const [kind, setKind] = useState<ServerEmbeddingKind>(savedKind ?? "ollama");
  const [baseUrl, setBaseUrl] = useState(savedKind ? (current.provider.baseUrl ?? "") : "");
  const key = useProviderKey();
  const { apiKey } = key;
  const [modelId, setModelId] = useState(
    savedKind ? current.provider.modelId : SUGGESTED_EMBEDDING_MODELS.ollama,
  );
  const [busy, setBusy] = useState<"testing" | "saving" | null>(null);
  const [test, setTest] = useState<EmbeddingConnectionTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [secretStorage, setSecretStorage] = useState<SecretStorageStatus | null>(null);

  useEffect(() => {
    core.getSecretStorage().then(setSecretStorage, () => undefined);
  }, []);

  const saved = current.provider;
  const sameServer =
    saved.kind === kind && (saved.baseUrl ?? "") === baseUrl.trim().replace(/\/+$/, "");
  const takesKey = kind === "openai-compatible";
  const keyBlocked = key.text !== "" && secretStorage !== null && !secretStorage.canSave;
  const complete =
    key.stray === null &&
    modelId.trim() !== "" &&
    (kind !== "openai-compatible" || baseUrl.trim() !== "");
  const unchanged = sameServer && key.text === "" && modelId.trim() === saved.modelId;
  const cloudService = cloudServiceOf(kind, baseUrl, t);
  // A server elsewhere, in local mode: said as the address is typed, not refused at the end.
  const outsideLocalMode = current.localOnly && cloudService !== null;

  const choose = (next: ServerEmbeddingKind) => {
    // A key typed for one server is never sent to another.
    if (next !== kind) key.clear();
    setKind(next);
    setBaseUrl(next === saved.kind ? (saved.baseUrl ?? "") : "");
    setModelId(next === saved.kind ? saved.modelId : SUGGESTED_EMBEDDING_MODELS[next]);
    setTest(null);
    setError(null);
  };

  const input = (): SaveEmbeddingProviderInput => ({
    kind,
    modelId: modelId.trim(),
    ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
    ...(takesKey && key.text ? { apiKey: key.text } : {}),
  });

  const runTest = async () => {
    setBusy("testing");
    setError(null);
    setTest(null);
    try {
      setTest(await core.testEmbeddingConnection(input()));
    } catch (failure) {
      setError(errorMessage(failure, t));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setConfirming(false);
    setBusy("saving");
    setError(null);
    try {
      useAppStore.setState({ embedding: await core.saveEmbeddingProvider(input()) });
      key.clear();
      onDone();
    } catch (failure) {
      setError(errorMessage(failure, t));
    } finally {
      setBusy(null);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setConfirming(true);
  };

  const acceptPlainText = async () => {
    try {
      setSecretStorage(await core.acceptPlainTextSecretStorage());
    } catch (failure) {
      setError(errorMessage(failure, t));
    }
  };

  const kindId = `${id}-kind`;
  const urlId = `${id}-url`;
  const keyId = `${id}-key`;
  const modelFieldId = `${id}-model`;

  return (
    <form data-testid="embedding-form" onSubmit={submit} className="flex flex-col gap-3">
      <div>
        <SettingsGroup>
          <SettingsRow
            label={t("embeddingProviders.form.server")}
            htmlFor={kindId}
            control={
              <PopUpSelect
                id={kindId}
                value={kind}
                onChange={(event) => {
                  const next = SERVER_KINDS.find((each) => each === event.target.value);
                  if (next) choose(next);
                }}
              >
                {SERVER_KINDS.map((option) => (
                  <option key={option} value={option}>
                    {t(`embeddingProviders.kind.${option}`)}
                  </option>
                ))}
              </PopUpSelect>
            }
          />
          <SettingsRow
            label={
              kind === "ollama"
                ? t("embeddingProviders.form.ollamaUrl")
                : t("providers.form.baseUrl")
            }
            htmlFor={urlId}
            control={
              <input
                id={urlId}
                type="url"
                required={kind === "openai-compatible"}
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                onBlur={() => key.leftAddress(baseUrl)}
                placeholder={kind === "ollama" ? OLLAMA_URL : "https://"}
                spellCheck={false}
                className={`${rowFieldClass} w-64`}
              />
            }
          >
            {outsideLocalMode ? (
              <p role="alert" data-testid="embedding-local-only" className={hintClass}>
                {t("embeddingProviders.form.localOnlyServer")}
              </p>
            ) : (
              <p className={hintClass}>
                {kind === "ollama"
                  ? t("embeddingProviders.form.ollamaHint")
                  : t("providers.form.baseUrlHint")}
              </p>
            )}
          </SettingsRow>
          {takesKey && (
            <SettingsRow
              label={t("providers.form.apiKeyOptional")}
              htmlFor={keyId}
              control={
                <input
                  id={keyId}
                  type="password"
                  value={apiKey}
                  onChange={(event) => key.type(event.target.value, baseUrl)}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={key.stray ? true : undefined}
                  aria-describedby={key.stray ? `${id}-stray` : undefined}
                  className={`${rowFieldClass} w-64`}
                />
              }
            >
              {(key.stray || (sameServer && saved.hasApiKey)) && (
                <>
                  {key.stray && <KeyCharacterLine id={`${id}-stray`} stray={key.stray} />}
                  {sameServer && saved.hasApiKey && (
                    <p className={hintClass}>{t("providers.form.apiKeySaved")}</p>
                  )}
                </>
              )}
            </SettingsRow>
          )}
          <SettingsRow
            label={t("embeddingProviders.form.model")}
            htmlFor={modelFieldId}
            control={
              <input
                id={modelFieldId}
                required
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                spellCheck={false}
                className={`${rowFieldClass} w-64`}
              />
            }
          />
        </SettingsGroup>
        <SettingsHelp>
          <p data-testid="embedding-trade-off">{t("embeddingProviders.form.tradeOff")}</p>
          {current.localOnly && <p>{t("embeddingProviders.form.localOnly")}</p>}
        </SettingsHelp>
      </div>

      {takesKey && secretStorage && !secretStorage.canSave && (
        <SecretStorageNotice status={secretStorage} onAccept={() => void acceptPlainText()} />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          data-testid="embedding-switch"
          disabled={!complete || unchanged || keyBlocked || outsideLocalMode || busy !== null}
          className={buttonStyle("primary", "sm")}
        >
          {busy === "saving"
            ? t("providers.form.saving")
            : saved.kind === "off"
              ? t("embeddingProviders.form.turnOn")
              : t("embeddingProviders.form.switch")}
        </button>
        <button
          type="button"
          disabled={!complete || outsideLocalMode || busy !== null}
          onClick={() => void runTest()}
          className={buttonStyle("secondary", "sm")}
        >
          {busy === "testing" ? t("providers.form.testing") : t("providers.form.test")}
        </button>
        <button type="button" onClick={onDone} className={buttonStyle("ghost", "sm")}>
          {t("providers.settings.cancel")}
        </button>
      </div>

      {test &&
        (test.ok ? (
          <p data-testid="connection-test" className={successTextClass}>
            {t("embeddingProviders.test.ok", { dimensions: test.dimensions })}
          </p>
        ) : (
          <TestResult result={test} />
        ))}
      {error && (
        <p role="alert" className={errorTextClass}>
          <ProblemMark />
          {error}
        </p>
      )}

      <SwitchConfirmation
        open={confirming}
        provider={`${t(`embeddingProviders.kind.${kind}`)} · ${modelId.trim()}`}
        change={saved.kind === "off" ? "turn-on" : "switch"}
        cloudService={cloudService}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void save()}
      />
    </form>
  );
}

/**
 * The warning before a change: turned on, or switched, every Document is
 * embedded (again), and a cloud provider receives all their text and every
 * search; turned off, search goes by words alone, and the vectors stay.
 * Cancelling changes nothing.
 */
export function SwitchConfirmation({
  open,
  provider,
  change,
  cloudService,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  provider: string;
  change: "turn-on" | "turn-off" | "switch";
  cloudService: string | null;
  onCancel(): void;
  onConfirm(): void;
}) {
  const t = useT();
  const dialog = useModal(open);
  const documentCount = useAppStore((state) => state.documents.length);
  return (
    <dialog
      ref={dialog}
      data-testid="embedding-confirm"
      aria-labelledby="embedding-confirm-title"
      onClose={(event) => {
        // React passes "close" up its tree: it mustn't close the Settings dialog this one sits in.
        event.stopPropagation();
        onCancel();
      }}
      className={`${dialogClass} w-[30rem]`}
    >
      {open && (
        <div className={dialogBodyClass}>
          <h2 id="embedding-confirm-title" className={dialogTitleClass}>
            {change === "turn-off"
              ? t("embeddingProviders.confirm.offTitle")
              : change === "turn-on"
                ? t("embeddingProviders.confirm.onTitle", { provider })
                : t("embeddingProviders.confirm.title", { provider })}
          </h2>
          {change === "turn-off" ? (
            <p className={dialogTextClass}>{t("embeddingProviders.confirm.off")}</p>
          ) : (
            <>
              <p className={dialogTextClass}>
                {change === "turn-on"
                  ? t("embeddingProviders.confirm.embed", { count: documentCount })
                  : t("embeddingProviders.confirm.reprocess", { count: documentCount })}
              </p>
              {cloudService ? (
                <p
                  data-testid="embedding-confirm-cloud"
                  className="rounded-lg border border-rule bg-frame px-3 py-2 text-ui font-semibold text-ink"
                >
                  {t("embeddingProviders.confirm.cloud", { service: cloudService })}
                </p>
              ) : (
                <p className={dialogTextClass}>{t("embeddingProviders.confirm.local")}</p>
              )}
            </>
          )}
          <div className={dialogActionsClass}>
            <button
              type="button"
              data-testid="embedding-confirm-cancel"
              onClick={onCancel}
              className={buttonClass}
            >
              {t("embeddingProviders.confirm.cancel")}
            </button>
            <button
              type="button"
              data-testid="embedding-confirm-switch"
              onClick={onConfirm}
              className={primaryButtonClass}
            >
              {change === "turn-off"
                ? t("embeddingProviders.confirm.turnOff")
                : change === "turn-on"
                  ? t("embeddingProviders.confirm.turnOn")
                  : t("embeddingProviders.confirm.switch")}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
