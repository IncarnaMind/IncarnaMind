import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  type ConnectionTestResult,
  JEV_DEFAULT_MODEL,
  type JevSettings,
  type SaveJevSettingsInput,
  type SecretStorageStatus,
} from "../../../../core/api";
import { JEV_SERVICE } from "../../../../core/providers/jev";
import { serviceForUrl } from "../../../../core/providers/service";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useT } from "../../i18n";
import { useMounted } from "../../useMounted";
import { KeyCharacterLine } from "../KeyCharacterLine";
import { ProblemMark } from "../ProblemLine";
import {
  buttonClass,
  errorTextClass,
  fieldLabelClass,
  ghostButtonClass,
  hintClass,
  inputClass,
  primaryButtonClass,
} from "../ui";
import { setUpJevForSorting } from "./jevSetUp";
import { SecretStorageNotice, TestResult } from "./ProviderForm";
import { useProviderKey } from "./shared";

/** TypeSafe's hosted API, shown as the server's placeholder. */
const HOSTED_URL = "https://api.typesafe.ai";

const toPercent = (probability: number) => Math.round(probability * 100);

/** Jev set up from the sorting picker (#2615), where its Use this is the consent and the choice. */
export interface JevSortingForm {
  /** What choosing Jev sends, to the service the form's server names (null: this computer). */
  consent(service: string | null): ReactNode;
  /** Makes Jev what sorts, once its key is saved: false when that failed, having said why. */
  choose(): Promise<boolean>;
}

/**
 * The service a server typed in the form sends to: TypeSafe's when there is none, null on this
 * computer. Anything that isn't a web address is named as typed, never taken for this computer.
 */
function serviceOfEndpoint(endpoint: string): string | null {
  const typed = endpoint.trim();
  if (typed === "") return JEV_SERVICE.name;
  try {
    const url = new URL(typed);
    if (!/^https?:$/.test(url.protocol) || url.hostname === "") return typed;
    return serviceForUrl(typed)?.name ?? null;
  } catch {
    return typed;
  }
}

/**
 * The Jev key, an optional server and model, and the review band; test, then save. From the
 * sorting picker (`sorting`), its one button tries the key, saves it and chooses Jev, with no
 * Test before: nothing goes to TypeSafe until the User has pressed it.
 */
