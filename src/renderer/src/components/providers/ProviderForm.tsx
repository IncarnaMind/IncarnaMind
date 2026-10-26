import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type {
  ChatProvider,
  ConnectionTestResult,
  SecretStorageStatus,
  TestChatConnectionInput,
} from "../../../../core/api";
import type { Language } from "../../../../core/language";
import type { DataUse } from "../../../../core/providers/catalog";
import { catalogMenu } from "../../../../core/providers/catalog";
import { serviceOfKey } from "../../../../core/providers/catalog/keyForms";
import {
  catalogProvider,
  dataUseOf,
  endpointOf,
  fieldAccepts,
  fieldUrl,
  isPreset,
  keyProviderGroups,
  kindOfCatalogId,
  untestedForCitations,
} from "../../../../core/providers/catalog/providers";
import type { Endpoint, Role } from "../../../../core/providers/catalog/types";
import { serviceForUrl } from "../../../../core/providers/service";
import { checkApiKey } from "../../../../shared/apiKey";
import type { MessageKey } from "../../../../shared/i18n";
import { gap } from "../../../../shared/i18n/join";
import { modelName } from "../../../../shared/modelName";
import { core } from "../../core";
import { dayOf } from "../../dates";
import { errorMessage } from "../../errors";
import { useLanguage, useT } from "../../i18n";
import type { KeyRefusal } from "../../keyRefusals";
import { useAppStore } from "../../store";
import { KeyCharacterLine } from "../KeyCharacterLine";
import { MetaLine } from "../MetaLine";
import { LineAction, type ProblemAction, ProblemMark } from "../ProblemLine";
import {
  buttonClass,
  errorTextClass,
  fieldLabelClass,
  hintClass,
  inputClass,
  noticeClass,
  primaryButtonClass,
  successTextClass,
} from "../ui";
import { KeyHelp } from "./KeyHelp";
import { KeyCheckLine, useKeyCheck } from "./keyCheck";
import { LocalServerLine, useLocalServer } from "./LocalServerLine";
import { SendsLine } from "./SendsLine";
import {
  defaultRegion,
  keyProviderName,
  regionName,
  regionsListed,
  testErrorKey,
  useProviderKey,
} from "./shared";

type CatalogId = string;

/**
 * Prefilled when a provider is picked: its Answers model in the catalog, none
 * for a server. The User can type any model their account has.
 */
const suggestedModel = (kind: CatalogId): string => catalogProvider(kind)?.roles.answers ?? "";

/** The providers shown as one row of choices, in the order the interface's language puts first; the rest are under "More…". */
const ROW: Readonly<Record<Language, readonly CatalogId[]>> = {
  en: ["anthropic", "openai", "google", "deepseek", "kimi", "qwen"],
  "zh-CN": ["deepseek", "qwen", "kimi", "glm", "anthropic", "openai", "google"],
};

/** What a provider's address field holds when it is chosen. */
const fieldDefault = (kind: CatalogId): string => {
  const provider = catalogProvider(kind);
  return (provider && endpointOf(provider, "")?.field?.default) ?? "";
};

/** The "Another model…" choice of the model list. */
const OTHER_MODEL = "\u0000other";

const ROLE_HINTS = {
  answers: "providers.form.hint.answers",
  strongest: "providers.form.hint.strongest",
  quickTasks: "providers.form.hint.quickTasks",
  images: "providers.form.hint.images",
} as const satisfies Record<Exclude<Role, "tagging">, MessageKey>;

function roleHint(kind: CatalogId, modelId: string): MessageKey | undefined {
  const roles = catalogProvider(kind)?.roles;
  const role = (["answers", "strongest", "quickTasks", "images"] as const).find(
    (each) => roles?.[each] === modelId,
  );
  return role && ROLE_HINTS[role];
}

/** An OpenAI-compatible server's address as the User typed it, by its host. */
const hostOf = (url: string): string | null => {
  try {
    return new URL(url.trim()).host || null;
  } catch {
    return null;
  }
};

const sameServer = (
  provider: ChatProvider,
  kind: CatalogId,
  endpoint: string,
  baseUrl: string,
  fieldAddress: string | null,
) =>
  (provider.catalogId ?? provider.kind) === kind &&
  (fieldAddress !== null
    ? provider.baseUrl === fieldAddress
    : kind === "openai-compatible"
      ? provider.baseUrl === baseUrl.trim().replace(/\/+$/, "")
      : provider.endpoint === endpoint);

