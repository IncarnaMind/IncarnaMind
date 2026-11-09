import { useEffect, useId, useState } from "react";
import type { ChatProvider, TaggingClassifier } from "../../../../core/api";
import { supportsLibraryImages } from "../../../../shared/libraryModels";
import { core } from "../../core";
import { useDecisionHosts } from "../../decisionHosts";
import { errorMessage } from "../../errors";
import { translateNow, useLanguage, useT } from "../../i18n";
import { useAppStore } from "../../store";
import { ProblemMark } from "../ProblemLine";
import { PopUpSelect } from "../settings/PopUpButton";
import { SettingsRow, SettingsSwitchRow } from "../settings/SettingsGroup";
import { buttonStyle, errorTextClass, rowFieldClass } from "../ui";

/** "Other model…": a model on a saved provider, or a local decision model in Ollama, by name. */
export function OtherModelForm({
  current,
  onSave,
}: {
  current: TaggingClassifier | null;
  onSave(classifier: TaggingClassifier): void;
}) {
  const t = useT();
  const language = useLanguage();
  const id = useId();
  const listId = `${id}-models`;
  const [providers, setProviders] = useState<ChatProvider[]>([]);
  const [decisionHosts] = useDecisionHosts();
  const localMode = useAppStore((state) => state.embedding?.localOnly === true);
  // Any model a host serves, by name: one it added since this copy was made included (#1907).
  const hosts = localMode ? [] : (decisionHosts ?? []).filter((host) => host.ready);
  // A saved provider's id, "ollama" for a decision model by name, "auto" for them picked per
  // Document, or "decision:<host>" for a decision model host.
  const [where, setWhere] = useState(
    current?.kind === "chat"
      ? current.choice.providerId
      : current?.kind === "decision"
        ? `decision:${current.host}`
        : current
          ? current.kind
          : "",
  );
  const [modelId, setModelId] = useState(
    current?.kind === "chat"
      ? current.choice.modelId
      : current?.kind === "ollama" || current?.kind === "decision"
        ? current.modelId
        : "",
  );
  const host = hosts.find((each) => `decision:${each.host}` === where);
  const [baseUrl, setBaseUrl] = useState(
    current?.kind === "ollama" || current?.kind === "auto"
      ? current.baseUrl
      : "http://localhost:11434",
  );
  const [usePageImages, setUsePageImages] = useState(
    current?.kind === "ollama" && current.usePageImages === true,
  );
  const [error, setError] = useState<string | null>(null);
  const service = host
    ? (host.service?.name ?? null)
    : (providers.find((provider) => provider.id === where)?.service?.name ?? null);
  useEffect(() => {
    core.listChatProviders().then(
      (list) => {
        setProviders(list);
        setWhere((chosen) => chosen || list[0]?.id || "ollama");
      },
      (failure: unknown) => setError(errorMessage(failure, translateNow)),
    );
  }, []);
  return (
    <form
      data-testid="tagging-other-form"
      className="settings-row"
      onSubmit={(event) => {
        event.preventDefault();
        if (where === "auto") {
          onSave({ kind: "auto", baseUrl });
          return;
        }
        const model = modelId.trim();
        if (!model) return;
        if (host) {
          onSave({ kind: "decision", host: host.host, modelId: model });
          return;
        }
        onSave(
          where === "ollama"
            ? {
                kind: "ollama",
                baseUrl,
                modelId: model,
                usePageImages: supportsLibraryImages(model) && usePageImages,
              }
            : { kind: "chat", choice: { providerId: where, modelId: model } },
        );
      }}
    >
      <SettingsRow
        label={t("library.connection")}
        htmlFor={`${id}-connection`}
        detail={
          service && (
            <span data-testid="tagging-other-sends">
              {t("setup.sorting.sendsWhenOn", { service })}
            </span>
          )
        }
        control={
          <PopUpSelect
            id={`${id}-connection`}
            className="max-w-64"
            value={where}
            onChange={(event) => setWhere(event.target.value)}
          >
            {providers
              .filter((provider) => !localMode || provider.service === null)
              .map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.service?.name ??
                    (provider.kind === "ollama" ? "Ollama" : provider.kind)}
                  {provider.baseUrl ? ` · ${provider.baseUrl}` : ""}
                </option>
              ))}
            {hosts.map((each) => (
              <option key={each.host} value={`decision:${each.host}`}>
                {each.name[language === "zh-CN" ? "zh" : "en"]}
              </option>
            ))}
            <option value="ollama">{t("library.ollama")}</option>
            <option value="auto">{t("tagging.other.auto")}</option>
          </PopUpSelect>
        }
      />
      {where !== "auto" && (
        <SettingsRow
          label={t("library.model")}
          htmlFor={`${id}-model`}
          control={
            <>
              <input
                id={`${id}-model`}
                className={`${rowFieldClass} w-64`}
                required
                maxLength={200}
                value={modelId}
                spellCheck={false}
                list={host ? listId : undefined}
                data-testid="tagging-other-model"
                onChange={(event) => setModelId(event.target.value)}
              />
              {host && (
                <datalist id={listId}>
                  {host.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.maker ? `${model.name} · ${model.maker}` : model.name}
                    </option>
                  ))}
                </datalist>
              )}
            </>
          }
        />
      )}
      {(where === "ollama" || where === "auto") && (
        <SettingsRow
          label={t("library.server")}
          htmlFor={`${id}-server`}
          control={
            <input
              id={`${id}-server`}
              required
              type="url"
              className={`${rowFieldClass} w-64`}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          }
        />
      )}
      {where === "ollama" && supportsLibraryImages(modelId) && (
        <SettingsSwitchRow
          label={t("library.pageImages")}
          checked={usePageImages}
          onChange={setUsePageImages}
          switchTestId="tagging-other-page-images"
        />
      )}
      <SettingsRow
        control={
          <button
            type="submit"
            className={buttonStyle("secondary", "sm")}
            data-testid="tagging-other-save"
          >
            {t("tagging.other.save")}
          </button>
        }
      >
        {error && (
          <p role="alert" className={errorTextClass}>
            <ProblemMark />
            {error}
          </p>
        )}
      </SettingsRow>
    </form>
  );
}