export function JevForm({
  current,
  sorting,
  onSaved,
  onCancel,
}: {
  current: JevSettings;
  sorting?: JevSortingForm;
  onSaved(saved: JevSettings, chosen?: boolean): void;
  onCancel(): void;
}) {
  const t = useT();
  const id = useId();
  const key = useProviderKey();
  const [endpoint, setEndpoint] = useState(current.endpoint ?? "");
  const [model, setModel] = useState(current.model === JEV_DEFAULT_MODEL ? "" : current.model);
  const [low, setLow] = useState(toPercent(current.reviewBand.low));
  const [high, setHigh] = useState(toPercent(current.reviewBand.high));
  const [busy, setBusy] = useState<"testing" | "saving" | null>(null);
  const [test, setTest] = useState<ConnectionTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secretStorage, setSecretStorage] = useState<SecretStorageStatus | null>(null);
  const keyField = useRef<HTMLInputElement>(null);
  const buttons = useRef<HTMLDivElement>(null);
  const problem = useRef<HTMLDivElement>(null);
  const mounted = useMounted();

  useEffect(() => {
    core.getSecretStorage().then(setSecretStorage, () => undefined);
  }, []);
  const fromPicker = sorting !== undefined;
  // In the setup card, which scrolls in a short window, the form's buttons come into view with
  // the key field, and the field wins where both can't show.
  useEffect(() => {
    if (!fromPicker) return;
    keyField.current?.focus({ preventScroll: true });
    buttons.current?.scrollIntoView({ block: "nearest" });
    keyField.current?.scrollIntoView({ block: "nearest" });
  }, [fromPicker]);
  const failed = error !== null || (test !== null && !test.ok);
  useEffect(() => {
    if (fromPicker && failed) problem.current?.scrollIntoView({ block: "nearest" });
  }, [fromPicker, failed]);

  const hasKey = key.text !== "" || current.hasApiKey;
  const keyBlocked = key.text !== "" && secretStorage !== null && !secretStorage.canSave;
  const bandValid = low > 0 && low <= high && high <= 100;

  const input = (): SaveJevSettingsInput => ({
    ...(key.text ? { apiKey: key.text } : {}),
    endpoint: endpoint.trim() || null,
    model: model.trim() || null,
  });

  const run = async (action: "testing" | "saving") => {
    setBusy(action);
    setError(null);
    if (action === "testing") setTest(null);
    try {
      const settings = { ...input(), reviewBand: { low: low / 100, high: high / 100 } };
      if (action === "testing") {
        setTest(await core.testJevConnection(input()));
      } else if (sorting) {
        setTest(null);
        const outcome = await setUpJevForSorting(core, settings, sorting.choose, mounted);
        if (outcome.kind === "given-up") return;
        if (outcome.kind === "failed") {
          setTest(outcome.result);
          return;
        }
        key.clear();
        onSaved(outcome.saved, outcome.chosen);
      } else {
        const saved = await core.saveJevSettings(settings);
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

  const percentInput = (value: number, onChange: (next: number) => void, label: string) => (
    <label className={`flex-1 ${fieldLabelClass}`}>
      {label}
      <input
        type="number"
        min={1}
        max={100}
        step={1}
        required
        value={Number.isNaN(value) ? "" : value}
        onChange={(event) => onChange(event.target.valueAsNumber)}
        className={inputClass}
      />
    </label>
  );

  return (
    <form
      data-testid="jev-form"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (!sorting || event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (busy === null) onCancel();
      }}
      className="flex flex-col gap-3"
    >
      <label className={fieldLabelClass}>
        {t("jev.form.apiKey")}
        <input
          ref={keyField}
          type="password"
          value={key.apiKey}
          onChange={(event) => key.type(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={key.stray ? true : undefined}
          aria-describedby={key.stray ? `${id}-stray` : undefined}
          className={sorting ? `${inputClass} max-w-[26rem]` : inputClass}
        />
        {key.stray && <KeyCharacterLine id={`${id}-stray`} stray={key.stray} />}
        {current.hasApiKey && <span className={hintClass}>{t("providers.form.apiKeySaved")}</span>}
      </label>

      {secretStorage && !secretStorage.canSave && (
        <SecretStorageNotice status={secretStorage} onAccept={() => void acceptPlainText()} />
      )}

      <details className="text-[13px] leading-5 text-ink-secondary">
        <summary className="cursor-pointer select-none hover:text-ink">
          {t("jev.form.advanced")}
        </summary>
        <div className="mt-2 flex flex-col gap-3">
          <label className={fieldLabelClass}>
            {t("jev.form.endpoint")}
            <input
              type="url"
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder={HOSTED_URL}
              spellCheck={false}
              className={inputClass}
            />
            <span className={hintClass}>{t("jev.form.endpointHint")}</span>
          </label>
          <label className={fieldLabelClass}>
            {t("jev.form.model")}
            <input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder={JEV_DEFAULT_MODEL}
              spellCheck={false}
              className={inputClass}
            />
          </label>
          <div>
            <div className="flex gap-2">
              {percentInput(low, setLow, t("jev.form.reviewFrom"))}
              {percentInput(high, setHigh, t("jev.form.reviewTo"))}
            </div>
            <span className={hintClass}>{t("jev.form.reviewHint")}</span>
          </div>
        </div>
      </details>

      {sorting ? (
        sorting.consent(serviceOfEndpoint(endpoint))
      ) : (
        <p data-testid="jev-sends" className={hintClass}>
          {t("jev.form.sends")}
        </p>
      )}
      <div ref={buttons} className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          data-testid="jev-save"
          disabled={!hasKey || !bandValid || keyBlocked || key.stray !== null || busy !== null}
          className={primaryButtonClass}
        >
          {busy === "saving"
            ? t(sorting ? "providers.form.checking" : "providers.form.saving")
            : t(sorting ? "setup.step.useThis" : "jev.form.save")}
        </button>
        {!sorting && (
          <button
            type="button"
            disabled={!hasKey || key.stray !== null || busy !== null}
            onClick={() => void run("testing")}
            className={buttonClass}
          >
            {busy === "testing" ? t("providers.form.testing") : t("providers.form.test")}
          </button>
        )}
        <button
          type="button"
          disabled={sorting !== undefined && busy !== null}
          onClick={onCancel}
          className={ghostButtonClass}
        >
          {t("providers.settings.cancel")}
        </button>
      </div>

      {(test || error) && (
        <div ref={problem} className="flex flex-col gap-3">
          {test && <TestResult result={test} />}
          {error && (
            <p role="alert" className={errorTextClass}>
              <ProblemMark />
              {error}
            </p>
          )}
        </div>
      )}
    </form>
  );
}
