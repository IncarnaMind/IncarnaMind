import { type FormEvent, useEffect, useId, useState } from "react";
import {
  type ConnectionTestResult,
  DEFAULT_RERANK_MODELS,
  type RerankingModelStatus,
  type RerankProviderKind,
  type RerankSettings,
  rerankProviderKinds,
  type SaveRerankSettingsInput,
  type SecretStorageStatus,
} from "../../../../core/api";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { DetailsLine } from "../DetailsLine";
import { KeyCharacterLine } from "../KeyCharacterLine";
import { ProblemMark } from "../ProblemLine";
import { SettingsAdvanced } from "../SettingsAdvanced";
import {
  buttonClass,
  choiceListClass,
  compactChoiceRadioClass,
  compactChoiceRowClass,
  errorTextClass,
  fieldLabelClass,
  ghostButtonClass,
  hintClass,
  inputClass,
  noticeClass,
  primaryButtonClass,
  rowButtonsClass,
  rowTextClass,
  ruledListClass,
  ruledRow,
  ruledRowClass,
  sectionNoteClass,
  sectionTitleClass,
} from "../ui";
import { SecretStorageNotice, TestResult } from "./ProviderForm";
import { useProviderKey } from "./shared";

const megabytes = (bytes: number) => Math.round(bytes / 1e6);

const FAILURE_KEYS = {
  network: "embedding.model.failure.network",
  integrity: "embedding.model.failure.integrity",
  storage: "embedding.model.failure.storage",
} as const;

/**
 * Settings → Search → Reranking: the built-in model on this computer reorders document
 * search's best matches by default; a Cohere or Voyage AI key can do it
 * instead, or the User turns it off.
 */
