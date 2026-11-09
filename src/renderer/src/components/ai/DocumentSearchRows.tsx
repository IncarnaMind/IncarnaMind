import { type CSSProperties, useId, useState } from "react";
import {
  type ChatProvider,
  DEFAULT_RERANK_MODELS,
  type EmbeddingProviderKind,
  type RerankServiceKind,
  type RerankSettings,
  type SaveEmbeddingProviderInput,
  SUGGESTED_EMBEDDING_MODELS,
} from "../../../../core/api";
import { core } from "../../core";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { ProblemMark } from "../ProblemLine";
import {
  cloudServiceOf,
  EmbeddingServerForm,
  SwitchConfirmation,
} from "../providers/EmbeddingSettings";
import { BuiltInModelState, RerankKeyForm } from "../providers/RerankSettings";
import { testErrorKey } from "../providers/shared";
import { PopUpSelect } from "../settings/PopUpButton";
import { SettingsRow } from "../settings/SettingsGroup";
import { buttonStyle, errorTextClass, noticeClass } from "../ui";
import { popUpWidth } from "./RoleSelect";

const OFF = "off";
const BUILT_IN = "built-in";
const SERVER = "server";
const CURRENT = "current";

/** A search model the picker offers: the built-in one, a company's own API on its account's key, Ollama's. */
interface SearchChoice {
  value: string;
  input: SaveEmbeddingProviderInput;
  label: string;
  /** Who runs it: the User's keys, this computer, or another computer, named by its address. */
  where: "keys" | "local" | { host: string };
}

/** The account a hosted search model takes its key from: the User's saved chat provider of that company. */
const hasAccount = (providers: readonly ChatProvider[], catalogId: string) =>
  providers.some(
    (each) =>
      (each.catalogId ?? each.kind) === catalogId && each.baseUrl === null && each.hasApiKey,
  );

/**
 * Settings › AI › Document search: off until Turn on…, then its model, among the built-in one,
 * Ollama, and a company's own API where the User's account with it is there, grouped by who pays,
 * with "Another server…" for one of their own. Changing it asks first, since every Document is read
 * again (and, for a cloud model, sent). Its option, how the best matches are ordered, sits under it.
 */
