import { type FormEvent, useEffect, useId, useState } from "react";
import {
  type ConnectionTestResult,
  DEFAULT_RERANK_MODELS,
  type RerankingModelStatus,
  type RerankServiceKind,
  type RerankSettings,
  type SecretStorageStatus,
} from "../../../../core/api";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useT } from "../../i18n";
import { KeyCharacterLine } from "../KeyCharacterLine";
import { ProblemMark } from "../ProblemLine";
import { buttonStyle, errorTextClass, hintClass, rowFieldClass } from "../ui";
import { SecretStorageNotice, TestResult } from "./ProviderForm";
import { useProviderKey } from "./shared";

const megabytes = (bytes: number) => Math.round(bytes / 1e6);

const FAILURE_KEYS = {
  network: "embedding.model.failure.network",
  integrity: "embedding.model.failure.integrity",
  storage: "embedding.model.failure.storage",
} as const;

/**
 * How document search orders its best matches on this device, read once and kept as it changes;
 * `answered`: the first read has ended, whether or not it could be read.
 */
export function useRerank(): {
  rerank: RerankSettings | null;
  setRerank(next: RerankSettings): void;
  answered: boolean;
} {
  const [rerank, setRerank] = useState<RerankSettings | null>(null);
  const [answered, setAnswered] = useState(false);
  useEffect(() => {
    core
      .getRerankSettings()
      .then(setRerank, (failure: unknown) => {
        console.error("Couldn't read how search orders its results:", failure);
      })
      .finally(() => setAnswered(true));
    return core.on("rerank.changed", setRerank);
  }, []);
  return { rerank, setRerank, answered };
}

/** The built-in model's download, while it isn't ready: when it will, its progress, or why it failed. */
export function BuiltInModelState({ model }: { model: RerankingModelStatus }) {
  const t = useT();
  if (model.state === "not-downloaded") {
    return (
      <p data-testid="rerank-model-state">
        {t("rerank.settings.notDownloaded", { total: megabytes(model.totalBytes) })}
      </p>
    );
  }
  if (model.state === "downloading") {
    return (
      <p data-testid="rerank-model-state">
        {t("rerank.settings.downloading", {
          downloaded: megabytes(model.downloadedBytes),
          total: megabytes(model.totalBytes),
        })}
      </p>
    );
  }
  if (model.state === "failed" && model.error) {
    const { kind, message } = model.error;
    return (
      <p role="alert" data-testid="rerank-model-state" className={errorTextClass} title={message}>
        <ProblemMark />
        {kind === "load"
          ? t("rerank.settings.loadFailed")
          : t("rerank.settings.failed", { reason: t(FAILURE_KEYS[kind]) })}
      </p>
    );
  }
  return null;
}

/**
 * A reranking service's key, and the model if not its default: tested, then saved with Use this,
 * which also makes it what orders search results. The line above Use this says what goes: that
 * press is the consent (ADR-0022). The same form changes the key of the service in use.
 */
export function RerankKeyForm({
  kind,
  current,
  onSaved,
  onCancel,
}: {
  kind: RerankServiceKind;
  current: RerankSettings;
  onSaved(saved: RerankSettings): void;
  onCancel(): void;
}) {
  const t = useT();
  const id = useId();
  const key = useProviderKey();
  const { apiKey } = key;
  const sameKind = current.kind === kind;
  const [model, setModel] = useState(
    sameKind && current.modelId !== DEFAULT_RERANK_MODELS[kind] ? (current.modelId ?? "") : "",
  );
  const [busy, setBusy] = useState<"testing" | "saving" | null>(null);
  const [test, setTest] = useState<ConnectionTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secretStorage, setSecretStorage] = useState<SecretStorageStatus | null>(null);

  useEffect(() => {
    core.getSecretStorage().then(setSecretStorage, () => undefined);
  }, []);

  const keySaved = sameKind && current.hasApiKey;
  const hasKey = key.stray === null && (key.text !== "" || keySaved);
  const keyBlocked = key.text !== "" && secretStorage !== null && !secretStorage.canSave;
  const service = t(`rerank.kind.${kind}`);

  const run = async (action: "testing" | "saving") => {
    setBusy(action);
    setError(null);
    if (action === "testing") setTest(null);
    try {
      const input = {
        kind,
        ...(key.text ? { apiKey: key.text } : {}),
        modelId: model.trim() || null,
      };
      if (action === "testing") setTest(await core.testRerankConnection(input));
      else {
        const saved = await core.saveRerankSettings(input);
        key.clear();
        onSaved(saved);
      }
    } catch (failure) {
      setError(errorMessage(failure, t));
    } finally {
      setBusy(null);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run("saving");
  };

  const acceptPlainText = async () => {
    try {
      setSecretStorage(await core.acceptPlainTextSecretStorage());
    } catch (failure) {
      setError(errorMessage(failure, t));
    }
  };

  return (
    <form
      data-testid="rerank-form"
      data-kind={kind}
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
      className="flex flex-col gap-2"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label htmlFor={`${id}-key`} className="text-ui text-ink">
          {t("providers.form.apiKey")}
        </label>
        <input
          id={`${id}-key`}
          type="password"
          data-testid="rerank-key"
          value={apiKey}
          onChange={(event) => key.type(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          // biome-ignore lint/a11y/noAutofocus: opened to type the key.
          autoFocus
          aria-invalid={key.stray ? true : undefined}
          aria-describedby={key.stray ? `${id}-stray` : undefined}
          className={`${rowFieldClass} w-64`}
        />
      </div>
      {key.stray && <KeyCharacterLine id={`${id}-stray`} stray={key.stray} />}
      {keySaved && <p className={`${hintClass} mt-0`}>{t("providers.form.apiKeySaved")}</p>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label htmlFor={`${id}-model`} className="text-ui text-ink">
          {t("rerank.form.model")}
        </label>
        <input
          id={`${id}-model`}
          value={model}
          onChange={(event) => setModel(event.target.value)}
          placeholder={DEFAULT_RERANK_MODELS[kind]}
          spellCheck={false}
          className={`${rowFieldClass} w-64`}
        />
      </div>
      <p data-testid="rerank-sends" className={`${hintClass} mt-0`}>
        {t("rerank.settings.sends", { service })}
      </p>
      {secretStorage && !secretStorage.canSave && (
        <SecretStorageNotice status={secretStorage} onAccept={() => void acceptPlainText()} />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          data-testid="rerank-use"
          disabled={!hasKey || keyBlocked || busy !== null}
          className={buttonStyle("primary", "sm")}
        >
          {busy === "saving" ? t("providers.form.saving") : t("setup.step.useThis")}
        </button>
        <button
          type="button"
          disabled={!hasKey || busy !== null}
          onClick={() => void run("testing")}
          className={buttonStyle("secondary", "sm")}
        >
          {busy === "testing" ? t("providers.form.testing") : t("providers.form.test")}
        </button>
        <button type="button" onClick={onCancel} className={buttonStyle("ghost", "sm")}>
          {t("providers.settings.cancel")}
        </button>
      </div>
      {test && <TestResult result={test} />}
      {error && (
        <p role="alert" data-testid="rerank-problem" className={errorTextClass}>
          <ProblemMark />
          {error}
        </p>
      )}
    </form>
  );
}