function ChoiceChip({
  name,
  value,
  checked,
  onChange,
  children,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange(): void;
  children: ReactNode;
}) {
  return (
    <label
      className={`inline-flex h-7 cursor-pointer items-center rounded-md border px-2.5 text-[13px] has-[:checked]:border-ink has-[:checked]:bg-wash has-[:focus-visible]:outline-2 ${
        checked ? "border-ink font-semibold text-ink" : "border-rule text-ink-secondary"
      }`}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        className="sr-only"
      />
      {children}
    </label>
  );
}

/**
 * Pick a provider, paste a key (and a URL for an OpenAI-compatible server),
 * keep the model its line names or Change it, test the connection,
 * and use it. No provider is preselected.
 */
export function ProviderForm({
  providers,
  onSaved,
  initialKind,
  only,
  refused = null,
  standalone = false,
  keepDefault = false,
  initialEndpoint = null,
  initialKey = "",
}: {
  /** Saved providers, to tell the User when a key is already stored. */
  providers: readonly ChatProvider[];
  /** `keyNotChecked`: Local mode stopped the key's test, so it was saved unchecked. */
  onSaved(provider: ChatProvider, keyNotChecked?: boolean): void;
  /** The provider chosen when the form opens: the one the User came from. DeepSeek in Chinese, else Anthropic. */
  initialKind?: CatalogId;
  /** The one provider this form sets up, with no chips to change it: a local server's row. */
  only?: CatalogId;
  /** A key its provider refused: the form opens on that provider, says so by the key, and focuses it. */
  refused?: KeyRefusal | null;
  /** The setup card's key step: the form is titled with the company picked, and opens on the key. */
  standalone?: boolean;
  /** The default model stays as it is, so while there is one the form asks for no model. */
  keepDefault?: boolean;
  initialEndpoint?: string | null;
  /** The key the User typed where the service wasn't named, kept as the service is picked. */
  initialKey?: string;
}) {
  const t = useT();
  const id = useId();
  const language = useLanguage();
  const first: CatalogId =
    only ?? refused?.catalogId ?? initialKind ?? (language === "zh-CN" ? "deepseek" : "anthropic");
  const [kind, setKind] = useState<CatalogId | null>(first);
  const [otherModel, setOtherModel] = useState(
    refused !== null && !catalogMenu(refused.catalogId, refused.endpoint).includes(refused.modelId),
  );
  const [moreOpen, setMoreOpen] = useState(false);
  /** The region of a provider that has several; its first otherwise. */
  const [endpointId, setEndpointId] = useState(
    refused?.endpoint ?? initialEndpoint ?? defaultRegion(first, language),
  );
  const key = useProviderKey(initialKey);
  const { apiKey } = key;
  const [fieldValue, setFieldValue] = useState(() => fieldDefault(first));
  const [baseUrl, setBaseUrl] = useState("");
  const [modelId, setModelId] = useState(refused?.modelId ?? suggestedModel(first));
  const [busy, setBusy] = useState<"saving" | null>(null);
  const [test, setTest] = useState<ConnectionTestResult | null>(null);
  const [notChecked, setNotChecked] = useState(false);
  // The region a result is about: the form may be on another by the time a slow test answers.
  const [testedRegion, setTestedRegion] = useState<string | null>(null);
  const hasDefault = useAppStore((state) => (state.settings?.user.chatModel ?? null) !== null);
  const [error, setError] = useState<string | null>(null);
  const [secretStorage, setSecretStorage] = useState<SecretStorageStatus | null>(null);
  const [switchedFrom, setSwitchedFrom] = useState<{ kind: CatalogId; region: string } | null>(
    null,
  );

  useEffect(() => {
    core.getSecretStorage().then(setSecretStorage, () => undefined);
  }, []);

  const { main, more } = keyProviderGroups();
  const offered = [...main, ...more];
  const refusedHere = refused !== null && refused.catalogId === kind;
  const keyField = useRef<HTMLInputElement>(null);
  const modelPicker = useRef<HTMLSelectElement>(null);
  const modelText = useRef<HTMLInputElement>(null);
  const changeModel = useRef<HTMLButtonElement>(null);
  /** Also opened, without Change, when a failure asks for another model. */
  const [modelOpen, setModelOpen] = useState(false);
  const showModelPicker = () => {
    flushSync(() => setModelOpen(true));
    modelPicker.current?.focus();
  };
  /** Opens the model list where it is, or puts the cursor in the field a model is typed in. */
  const openModelPicker = () => {
    showModelPicker();
    if (modelPicker.current) modelPicker.current.showPicker?.();
    else modelText.current?.focus();
  };
  // A refused key's field is where "Check the key" leads: in view, focused, and under "More
  // providers" opened when its provider is listed there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, as the form opens on it.
  useEffect(() => {
    if (!refused) {
      if (standalone) keyField.current?.focus();
      return;
    }
    if (more.includes(refused.catalogId)) setMoreOpen(true);
    keyField.current?.scrollIntoView({ block: "center" });
    keyField.current?.focus({ preventScroll: true });
  }, []);
  const outcome = useRef<HTMLDivElement>(null);
  const keyLine = useRef<HTMLDivElement>(null);
  const regionGroup = useRef<HTMLDivElement>(null);
  // The setup card keeps the action row at its foot, which would leave a failure under it out of sight.
  useEffect(() => {
    if (test?.ok === false || error) outcome.current?.scrollIntoView({ block: "nearest" });
  }, [test, error]);
  const catalog = kind ? catalogProvider(kind) : undefined;
  const local = catalog?.group === "local";
  const server = useLocalServer(local ? kind : null);
  const words = language === "zh-CN" ? "zh" : "en";
  const endpoint = catalog ? endpointOf(catalog, endpointId) : undefined;
  const field = endpoint?.field;
  const fieldUsed = (fieldValue || field?.choices?.[0]?.value || "").trim();
  const fieldAddress =
    endpoint && field && fieldAccepts(field, fieldUsed) ? fieldUrl(endpoint, fieldUsed) : null;
  // An address elsewhere is a service like any other: it says what goes to it, and choosing it is the consent.
  const away = local && fieldAddress !== null && serviceForUrl(fieldAddress) !== null;
  const saved = kind
    ? providers.find((each) => sameServer(each, kind, endpoint?.id ?? "", baseUrl, fieldAddress))
    : undefined;
  const keyRequired = catalog?.apiKey === "required";
  const hasKey = key.text !== "" || Boolean(saved?.hasApiKey);
  const keyBlocked = key.text !== "" && secretStorage !== null && !secretStorage.canSave;
  const missing: MessageKey | null =
    kind === null
      ? null
      : kind === "openai-compatible" && baseUrl.trim() === ""
        ? "providers.form.needsAddress"
        : field && fieldAddress === null
          ? "providers.form.needsField"
          : local && server.status?.running === false
            ? "providers.form.needsServer"
            : keyRequired && !hasKey
              ? "providers.form.needsKey"
              : modelId.trim() === ""
                ? "providers.form.needsModel"
                : null;
  const complete =
    kind !== null &&
    missing === null &&
    key.stray === null &&
    (!local || server.status?.running === true);
  const keyCheck = useKeyCheck(
    kind !== null && kind !== "openai-compatible" && !local ? kind : null,
    apiKey,
  );
  const keyLineShown = keyCheck.blocked || switchedFrom !== null;
  // The card's foot would cover the line under it, and the button it explains is grey.
  useEffect(() => {
    if (keyLineShown) keyLine.current?.scrollIntoView({ block: "nearest" });
  }, [keyLineShown]);
  const shortName = (option: CatalogId) =>
    option === "qwen"
      ? t("providers.kind.short.qwen")
      : option === "deepseek"
        ? t("providers.kind.short.deepseek")
        : option === "kimi"
          ? t("providers.kind.short.kimi")
          : keyProviderName(option, t, language);

  const chip = (option: CatalogId) => (
    <ChoiceChip
      key={option}
      name={`${id}-kind`}
      value={option}
      checked={kind === option}
      onChange={() => choose(option, { keepKey: keyCheck.blocked })}
    >
      {shortName(option)}
    </ChoiceChip>
  );

  const choose = (
    next: CatalogId,
    {
      keepKey = false,
      from = null,
      region,
    }: {
      keepKey?: boolean;
      from?: { kind: CatalogId; region: string } | null;
      region?: string;
    } = {},
  ) => {
    // A key typed for one provider is never sent to another, unless it was pasted for this one.
    if (next !== kind && !keepKey) key.clear();
    setKind(next);
    setSwitchedFrom(from);
    if (more.includes(next) || !ROW[language].includes(next)) setMoreOpen(true);
    setEndpointId(region ?? defaultRegion(next, language));
    setFieldValue(fieldDefault(next));
    setModelId(suggestedModel(next));
    setOtherModel(false);
    setModelOpen(false);
    setTest(null);
    setNotChecked(false);
    setError(null);
  };

  const typeKey = (value: string) => {
    key.type(value, baseUrl);
    setNotChecked(false);
    const { key: given, stray } = checkApiKey(value);
    // Spaces around the same key change nothing, and leave an agreement to use it where it was.
    if (given === key.text) return;
    // A refusal is about the key that was sent: a changed key is not refused yet.
    setTest(null);
    setError(null);
    setSwitchedFrom(null);
    const named =
      only || kind === null || kind === "openai-compatible" || local || stray !== null
        ? null
        : serviceOfKey(given);
    if (named !== null && kind !== null && named !== kind && offered.includes(named)) {
      choose(named, { keepKey: true, from: { kind, region: endpointId } });
    }
  };

  useEffect(() => {
    const models = server.status?.running ? server.status.models : [];
    const [first] = models;
    if (first !== undefined) setModelId((current) => (models.includes(current) ? current : first));
  }, [server.status]);

  // A key already typed stays: the User's pick decides its host, and nothing is sent until they send it.
  const chooseRegion = (region: string) => {
    setEndpointId(region);
    setModelId(modelIn(region));
    setTest(null);
    setError(null);
  };

  // The one way a key reaches the other region's host, by the User pressing the refusal's button.
  const sendTo = (region: Endpoint) => {
    flushSync(() => chooseRegion(region.id));
    regionGroup.current?.querySelector<HTMLInputElement>("input:checked")?.focus();
    void run(region);
  };

  const changeField = (value: string) => {
    setFieldValue(value);
    setTest(null);
    setError(null);
  };

  const modelIn = (region: string) =>
    otherModel || !kind || catalogMenu(kind, region).includes(modelId)
      ? modelId
      : suggestedModel(kind);

  const input = (on: Endpoint | undefined = endpoint): TestChatConnectionInput | null => {
    if (!kind) return null;
    return {
      kind: kindOfCatalogId(kind),
      ...(isPreset(catalogProvider(kind)) && { catalogId: kind }),
      modelId: (on && on !== endpoint ? modelIn(on.id) : modelId).trim(),
      ...(on ? { endpoint: on.id } : {}),
      ...(field ? { endpointValue: fieldUsed } : {}),
      ...(kind === "openai-compatible" ? { baseUrl: baseUrl.trim() } : {}),
      ...(key.text ? { apiKey: key.text } : {}),
    };
  };

  /** One button: the key is tested as it saves, and a failure stays here, in plain words. */
  const run = async (on?: Endpoint) => {
    const request = input(on);
    if (!request) return;
    setBusy("saving");
    setError(null);
    setTest(null);
    setNotChecked(false);
    setTestedRegion((on ?? endpoint)?.id ?? null);
    try {
      const result = await core.testChatConnection(request);
      const notChecked = !result.ok && result.error.kind === "local-mode";
      if (!result.ok && !notChecked) {
        setTest(result);
        return;
      }
      const provider = await core.saveChatProvider(
        keepDefault ? { ...request, keepDefault } : request,
      );
      key.clear();
      setNotChecked(notChecked);
      onSaved(provider, notChecked);
    } catch (failure) {
      setError(errorMessage(failure, t));
    } finally {
      setBusy(null);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!keyCheck.blocked) void run();
  };

  const acceptPlainText = async () => {
    try {
      setSecretStorage(await core.acceptPlainTextSecretStorage());
    } catch (failure) {
      setError(errorMessage(failure, t));
    }
  };

  const siteOf = (url: string | undefined) => {
    try {
      return url ? new URL(url).host : "";
    } catch {
      return "";
    }
  };
  const site = siteOf(endpoint?.keyUrl ?? catalog?.keyUrl);
  const providerName = kind ? keyProviderName(kind, t, language) : "";
  const refusedOn =
    catalog && catalog.endpoints.length > 1 ? endpointOf(catalog, testedRegion) : undefined;
  const badKeyLine = refusedOn
    ? t("providers.form.badKeyAt", {
        host: siteOf(refusedOn.baseUrl),
        region: refusedOn.label[words],
        site: siteOf(refusedOn.keyUrl ?? catalog?.keyUrl),
      })
    : t("providers.form.badKey", { provider: providerName, site });
  const otherRegion =
    refusedOn && catalog ? catalog.endpoints.find((each) => each.id !== refusedOn.id) : undefined;
  const sendToWhere =
    otherRegion &&
    t("providers.form.sendTo.aria", {
      region: regionName(otherRegion, t, language),
      host: siteOf(otherRegion.baseUrl),
    });
  const listed = server.status?.running ? server.status.models : [];
  const choices =
    kind && kind !== "openai-compatible" ? (local ? listed : catalogMenu(kind, endpoint?.id)) : [];
  const recommended = choices[0];
  const shownName = (id: string) =>
    modelName(id, { kind: kind ? kindOfCatalogId(kind) : undefined, endpoint: endpoint?.id });
  const optionName = (id: string) => {
    const hint = kind ? roleHint(kind, id) : undefined;
    return hint
      ? t("providers.form.modelHint", { model: shownName(id), hint: t(hint) })
      : shownName(id);
  };
  const example = catalog?.roles.answers;
  const modelLine = !modelOpen && !otherModel && choices.includes(modelId);
  const docsLink = !standalone && catalog?.docsUrl && (
    <a
      href={catalog.docsUrl}
      target="_blank"
      rel="noreferrer"
      data-testid="provider-docs-link"
      className="text-[12px] leading-5 text-ink-meta underline"
    >
      {t("providers.form.modelsAndPrices")} ↗
    </a>
  );
  const untestedReason = untestedForCitations(catalog) && modelId === recommended && (
    <span data-testid="provider-model-reason" className={hintClass}>
      {t("providers.untested")}
    </span>
  );
  const modelIdField = (
    <input
      id={`${id}-model-id`}
      ref={modelText}
      required
      value={modelId}
      onChange={(event) => setModelId(event.target.value)}
      spellCheck={false}
      placeholder={example && t("providers.form.modelExample", { model: example })}
      data-testid="provider-model-text"
      className={inputClass}
    />
  );
  const rowKinds = ROW[language].filter((each) => offered.includes(each));
  // A key that fits no service's prefix may be one the services under More… issue.
  const showMore =
    moreOpen ||
    (!keyCheck.check.ok && keyCheck.check.service === null && key.text.startsWith("sk-"));
  const underMore = offered.filter((each) => !rowKinds.includes(each));

  return (
    <form data-testid="provider-form" onSubmit={submit} className="flex flex-col gap-3">
      {standalone && kind && (
        <h3
          data-testid="provider-form-title"
          className="text-[15px] leading-6 font-semibold text-ink"
        >
          {kind === "openai-compatible"
            ? t("providers.form.title.server")
            : t("providers.form.title", { provider: shortName(kind) })}
        </h3>
      )}
      {!only && (
        <fieldset>
          <legend className="sr-only">{t("providers.form.label")}</legend>
          <div className="flex flex-wrap gap-1">
            {[...rowKinds, ...(showMore ? underMore : [])].map(chip)}
            {underMore.length > 0 && !showMore && (
              <button
                type="button"
                data-testid="provider-more-toggle"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen(true)}
                className={`${buttonClass} h-7 px-2.5`}
              >
                {t("providers.form.moreShort")}
              </button>
            )}
          </div>
        </fieldset>
      )}

      {kind && (
        <>
          {catalog && catalog.endpoints.length > 1 && (
            <div
              ref={regionGroup}
              role="radiogroup"
              aria-labelledby={`${id}-region`}
              data-testid="provider-region"
              className="flex flex-wrap items-center gap-1"
            >
              <span id={`${id}-region`} className="mr-1 text-[13px] leading-5 text-ink-secondary">
                {t("providers.form.region")}
              </span>
              {regionsListed(catalog.endpoints).map((option) => (
                <ChoiceChip
                  key={option.id}
                  name={`${id}-region`}
                  value={option.id}
                  checked={option.id === endpoint?.id}
                  onChange={() => chooseRegion(option.id)}
                >
                  {regionName(option, t, language)}
                </ChoiceChip>
              ))}
            </div>
          )}

          {field && (
            <label htmlFor={`${id}-field`} className={fieldLabelClass}>
              {field.label[words]}
              {field.choices ? (
                <select
                  id={`${id}-field`}
                  data-testid="provider-field"
                  value={fieldUsed}
                  onChange={(event) => changeField(event.target.value)}
                  className={inputClass}
                >
                  {field.choices.map((option) => (
                    <option key={option.value} value={option.value}>
                      {`${option.label[words]} · ${option.value}`}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`${id}-field`}
                  data-testid="provider-field"
                  value={fieldValue}
                  onChange={(event) => changeField(event.target.value)}
                  onBlur={() => local && void server.detect(apiKey, fieldUsed)}
                  autoComplete="off"
                  spellCheck={false}
                  className={inputClass}
                />
              )}
              {field.hint && (
                <span data-testid="provider-field-hint" className={hintClass}>
                  {field.hint[words]}
                </span>
              )}
            </label>
          )}

          {local && (
            <LocalServerLine
              provider={keyProviderName(kind, t, language)}
              status={server.status}
              away={away}
              onCheckAgain={() => void server.detect(apiKey, fieldUsed)}
            />
          )}

          {kind === "openai-compatible" && (
            <label className={fieldLabelClass}>
              {t("providers.form.baseUrl")}
              <input
                type="url"
                required
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                onBlur={() => key.leftAddress(baseUrl)}
                placeholder="https://"
                spellCheck={false}
                className={inputClass}
              />
              <span className={hintClass}>{t("providers.form.baseUrlHint")}</span>
            </label>
          )}

          <label className={fieldLabelClass}>
            {keyRequired ? t("providers.form.apiKey") : t("providers.form.apiKeyOptional")}
            <input
              type="password"
              value={apiKey}
              onChange={(event) => typeKey(event.target.value)}
              onBlur={() => local && key.text !== "" && void server.detect(apiKey, fieldUsed)}
              autoComplete="off"
              spellCheck={false}
              ref={keyField}
              aria-invalid={key.stray ? true : undefined}
              aria-describedby={
                key.stray ? `${id}-stray` : refusedHere ? `${id}-refused` : undefined
              }
              className={inputClass}
            />
            {key.stray && <KeyCharacterLine id={`${id}-stray`} stray={key.stray} />}
            {refusedHere && <KeyRefusedLine id={`${id}-refused`} refused={refused} />}
            {saved?.hasApiKey && (
              <span className={hintClass}>{t("providers.form.apiKeySaved")}</span>
            )}
          </label>
          <div ref={keyLine}>
            {kind && (
              <KeyCheckLine
                check={keyCheck.check}
                provider={shortName(kind)}
                nameOf={shortName}
                pickAbove={!only}
                onAnyway={() => keyCheck.agree()}
                {...(switchedFrom !== null && {
                  from: {
                    name: shortName(switchedFrom.kind),
                    back: () => {
                      choose(switchedFrom.kind, { keepKey: true, region: switchedFrom.region });
                      keyCheck.agree(switchedFrom.kind);
                    },
                  },
                })}
              />
            )}
          </div>
          {catalog && (
            <KeyHelp
              key={`${kind}:${endpoint?.id}`}
              catalog={catalog}
              keyUrl={endpoint?.keyUrl ?? catalog.keyUrl}
              provider={shortName(kind)}
              firstRun={standalone}
            />
          )}

          {secretStorage && !secretStorage.canSave && (
            <SecretStorageNotice status={secretStorage} onAccept={() => void acceptPlainText()} />
          )}

          {keepDefault && hasDefault && choices.length > 0 ? null : choices.length === 0 ? (
            <div>
              <label htmlFor={`${id}-model-id`} className={fieldLabelClass}>
                {t("providers.form.model")}
              </label>
              {modelIdField}
            </div>
          ) : modelLine ? (
            <div>
              <div className="flex items-baseline justify-between gap-3">
                <MetaLine
                  data-testid="provider-model-line"
                  className="text-[13px] leading-5 text-ink-secondary"
                  parts={[
                    t("providers.form.modelLine", { model: shownName(modelId) }),
                    <LineAction
                      key="change"
                      ref={changeModel}
                      action={{
                        label: t("providers.form.change"),
                        ariaLabel: t("providers.form.changeModel"),
                        testId: "provider-model-change",
                        onClick: showModelPicker,
                      }}
                    />,
                  ]}
                />
                {docsLink}
              </div>
              {untestedReason}
            </div>
          ) : (
            <div>
              <div className="flex items-baseline justify-between gap-3">
                <label htmlFor={`${id}-model`} className={fieldLabelClass}>
                  {t("providers.form.model")}
                </label>
                {docsLink}
              </div>
              <select
                id={`${id}-model`}
                ref={modelPicker}
                data-testid="provider-model"
                value={!otherModel && choices.includes(modelId) ? modelId : OTHER_MODEL}
                onKeyDown={(event) => {
                  if (event.key !== "Escape" || otherModel || !choices.includes(modelId)) return;
                  // Esc closes the innermost thing open: the list, back to its line, not the card or Settings.
                  event.preventDefault();
                  event.stopPropagation();
                  flushSync(() => setModelOpen(false));
                  changeModel.current?.focus();
                }}
                onChange={(event) => {
                  const chosen = event.target.value;
                  setOtherModel(chosen === OTHER_MODEL);
                  setModelId(chosen === OTHER_MODEL ? "" : chosen);
                  setTest(null);
                  setError(null);
                }}
                className={inputClass}
              >
                {choices.map((id) => (
                  <option key={id} value={id} title={id}>
                    {optionName(id)}
                  </option>
                ))}
                <option value={OTHER_MODEL}>{t("providers.form.anotherModel")}</option>
              </select>
              {otherModel ? (
                <div className="mt-2">
                  <label htmlFor={`${id}-model-id`} className="sr-only">
                    {t("providers.form.modelId")}
                  </label>
                  {modelIdField}
                  <span className={hintClass}>{t("providers.form.modelIdHint")}</span>
                </div>
              ) : (
                untestedReason
              )}
            </div>
          )}

          {(!local || away) && (
            <ProviderSendsLine
              provider={
                kind === "openai-compatible"
                  ? (hostOf(baseUrl) ?? t("providers.kind.openai-compatible"))
                  : providerName
              }
              dataUse={catalog && dataUseOf(catalog, away)}
            />
          )}
          <div data-setup-foot className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              data-testid="provider-use-key"
              disabled={!complete || keyBlocked || keyCheck.blocked || busy !== null}
              className={primaryButtonClass}
            >
              {busy
                ? t(keyRequired ? "providers.form.checking" : "providers.form.connecting")
                : t(
                    keyRequired
                      ? "providers.form.useKey"
                      : local
                        ? "providers.form.save"
                        : "providers.form.connect",
                  )}
            </button>
            {missing && (
              <span data-testid="provider-use-key-why" className={hintClass}>
                {missing === "providers.form.needsField" && field
                  ? t(missing, { field: field.label[words] })
                  : t(missing, { provider: providerName })}
              </span>
            )}
          </div>

          {notChecked && <KeyNotCheckedLine provider={providerName} />}

          {(test?.ok === false || error) && (
            <div ref={outcome} className="flex flex-col gap-3">
              {test && !test.ok && (
                <TestResult
                  result={test}
                  model={shownName(modelId)}
                  {...(test.error.kind === "auth" && site ? { line: badKeyLine } : {})}
                  {...(test.error.kind === "auth" &&
                    otherRegion && {
                      action: {
                        label: t("providers.form.sendTo", {
                          region: regionName(otherRegion, t, language),
                        }),
                        ariaLabel: sendToWhere,
                        title: sendToWhere,
                        testId: "provider-send-other-region",
                        onClick: () => sendTo(otherRegion),
                      },
                    })}
                  {...(test.error.kind === "data-retention" && {
                    action: {
                      label: t("answer.error.chooseModel"),
                      testId: "connection-test-choose-model",
                      onClick: openModelPicker,
                    },
                  })}
                />
              )}
              {error && (
                <p role="alert" className={errorTextClass}>
                  <ProblemMark />
                  {error}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </form>
  );
}

/** Beside a refused key: who refused it, and when. */
export function KeyRefusedLine({ id, refused }: { id: string; refused: KeyRefusal }) {
  const t = useT();
  const language = useLanguage();
  const provider = keyProviderName(refused.catalogId, t, language);
  const when = refused.at ? dayOf(new Date(refused.at), new Date(), language, t) : null;
  return (
    <span id={id} data-testid="provider-key-refused" role="status" className={hintClass}>
      {when
        ? t("providers.form.keyRefused", { provider, when })
        : t("providers.form.keyRefusedNow", { provider })}
    </span>
  );
}

export function KeyNotCheckedLine({ provider }: { provider: string }) {
  const t = useT();
  return (
    <span data-testid="provider-key-not-checked" role="status" className={hintClass}>
      {t("providers.key.notChecked", { provider })}
    </span>
  );
}

/**
 * Above the button that chooses the chat model's provider: what goes to it.
 * Choosing it is the consent for all of that (ADR-0022).
 */
export function ProviderSendsLine({ provider, dataUse }: { provider: string; dataUse?: DataUse }) {
  const t = useT();
  const language = useLanguage();
  const words = language === "zh-CN" ? "zh" : "en";
  const summary = dataUse && t("providers.form.dataUse", { summary: dataUse.summary[words] });
  const link = `${t("providers.form.dataUseLink")} ↗`;
  const href = (words === "zh" && dataUse?.zhUrl) || dataUse?.url;
  return (
    <div className="flex flex-col">
      <SendsLine provider={provider} />
      {summary && (
        <p data-testid="provider-data-use" className={`${hintClass} mt-0`}>
          {summary}
          {href && (
            <>
              {gap(language, summary, link)}
              <a href={href} target="_blank" rel="noreferrer" className="underline">
                {link}
              </a>
            </>
          )}
        </p>
      )}
    </div>
  );
}

/**
 * A provider's own error message, readable: some send their JSON error body
 * (e.g. `{"error_type":"authentication_error","message":"…"}`), whose
 * message, or else its type, says it in words.
 */
function readableMessage(message: string): string {
  const text = message.trim();
  if (!text.startsWith("{")) return message;
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const inner = body.error;
    const nested =
      inner && typeof inner === "object" ? (inner as Record<string, unknown>).message : inner;
    const said = [body.message, nested, body.detail].find(
      (each): each is string => typeof each === "string" && each.trim() !== "",
    );
    if (said) return said;
    // Only a type, e.g. "authentication_error": as words.
    return typeof body.error_type === "string" ? body.error_type.replaceAll("_", " ") : message;
  } catch {
    return message;
  }
}

/** A connection test's outcome. A test sends nothing of the User's, so it asks nothing (ADR-0022). */
export function TestResult({
  result,
  line: ownLine,
  model,
  action,
}: {
  result: ConnectionTestResult;
  /** Says it in the provider's own terms (a refused key), in place of the general line. */
  line?: string;
  /** The model that was tried, for a line that names it. */
  model?: string;
  /** What the User can do about it, after the line. */
  action?: ProblemAction;
}) {
  const t = useT();
  if (result.ok) {
    return (
      <p data-testid="connection-test" className={successTextClass}>
        {t("providers.test.ok")}
      </p>
    );
  }
  const { wording } = result.error;
  const badKey = wording?.key === "error.provider.keyCharacter" ? wording : null;
  const line = badKey
    ? t(badKey.key, badKey.values)
    : (ownLine ?? t(testErrorKey(result.error.kind), { model: model ?? "" }));
  return (
    <div data-testid="connection-test" role="alert" className={errorTextClass}>
      <div className="flex items-baseline">
        <ProblemMark className="mr-1.5 shrink-0 translate-y-0.5" />
        <MetaLine parts={[line, action && <LineAction action={action} />]} />
      </div>
      {/* The provider's own words help with its errors. */}
      {!badKey && result.error.message && (
        <p className="mt-1 text-[12px] leading-[18px] break-words text-ink-meta">
          {readableMessage(result.error.message)}
        </p>
      )}
    </div>
  );
}

/** Linux without a keyring (safeStorage "basic_text"), or no encryption at all. */
export function SecretStorageNotice({
  status,
  onAccept,
}: {
  status: SecretStorageStatus;
  onAccept(): void;
}) {
  const t = useT();
  if (status.protection === "unavailable") {
    return (
      <p role="alert" className={noticeClass}>
        {t("providers.secrets.unavailable")}
      </p>
    );
  }
  return (
    <div role="alert" data-testid="plain-text-secrets" className={noticeClass}>
      <p className="font-semibold text-ink">{t("providers.secrets.plainText.title")}</p>
      <p className="mt-1">{t("providers.secrets.plainText.body")}</p>
      <label className="mt-2 flex items-start gap-2">
        <input
          type="checkbox"
          checked={status.plainTextAccepted}
          onChange={onAccept}
          className="mt-[3px] size-4 shrink-0 accent-ink"
        />
        <span>{t("providers.secrets.plainText.accept")}</span>
      </label>
    </div>
  );
}
