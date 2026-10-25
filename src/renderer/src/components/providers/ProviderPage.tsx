import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import type {
  ChatModelChoice,
  ChatModelGroup,
  ChatProvider,
  ModelAbout,
  ProviderTestResult,
} from "../../../../core/api";
import type { Language } from "../../../../core/language";
import {
  catalogProviderOf,
  dataUseOf,
  endpointOf,
  fieldValueOf,
  isPreset,
} from "../../../../core/providers/catalog/providers";
import { OLLAMA_CLOUD } from "../../../../core/providers/ollamaCloud";
import { formatDate } from "../../../../shared/dates";
import type { MessageKey, MessageParams } from "../../../../shared/i18n";
import { useAnswers } from "../../answers";
import { core } from "../../core";
import { formatMoney, formatSpent, joinMeta, setAsideText } from "../../cost";
import { errorMessage } from "../../errors";
import { useLanguage, useT } from "../../i18n";
import { type KeyRefusal, useKeyRefusals } from "../../keyRefusals";
import { clearModelFailure } from "../../modelHealth";
import { useModelNames } from "../../modelNames";
import { useAppStore } from "../../store";
import { KeyCharacterLine } from "../KeyCharacterLine";
import { OnThisComputer } from "../OnThisComputer";
import { ProblemMark } from "../ProblemLine";
import { SettingsBackLink } from "../SettingsBackLink";
import { useCostSummary } from "../SpendingCapSettings";
import {
  buttonClass,
  errorTextClass,
  fieldClass,
  fieldLabelClass,
  hintClass,
  successTextClass,
} from "../ui";
import { KeyCheckLine, useKeyCheck } from "./keyCheck";
import { LocalModeUnavailable } from "./LocalModeUnavailable";
import { OtherModels } from "./OtherModels";
import { KeyNotCheckedLine, KeyRefusedLine, ProviderSendsLine, TestResult } from "./ProviderForm";
import { logoIdOf, ProviderLogo } from "./ProviderLogo";
import { keyProviderName, useProviderKey } from "./shared";

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** `answers`: where Answers went, null for nowhere; left out when they didn't use the provider. */
export interface RemovedProvider {
  provider: string;
  answers?: ChatModelChoice | null;
  automatic: boolean;
}

export function providerName(provider: ChatProvider, t: Translate, language: Language): string {
  if (provider.kind === "chatgpt") return t("chatgpt.title");
  if (provider.kind === "claude-account" || provider.kind === "copilot") {
    return t(`providers.kind.${provider.kind}`);
  }
  const catalog = catalogProviderOf(provider.kind, provider.catalogId);
  if (provider.kind === "openai-compatible" && !isPreset(catalog) && provider.baseUrl) {
    try {
      return new URL(provider.baseUrl).host;
    } catch {
      return provider.baseUrl;
    }
  }
  return keyProviderName(provider.catalogId ?? provider.kind, t, language);
}

const contextSize = (tokens: number) =>
  tokens >= 1_000_000
    ? `${Number((tokens / 1_000_000).toFixed(1))}M`
    : `${Math.round(tokens / 1_000)}K`;

function abilitiesOf(about: ModelAbout | undefined, t: Translate): string {
  if (!about) return "";
  const line = joinMeta([
    about.tools ? t("models.ability.tools") : "",
    about.readsImages ? t("models.ability.images") : "",
    about.reasoning ? t("models.ability.thinks") : "",
    about.context ? t("models.ability.context", { size: contextSize(about.context) }) : "",
  ]);
  return line.charAt(0).toLocaleUpperCase() + line.slice(1);
}

