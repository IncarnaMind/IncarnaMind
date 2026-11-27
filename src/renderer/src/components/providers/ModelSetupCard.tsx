import { useEffect, useRef, useState } from "react";
import type { ChatProvider } from "../../../../core/api";
import type { KeyTarget } from "../../../../core/providers/catalog/keyForms";
import { core } from "../../core";
import { useLanguage, useT } from "../../i18n";
import { turnOffLocalMode } from "../../localMode";
import { giveUpWaiting } from "../../modelSetup";
import { useAppStore } from "../../store";
import { ProblemLine } from "../ProblemLine";
import { buttonStyle } from "../ui";
import { ChatGptSignInState, useContinueWithChatGpt } from "./ChatGptSignIn";
import { ClaudePlanWay } from "./ClaudePlan";
import { CopilotSetupWay } from "./CopilotPlan";
import { KeyEntry } from "./KeyEntry";
import { useOllama } from "./OllamaCard";
import { ProviderForm } from "./ProviderForm";
import { ChatGptPlanWay, LocalWay } from "./SetupWays";

/**
 * The first own Question with no model set (#103): the assistant's composer becomes this card
 * while the Question waits above it. A key is pasted, named by its form and used at once; then
 * the ways in that need no key, best first. Choosing a service is the consent for it (#718), so
 * no dialog is added here.
 */
export function ModelSetupCard() {
  const t = useT();
  const chinese = useLanguage() === "zh-CN";
  const localOnly = useAppStore((state) => state.embedding?.localOnly === true);
  const [view, setView] = useState<"key" | null>(null);
  const [initialKey, setInitialKey] = useState("");
  const [initialTarget, setInitialTarget] = useState<KeyTarget | undefined>(undefined);
  const [others, setOthers] = useState(false);
  const [providers, setProviders] = useState<ChatProvider[]>([]);
  const ollama = useOllama(() => undefined, undefined, { localModeUnasked: true });
  const sign = useContinueWithChatGpt({ onSignedIn: () => undefined });
  const keyField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Only to tell the form a key is already saved: the form works with none listed.
    core
      .listChatProviders()
      .then(setProviders, (error: unknown) =>
        console.error("The saved chat providers couldn't be listed for the setup card.", error),
      );
  }, []);
  const card = useRef<HTMLElement>(null);
  // It takes the composer's place, or opens from the steps card: either way the focus comes in.
  useEffect(() => {
    if (view !== null) return;
    card.current?.querySelector<HTMLInputElement>('[data-testid="setup-key"]')?.focus();
  }, [view]);

  const useKeyInstead = () => {
    setView(null);
    keyField.current?.focus();
  };
  // Neither plan is sold in mainland China, the region the Chinese interface stands for, so
  // there they wait under Other ways (#2865).
  const plans = (
    <>
      <ChatGptPlanWay sign={sign} leads={!chinese} />
      <ClaudePlanWay onUseKey={useKeyInstead} />
    </>
  );

  return (
    <section
      ref={card}
      data-testid="model-setup"
      aria-labelledby="model-setup-title"
      className="setup-card flex min-h-0 max-h-[85vh] flex-col gap-2.5 overflow-y-auto px-4"
    >
      <h2
        id="model-setup-title"
        data-setup-title={view === null ? true : undefined}
        className={view === null ? "text-ui leading-6 text-ink" : "sr-only"}
      >
        {t("setup.title")}
      </h2>

      {view === null ? (
        sign.waiting ? (
          <ChatGptSignInState sign={sign} />
        ) : (
          <>
            {localOnly ? (
              <ProblemLine
                testId="setup-local-mode"
                action={{
                  label: t("localMode.turnOff"),
                  testId: "setup-local-mode-off",
                  onClick: () => void turnOffLocalMode(),
                }}
              >
                {t("setup.localMode")}
              </ProblemLine>
            ) : (
              <KeyEntry
                testId="setup-key"
                autoFocus
                inputRef={keyField}
                onSaved={() => undefined}
                unrecognised={{
                  label: "setup.key.chooseService",
                  run: (key, next) => {
                    setInitialKey(key);
                    setInitialTarget(next);
                    setView("key");
                  },
                }}
              />
            )}
            {!localOnly && !chinese && plans}
            {!localOnly && (
              <details
                open={others}
                onToggle={(event) => setOthers(event.currentTarget.open)}
                className="flex flex-col gap-2"
              >
                <summary
                  data-testid="setup-other"
                  className="cursor-default text-ui leading-5 text-ink-secondary"
                >
                  {t("setup.other")}
                </summary>
                <div className="mt-2 flex flex-col gap-2">
                  {chinese && plans}
                  <CopilotSetupWay onKey={useKeyInstead} />
                </div>
              </details>
            )}
            <LocalWay ollama={ollama} />
          </>
        )
      ) : (
        <>
          <button
            type="button"
            data-testid="setup-back"
            onClick={() => setView(null)}
            className="self-start text-ui text-accent underline-offset-2 hover:underline"
          >
            ‹ {t("setup.back")}
          </button>
          <ProviderForm
            providers={providers}
            initialKey={initialKey}
            {...(initialTarget !== undefined && {
              initialKind: initialTarget.service,
              initialEndpoint: initialTarget.region,
            })}
            onSaved={() => undefined}
            standalone
          />
        </>
      )}

      <div>
        <button
          type="button"
          data-testid="setup-later"
          onClick={giveUpWaiting}
          className={`-ml-3 ${buttonStyle("ghost", "md")}`}
        >
          {t("providers.setup.later")}
        </button>
      </div>
    </section>
  );
}
