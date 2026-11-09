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
import { formatSpent, joinMeta, perHundredAnswers, setAsideText } from "../../cost";
import { errorMessage } from "../../errors";
import { useLanguage, useT } from "../../i18n";
import { type KeyRefusal, useKeyRefusals } from "../../keyRefusals";
import { clearModelFailure } from "../../modelHealth";
import { useModelNames } from "../../modelNames";
import { useAppStore } from "../../store";
import { KeyCharacterLine } from "../KeyCharacterLine";
import { PlusLineIcon, TrashLineIcon } from "../lineIcons";
import { OnThisComputer } from "../OnThisComputer";
import { ProblemMark } from "../ProblemLine";
import { SettingsBackLink } from "../SettingsBackLink";
import { useCostSummary } from "../SpendingCapSettings";
import { SettingsPopUpRow } from "../settings/PopUpButton";
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowAction,
  SettingsSection,
  SettingsSwitch,
} from "../settings/SettingsGroup";
import {
  buttonStyle,
  errorTextClass,
  fieldClass,
  hintClass,
  rowFieldClass,
  successTextClass,
} from "../ui";
import { ChatGptPlanRow } from "./ChatGptPlanSettings";
import { ClaudePlanRow } from "./ClaudePlan";
import { CopilotPlanRow } from "./CopilotPlan";
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
  const keyLabel =
    catalog?.apiKey === "required"
      ? t("providers.form.apiKey")
      : t("providers.form.apiKeyOptional");
  const notes = catalog?.notes ?? [];

  const action =
    key.text !== "" ? (
      <button
        type="submit"
        data-testid="provider-page-save-key"
        disabled={saving || !someModel || key.stray !== null || keyCheck.blocked}
        className={buttonStyle("secondary", "sm")}
      >
        {t("models.provider.saveKey")}
      </button>
    ) : (
      <button
        type="button"
        data-testid="provider-test"
        disabled={testing}
        onClick={() => void test()}
        className={buttonStyle("secondary", "sm")}
      >
        {testing ? t("models.provider.testing") : t("models.provider.test")}
      </button>
    );

  return (
    <section
      data-testid="provider-page"
      data-provider-id={provider.id}
      className="flex flex-col gap-6"
    >
      <SettingsBackLink label={t("settings.pages.ai")} testId="models-back" onBack={onBack} />
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
      </header>

      {provider.service && provider.kind !== "ollama" && <LocalModeUnavailable />}

      {plan && (
        <SettingsGroup role="list">
          {provider.kind === "chatgpt" ? (
            <ChatGptPlanRow />
          ) : provider.kind === "claude-account" ? (
            <ClaudePlanRow />
          ) : (
            <CopilotPlanRow />
          )}
        </SettingsGroup>
      )}

      <form onSubmit={(event) => void saveKey(event)}>
        <SettingsSection
          help={
            <>
              {provider.service ? (
                <ProviderSendsLine
                  provider={provider.service.name}
                  // Ollama's cloud models run at ollama.com, which its own line covers.
                  dataUse={catalog && dataUseOf(catalog, provider.service.id !== OLLAMA_CLOUD.id)}
                />
              ) : (
                <div>
                  <OnThisComputer>{t("providers.choice.local")}</OnThisComputer>
                </div>
              )}
              {notes.map((note) => (
                <span key={note.en} data-testid="provider-note" className={hintClass}>
                  {note[words]}
                </span>
              ))}
            </>
          }
        >
          <SettingsGroup>
            {regions.length > 0 && (
              <SettingsPopUpRow
                label={t("providers.form.region")}
                value={endpoint?.id ?? ""}
                options={regions.map((each) => ({ value: each.id, label: each.label[words] }))}
                onChange={(region) => {
                  if (region !== endpoint?.id) onRegion(region);
                }}
                buttonTestId="provider-page-region"
              />
            )}
            {takesKey ? (
              <SettingsRow
                label={keyLabel}
                htmlFor={`${id}-key`}
                control={
                  <>
                    {keyUrl && (
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
                    {action}
                  </>
                }
              >
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
                  className={`${fieldClass} block w-full`}
                />
                {key.stray && <KeyCharacterLine id={`${id}-stray`} stray={key.stray} />}
                <KeyCheckLine
                  check={keyCheck.check}
                  provider={name}
                  nameOf={(catalogId) => keyProviderName(catalogId, t, language)}
                  onAnyway={() => keyCheck.agree()}
                />
                {refusedHere && refused && (
                  <KeyRefusedLine id={`${id}-refused`} refused={refused} />
                )}
                {provider.apiKeyUnreadable && (
                  <span data-testid="provider-key-unreadable" role="status" className={hintClass}>
                    {t("providers.form.apiKeyUnreadable")}
                  </span>
                )}
                {notChecked && localOnly && key.text === "" && (
                  <KeyNotCheckedLine provider={name} />
                )}
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
                <TestLine provider={provider} name={name} result={result} />
              </SettingsRow>
            ) : (
              <SettingsRow label={t("providers.form.test")} control={action}>
                <TestLine provider={provider} name={name} result={result} />
              </SettingsRow>
            )}
          </SettingsGroup>
        </SettingsSection>
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
      {!plan && (
        <SettingsSection>
          <SettingsGroup>
            <SettingsRowAction
              label={t("providers.settings.remove")}
              testId="provider-remove"
              onClick={() => void remove()}
              trailing={<TrashLineIcon className="size-4 shrink-0 text-ink-placeholder" />}
            />
          </SettingsGroup>
        </SettingsSection>
      )}
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
    <SettingsSection
      title={t("models.provider.models")}
      titleAs="h5"
      testId="provider-models"
      help={
        <>
          <p>{t("models.provider.inMenu.help")}</p>
          <p data-testid="provider-cost-head">
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
          </p>
        </>
      }
    >
      <SettingsGroup role="group" aria-label={t("models.provider.inMenu")}>
        {group.offered.map((modelId) => {
          const shown = nameOf(modelId, group.provider.id);
          const about = group.about[modelId];
          const abilities = group.unknown.includes(modelId)
            ? t("models.other.group.unknown")
            : abilitiesOf(about, t);
          const isDefault = modelId === defaultModel;
          const checkbox = `${group.provider.id}-${modelId}`;
          return (
            <SettingsRow
              key={modelId}
              data-testid="provider-model-row"
              data-model={modelId}
              label={
                <span title={shown.id} className="break-words">
                  {shown.name}
                </span>
              }
              htmlFor={checkbox}
              detailId={`${checkbox}-detail`}
              detail={
                (abilities || isDefault) && (
                  <>
                    {abilities && <div>{abilities}</div>}
                    {isDefault && <div>{t("models.provider.isDefault")}</div>}
                  </>
                )
              }
              control={
                <>
                  <span className="text-[12px] leading-5 text-ink-meta">
                    <CostText
                      cost={about?.cost ?? null}
                      provider={name}
                      checked={prices?.checked}
                      language={language}
                    />
                  </span>
                  <SettingsSwitch
                    id={checkbox}
                    testId="provider-model-in-menu"
                    checked={isDefault || !group.hidden.includes(modelId)}
                    disabled={isDefault}
                    describedBy={isDefault ? `${checkbox}-detail` : undefined}
                    onChange={(inMenu) => onToggle(modelId, inMenu)}
                  />
                </>
              }
            />
          );
        })}
      </SettingsGroup>
    </SettingsSection>
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
  const about = perHundredAnswers(cost, t, language);
  if (!about) return null;
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
        {about}
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
      <SettingsSection>
        <SettingsGroup>
          <SettingsRowAction
            label={t("models.provider.addModel")}
            testId="provider-add-model"
            onClick={() => setOpen(true)}
            trailing={<PlusLineIcon className="size-4 shrink-0 text-ink-placeholder" />}
          />
        </SettingsGroup>
      </SettingsSection>
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
    >
      <SettingsSection>
        <SettingsGroup>
          <SettingsRow
            label={t("providers.form.modelId")}
            htmlFor={id}
            control={
              <>
                <input
                  id={id}
                  ref={field}
                  data-testid="provider-add-model-id"
                  value={value}
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
                  className={`${rowFieldClass} w-56`}
                />
                <button
                  type="submit"
                  data-testid="provider-add-model-save"
                  disabled={modelId === "" || taken.includes(modelId)}
                  className={buttonStyle("secondary", "sm")}
                >
                  {t("models.provider.add")}
                </button>
              </>
            }
          />
        </SettingsGroup>
      </SettingsSection>
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
  const summary = useCostSummary("ai");
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