export function ProviderPage({
  provider,
  keyNotChecked = false,
  group,
  refused,
  onBack,
  onRegion,
  onRemoved,
}: {
  provider: ChatProvider;
  /** The key was just saved with its test stopped by Local mode. */
  keyNotChecked?: boolean;
  group: ChatModelGroup | undefined;
  /** From "Check the key": said by the key field, which takes the focus. */
  refused: KeyRefusal | null;
  onBack(): void;
  onRegion(endpoint: string): void;
  onRemoved(removed: RemovedProvider): void;
}) {
  const t = useT();
  const language = useLanguage();
  const id = useId();
  const catalog = catalogProviderOf(provider.kind, provider.catalogId);
  const plan = !catalog;
  const words = language === "zh-CN" ? "zh" : "en";
  const name = providerName(provider, t, language);
  const endpoint = catalog ? endpointOf(catalog, provider.endpoint) : undefined;
  const fieldValue = endpoint ? fieldValueOf(endpoint, provider.baseUrl) : null;
  const takesKey = catalog !== undefined && catalog.apiKey !== "none";
  const keyUrl = endpoint?.keyUrl ?? catalog?.keyUrl;
  const key = useProviderKey();
  const keyCheck = useKeyCheck(
    takesKey && catalog.group !== "local" && catalog.id !== "openai-compatible" ? catalog.id : null,
    key.apiKey,
  );
  const keyField = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [notChecked, setNotChecked] = useState(keyNotChecked);
  const localOnly = useAppStore((state) => state.embedding?.localOnly === true);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ProviderTestResult | null>(null);
  const [otherOpen, setOtherOpen] = useState(false);
  const refusedHere = refused !== null && takesKey;

  useEffect(() => {
    if (!refusedHere) return;
    keyField.current?.scrollIntoView({ block: "center" });
    keyField.current?.focus({ preventScroll: true });
  }, [refusedHere]);

  const changed = () => {
    useAnswers.setState({ models: null });
    useAnswers.getState().loadModels();
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await core.testChatProvider(provider.id));
    } catch (failure) {
      useAppStore.getState().reportError(failure);
    } finally {
      setTesting(false);
    }
  };

  const chatModel = useAppStore((state) => state.settings?.user.chatModel ?? null);
  // Saving a key needs a model id; with `keepDefault` it changes nothing.
  const someModel =
    (chatModel?.providerId === provider.id ? chatModel.modelId : undefined) ??
    group?.models[0] ??
    catalog?.roles.answers;

  const saveKey = async (event: FormEvent) => {
    event.preventDefault();
    const apiKey = key.text;
    if (apiKey === "" || key.stray || !someModel || keyCheck.blocked) return;
    setSaving(true);
    setKeyError(null);
    try {
      const saved = await core.saveChatProvider({
        kind: provider.kind,
        ...(isPreset(catalog) ? { catalogId: catalog.id } : {}),
        ...(provider.endpoint ? { endpoint: provider.endpoint } : {}),
        ...(fieldValue ? { endpointValue: fieldValue } : {}),
        ...(provider.kind === "openai-compatible" && provider.baseUrl
          ? { baseUrl: provider.baseUrl }
          : {}),
        apiKey,
        modelId: someModel,
        keepDefault: true,
      });
      key.clear();
      setResult(null);
      setNotChecked(saved.service !== null && localOnly);
      clearModelFailure(saved.id);
      if (refused) useKeyRefusals.getState().saved(saved);
    } catch (failure) {
      setKeyError(errorMessage(failure, t));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const before = useAppStore.getState().settings?.user;
    const held = (choice: ChatModelChoice | null | undefined) => choice?.providerId === provider.id;
    try {
      await core.deleteChatProvider(provider.id);
      const after = (await core.getSettings()).user;
      onRemoved({
        provider: name,
        ...(held(before?.chatModel) && { answers: after.chatModel }),
        automatic: held(before?.quickTasksModel) || held(before?.imageModel),
      });
    } catch (failure) {
      useAppStore.getState().reportError(failure);
    }
  };

  const setInMenu = async (modelId: string, inMenu: boolean) => {
    try {
      await core.setChatModelInMenu({ providerId: provider.id, modelId, inMenu });
    } catch (failure) {
      useAppStore.getState().reportError(failure);
    }
    changed();
  };

  const regions = catalog && catalog.endpoints.length > 1 ? catalog.endpoints : [];
  // A hosted provider is named by its region; a server the User runs, by its address.
  const address = fieldValue ?? (catalog?.endpoints.length ? null : provider.baseUrl);

  return (
    <section
      data-testid="provider-page"
      data-provider-id={provider.id}
      className="flex flex-col gap-5"
    >
      <SettingsBackLink label={t("settings.pages.models")} testId="models-back" onBack={onBack} />
      <header className="flex items-start gap-3">
        <ProviderLogo id={logoIdOf(provider)} large />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h4
            data-testid="provider-page-title"
            className="truncate text-[17px] leading-6 font-semibold text-ink"
            title={name}
          >
            {name}
          </h4>
          {regions.length > 0 && (
            <label className="flex items-center gap-2 text-[13px] leading-5 text-ink-secondary">
              {t("providers.form.region")}
              <select
                data-testid="provider-page-region"
                value={endpoint?.id ?? ""}
                onChange={(event) => onRegion(event.target.value)}
                className={`${fieldClass} h-7 w-auto py-0`}
              >
                {regions.map((each) => (
                  <option key={each.id} value={each.id}>
                    {each.label[words]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {address && (
            <span
              data-testid="provider-page-address"
              className="truncate text-[13px] leading-5 text-ink-meta"
              title={address}
            >
              {address}
            </span>
          )}
          <ProviderCostLine providerId={provider.id} />
        </div>
        {!plan && (
          <button
            type="button"
            data-testid="provider-remove"
            onClick={() => void remove()}
            className={`${buttonClass} shrink-0`}
          >
            {t("providers.settings.remove")}
          </button>
        )}
      </header>

      {provider.service && provider.kind !== "ollama" && <LocalModeUnavailable />}

      {provider.service ? (
        <ProviderSendsLine
          provider={provider.service.name}
          // Ollama's cloud models run at ollama.com, which its own line covers.
          dataUse={catalog && dataUseOf(catalog, provider.service.id !== OLLAMA_CLOUD.id)}
        />
      ) : (
        <p className="text-[13px] leading-5">
          <OnThisComputer>{t("providers.choice.local")}</OnThisComputer>
        </p>
      )}

      <form onSubmit={(event) => void saveKey(event)} className="flex flex-col gap-1">
        {takesKey && (
          <label htmlFor={`${id}-key`} className={fieldLabelClass}>
            {catalog?.apiKey === "required"
              ? t("providers.form.apiKey")
              : t("providers.form.apiKeyOptional")}
          </label>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {takesKey && (
            <input
              id={`${id}-key`}
              ref={keyField}
              type="password"
              data-testid="provider-page-key"
              value={key.apiKey}
              placeholder={provider.hasApiKey ? t("models.providers.keySaved") : ""}
              onChange={(event) => key.type(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={key.stray ? true : undefined}
              aria-describedby={
                key.stray ? `${id}-stray` : refusedHere ? `${id}-refused` : undefined
              }
              className={`${fieldClass} min-w-0 flex-1 basis-56`}
            />
          )}
          {key.text !== "" ? (
            <button
              type="submit"
              data-testid="provider-page-save-key"
              disabled={saving || !someModel || key.stray !== null || keyCheck.blocked}
              className={buttonClass}
            >
              {t("models.provider.saveKey")}
            </button>
          ) : (
            <button
              type="button"
              data-testid="provider-test"
              disabled={testing}
              onClick={() => void test()}
              className={buttonClass}
            >
              {testing ? t("models.provider.testing") : t("models.provider.test")}
            </button>
          )}
          {takesKey && keyUrl && (
            <a
              href={keyUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="provider-page-get-key"
              className="text-[13px] leading-5 text-accent underline-offset-2 hover:underline"
            >
              {t("models.provider.getKey")} ↗
            </a>
          )}
        </div>
        {key.stray && <KeyCharacterLine id={`${id}-stray`} stray={key.stray} />}
        <KeyCheckLine
          check={keyCheck.check}
          provider={name}
          nameOf={(catalogId) => keyProviderName(catalogId, t, language)}
          onAnyway={() => keyCheck.agree()}
        />
        {refusedHere && refused && <KeyRefusedLine id={`${id}-refused`} refused={refused} />}
        {notChecked && localOnly && key.text === "" && <KeyNotCheckedLine provider={name} />}
        {keyError && (
          <p
            role="alert"
            data-testid="provider-page-key-error"
            className={`${errorTextClass} mt-1`}
          >
            <ProblemMark />
            {keyError}
          </p>
        )}
        {(catalog?.notes ?? []).map((note) => (
          <span key={note.en} data-testid="provider-note" className={hintClass}>
            {note[words]}
          </span>
        ))}
        <TestLine provider={provider} name={name} result={result} />
      </form>

      {group && (
        <ModelsList
          group={group}
          name={name}
          defaultModel={chatModel?.providerId === provider.id ? chatModel.modelId : null}
          onToggle={(modelId, inMenu) => void setInMenu(modelId, inMenu)}
        />
      )}
      {group && (
        <OtherModels
          group={group}
          open={otherOpen}
          onOpen={setOtherOpen}
          onToggle={(modelId, inMenu) => void setInMenu(modelId, inMenu)}
        />
      )}
      <AddModelId
        onAdd={async (modelId) => {
          await setInMenu(modelId, true);
          setOtherOpen(true);
        }}
        taken={[...(group?.models ?? []), ...(group?.hidden ?? [])]}
      />
    </section>
  );
}

function TestLine({
  provider,
  name,
  result,
}: {
  provider: ChatProvider;
  name: string;
  result: ProviderTestResult | null;
}) {
  const t = useT();
  const nameOf = useModelNames();
  if (!result) return null;
  if (result.ok) {
    return (
      <p data-testid="provider-test-result" role="status" className={`${successTextClass} mt-1`}>
        {t("models.provider.works", {
          model: nameOf(result.modelId, provider.id).name,
          seconds: (result.ms / 1_000).toFixed(1),
        })}
      </p>
    );
  }
  const line =
    result.modelId === null && result.step === "answer"
      ? t("models.provider.test.noModels", { provider: name })
      : result.step === "list" && result.error.kind === "model"
        ? t("models.provider.test.listNotFound")
        : undefined;
  return (
    <div data-testid="provider-test-result" className="mt-1">
      <TestResult
        result={{ ok: false, error: result.error }}
        model={result.modelId ? nameOf(result.modelId, provider.id).name : ""}
        {...(line && { line })}
      />
    </div>
  );
}

function ModelsList({
  group,
  name,
  defaultModel,
  onToggle,
}: {
  group: ChatModelGroup;
  name: string;
  defaultModel: string | null;
  onToggle(modelId: string, inMenu: boolean): void;
}) {
  const t = useT();
  const language = useLanguage();
  const nameOf = useModelNames();
  const { prices } = group;
  const priced = group.offered.some((id) => group.about[id]?.cost?.kind === "estimate");
  if (group.offered.length === 0) return null;
  return (
    <section data-testid="provider-models" className="flex flex-col gap-1">
      <h5 className="text-[13px] leading-5 font-semibold text-ink">
        {t("models.provider.models")}
      </h5>
      <table className="w-full table-fixed border-collapse text-left">
        <thead>
          <tr className="text-[12px] leading-4 text-ink-meta">
            <th className="pb-1 font-normal">{t("models.provider.model")}</th>
            <th data-testid="provider-cost-head" className="w-[38%] pb-1 font-normal">
              {t("models.provider.cost")}
              {prices && priced && (
                <>
                  {" · "}
                  <a
                    href={prices.url}
                    target="_blank"
                    rel="noreferrer"
                    data-testid="provider-pricing"
                    className="underline underline-offset-2 hover:text-ink"
                  >
                    {t("models.provider.pricing")} ↗
                  </a>
                </>
              )}
            </th>
            <th className="w-[5.5rem] pb-1 text-right font-normal">
              {t("models.provider.inMenu")}
            </th>
          </tr>
        </thead>
        <tbody>
          {group.offered.map((modelId) => {
            const shown = nameOf(modelId, group.provider.id);
            const about = group.about[modelId];
            const abilities = group.unknown.includes(modelId)
              ? t("models.other.group.unknown")
              : abilitiesOf(about, t);
            const isDefault = modelId === defaultModel;
            const checkbox = `${group.provider.id}-${modelId}`;
            return (
              <tr
                key={modelId}
                data-testid="provider-model-row"
                data-model={modelId}
                className="border-t border-rule align-top"
              >
                <td className="py-2 pr-3">
                  <label
                    htmlFor={checkbox}
                    title={shown.id}
                    className="block truncate text-[13px] leading-5 font-semibold text-ink"
                  >
                    {shown.name}
                  </label>
                  {abilities && (
                    <span className="block text-[12px] leading-[18px] text-ink-meta">
                      {abilities}
                    </span>
                  )}
                </td>
                <td className="py-2 pr-3 text-[12px] leading-5 text-ink-secondary">
                  <CostText
                    cost={about?.cost ?? null}
                    provider={name}
                    checked={prices?.checked}
                    language={language}
                  />
                </td>
                <td className="py-2 text-right">
                  <input
                    id={checkbox}
                    type="checkbox"
                    data-testid="provider-model-in-menu"
                    checked={isDefault || !group.hidden.includes(modelId)}
                    disabled={isDefault}
                    title={isDefault ? t("models.provider.isDefault") : t("models.provider.inMenu")}
                    onChange={(event) => onToggle(modelId, event.target.checked)}
                    className="mt-0.5 size-4 accent-ink"
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function CostText({
  cost,
  provider,
  checked,
  language,
}: {
  cost: ModelAbout["cost"];
  provider: string;
  checked: string | undefined;
  language: Language;
}) {
  const t = useT();
  const tipId = useId();
  if (!cost) return null;
  if (cost.kind === "free")
    return <span data-testid="provider-model-cost">{t("models.provider.cost.free")}</span>;
  if (cost.kind === "plan")
    return <span data-testid="provider-model-cost">{t("models.provider.cost.plan")}</span>;
  const tip =
    checked &&
    t("models.provider.cost.tip", {
      provider,
      date: formatDate(checked, language, { timeZone: "UTC" }),
    });
  return (
    <>
      <span
        data-testid="provider-model-cost"
        title={tip || undefined}
        // Reached by Tab too, so where the estimate comes from isn't for the mouse alone.
        tabIndex={tip ? 0 : undefined}
        aria-describedby={tip ? tipId : undefined}
        className="rounded-sm"
      >
        {t("models.provider.cost.estimate", { amount: formatMoney(cost, language) })}
      </span>
      {tip && (
        <span id={tipId} className="sr-only">
          {tip}
        </span>
      )}
    </>
  );
}

function AddModelId({
  onAdd,
  taken,
}: {
  onAdd(modelId: string): Promise<void>;
  taken: readonly string[];
}) {
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);
  const modelId = value.trim();
  if (!open) {
    return (
      <button
        type="button"
        data-testid="provider-add-model"
        onClick={() => setOpen(true)}
        className={`${buttonClass} self-start`}
      >
        {t("models.provider.addModel")}
      </button>
    );
  }
  return (
    <form
      data-testid="provider-add-model-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (modelId === "" || taken.includes(modelId)) return;
        void onAdd(modelId).then(() => {
          setValue("");
          setOpen(false);
        });
      }}
      className="flex flex-wrap items-center gap-2"
    >
      <label htmlFor={id} className="sr-only">
        {t("providers.form.modelId")}
      </label>
      <input
        id={id}
        ref={field}
        data-testid="provider-add-model-id"
        value={value}
        placeholder={t("providers.form.modelId")}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          // Esc puts the field away before it closes Settings.
          event.preventDefault();
          setValue("");
          setOpen(false);
        }}
        spellCheck={false}
        autoComplete="off"
        className={`${fieldClass} min-w-0 flex-1 basis-56`}
      />
      <button
        type="submit"
        data-testid="provider-add-model-save"
        disabled={modelId === "" || taken.includes(modelId)}
        className={buttonClass}
      >
        {t("models.provider.add")}
      </button>
    </form>
  );
}

/**
 * What a provider billed per token cost this month, in its own currency
 * ("This month: $3.20 spent"), once it has been used. A plan's line is in its
 * own section, and a model on this computer costs nothing.
 */
function ProviderCostLine({ providerId }: { providerId: string }) {
  const t = useT();
  const language = useLanguage();
  const summary = useCostSummary("models");
  const used = summary?.providers.find(
    (each) => each.providerId === providerId && each.billing === "per-token",
  );
  if (!used) return null;
  const spent = formatSpent(used.spent, t, language);
  const setAside = setAsideText(used.setAside, t, language);
  const tokens = new Intl.NumberFormat(language).format(used.unpricedTokens);
  return (
    <span data-testid="chat-provider-cost" className="text-[13px] leading-5 text-ink-meta">
      {spent ? t("cost.provider.thisMonth", { spent }) : t("cost.provider.unpriced", { tokens })}
      {setAside && (
        <>
          {" · "}
          <span data-testid="chat-provider-set-aside" title={t("cost.setAside.tip")}>
            {setAside}
          </span>
        </>
      )}
    </span>
  );
}
