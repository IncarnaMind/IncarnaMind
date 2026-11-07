import { type FormEvent, useEffect, useId, useState } from "react";
import {
  type EmbeddingConnectionTestResult,
  type EmbeddingProvider,
  type EmbeddingProviderKind,
  type EmbeddingSettings,
  embeddingProviderKinds,
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
import { SettingsAdvanced } from "../SettingsAdvanced";
import { PopUpSelect } from "../settings/PopUpButton";
import {
  SettingsGroup,
  SettingsHelp,
  SettingsRow,
  SettingsSection,
} from "../settings/SettingsGroup";
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
import { testErrorKey, useProviderKey } from "./shared";

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** Ollama's default local address, shown as the URL's placeholder. */
const OLLAMA_URL = "http://127.0.0.1:11434";

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

/** Where a provider the form describes would send Document text, or null when it stays here. */
function cloudServiceOf(kind: EmbeddingProviderKind, baseUrl: string, t: Translate) {
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

/** "Off", "Built-in model (multilingual-e5-small)", "OpenAI · text-embedding-3-small". */
export function embeddingProviderLabel(provider: EmbeddingProvider, t: Translate): string {
  if (provider.kind === "off") return t("embeddingProviders.settings.off");
  if (provider.kind === "built-in") {
    return t("embeddingProviders.settings.builtIn", { model: provider.modelId });
  }
  const kind = t(`embeddingProviders.kind.${provider.kind}`);
  const server =
    provider.kind === "openai-compatible" || provider.kind === "ollama"
      ? ` (${provider.service?.name ?? t("providers.settings.local")})`
      : "";
  return `${kind}${server} · ${provider.modelId}`;
}

/**
 * Settings → Search: search by meaning, off by default, or the model that
 * finds Documents by it (the built-in one, or a provider chosen instead),
 * turning it on or off or switching model with a warning, its error and
 * rebuild. The model's own name and facts wait under Advanced (#763).
 */
export function EmbeddingSettingsSection() {
  const t = useT();
  const embedding = useAppStore((state) => state.embedding);
  const retry = useAppStore((state) => state.retryEmbedding);
  const [editing, setEditing] = useState(false);

  if (!embedding) return null;
  const { provider, error, rebuild } = embedding;
  const off = provider.kind === "off";
  return (
    <SettingsSection title={t("embeddingProviders.settings.title")} testId="embedding-settings">
      <SettingsGroup>
        <SettingsRow
          label={
            <span data-testid="embedding-state">
              {off
                ? `${t("embeddingProviders.settings.off")} · ${t("embeddingProviders.settings.download")}`
                : provider.service
                  ? t("embeddingProviders.settings.stateSent", { service: provider.service.name })
                  : t("embeddingProviders.settings.stateOn")}
            </span>
          }
          detail={
            (rebuild || error) && (
              <>
                {rebuild && (
                  <p data-testid="embedding-rebuild">
                    {t("embeddingProviders.rebuild.title", {
                      done: rebuild.done,
                      total: rebuild.total,
                    })}
                  </p>
                )}
                {error && (
                  <p role="alert" className={errorTextClass} title={error.message}>
                    <ProblemMark />
                    {t("embeddingProviders.settings.error", {
                      reason: t(testErrorKey(error.kind)),
                    })}
                  </p>
                )}
              </>
            )
          }
          control={
            <>
              {error && (
                <button
                  type="button"
                  onClick={() => void retry()}
                  className={buttonStyle("secondary", "sm")}
                >
                  {t("embeddingProviders.settings.retry")}
                </button>
              )}
              {!editing && (
                <button
                  type="button"
                  data-testid="embedding-change"
                  onClick={() => setEditing(true)}
                  className={buttonStyle("secondary", "sm")}
                >
                  {off
                    ? t("embeddingProviders.settings.turnOn")
                    : t("embeddingProviders.settings.change")}
                </button>
              )}
            </>
          }
        />
      </SettingsGroup>
      <SettingsHelp data-testid="embedding-plain">
        {t("embeddingProviders.settings.plain")}
      </SettingsHelp>

      <SettingsAdvanced testId="embedding-advanced">
        <SettingsGroup>
          <SettingsRow
            label={
              <span data-testid="embedding-current">
                {t("embeddingProviders.settings.current")}
                {embeddingProviderLabel(provider, t)}
              </span>
            }
            detail={
              off
                ? t("embeddingProviders.settings.offNote")
                : provider.service
                  ? t("embeddingProviders.settings.sendsTo", { service: provider.service.name })
                  : t("embeddingProviders.settings.local")
            }
          />
        </SettingsGroup>
      </SettingsAdvanced>

      {editing && <EmbeddingForm current={embedding} onDone={() => setEditing(false)} />}
    </SettingsSection>
  );
}

/** Pick a provider, a key, a server and a model; test; then switch, after a warning. */
function EmbeddingForm({ current, onDone }: { current: EmbeddingSettings; onDone(): void }) {
  const t = useT();
  const id = useId();
  const [kind, setKind] = useState<EmbeddingProviderKind>(current.provider.kind);
  const [baseUrl, setBaseUrl] = useState(current.provider.baseUrl ?? "");
  const key = useProviderKey();
  const { apiKey } = key;
  const [modelId, setModelId] = useState(
    isPlainKind(current.provider.kind) ? "" : current.provider.modelId,
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
  const takesKey = kind === "openai" || kind === "google" || kind === "openai-compatible";
  const keyRequired = kind === "openai" || kind === "google";
  const hasKey = key.text !== "" || (sameServer && saved.hasApiKey);
  const keyBlocked = key.text !== "" && secretStorage !== null && !secretStorage.canSave;
  const complete =
    isPlainKind(kind) ||
    (key.stray === null &&
      modelId.trim() !== "" &&
      (kind !== "openai-compatible" || baseUrl.trim() !== "") &&
      (!keyRequired || hasKey));
  const unchanged =
    sameServer && key.text === "" && (isPlainKind(kind) || modelId.trim() === saved.modelId);
  const cloudService = cloudServiceOf(kind, baseUrl, t);
  // A server elsewhere, in local mode: said as the address is typed, not refused at the end.
  const outsideLocalMode = current.localOnly && cloudService !== null;

  const choose = (next: EmbeddingProviderKind) => {
    // A key typed for one provider is never sent to another.
    if (next !== kind) key.clear();
    setKind(next);
    setBaseUrl(next === saved.kind ? (saved.baseUrl ?? "") : "");
    setModelId(
      next === "off" || next === "built-in"
        ? ""
        : next === saved.kind
          ? saved.modelId
          : SUGGESTED_EMBEDDING_MODELS[next],
    );
    setTest(null);
    setError(null);
  };

  const input = (): SaveEmbeddingProviderInput =>
    isPlainKind(kind)
      ? { kind }
      : {
          kind,
          modelId: modelId.trim(),
          ...((kind === "openai-compatible" || kind === "ollama") && baseUrl.trim()
            ? { baseUrl: baseUrl.trim() }
            : {}),
          ...(takesKey && key.text ? { apiKey: key.text } : {}),
        };

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
    <form data-testid="embedding-form" onSubmit={submit} className="mt-4 flex flex-col gap-3">
      <div>
        <SettingsGroup>
          <SettingsRow
            label={t("embeddingProviders.form.label")}
            htmlFor={kindId}
            detail={
              kind === "off"
                ? t("embeddingProviders.form.offHint")
                : kind === "built-in"
                  ? t("embeddingProviders.form.builtInHint")
                  : undefined
            }
            control={
              <PopUpSelect
                id={kindId}
                value={kind}
                onChange={(event) => {
                  const next = embeddingProviderKinds.find((each) => each === event.target.value);
                  if (next) choose(next);
                }}
              >
                {embeddingProviderKinds.map((option) => (
                  <option
                    key={option}
                    value={option}
                    disabled={current.localOnly && CLOUD_KINDS.has(option)}
                  >
                    {t(`embeddingProviders.kind.${option}`)}
                  </option>
                ))}
              </PopUpSelect>
            }
          />

          {(kind === "openai-compatible" || kind === "ollama") && (
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
          )}

          {takesKey && (
            <SettingsRow
              label={keyRequired ? t("providers.form.apiKey") : t("providers.form.apiKeyOptional")}
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

          {!isPlainKind(kind) && (
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
          )}
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
            : kind === "off"
              ? t("embeddingProviders.form.turnOff")
              : saved.kind === "off"
                ? t("embeddingProviders.form.turnOn")
                : t("embeddingProviders.form.switch")}
        </button>
        {!isPlainKind(kind) && (
          <button
            type="button"
            disabled={!complete || outsideLocalMode || busy !== null}
            onClick={() => void runTest()}
            className={buttonStyle("secondary", "sm")}
          >
            {busy === "testing" ? t("providers.form.testing") : t("providers.form.test")}
          </button>
        )}
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
        provider={
          isPlainKind(kind)
            ? t(`embeddingProviders.kind.${kind}`)
            : `${t(`embeddingProviders.kind.${kind}`)} · ${modelId.trim()}`
        }
        change={kind === "off" ? "turn-off" : saved.kind === "off" ? "turn-on" : "switch"}
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
function SwitchConfirmation({
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
