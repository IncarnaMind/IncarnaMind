import { useEffect, useRef, useState } from "react";
import type { AgentClient, ChatProvider } from "../../../../core/api";
import { SHOW_CLAUDE_APP_SETUP } from "../../../../shared/agentConnection";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useLanguage, useT } from "../../i18n";
import { turnOffLocalMode } from "../../localMode";
import { giveUpWaiting, useModelSetup } from "../../modelSetup";
import { ollamaRead } from "../../ollamaRead";
import { useAppStore } from "../../store";
import { useTranscriptionServicesRead } from "../../transcriptionServices";
import { OnThisComputer } from "../OnThisComputer";
import { ProblemLine } from "../ProblemLine";
import { ReadProblem } from "../ReadProblem";
import { buttonStyle, hintClass } from "../ui";
import { ChatGptMark } from "./ChatGptMark";
import {
  CHATGPT_RECIPIENT,
  ChatGptSignInState,
  ChatGptStorageNotice,
  useChatGptStorage,
  useContinueWithChatGpt,
} from "./ChatGptSignIn";
import { ClaudePlanWay } from "./ClaudePlan";
import { CopilotSetupWay } from "./CopilotPlan";
import { KeyEntry } from "./KeyEntry";
import { OllamaAction, OllamaProgress, type Ollama as OllamaState, useOllama } from "./OllamaCard";
import { ProviderForm } from "./ProviderForm";
import { SendsLine } from "./SendsLine";
import { SetupCard, SetupSteps } from "./SetupSteps";

const CLAUDE_DOWNLOAD = "https://claude.ai/download";

/**
 * The first own Question with no model set (#103): the assistant's composer becomes this card
 * while the Question waits above it. The first of three steps (#1922) is a key pasted, named by
 * its form and used at once; then the ways in that need no key, best first. Choosing a service
 * is the consent for it (#718), so no dialog is added here.
 */
export function ModelSetupCard() {
  const ready = useModelSetup((state) => state.ready);
  const t = useT();
  // Step 2's rows depend on whether a cloud service has a key, so the steps open only on a list
  // that was read, and never redraw as a later read lands (#2147). While the read goes, the card
  // says it is reading, rather than offering the key form of step 1 again (#2310).
  const services = useTranscriptionServicesRead(ready, true);
  if (!ready) return <ChooseAnAi />;
  if (services.state === "loading") {
    return (
      <section
        data-testid="model-setup"
        aria-busy="true"
        className="setup-card flex min-h-0 max-h-[85vh] flex-col gap-2.5 overflow-y-auto px-4"
      >
        <p data-testid="setup-services-reading" className={hintClass}>
          {t("setup.services.reading")}
        </p>
      </section>
    );
  }
  if (services.state === "ready") return <SetupSteps />;
  return (
    <SetupCard>
      <ReadProblem
        words={t("setup.services.failed")}
        read={services}
        testId="setup-services-problem"
      />
    </SetupCard>
  );
}

function ChooseAnAi() {
  const t = useT();
  const chinese = useLanguage() === "zh-CN";
  const localOnly = useAppStore((state) => state.embedding?.localOnly === true);
  const [view, setView] = useState<"key" | null>(null);
  const [initialKey, setInitialKey] = useState("");
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
                  run: (key) => {
                    setInitialKey(key);
                    setView("key");
                  },
                }}
              />
            )}
            {!localOnly && (
              <>
                <ChatGptPlanWay sign={sign} chinese={chinese} />
                <ClaudePlanWay onUseKey={useKeyInstead} />
              </>
            )}
            <LocalWay ollama={ollama} />
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
                  <CopilotSetupWay onKey={useKeyInstead} />
                  {SHOW_CLAUDE_APP_SETUP && !chinese && <ClaudeWay />}
                </div>
              </details>
            )}
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

/** The ChatGPT plan: the first way in for a User with no key. */
function ChatGptPlanWay({
  sign,
  chinese,
}: {
  sign: ReturnType<typeof useContinueWithChatGpt>;
  chinese: boolean;
}) {
  const t = useT();
  const storage = useChatGptStorage();
  const lineClass = "text-[12px] leading-[18px] text-ink-meta";
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <ChatGptStorageNotice storage={storage} />
      <button
        type="button"
        data-testid="setup-chatgpt"
        data-setup-choice
        disabled={!storage.canSave}
        onClick={() => void sign.run()}
        className={`w-full ${buttonStyle(chinese ? "secondary" : "primary", "lg")}`}
      >
        <ChatGptMark className="size-4" />
        {t("setup.chatgpt.use")}
      </button>
      <p data-testid="setup-chatgpt-line" className={lineClass}>
        {t(chinese ? "setup.chatgpt.line.china" : "setup.chatgpt.line")}
      </p>
      {/* It signs in at once, so it says here what goes to OpenAI (ADR-0022). */}
      <SendsLine provider={CHATGPT_RECIPIENT} testId="setup-chatgpt-sends" />
    </div>
  );
}

/**
 * A model on this computer (#545): used at once when Ollama runs and has a model, else its app
 * is opened to install one. It says what it costs and that nothing leaves. Before the probe
 * answers it says it is looking; a look that ran out of time, twice, settles to saying it wasn't
 * heard from with Check again, and neither says the app is missing (#2196, #2224).
 */
function LocalWay({ ollama }: { ollama: OllamaState }) {
  const t = useT();
  const read = ollamaRead(ollama);
  return (
    <div data-testid="way-local" className="flex flex-col items-start gap-1.5 px-2 py-1.5">
      <span className="text-ui font-semibold text-ink">
        {t(read === "not-running" ? "setup.way.local.install" : "setup.way.local")}
      </span>
      <span
        data-testid="ollama-status"
        data-read={read}
        data-looking={read === "looking" || undefined}
        className="text-[13px] leading-5 text-ink-secondary"
      >
        {t(
          read === "looking"
            ? "providers.ollama.checking"
            : read === "no-answer"
              ? "providers.ollama.noAnswer"
              : read === "running"
                ? "setup.way.local.running"
                : "setup.way.local.notRunning",
        )}
      </span>
      <OllamaProgress ollama={ollama} />
      <OllamaAction ollama={ollama} />
      {/* One line in every state, so nothing under it moves when the line below changes. */}
      <p data-testid="setup-local-keeps" className="min-h-[18px] text-[12px] leading-[18px]">
        {/* With a cloud service set up and Local mode off, the click leaves Local mode as it is. */}
        {ollama.status?.running && ollama.keepLocal.checked ? (
          <OnThisComputer>{t("setup.way.local.keeps")}</OnThisComputer>
        ) : (
          <span className="text-ink-meta">{t("setup.way.local.line")}</span>
        )}
      </p>
    </div>
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
            onClick={() => showPage("agents")}
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
