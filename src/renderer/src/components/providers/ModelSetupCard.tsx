import { useEffect, useRef, useState } from "react";
import type { AgentClient, ChatProvider } from "../../../../core/api";
import type { KeyTarget } from "../../../../core/providers/catalog/keyForms";
import { SHOW_CLAUDE_APP_SETUP } from "../../../../shared/agentConnection";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useLanguage, useT } from "../../i18n";
import { turnOffLocalMode } from "../../localMode";
import { giveUpWaiting, useModelSetup } from "../../modelSetup";
import { useAppStore } from "../../store";
import { ProblemLine } from "../ProblemLine";
import { buttonStyle, hintClass } from "../ui";
import { ChatGptSignInState, useContinueWithChatGpt } from "./ChatGptSignIn";
import { ClaudePlanWay } from "./ClaudePlan";
import { CopilotSetupWay } from "./CopilotPlan";
import { KeyEntry } from "./KeyEntry";
import { useOllama } from "./OllamaCard";
import { ProviderForm } from "./ProviderForm";
import { ChatGptPlanWay, LocalWay } from "./SetupWays";

const CLAUDE_DOWNLOAD = "https://claude.ai/download";

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
        className={view === null ? "text-[15px] leading-6 font-semibold text-ink" : "sr-only"}
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
                  className="cursor-default text-[13px] leading-5 font-semibold text-ink-secondary"
                >
                  {t("setup.other")}
                </summary>
                <div className="mt-2 flex flex-col gap-2">
                  {chinese && plans}
                  <CopilotSetupWay onKey={useKeyInstead} />
                  {SHOW_CLAUDE_APP_SETUP && !chinese && <ClaudeWay />}
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
            className="self-start text-[13px] font-semibold text-accent underline-offset-2 hover:underline"
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

function ClaudeWay() {
  const t = useT();
  const reportError = useAppStore((state) => state.reportError);
  const showPage = useAppStore((state) => state.showSettingsPage);
  const [client, setClient] = useState<AgentClient | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<"copy" | "connected" | null>(null);
  // Only the Folder of the Mind the Question was asked from is shared.
  const folderId = useAppStore((state) => {
    const mindId = useModelSetup.getState().waiting?.mindId;
    return state.minds.find((mind) => mind.id === mindId)?.folderId ?? null;
  });
  useEffect(() => {
    core.listAgentClients().then(
      (all) => setClient(all.find((each) => each.id === "claude-desktop") ?? null),
      (error: unknown) => {
        console.error("The agent list couldn't be read for the setup card.", error);
        setClient(null);
      },
    );
  }, []);
  const connect = async () => {
    if (!folderId) return;
    setBusy(true);
    setProblem(null);
    try {
      await core.setAgentsEnabled(true);
      const { result } = await core.setUpAgent({ client: "claude-desktop", folderIds: [folderId] });
      if (result.kind === "copy") {
        await navigator.clipboard.writeText(result.text).catch(reportError);
        setDone("copy");
      } else setDone("connected");
    } catch (error) {
      setProblem(errorMessage(error, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-testid="setup-claude" className="flex flex-col items-start gap-1 px-2 py-1.5">
      <span className="text-ui font-semibold text-ink">{t("setup.claude.title")}</span>
      <span className="text-[13px] leading-5 text-ink-secondary">{t("setup.claude.line")}</span>
      {client?.installed === false ? (
        <>
          <span className={hintClass}>{t("setup.claude.missing")}</span>
          <a
            href={CLAUDE_DOWNLOAD}
            target="_blank"
            rel="noreferrer"
            className="text-[13px] font-semibold text-accent underline-offset-2 hover:underline"
          >
            {t("setup.claude.download")} ↗
          </a>
        </>
      ) : done ? (
        <p data-testid="setup-claude-done" role="status" className={hintClass}>
          {t(done === "copy" ? "setup.claude.copied" : "setup.claude.connected")}
        </p>
      ) : folderId ? (
        <button
          type="button"
          data-testid="setup-claude-connect"
          disabled={busy}
          onClick={() => void connect()}
          className={buttonStyle("secondary", "sm")}
        >
          {t("setup.claude.connect")}
        </button>
      ) : (
        <>
          <span data-testid="setup-claude-nofolder" className={hintClass}>
            {t("setup.claude.noFolder")}
          </span>
          <button
            type="button"
            onClick={() => showPage("ai")}
            className={buttonStyle("secondary", "sm")}
          >
            {t("setup.claude.openAgents")}
          </button>
        </>
      )}
      {problem && <ProblemLine testId="setup-claude-problem">{problem}</ProblemLine>}
    </div>
  );
}
