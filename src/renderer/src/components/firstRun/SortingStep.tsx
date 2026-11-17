import { useEffect, useId, useState } from "react";
import type { ChatProvider, DecisionHost, DecisionHostStatus } from "../../../../core/api";
import { JEV_SERVICE } from "../../../../core/providers/jev";
import { core } from "../../core";
import { useDecisionHosts } from "../../decisionHosts";
import { useLanguage, useT } from "../../i18n";
import { useAppStore } from "../../store";
import { DecisionSortingSetUp, firstModelOf, hostName } from "../providers/DecisionKeyForm";
import { JevSortingSetUp } from "../providers/JevSortingSetUp";
import { ProviderForm } from "../providers/ProviderForm";
import { SortingLine, useSorting } from "../providers/SortingChoice";
import { keyProviderName } from "../providers/shared";
import type { SortingOption } from "../providers/sortingOptions";
import { buttonStyle, fieldClass, fieldLabelClass, hintClass } from "../ui";
import { KeysStay, SetupChoice, SetupPanel, type StepPlace, WorksRow } from "./SetupPanel";

type Choice = "decision" | "chat" | "local";
type Host = DecisionHost | "jev";

/** The order the Provider picker lists the hosts in; the first is the best measured (#1907). */
const HOSTS: readonly Host[] = [
  "openrouter",
  "openai",
  "perplexity",
  "liquid",
  "cloudflare",
  "alibaba",
  "jev",
];

/**
 * The setup's third step (#3296): what sorts new Documents and reads a check's sentences first. A
 * decision model leads, on the host the User's key already reaches, else on the best measured
 * one, whose key is asked for in place; then the User's AI model; last a model on this computer.
 * Only the choice is saved: turning tagging on stays the User's own act (ADR-0022).
 */
export function SortingStep({ place }: { place: StepPlace }) {
  const t = useT();
  const id = useId();
  const language = useLanguage();
  const localOnly = useAppStore((state) => state.embedding?.localOnly === true);
  const sorting = useSorting();
  const [hosts, setHosts] = useDecisionHosts();
  const [choice, setChoice] = useState<Choice>(localOnly ? "local" : "decision");
  const [picked, setPicked] = useState<Host | null>(null);
  const [saving, setSaving] = useState(false);
  const chat = localOnly
    ? undefined
    : sorting.options.find((option) => option.classifier.kind === "chat");
  const local = sorting.options.find((option) => option.provider === null);
  const keyHost = hosts?.find((each) => each.key === "provider" && each.ready);
  const host: Host = picked ?? keyHost?.host ?? "openrouter";
  const status = host === "jev" ? null : (hosts?.find((each) => each.host === host) ?? null);
  const jev = sorting.jevSettings;
  const jevReady = jev?.enabled === true && jev.hasApiKey;
  const shown: Choice = localOnly ? "local" : choice;

  const decision: SortingOption | null =
    host === "jev"
      ? jevReady
        ? {
            classifier: { kind: "jev" },
            label: JEV_SERVICE.name,
            provider: JEV_SERVICE.name,
            decisionModel: true,
          }
        : null
      : status?.ready
        ? {
            classifier: firstModelOf(status),
            label: status.models[0]?.name ?? hostName(status, language),
            provider: hostName(status, language),
            decisionModel: true,
          }
        : null;
  const option =
    shown === "decision" ? decision : shown === "chat" ? (chat ?? null) : (local ?? null);

  const use = async (chosen: Pick<SortingOption, "classifier">) => {
    setSaving(true);
    try {
      if (await sorting.choose(chosen)) place.next();
    } finally {
      setSaving(false);
    }
  };
  const chooseHere = async (chosen: SortingOption["classifier"]) => {
    const done = await sorting.choose({ classifier: chosen });
    sorting.reread();
    return done;
  };
  const keySaved = () => {
    core.listDecisionHosts().then(setHosts, (error: unknown) => {
      console.error("The decision model hosts couldn't be read again.", error);
    });
    sorting.reread();
  };

  const nameOf = (each: Host) =>
    each === "jev"
      ? JEV_SERVICE.name
      : (hosts?.find((entry) => entry.host === each)?.name[language === "zh-CN" ? "zh" : "en"] ??
        each);

  return (
    <SetupPanel
      place={place}
      view="sorting"
      title={t("setupPage.sorting.title")}
      lead={t("setupPage.sorting.lead")}
      foot={
        <>
          {place.back && (
            <button
              type="button"
              data-testid="setup-back"
              onClick={place.back}
              className={`-ml-2.5 ${buttonStyle("ghost", "lg")}`}
            >
              {t("setupPage.back")}
            </button>
          )}
          <span className="flex-1" />
          <button
            type="button"
            data-testid="setup-skip"
            onClick={place.next}
            className={buttonStyle("ghost", "lg")}
          >
            {t("setupPage.skip")}
          </button>
          <button
            type="button"
            data-testid="setup-next"
            disabled={option === null || option.unresolved === true || saving}
            onClick={() => option && void use(option)}
            className={buttonStyle("primary", "lg")}
          >
            {t("setup.step.useThis")}
          </button>
        </>
      }
    >
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="sr-only">{t("setupPage.sorting.title")}</legend>
        {!localOnly && (
          <SetupChoice
            type="radio"
            name="sorting"
            value="decision"
            testId="setup-sorting"
            checked={shown === "decision"}
            title={t("setupPage.sorting.decision")}
            line={t("setupPage.sorting.decision.line")}
            onChange={() => setChoice("decision")}
          />
        )}
        {chat && (
          <SetupChoice
            type="radio"
            name="sorting"
            value="chat"
            testId="setup-sorting"
            checked={shown === "chat"}
            title={t("setupPage.sorting.chat", { model: chat.modelName ?? "" })}
            line={t("setupPage.sorting.chat.line")}
            onChange={() => setChoice("chat")}
          />
        )}
        <SetupChoice
          type="radio"
          name="sorting"
          value="local"
          testId="setup-sorting"
          checked={shown === "local"}
          title={t("setupPage.sorting.local")}
          line={t("setupPage.sorting.local.line")}
          onChange={() => setChoice("local")}
        />
      </fieldset>
      {shown === "decision" && (
        <div data-testid="setup-decision" className="flex flex-col gap-3">
          <label className={`${fieldLabelClass} flex flex-col gap-1`} htmlFor={`${id}-host`}>
            <span className="font-semibold">{t("setupPage.sorting.provider")}</span>
            <select
              id={`${id}-host`}
              data-testid="setup-decision-host"
              value={host}
              onChange={(event) =>
                setPicked(HOSTS.find((each) => each === event.target.value) ?? null)
              }
              className={`${fieldClass} w-fit min-w-48`}
            >
              {HOSTS.filter(
                (each) => each === "jev" || hosts?.some((entry) => entry.host === each),
              ).map((each) => (
                <option key={each} value={each}>
                  {nameOf(each)}
                </option>
              ))}
            </select>
          </label>
          <DecisionPlace
            key={host}
            host={host}
            status={status}
            option={decision}
            onKeySaved={keySaved}
            choose={chooseHere}
            onChosen={place.next}
            jev={jev}
          />
        </div>
      )}
      {shown !== "decision" &&
        (option ? (
          <SortingLine option={option} choosing={false} />
        ) : (
          shown === "local" && (
            <p data-testid="setup-sorting-none" className={`${hintClass} mt-0`}>
              {t("setupPage.sorting.local.none")}
            </p>
          )
        ))}
    </SetupPanel>
  );
}