export function RerankSettingsSection() {
  const t = useT();
  const [rerank, setRerank] = useState<RerankSettings | null>(null);
  const [editing, setEditing] = useState(false);
  const localOnly = useAppStore((state) => state.embedding?.localOnly === true);

  useEffect(() => {
    core.getRerankSettings().then(setRerank, () => undefined);
    return core.on("rerank.changed", setRerank);
  }, []);

  const run = async (action: () => Promise<RerankSettings>) => {
    try {
      setRerank(await action());
    } catch (failure) {
      useAppStore.getState().reportError(failure);
    }
  };

  if (!rerank) return null;
  const service = rerank.service?.name ?? "";
  const builtIn = rerank.kind === "built-in";
  return (
    <section data-testid="rerank-settings" className="flex flex-col">
      <h4 className={sectionTitleClass}>{t("rerank.settings.title")}</h4>
      <DetailsLine
        testId="rerank-settings-body"
        className={sectionNoteClass}
        details={t("rerank.settings.body.details")}
      >
        {t("rerank.settings.body")}
      </DetailsLine>

      {!editing && (
        <>
          <div className={ruledListClass}>
            <div className={rerank.enabled ? ruledRowClass : ruledRow("center", true)}>
              <div className="flex min-w-0 flex-col gap-0.5">
                <p data-testid="rerank-state" className="text-ui text-ink">
                  {rerank.enabled
                    ? builtIn
                      ? t("rerank.settings.stateOn")
                      : t("rerank.settings.stateSent", { service })
                    : t("privacy.traffic.off")}
                </p>
                {rerank.enabled && rerank.paused && (
                  <p className={`mt-1.5 ${noticeClass}`}>{t("rerank.settings.paused")}</p>
                )}
                {rerank.enabled && !builtIn && !rerank.hasApiKey && (
                  <p className={`mt-1.5 ${noticeClass}`}>
                    {t("rerank.settings.keyMissing", { service })}
                  </p>
                )}
                {rerank.enabled && builtIn && <BuiltInModelState model={rerank.model} />}
              </div>
              <div className={rowButtonsClass}>
                {builtIn && rerank.model.state === "failed" && (
                  <button
                    type="button"
                    data-testid="rerank-retry"
                    onClick={() => void run(() => core.downloadRerankingModel())}
                    className={buttonClass}
                  >
                    {t("rerank.settings.retry")}
                  </button>
                )}
                {rerank.enabled ? (
                  <>
                    <button
                      type="button"
                      data-testid="rerank-change"
                      onClick={() => setEditing(true)}
                      className={buttonClass}
                    >
                      {t("rerank.settings.change")}
                    </button>
                    <button
                      type="button"
                      data-testid="rerank-remove"
                      onClick={() => void run(() => core.removeRerankSettings())}
                      className={buttonClass}
                    >
                      {t("rerank.settings.remove")}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    data-testid="rerank-set-up"
                    onClick={() => setEditing(true)}
                    className={buttonClass}
                  >
                    {t("rerank.settings.setUp")}
                  </button>
                )}
              </div>
            </div>
          </div>

          {rerank.enabled && (
            <SettingsAdvanced testId="rerank-advanced">
              {builtIn ? (
                <>
                  <p data-testid="rerank-current" className="text-[13px] leading-5 text-ink">
                    {t(
                      rerank.byDefault
                        ? "rerank.settings.builtInDefault"
                        : "rerank.settings.builtInUse",
                      { model: rerank.modelId ?? "" },
                    )}
                  </p>
                  {rerank.runsOn && (
                    <p data-testid="rerank-runs-on" className={rowTextClass}>
                      {t("rerank.settings.runsOn", {
                        device: rerank.runsOn === "gpu" ? "GPU" : "CPU",
                      })}
                    </p>
                  )}
                  <p className={rowTextClass}>{t("rerank.settings.builtInNote")}</p>
                </>
              ) : (
                <>
                  <p data-testid="rerank-current" className="text-[13px] leading-5 text-ink">
                    {t("rerank.settings.inUse", { service, model: rerank.modelId ?? "" })}
                  </p>
                  <p className={rowTextClass}>{t("rerank.settings.sends", { service })}</p>
                </>
              )}
            </SettingsAdvanced>
          )}
        </>
      )}

      {editing && (
        <RerankForm
          current={rerank}
          localOnly={localOnly}
          onSaved={(saved) => {
            setRerank(saved);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      )}
    </section>
  );
}

/** The built-in model's download, while it isn't ready: when it will, its progress, or why it failed. */
function BuiltInModelState({ model }: { model: RerankingModelStatus }) {
  const t = useT();
  if (model.state === "not-downloaded") {
    return (
      <p data-testid="rerank-model-state" className={`mt-1.5 ${rowTextClass}`}>
        {t("rerank.settings.notDownloaded", { total: megabytes(model.totalBytes) })}
      </p>
    );
  }
  if (model.state === "downloading") {
    return (
      <p data-testid="rerank-model-state" className={`mt-1.5 ${rowTextClass}`}>
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
      <p
        role="alert"
        data-testid="rerank-model-state"
        className={`mt-1.5 ${errorTextClass}`}
        title={message}
      >
        <ProblemMark />
        {kind === "load"
          ? t("rerank.settings.loadFailed")
          : t("rerank.settings.failed", { reason: t(FAILURE_KEYS[kind]) })}
      </p>
    );
  }
  return null;
}

/** Built in, or a service with its key and an optional model; test a service, then save. */
function RerankForm({
  current,
  localOnly,
  onSaved,
  onCancel,
}: {
  current: RerankSettings;
  localOnly: boolean;
  onSaved(saved: RerankSettings): void;
  onCancel(): void;
}) {
  const t = useT();
  const id = useId();
  // A service can't be chosen in local mode: the built-in model is offered first.
  const [kind, setKind] = useState<RerankProviderKind>(
    current.kind && !(localOnly && current.kind !== "built-in") ? current.kind : "built-in",
  );
  const key = useProviderKey();
  const { apiKey } = key;
  const [model, setModel] = useState(
    current.kind &&
      current.kind !== "built-in" &&
      current.modelId !== DEFAULT_RERANK_MODELS[current.kind]
      ? (current.modelId ?? "")
      : "",
  );
  const [busy, setBusy] = useState<"testing" | "saving" | null>(null);
  const [test, setTest] = useState<ConnectionTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secretStorage, setSecretStorage] = useState<SecretStorageStatus | null>(null);

  useEffect(() => {
    core.getSecretStorage().then(setSecretStorage, () => undefined);
  }, []);

  const builtIn = kind === "built-in";
  const keySaved = current.kind === kind && current.hasApiKey;
  const hasKey = builtIn || (key.stray === null && (key.text !== "" || keySaved));
  const keyBlocked =
    !builtIn && key.text !== "" && secretStorage !== null && !secretStorage.canSave;

  const input = (): SaveRerankSettingsInput =>
    builtIn
      ? { kind }
      : {
          kind,
          ...(key.text ? { apiKey: key.text } : {}),
          modelId: model.trim() || null,
        };

  const run = async (action: "testing" | "saving") => {
    setBusy(action);
    setError(null);
    if (action === "testing") setTest(null);
    try {
      if (action === "testing") {
        if (kind !== "built-in") {
          setTest(
            await core.testRerankConnection({
              kind,
              ...(key.text ? { apiKey: key.text } : {}),
              modelId: model.trim() || null,
            }),
          );
        }
      } else {
        const saved = await core.saveRerankSettings(input());
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
    <form data-testid="rerank-form" onSubmit={submit} className="flex flex-col gap-3">
      <fieldset>
        <legend className={`mb-1.5 ${fieldLabelClass}`}>{t("rerank.form.label")}</legend>
        <div className={choiceListClass}>
          {rerankProviderKinds.map((option) => (
            <label key={option} className={compactChoiceRowClass}>
              <input
                type="radio"
                name={`${id}-kind`}
                value={option}
                checked={kind === option}
                disabled={localOnly && option !== "built-in"}
                onChange={() => {
                  // A key typed for one provider is never sent to another.
                  if (option !== kind) key.clear();
                  setKind(option);
                  setTest(null);
                }}
                className={compactChoiceRadioClass}
              />
              {t(`rerank.kind.${option}`)}
            </label>
          ))}
        </div>
        {localOnly && (
          <p data-testid="rerank-local-only" className={hintClass}>
            {t("rerank.settings.localOnly")}
          </p>
        )}
      </fieldset>

      {builtIn ? (
        <p data-testid="rerank-built-in-note" className={hintClass}>
          {t("rerank.form.builtInNote", {
            model: current.model.name,
            size: megabytes(current.model.totalBytes),
          })}
        </p>
      ) : (
        <>
          <label className={fieldLabelClass}>
            {t("providers.form.apiKey")}
            <input
              type="password"
              value={apiKey}
              onChange={(event) => key.type(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={key.stray ? true : undefined}
              aria-describedby={key.stray ? `${id}-stray` : undefined}
              className={inputClass}
            />
            {key.stray && <KeyCharacterLine id={`${id}-stray`} stray={key.stray} />}
            {keySaved && <span className={hintClass}>{t("providers.form.apiKeySaved")}</span>}
          </label>

          {secretStorage && !secretStorage.canSave && (
            <SecretStorageNotice status={secretStorage} onAccept={() => void acceptPlainText()} />
          )}

          <label className={fieldLabelClass}>
            {t("rerank.form.model")}
            <input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder={DEFAULT_RERANK_MODELS[kind]}
              spellCheck={false}
              className={inputClass}
            />
          </label>
        </>
      )}

      {!builtIn && (
        <p data-testid="rerank-sends" className={hintClass}>
          {t("rerank.settings.sends", { service: t(`rerank.kind.${kind}`) })}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={!hasKey || keyBlocked || busy !== null}
          className={primaryButtonClass}
        >
          {busy === "saving" ? t("providers.form.saving") : t("rerank.form.save")}
        </button>
        {!builtIn && (
          <button
            type="button"
            disabled={!hasKey || busy !== null}
            onClick={() => void run("testing")}
            className={buttonClass}
          >
            {busy === "testing" ? t("providers.form.testing") : t("providers.form.test")}
          </button>
        )}
        <button type="button" onClick={onCancel} className={ghostButtonClass}>
          {t("providers.settings.cancel")}
        </button>
      </div>

      {test && <TestResult result={test} />}
      {error && (
        <p role="alert" className={errorTextClass}>
          <ProblemMark />
          {error}
        </p>
      )}
    </form>
  );
}
