import { useId, useState } from "react";
import type { DecisionHost, DecisionHostStatus } from "../../../../core/api";
import { JEV_SERVICE } from "../../../../core/providers/jev";
import { sortingSwitchOn } from "../../../../shared/libraryModels";
import { useAgentAlone } from "../../agentNote";
import { core } from "../../core";
import { useDecisionHosts } from "../../decisionHosts";
import { useLanguage, useT } from "../../i18n";
import { useAppStore } from "../../store";
import { useMounted } from "../../useMounted";
import { firstModelOf, hostName } from "../providers/DecisionKeyForm";
import { setUpJevForSorting } from "../providers/jevSetUp";
import { SendsLine } from "../providers/SendsLine";
import { useSorting } from "../providers/SortingChoice";
import { refusalWords, testAndSaveKey } from "../providers/saveKey";
import { defaultRegion, keyProviderName } from "../providers/shared";
import type { SortingOption } from "../providers/sortingOptions";
import { buttonStyle, fieldClass, fieldLabelClass, hintClass } from "../ui";
import { KeysStay, SetupChoice, SetupPanel, type StepPlace, WorksRow } from "./SetupPanel";
import { StepKeyField, useStepKey } from "./StepKey";

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

const lineClass = "text-[12px] leading-5 text-ink-meta";

/**
 * The sorting step in Settings: what sorts new Documents and reads a check's sentences first. A
 * decision model leads, on the host the User's key already reaches, else on the best measured
 * one, whose key is asked for in place; then the User's AI model; last a model on this computer.
 * Use this checks and keeps a key typed and saves the choice, under the line that says what
 * sorting sends: that press is the consent. Sorting new Documents by themselves still asks before
 * the first one goes to a cloud service (#3353, ADR-0022).
 */