const focusHostPicker = () =>
  document.querySelector<HTMLElement>("[data-testid=setup-decision-host]")?.focus();

/**
 * The chosen host, as it stands: working with a key the User has, so Use this chooses it; or its
 * key (and account) asked for in place, whose own Use this keeps them and chooses it. A host
 * reached with a chat provider's key asks for that provider's key, which then serves both.
 */
function DecisionPlace({
  host,
  status,
  option,
  onKeySaved,
  choose,
  onChosen,
  jev,
}: {
  host: Host;
  status: DecisionHostStatus | null;
  option: SortingOption | null;
  onKeySaved(): void;
  choose(classifier: SortingOption["classifier"]): Promise<boolean>;
  onChosen(): void;
  jev: ReturnType<typeof useSorting>["jevSettings"];
}) {
  const t = useT();
  const language = useLanguage();
  const [providers, setProviders] = useState<ChatProvider[] | null>(null);
  const asksProviderKey = status?.key === "provider" && !status.hasKey;
  useEffect(() => {
    if (!asksProviderKey) return;
    core.listChatProviders().then(setProviders, (error: unknown) => {
      console.error("The saved chat providers couldn't be listed for the setup.", error);
      setProviders([]);
    });
  }, [asksProviderKey]);
  if (option) {
    const own = status?.key === "provider" && status.provider !== null;
    const name = own
      ? keyProviderName(status.provider ?? "", t, language)
      : (option.provider ?? option.label);
    return (
      <>
        <WorksRow
          text={t(own ? "setupPage.usesKey" : "setupPage.keyWorks", { provider: name })}
          testId="setup-decision-works"
        >
          <span className="text-[12px] leading-[18px] text-ink-meta">{option.label}</span>
        </WorksRow>
        <SortingLine option={option} choosing={false} />
      </>
    );
  }
  if (host === "jev") {
    return jev ? (
      <>
        <JevSortingSetUp
          jev={jev}
          choose={() => choose({ kind: "jev" })}
          onChosen={onChosen}
          onCancel={focusHostPicker}
        />
        <KeysStay />
      </>
    ) : null;
  }
  if (!status) return null;
  if (asksProviderKey && status.provider) {
    if (providers === null) return null;
    return (
      <>
        <ProviderForm
          providers={providers}
          only={status.provider}
          keepDefault
          onSaved={onKeySaved}
        />
        <KeysStay />
      </>
    );
  }
  return (
    <>
      <DecisionSortingSetUp
        host={status}
        choose={() => choose(firstModelOf(status))}
        onChosen={onChosen}
        onCancel={focusHostPicker}
      />
      <KeysStay />
    </>
  );
}