export function DocumentSearchRows({
  id,
  providers,
  rerank,
  setRerank,
}: {
  id: string;
  providers: readonly ChatProvider[];
  /** The page's one read of how search orders its best matches, which Accounts and keys reads too. */
  rerank: RerankSettings | null;
  setRerank(next: RerankSettings): void;
}) {
  const t = useT();
  const embedding = useAppStore((state) => state.embedding);
  const retry = useAppStore((state) => state.retryEmbedding);
  const [asking, setAsking] = useState<SearchChoice | "off" | null>(null);
  const [server, setServer] = useState(false);
  if (!embedding) return null;
  const { provider, error, rebuild, localOnly } = embedding;
  const off = provider.kind === "off";

  const hasOllama = providers.some((each) => each.kind === "ollama" && each.service === null);
  const offered: SearchChoice[] = [
    {
      value: BUILT_IN,
      input: { kind: "built-in" },
      label: t("embeddingProviders.kind.built-in"),
      where: "local",
    },
    ...(hasOllama || provider.kind === "ollama"
      ? [hostedChoice("ollama", provider.kind === "ollama" ? provider.modelId : null)]
      : []),
    ...(!localOnly && (hasAccount(providers, "openai") || provider.kind === "openai")
      ? [hostedChoice("openai", provider.kind === "openai" ? provider.modelId : null)]
      : []),
    ...(!localOnly && (hasAccount(providers, "google") || provider.kind === "google")
      ? [hostedChoice("google", provider.kind === "google" ? provider.modelId : null)]
      : []),
  ];
  function hostedChoice(
    kind: Extract<EmbeddingProviderKind, "openai" | "google" | "ollama">,
    model: string | null,
  ): SearchChoice {
    const modelId = model ?? SUGGESTED_EMBEDDING_MODELS[kind];
    return {
      value: kind,
      input: {
        kind,
        modelId,
        ...(kind === "ollama" && provider.kind === "ollama" && provider.baseUrl
          ? { baseUrl: provider.baseUrl }
          : {}),
      },
      label: `${t(`embeddingProviders.kind.${kind}`)} · ${modelId}`,
      where:
        kind !== "ollama"
          ? "keys"
          : provider.kind === "ollama" && provider.service
            ? { host: provider.service.name }
            : "local",
    };
  }
  // A server of the User's own stays shown as it is, under its own name.
  const own = provider.kind === "openai-compatible";
  const value = off ? OFF : own ? CURRENT : provider.kind;

  const switchTo = async (choice: SearchChoice | "off") => {
    setAsking(null);
    try {
      useAppStore.setState({
        embedding: await core.saveEmbeddingProvider(
          choice === "off" ? { kind: "off" } : choice.input,
        ),
      });
    } catch (failure) {
      useAppStore.getState().reportError(failure);
    }
  };
  const asked = asking === null || asking === "off" ? null : asking;
  const keys = offered.filter((each) => each.where === "keys");
  const local = offered.filter((each) => each.where === "local");
  const elsewhere = offered.flatMap((each) =>
    typeof each.where === "object" ? [{ host: each.where.host, choice: each }] : [],
  );

  return (
    <>
      <SettingsRow
        data-testid="ai-document-search"
        label={t("ai.jobs.search")}
        htmlFor={off ? undefined : id}
        detail={
          <>
            <span data-testid="embedding-state" className="block">
              {off
                ? t("ai.jobs.search.offLine")
                : provider.service
                  ? t("embeddingProviders.settings.stateSent", { service: provider.service.name })
                  : t("ai.jobs.search.line")}
            </span>
            {rebuild && (
              <span data-testid="embedding-rebuild" className="block">
                {t("embeddingProviders.rebuild.title", {
                  done: rebuild.done,
                  total: rebuild.total,
                })}
              </span>
            )}
            {rebuild?.reason === "key-removed" && (
              <span data-testid="embedding-rebuild-reason" className="block">
                {t("embeddingProviders.rebuild.keyRemoved")}
              </span>
            )}
            {error && (
              <span role="alert" className={`block ${errorTextClass}`} title={error.message}>
                <ProblemMark />
                {t("embeddingProviders.settings.error", { reason: t(testErrorKey(error.kind)) })}
              </span>
            )}
          </>
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
            {off ? (
              <button
                type="button"
                data-testid="embedding-change"
                onClick={() => setAsking(offered[0] ?? null)}
                className={buttonStyle("secondary", "sm")}
              >
                {t("embeddingProviders.settings.turnOn")}
              </button>
            ) : (
              <PopUpSelect
                id={id}
                data-testid="embedding-model"
                value={server ? SERVER : value}
                className={popUpWidth}
                onChange={(event) => {
                  const next = event.target.value;
                  if (next === SERVER) setServer(true);
                  else if (next === OFF) setAsking("off");
                  else {
                    const choice = offered.find((each) => each.value === next);
                    if (choice) setAsking(choice);
                  }
                }}
              >
                <option value={OFF}>{t("embeddingProviders.settings.off")}</option>
                {own && (
                  <option value={CURRENT}>
                    {`${provider.service?.name ?? t("embeddingProviders.kind.openai-compatible")} · ${provider.modelId}`}
                  </option>
                )}
                {keys.length > 0 && (
                  <optgroup label={t("ai.payer.keys")}>
                    {keys.map((each) => (
                      <option key={each.value} value={each.value}>
                        {each.label}
                      </option>
                    ))}
                  </optgroup>
                )}
                {elsewhere.map(({ host, choice }) => (
                  <optgroup key={host} label={host}>
                    <option value={choice.value}>{choice.label}</option>
                  </optgroup>
                ))}
                <optgroup label={t("ai.payer.local")}>
                  {local.map((each) => (
                    <option key={each.value} value={each.value}>
                      {each.label}
                    </option>
                  ))}
                </optgroup>
                <option value={SERVER}>{t("ai.jobs.search.server")}</option>
              </PopUpSelect>
            )}
          </>
        }
      >
        {server && (
          <EmbeddingServerForm
            current={embedding}
            onDone={() => {
              setServer(false);
              document.getElementById(id)?.focus();
            }}
          />
        )}
      </SettingsRow>
      <RerankRow providers={providers} rerank={rerank} setRerank={setRerank} />
      <SwitchConfirmation
        open={asking !== null}
        provider={asked ? asked.label : t("embeddingProviders.settings.off")}
        change={asking === "off" ? "turn-off" : off ? "turn-on" : "switch"}
        cloudService={asked ? cloudServiceOf(asked.input.kind, "", t) : null}
        onCancel={() => setAsking(null)}
        onConfirm={() => {
          if (asking) void switchTo(asking);
        }}
      />
    </>
  );
}