export function SortingStep({ place }: { place: StepPlace }) {
  const t = useT();
  const id = useId();
  const language = useLanguage();
  const localOnly = useAppStore((state) => state.embedding?.localOnly === true);
  const switchOn = useAppStore((state) => !state.library || sortingSwitchOn(state.library));
  const chatModel = useAppStore((state) => state.settings?.user.chatModel ?? null);
  // The User's own AI, and no model here: a key kept for sorting serves sorting alone (#3362).
  const agentAlone = useAgentAlone();
  const sorting = useSorting();
  const [hosts, setHosts] = useDecisionHosts();
  const [choice, setChoice] = useState<Choice>(localOnly ? "local" : "decision");
  const [picked, setPicked] = useState<Host | null>(null);
  const [account, setAccount] = useState("");
  const [saving, setSaving] = useState(false);
  const step = useStepKey();
  const mounted = useMounted();
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

  const setUp = shown === "decision" && decision === null;
  const asksKey = setUp && (host === "jev" ? jev !== null : status !== null && !status.hasKey);
  const asksAccount = setUp && status?.account != null && !status.account.value;
  // A chat provider's key kept here becomes the Answers model where there is none yet.
  const answersToo =
    asksKey &&
    status?.key === "provider" &&
    status.provider !== null &&
    chatModel === null &&
    !agentAlone;
  const serviceName =
    host === "jev" ? JEV_SERVICE.name : status ? hostName(status, language) : null;
  const keyName =
    status?.key === "provider" && status.provider
      ? keyProviderName(status.provider, t, language)
      : serviceName;
  const filled =
    (asksKey || asksAccount) && (!asksKey || step.typed) && (!asksAccount || account.trim() !== "");
  const ready = setUp ? filled : option !== null && option.unresolved !== true;

  const chooseHere = async (chosen: SortingOption["classifier"]) => {
    const done = await sorting.choose({ classifier: chosen });
    sorting.reread();
    return done;
  };

  /** Checks and keeps what was typed, then chooses the host; why it couldn't, or null once done. */
  const keepAndChoose = async (): Promise<string | null> => {
    const typed = step.key.text;
    if (host === "jev") {
      const outcome = await setUpJevForSorting(
        core,
        { apiKey: typed },
        () => chooseHere({ kind: "jev" }),
        mounted,
      );
      if (outcome.kind === "failed") {
        return refusalWords(outcome.result.error, JEV_SERVICE.name, t);
      }
      // The choice's own failure is told where it happened.
      return outcome.kind === "saved" && outcome.chosen ? null : "";
    }
    if (!status) return "";
    let after: DecisionHostStatus[] | null = null;
    if (asksKey && status.key === "provider" && status.provider) {
      const saved = await testAndSaveKey({
        service: status.provider,
        key: typed,
        endpoint: defaultRegion(status.provider, language) || null,
        keepDefault: agentAlone ? "always" : true,
      });
      if (saved.kind === "refused") return refusalWords(saved.error, status.provider, t);
      if (saved.kind === "unknown") return t("setup.key.unrecognised");
    }
    const ownKey = asksKey && status.key === "own";
    if (ownKey || asksAccount) {
      after = await core.setDecisionKey({
        host: status.host,
        ...(ownKey && { apiKey: typed }),
        ...(asksAccount && { account: account.trim() }),
      });
    }
    after ??= await core.listDecisionHosts();
    setHosts(after);
    const now = after.find((each) => each.host === status.host) ?? status;
    return (await chooseHere(firstModelOf(now))) ? null : "";
  };

  const next = async () => {
    if (!ready || saving || step.busy) return;
    if (setUp) {
      if (await step.save(keepAndChoose)) place.next();
      return;
    }
    if (!option) return;
    setSaving(true);
    try {
      if (await sorting.choose(option)) place.next();
    } finally {
      setSaving(false);
    }
  };

  const nameOf = (each: Host) =>
    each === "jev"
      ? JEV_SERVICE.name
      : (hosts?.find((entry) => entry.host === each)?.name[language === "zh-CN" ? "zh" : "en"] ??
        each);

  const sends = (service: string | null) =>
    service && (
      <>
        {switchOn && (
          <p data-testid="setup-sorting-asks" className={lineClass}>
            {t("setup.sorting.asks", { service })}
          </p>
        )}
        <p data-testid="setup-sorting-sends" className={lineClass}>
          {t("setup.sorting.sendsWhenOn", { service })}
        </p>
      </>
    );

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
            disabled={step.busy}
            className={buttonStyle("ghost", "lg")}
          >
            {t("setupPage.skip")}
          </button>
          <button
            type="button"
            data-testid="setup-next"
            disabled={!ready || saving || step.busy}
            onClick={() => void next()}
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
              disabled={step.busy}
              onChange={(event) => {
                setPicked(HOSTS.find((each) => each === event.target.value) ?? null);
                step.reset();
                setAccount("");
              }}
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
          {decision ? (
            <>
              <WorksRow
                text={t(status?.key === "provider" ? "decisions.usesKey" : "setupPage.keyWorks", {
                  provider: keyName ?? decision.label,
                })}
                testId="setup-decision-works"
              >
                <span className={lineClass}>{decision.label}</span>
              </WorksRow>
              {sends(decision.provider)}
            </>
          ) : (
            (asksKey || asksAccount) && (
              <div className="flex flex-col gap-3">
                {asksKey && (
                  <StepKeyField
                    step={step}
                    label={t("setupPage.sorting.connectionKey", { provider: keyName ?? "" })}
                    keyUrl={status?.keyUrl ?? null}
                    testId="setup-decision-key"
                    onEnter={() => void next()}
                  />
                )}
                {asksAccount && status?.account && (
                  <label className={`${fieldLabelClass} flex flex-col gap-1`}>
                    <span className="font-semibold">
                      {t(`decisions.account.${status.account.kind}`)}
                    </span>
                    <input
                      type="text"
                      data-testid="setup-decision-account"
                      value={account}
                      onChange={(event) => setAccount(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        void next();
                      }}
                      autoComplete="off"
                      spellCheck={false}
                      className={`${fieldClass} w-full`}
                    />
                  </label>
                )}
                <div className="flex flex-col gap-1">
                  <KeysStay />
                  {sends(serviceName)}
                  {answersToo && keyName && (
                    <>
                      <p data-testid="setup-decision-answers" className={lineClass}>
                        {t("setupPage.alsoAnswers", { provider: keyName })}
                      </p>
                      <SendsLine provider={keyName} testId="setup-decision-chat-sends" />
                    </>
                  )}
                </div>
              </div>
            )
          )}
        </div>
      )}
      {shown !== "decision" &&
        (option
          ? option.unresolved !== true && sends(option.provider)
          : shown === "local" && (
              <p data-testid="setup-sorting-none" className={`${hintClass} mt-0`}>
                {t("setupPage.sorting.local.none")}
              </p>
            ))}
      {agentAlone && (
        <p data-testid="setup-sorting-agent-alone" className={lineClass}>
          {t("setupPage.sorting.agentAlone")}
        </p>
      )}
    </SetupPanel>
  );
}