/** An option sits under its job's row, its words and the hairline above it indented past the row's. */
const optionRow = {
  className: "pl-6",
  style: { "--row-inset": "40px" } as CSSProperties,
};

const SERVICES: readonly RerankServiceKind[] = ["cohere", "voyage"];
const SET_UP = "set-up:";

/**
 * Document search's option: what puts its best matches first. The built-in model by default; a
 * Cohere or Voyage AI key instead, set up in place from the picker's foot, its key one row in
 * Accounts and keys; or off.
 */
function RerankRow({
  providers,
  rerank,
  setRerank,
}: {
  providers: readonly ChatProvider[];
  rerank: RerankSettings | null;
  setRerank(next: RerankSettings): void;
}) {
  const t = useT();
  const id = useId();
  const localOnly = useAppStore((state) => state.embedding?.localOnly === true);
  const [settingUp, setSettingUp] = useState<RerankServiceKind | null>(null);
  // A service already set up asks first too: its line says what goes before Use this sends it.
  const [confirming, setConfirming] = useState<RerankServiceKind | null>(null);
  if (!rerank) return null;
  const service = rerank.kind && rerank.kind !== "built-in" ? rerank.kind : null;
  const value = settingUp
    ? `${SET_UP}${settingUp}`
    : confirming
      ? confirming
      : !rerank.enabled
        ? OFF
        : (rerank.kind ?? BUILT_IN);
  const run = async (action: () => Promise<RerankSettings>) => {
    try {
      setRerank(await action());
    } catch (failure) {
      useAppStore.getState().reportError(failure);
    }
  };
  // A company whose account is there is chosen at once, on its key; the others are set up here.
  const ready = localOnly
    ? []
    : SERVICES.filter((each) => each === service || hasAccount(providers, each));
  const offers = localOnly ? [] : SERVICES.filter((each) => !ready.includes(each));
  const close = () => {
    setSettingUp(null);
    setConfirming(null);
    document.getElementById(id)?.focus();
  };
  const notices = rerank.enabled
    ? [
        rerank.paused && t("rerank.settings.paused"),
        service &&
          !rerank.hasApiKey &&
          t("rerank.settings.keyMissing", { service: t(`rerank.kind.${service}`) }),
      ].filter((notice) => typeof notice === "string")
    : [];
  return (
    <SettingsRow
      {...optionRow}
      data-testid="rerank-settings"
      label={t("rerank.settings.title")}
      htmlFor={id}
      detail={
        <>
          <span className="block">{t("rerank.settings.body")}</span>
          {rerank.enabled && rerank.kind === "built-in" && (
            <BuiltInModelState model={rerank.model} />
          )}
          {rerank.enabled && rerank.kind === "built-in" && rerank.runsOn && (
            <span data-testid="rerank-runs-on" className="block">
              {t("rerank.settings.runsOn", { device: rerank.runsOn === "gpu" ? "GPU" : "CPU" })}
            </span>
          )}
          {rerank.enabled && rerank.kind === "built-in" && rerank.keyRemoved && (
            <span data-testid="rerank-key-removed" className="block">
              {t("embeddingProviders.rebuild.keyRemoved")}
            </span>
          )}
          {rerank.enabled && service && !confirming && (
            <span data-testid="rerank-sent-to" className="block">
              {t("rerank.settings.sentTo", { service: t(`rerank.kind.${service}`) })}
            </span>
          )}
        </>
      }
      control={
        <>
          {rerank.kind === "built-in" && rerank.model.state === "failed" && (
            <button
              type="button"
              data-testid="rerank-retry"
              onClick={() => void run(() => core.downloadRerankingModel())}
              className={buttonStyle("secondary", "sm")}
            >
              {t("rerank.settings.retry")}
            </button>
          )}
          <PopUpSelect
            id={id}
            data-testid="rerank-choice"
            value={value}
            className={popUpWidth}
            onChange={(event) => {
              const next = event.target.value;
              const offer = offers.find((each) => `${SET_UP}${each}` === next);
              if (offer) {
                setSettingUp(offer);
                return;
              }
              setSettingUp(null);
              setConfirming(null);
              if (next === OFF) void run(() => core.removeRerankSettings());
              else if (next === BUILT_IN)
                void run(() => core.saveRerankSettings({ kind: "built-in" }));
              else {
                const chosen = ready.find((each) => each === next);
                if (chosen && chosen !== service) setConfirming(chosen);
              }
            }}
          >
            <option value={OFF}>{t("embeddingProviders.settings.off")}</option>
            {ready.length > 0 && (
              <optgroup label={t("ai.payer.keys")}>
                {ready.map((each) => (
                  <option key={each} value={each}>
                    {`${t(`rerank.kind.${each}`)} · ${
                      each === service ? (rerank.modelId ?? "") : DEFAULT_RERANK_MODELS[each]
                    }`}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label={t("ai.payer.local")}>
              <option value={BUILT_IN}>{t("embeddingProviders.kind.built-in")}</option>
            </optgroup>
            {offers.length > 0 && (
              <optgroup label={t("ai.rerank.setUp.group")}>
                {offers.map((each) => (
                  <option key={each} value={`${SET_UP}${each}`}>
                    {t("ai.rerank.setUp.row", { provider: t(`rerank.kind.${each}`) })}
                  </option>
                ))}
              </optgroup>
            )}
          </PopUpSelect>
        </>
      }
    >
      {confirming ? (
        <RerankConfirm
          kind={confirming}
          onUse={() => {
            const kind = confirming;
            close();
            void run(() => core.saveRerankSettings({ kind }));
          }}
          onCancel={close}
        />
      ) : settingUp ? (
        <RerankKeyForm
          kind={settingUp}
          current={rerank}
          onSaved={(saved) => {
            setRerank(saved);
            close();
          }}
          onCancel={close}
        />
      ) : (
        notices.length > 0 && (
          <div className="flex flex-col gap-2">
            {notices.map((notice) => (
              <p key={notice} className={noticeClass}>
                {notice}
              </p>
            ))}
          </div>
        )
      )}
    </SettingsRow>
  );
}

/**
 * Choosing a reranking service the User's account already reaches: what each search sends, and to
 * whom, above Use this, which is the consent (ADR-0022). Esc or Cancel keeps what was chosen.
 */
function RerankConfirm({
  kind,
  onUse,
  onCancel,
}: {
  kind: RerankServiceKind;
  onUse(): void;
  onCancel(): void;
}) {
  const t = useT();
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Esc closes what the choice opened, as elsewhere in Settings.
    <div
      data-testid="rerank-confirm"
      className="flex flex-col gap-2"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      <p data-testid="rerank-confirm-sends" className="text-[12px] leading-5 text-ink-meta">
        {t("rerank.settings.sends", { service: t(`rerank.kind.${kind}`) })}
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          data-testid="rerank-confirm-use"
          // biome-ignore lint/a11y/noAutofocus: the choice was just made; Use this is its next step.
          autoFocus
          onClick={onUse}
          className={buttonStyle("primary", "sm")}
        >
          {t("setup.step.useThis")}
        </button>
        <button
          type="button"
          data-testid="rerank-confirm-cancel"
          onClick={onCancel}
          className="text-[13px] leading-5 font-semibold text-ink-secondary hover:text-ink"
        >
          {t("library.cancel")}
        </button>
      </div>
    </div>
  );
}
